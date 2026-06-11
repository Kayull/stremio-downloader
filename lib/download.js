const mime = require('mime-types')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { Readable } = require('stream')
const downloadDir = require('./downloadDir')
const filelist = require('./fileList')
const metaDir = require('./metaDir')
const ffmpeg = require('./ffmpeg')
const logger = require('./logger')
const { getDownloadSourceKind } = require('./sourceKind')
const files = filelist.get()
const isWin = process.platform === 'win32'
const SAVE_DELAY_MS = 150
const SAVE_INTERVAL_MS = 60 * 60 * 1000
const EMPTY_META = Object.freeze({ url: '', type: '', id: '' })

function refreshFilePresenceState(file) {
    file.sourceKind = getDownloadSourceKind(file.url, file.type)
    const fileExists = file.filePath && fs.existsSync(file.filePath)

    if (file.completed) {
        if (!fileExists) {
            const wasMissing = !!file.missingOnDisk
            file.missingOnDisk = true
            file.error = false
            if (!wasMissing)
                logger.warn('Completed download is missing on disk', file.filename || file.url || 'unknown')
        } else {
            if (file.missingOnDisk)
                logger.info('Missing completed download is available on disk again', file.filename || file.url || 'unknown')
            file.missingOnDisk = false
        }
        return
    }

    file.missingOnDisk = false
}

function normalizeMeta(meta) {
    if (!meta || typeof meta !== 'object')
        return { ...EMPTY_META }

    return {
        url: meta.url || '',
        type: meta.type || '',
        id: meta.id || ''
    }
}

function recovercompletedDownloadFromDisk(file) {
    if (!file || file.completed || !file.filePath || !fs.existsSync(file.filePath))
        return false

    const expectedSize = Number(file.total)
    if (!Number.isFinite(expectedSize) || expectedSize <= 0)
        return false

    let stats
    try {
        stats = fs.statSync(file.filePath)
    } catch (err) {
        return false
    }

    if (!stats || stats.size < expectedSize)
        return false

    file.completed = true
    file.error = false
    file.stopped = false
    file.missingOnDisk = false
    file.current = stats.size
    file.total = stats.size
    logger.info('Recovered completed download from disk on startup', {
        url: file.url,
        filename: file.filename,
        filePath: file.filePath,
        size: stats.size,
        sourceKind: getDownloadSourceKind(file.url, file.type)
    })
    return true
}

function recoverInterruptedStoredDownload(file) {
    recovercompletedDownloadFromDisk(file)
    refreshFilePresenceState(file)

    if (file.completed)
        return

    const hasActiveRuntimeHandle = typeof file.getReq === 'function' || typeof file.getCommand === 'function'

    if (!file.error && !file.stopped && !hasActiveRuntimeHandle) {
        file.error = true
        logger.warn('Marking interrupted uncompleted download as errored on startup', file.filename || file.url || 'unknown')
        removeUnresumablePartial(file, 'interrupted non-resumable download on startup')
    }
}

function getLogTimestamp(line) {
    const match = String(line || '').match(/^\[([^\]]+)\]/)
    if (!match)
        return Date.now()

    const value = Date.parse(match[1])
    return Number.isFinite(value) ? value : Date.now()
}

function getLoggedPayload(line, label) {
    const marker = '] [INFO] ' + label + ' '
    const idx = String(line || '').indexOf(marker)
    if (idx === -1)
        return null

    try {
        return JSON.parse(String(line).slice(idx + marker.length))
    } catch (err) {
        return null
    }
}

function hasTrackedFile(fileCollection, candidate) {
    return fileCollection.some(file =>
        (!!candidate.url && file.url === candidate.url) ||
        (!!candidate.filePath && file.filePath === candidate.filePath)
    )
}

function buildRecoveredCompletedFile(payload, timestamp, metadataByUrl) {
    if (!payload || !payload.url || !payload.filePath || !payload.filename)
        return null

    if (!fs.existsSync(payload.filePath))
        return null

    let stats
    try {
        stats = fs.statSync(payload.filePath)
    } catch (err) {
        return null
    }

    const metadata = metadataByUrl.get(payload.url) || null
    const size = Number(payload.size) > 0 ? Number(payload.size) : (stats.size || 0)

    return {
        filename: payload.filename,
        url: payload.url,
        type: payload.type || '',
        streamId: payload.streamId || '',
        total: size,
        current: size,
        time: timestamp,
        filePath: payload.filePath,
        error: false,
        completed: true,
        missingOnDisk: false,
        stopped: false,
        sourceKind: payload.sourceKind || (metadata || {}).sourceKind || getDownloadSourceKind(payload.url, payload.type),
        meta: normalizeMeta((metadata || {}).meta)
    }
}

function recoverCompletedDownloadsFromLogs(fileCollection) {
    const lines = String(logger.list() || '').split('\n').filter(Boolean)
    const metadataByUrl = new Map()
    const recovered = []

    lines.forEach(line => {
        const resolved = getLoggedPayload(line, 'Resolved download storage path')
        if (resolved && resolved.url) {
            metadataByUrl.set(resolved.url, {
                sourceKind: resolved.sourceKind || getDownloadSourceKind(resolved.url, ''),
                meta: {
                    url: resolved.metaUrl || '',
                    type: resolved.metaType || '',
                    id: resolved.metaId || ''
                }
            })
        }
    })

    lines.forEach(line => {
        const payload = getLoggedPayload(line, 'Completed direct download')
            || getLoggedPayload(line, 'Completed HLS download')
            || getLoggedPayload(line, 'Recovered completed download from disk on startup')

        if (!payload)
            return

        if (hasTrackedFile(fileCollection, payload) || hasTrackedFile(recovered, payload))
            return

        const file = buildRecoveredCompletedFile(payload, getLogTimestamp(line), metadataByUrl)
        if (!file)
            return

        recovered.push(file)
    })

    recovered.forEach(file => {
        fileCollection.push(file)
        logger.info('Recovered completed download from logs', {
            url: file.url,
            filename: file.filename,
            filePath: file.filePath,
            size: file.total,
            sourceKind: file.sourceKind
        })
    })
}

function mergeMissingCompletedDownloads(fileCollection, preservedFiles) {
    let mergedCount = 0

    ;(preservedFiles || []).forEach(file => {
        if (!file || !file.completed || !file.filePath || !fs.existsSync(file.filePath))
            return

        if (hasTrackedFile(fileCollection, file))
            return

        const restored = JSON.parse(JSON.stringify(file))
        restored.error = false
        restored.stopped = false
        restored.missingOnDisk = false
        restored.meta = normalizeMeta(restored.meta)
        recovercompletedDownloadFromDisk(restored)
        refreshFilePresenceState(restored)
        fileCollection.push(restored)
        mergedCount++
    })

    return mergedCount
}

function buildPersistedFilesSnapshot() {
    const snapshot = JSON.parse(JSON.stringify(files))
    const mergedCount = mergeMissingCompletedDownloads(snapshot, filelist.get())

    if (mergedCount)
        logger.info('Preserved completed downloads from stored state before save', { count: mergedCount })

    return snapshot
}

files.forEach(recoverInterruptedStoredDownload)
recoverCompletedDownloadsFromLogs(files)
filelist.set(files)

function persistFiles() {
    filelist.set(buildPersistedFilesSnapshot())
}

function scheduleSave(delayMs) {
    if (saveFilesTimer)
        clearTimeout(saveFilesTimer)

    saveFilesTimer = setTimeout(() => {
        saveFilesTimer = null
        persistFiles()
        scheduleSave(SAVE_INTERVAL_MS)
    }, delayMs)
}

function scheduleStateSave() {
    scheduleSave(SAVE_DELAY_MS)
}
// no need to save on app start
let saveFilesTimer = null
scheduleSave(SAVE_INTERVAL_MS)
function clone(obj) { return JSON.parse(JSON.stringify(obj)) }
function checkFilePath(origPath, filePath, nr) {
    filePath = filePath || origPath
    nr = nr || 0
    if (fs.existsSync(filePath)) {
        const ext = path.extname(origPath)
        const basePath = ext ? origPath.slice(0, -ext.length) : origPath
        nr++
        const newFilePath = basePath + ' (' + nr + ')' + ext
        return checkFilePath(origPath, newFilePath, nr)
    }
    return filePath
}
function decodeFilenamePart(name) {
    if (!name || typeof name !== 'string')
        return name
    try {
        return decodeURIComponent(name)
    } catch (err) {
        return name.replace(/%20/g, ' ')
    }
}

function normalizeContentType(contentType) {
    return String(contentType || '').split(';')[0].trim().toLowerCase()
}

const genericBinaryContentTypes = [
    'application/octet-stream',
    'binary/octet-stream',
    'application/x-binary'
]

function isGenericBinaryContentType(contentType) {
    const normalized = normalizeContentType(contentType)
    return genericBinaryContentTypes.includes(normalized)
}

function getExtensionFromContentType(contentType) {
    const normalized = normalizeContentType(contentType)
    if (!normalized)
        return ''
    if (isGenericBinaryContentType(normalized))
        return ''
    if (hlsTypes.includes(normalized))
        return 'mp4'
    return mime.extension(normalized) || ''
}

function getFilenameExtension(filename) {
    const ext = path.extname(String(filename || '')).replace(/^\./, '').trim().toLowerCase()
    if (!ext || ext.length > 10)
        return ''
    return ext
}

function hasFilenameExtension(filename) {
    return !!getFilenameExtension(filename)
}

function unwrapHeaderToken(value) {
    let token = String(value || '').trim()
    if (!token)
        return ''
    if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'")))
        token = token.slice(1, -1)
    return token.replace(/\\"/g, '"')
}

function decodeHeaderFilename(value) {
    const token = unwrapHeaderToken(value)
    if (!token)
        return ''
    try {
        return decodeURIComponent(token)
    } catch (err) {
        return token
    }
}

function getFilenameFromContentDisposition(contentDisposition) {
    const header = String(contentDisposition || '')
    if (!header)
        return ''

    const utfMatch = header.match(/filename\*\s*=\s*(?:UTF-8''|utf-8''|)([^;]+)/i)
    if (utfMatch) {
        const decoded = decodeHeaderFilename(utfMatch[1])
        if (decoded)
            return decoded
    }

    const plainMatch = header.match(/filename\s*=\s*("(?:[^"\\]|\\.)*"|[^;]+)/i)
    if (!plainMatch)
        return ''

    return decodeHeaderFilename(plainMatch[1])
}

function getFilenameFromUrlCandidate(candidateUrl) {
    if (!candidateUrl)
        return ''

    let pathname = String(candidateUrl)
    try {
        pathname = new URL(candidateUrl).pathname || ''
    } catch (err) {}

    pathname = pathname.split('#')[0].split('?')[0]
    const filename = path.basename(pathname || '')
    return decodeFilenamePart(filename)
}

function getErrorSummary(err) {
    if (!err)
        return ''
    if (typeof err === 'string')
        return err
    return err.message || err.code || err.name || String(err)
}

function serializeError(err) {
    if (!err)
        return null

    return {
        name: err.name || '',
        code: err.code || '',
        message: getErrorSummary(err)
    }
}

function buildDownloadFailureReason(stage, details, err) {
    const parts = [stage]
    const status = Number((details || {}).status)
    const current = Number((details || {}).current)
    const total = Number((details || {}).total)
    const detail = String((details || {}).detail || '').trim()
    const errorMessage = getErrorSummary(err)

    if (status > 0)
        parts.push('HTTP ' + status)
    if (Number.isFinite(current) && Number.isFinite(total) && total > 0)
        parts.push('received ' + current + ' of ' + total + ' bytes')
    if (detail)
        parts.push(detail)
    if (errorMessage && errorMessage !== detail)
        parts.push(errorMessage)
    return parts.join(': ')
}

function logDownloadFailure(stage, context, err) {
    const reason = buildDownloadFailureReason(stage, context, err)
    logger.error('Download failed', {
        ...context,
        stage,
        reason,
        error: serializeError(err)
    })
    return reason
}

function setDownloadErrorState(idx, reason) {
    if (idx < 0 || !files[idx] || files[idx].stopped)
        return
    files[idx].error = true
    files[idx].errorMessage = reason
}

function getPositiveNumber(value) {
    const number = Number(value)
    return Number.isFinite(number) && number > 0 ? number : 0
}

function getFileSize(filePath) {
    if (!filePath)
        return 0

    try {
        const stats = fs.statSync(filePath)
        return (stats || {}).size || 0
    } catch (err) {
        return 0
    }
}

function stopRuntimeHandles(file) {
    if (!file)
        return

    if (file.getReq) {
        const req = file.getReq()
        if (req)
            req.abort()
    }

    if (file.getCommand) {
        const command = file.getCommand()
        if ((command || {}).kill)
            command.kill('SIGINT')
    }

    if (file.closeStream)
        file.closeStream()
}

function removeTrackedDownload(url) {
    const idx = download.findIdx(url)
    if (idx === -1)
        return null

    const file = files[idx]
    stopRuntimeHandles(file)
    files.splice(idx, 1)
    return file
}

function deletePartialFile(file, reason) {
    if (!file || !file.filePath || file.completed)
        return false

    try {
        fs.unlinkSync(file.filePath)
        file.current = 0
        logger.info('Removed non-resumable partial download', {
            url: file.url,
            filename: file.filename,
            filePath: file.filePath,
            reason: reason || ''
        })
        return true
    } catch (err) {
        if (!err || err.code === 'ENOENT') {
            file.current = 0
            return true
        }

        logger.warn('Failed to remove non-resumable partial download', {
            url: file.url,
            filename: file.filename,
            filePath: file.filePath,
            reason: reason || '',
            error: err.message || err.code || String(err)
        })
        return false
    }
}

function removeUnresumablePartial(file, reason) {
    if (!file || file.resumeSupported !== false || file.isHls || file.completed)
        return false

    return deletePartialFile(file, reason)
}

function getResumePlan(file, total, sourceKind) {
    if (!file || file.completed || file.isHls || sourceKind === 'hls-stream')
        return null

    if (file.resumeSupported === false)
        return null

    const current = getFileSize(file.filePath)
    if (current <= 0)
        return null

    const expectedTotal = getPositiveNumber(total) || getPositiveNumber(file.total)
    if (!expectedTotal)
        return null

    return {
        file,
        current,
        total: expectedTotal,
        isComplete: current >= expectedTotal
    }
}

function getPublicId(file) {
    const hash = crypto.createHash('sha1')
    hash.update(String((file || {}).url || ''))
    hash.update('\n')
    hash.update(String((file || {}).filename || ''))
    return hash.digest('hex')
}
function getPublicPath(file) {
    if (!file || !file.filePath)
        return ''

    return [
        getPublicId(file),
        encodeURIComponent(String(file.filename || 'download'))
    ].join('/')
}
function removeIllegalCharacters(name) {

    if (!name)
        return false

	if (isWin) {
	    // illegal characters on windows are: < > : " / \ | ? *
	    return name.replace(/\<|\>|\:|\"|\/|\\|\||\?|\*/g,' ').replace(/  +/g, ' ')
	} else {
	    // On macOS, ":" is rendered like a path separator in Finder, so normalize it too.
	    return name.replace(/[/:]/g, ' ').replace(/  +/g, ' ')
	}

}

function normalizeShowFolderName(name) {
    const sanitized = removeIllegalCharacters(name)
    if (!sanitized)
        return ''

    return sanitized
        .replace(/[\s._-]+/g, ' ')
        .trim()
}

function getShowFolderLookupKey(name) {
    const normalized = normalizeShowFolderName(name)
    return normalized ? normalized.toLowerCase() : ''
}

function findExistingShowFolder(downDir, showName) {
    if (!showName)
        return ''

    const exactMatchPath = path.join(downDir, showName)
    if (showName && fs.existsSync(exactMatchPath) && fs.statSync(exactMatchPath).isDirectory())
        return exactMatchPath

    const targetKey = getShowFolderLookupKey(showName)
    if (!targetKey)
        return ''

    let entries
    try {
        entries = fs.readdirSync(downDir, { withFileTypes: true })
    } catch (err) {
        return ''
    }

    const match = entries.find(entry =>
        entry.isDirectory() &&
        getShowFolderLookupKey(entry.name) === targetKey
    )

    return match ? path.join(downDir, match.name) : ''
}

function decideFilename(name, url, contentType, options) {
    const decodedName = decodeFilenamePart(name)
    const contentTypeExt = getExtensionFromContentType(contentType)
    const dispositionFilename = getFilenameFromContentDisposition((options || {}).contentDisposition)
    const finalUrlFilename = getFilenameFromUrlCandidate((options || {}).finalUrl)
    const requestUrlFilename = getFilenameFromUrlCandidate(url)
    const inferredExt = getFilenameExtension(dispositionFilename)
        || getFilenameExtension(finalUrlFilename)
        || getFilenameExtension(requestUrlFilename)

    if (decodedName && contentTypeExt) {
        return {
            filename: decodedName + '.' + contentTypeExt,
            reason: 'title with extension from content-type'
        }
    }

    if (dispositionFilename && hasFilenameExtension(dispositionFilename)) {
        return {
            filename: dispositionFilename,
            reason: 'filename from content-disposition'
        }
    }

    if (decodedName && inferredExt && isGenericBinaryContentType(contentType)) {
        return {
            filename: decodedName + '.' + inferredExt,
            reason: 'title with extension inferred from generic binary download URL'
        }
    }

    if (finalUrlFilename && hasFilenameExtension(finalUrlFilename)) {
        return {
            filename: finalUrlFilename,
            reason: 'filename from redirected download URL'
        }
    }

    if (requestUrlFilename && hasFilenameExtension(requestUrlFilename)) {
        return {
            filename: requestUrlFilename,
            reason: 'filename from requested download URL'
        }
    }

    if (decodedName && inferredExt) {
        return {
            filename: decodedName + '.' + inferredExt,
            reason: 'title with extension inferred from server filename'
        }
    }

    if (decodedName) {
        return {
            filename: decodedName,
            reason: 'title only because no usable extension was exposed by the server'
        }
    }

    if (contentTypeExt) {
        return {
            filename: 'Unknown.' + contentTypeExt,
            reason: 'fallback filename from content-type'
        }
    }

    if (dispositionFilename) {
        return {
            filename: dispositionFilename,
            reason: 'extensionless filename from content-disposition'
        }
    }

    if (finalUrlFilename) {
        return {
            filename: finalUrlFilename,
            reason: 'extensionless filename from redirected download URL'
        }
    }

    if (requestUrlFilename) {
        return {
            filename: requestUrlFilename,
            reason: 'extensionless filename from requested download URL'
        }
    }

    return false
}
const hlsTypes = [
    'video/m3u',
    'video/m3u8',
    'video/hls',
    'application/x-mpegurl',
    'vnd.apple.mpegURL',
    'video/mp2t',
    'application/vnd.apple.mpegurl'
]

function isIgnorableFolderEntry(name) {
    const entry = String(name || '')
    if (!entry)
        return false
    if (entry === '.DS_Store' || entry === 'Thumbs.db' || entry === '.localized')
        return true
    return entry.startsWith('._')
}

function removeEmptyParentFolder(filePath) {
	if (!filePath)
		return

	if (downloadDir.getAutoDeleteEmptyShowFolders() !== true)
		return

	const parentDir = path.dirname(filePath)
	const downloadRoot = downloadDir.get()

	if (!parentDir || parentDir === downloadRoot)
		return

	let entries
	try {
		entries = fs.readdirSync(parentDir)
	} catch (err) {
		return
	}

    const removableEntries = entries.filter(isIgnorableFolderEntry)
    removableEntries.forEach(entry => {
        try {
            fs.unlinkSync(path.join(parentDir, entry))
            logger.info('Removed ignorable download folder entry', { parentDir, entry })
        } catch (err) {
            logger.warn('Failed to remove ignorable download folder entry', {
                parentDir,
                entry,
                error: err.message || err.code || String(err)
            })
        }
    })

    try {
        entries = fs.readdirSync(parentDir)
    } catch (err) {
        return
    }

    if (entries.length)
        return

    try {
        fs.rmdirSync(parentDir)
        logger.info('Removed empty download folder', parentDir)
    } catch (err) {
        if (err && err.code !== 'ENOTEMPTY' && err.code !== 'ENOENT')
            logger.warn('Failed to remove empty download folder', { parentDir, error: err.message || err.code || String(err) })
    }
}

function getMeta(url, metaUrl, metaId, metaType) {
    fetch(metaUrl).then(resp => {
        if (!resp.ok)
            return ''
        return resp.text()
    }).then(body => {
        if (body)
            metaDir.setMeta(metaId, metaType, body)
    }).catch(err => {
        logger.warn('Failed to fetch metadata for download', url, err)
    })
}

function getMetadataLogSnapshot(meta) {
    if (!meta || typeof meta !== 'object')
        return null

    return {
        id: meta.id || null,
        type: meta.type || null,
        name: meta.name || null,
        year: meta.year || null,
        releaseInfo: meta.releaseInfo || null
    }
}

async function getMetaObjectForPath(metaUrl, metaId, metaType) {
    if (!metaId || !metaType)
        return null

    const cachedMeta = metaDir.getMeta(metaId, metaType)
    if ((cachedMeta || {}).meta) {
        logger.info('Using cached metadata for download target', {
            metaId,
            metaType,
            metaUrl,
            metadata: getMetadataLogSnapshot(cachedMeta.meta)
        })
        return cachedMeta.meta
    }

    if (!metaUrl)
        return null

    try {
        const response = await fetch(metaUrl)
        if (!response.ok)
            return null
        const body = await response.text()
        if (!body)
            return null
        metaDir.setMeta(metaId, metaType, body)
        const parsed = JSON.parse(body)
        logger.info('Fetched metadata for download target', {
            metaId,
            metaType,
            metaUrl,
            metadata: getMetadataLogSnapshot(parsed.meta || null)
        })
        return parsed.meta || null
    } catch (err) {
        logger.warn('Failed to fetch metadata for folder resolution', { metaUrl, metaId, metaType }, err)
        return null
    }
}

async function resolveTargetDirectory(metaUrl, metaId, metaType) {
    const downDir = downloadDir.get()
    if (!downDir)
        throw new Error('No download folder has been configured yet.')

    if (!downloadDir.getUseShowSubfolders() || metaType !== 'series')
        return { targetDir: downDir, meta: null }

    const meta = await getMetaObjectForPath(metaUrl, metaId, metaType)
    const rawShowName = removeIllegalCharacters((meta || {}).name || '')
    const existingTargetDir = findExistingShowFolder(downDir, rawShowName)

    if (existingTargetDir)
        return { targetDir: existingTargetDir, meta }

    const showName = normalizeShowFolderName((meta || {}).name || '')

    if (!showName)
        return { targetDir: downDir, meta }

    const targetDir = path.join(downDir, showName)
    if (!fs.existsSync(targetDir))
        fs.mkdirSync(targetDir, { recursive: true })
    return { targetDir, meta }
}

function getTotalFromHeaders(headers) {
    const contentRange = headers.get('content-range') || ''
    if (contentRange.includes('/')) {
        const total = contentRange.split('/').pop()
        if (total && total !== '*')
            return total
    }

    return headers.get('content-length')
}

function getContentRangeStart(headers) {
    const contentRange = String(headers.get('content-range') || '')
    const match = contentRange.match(/^bytes\s+(\d+)-/i)
    if (!match)
        return -1

    return Number(match[1])
}

function headerSupportsRange(headers) {
    return String(headers.get('accept-ranges') || '').toLowerCase().split(',').map(value => value.trim()).includes('bytes')
}

async function probeDownload(url, method, extraHeaders) {
    const response = await fetch(url, {
        method,
        redirect: 'follow',
        headers: extraHeaders
    })

    return response
}

async function closeProbeBody(response) {
    if (!response || !response.body)
        return

    try {
        await response.body.cancel()
    } catch (err) {}
}

async function probeResumeSupport(url, baseResponse, type) {
    if (type && hlsTypes.includes(normalizeContentType(type)))
        return false

    if (baseResponse.status === 206 && getContentRangeStart(baseResponse.headers) === 0)
        return true

    if (headerSupportsRange(baseResponse.headers))
        return true

    try {
        const response = await probeDownload(url, 'GET', { Range: 'bytes=0-0' })
        await closeProbeBody(response)
        return response.status === 206 && getContentRangeStart(response.headers) === 0
    } catch (err) {
        logger.warn('Failed to probe download resume support', {
            url,
            sourceKind: getDownloadSourceKind(url, type),
            error: err.message || err.code || String(err)
        })
        return false
    }
}

async function fetchHeaders(url) {
    let probeMethod = 'HEAD'
    let response = await probeDownload(url, 'HEAD')

    if (response.status === 405) {
        logger.warn('HEAD rejected for download probe, retrying with GET', { url, sourceKind: getDownloadSourceKind(url) })
        probeMethod = 'GET'
        response = await probeDownload(url, 'GET', { Range: 'bytes=0-0' })
        await closeProbeBody(response)
    }

    if (!response.ok)
        throw new Error('Request failed with status ' + response.status)

    const type = response.headers.get('content-type')
    const resumeSupported = await probeResumeSupport(url, response, type)
    const headers = {
        total: getTotalFromHeaders(response.headers),
        type,
        contentDisposition: response.headers.get('content-disposition') || '',
        finalUrl: response.url || url,
        probeMethod,
        status: response.status,
        resumeSupported
    }
    logger.info('Fetched download headers', {
        url,
        finalUrl: headers.finalUrl,
        total: headers.total,
        type: headers.type,
        contentDisposition: headers.contentDisposition,
        probeMethod: headers.probeMethod,
        status: headers.status,
        resumeSupported: headers.resumeSupported,
        sourceKind: getDownloadSourceKind(url, headers.type)
    })
    return headers
}

async function openDownloadStream(url, signal, resumeFrom) {
    const headers = resumeFrom > 0 ? { Range: 'bytes=' + resumeFrom + '-' } : undefined
    const response = await fetch(url, {
        method: 'GET',
        redirect: 'follow',
        signal,
        headers
    })

    if (!response.ok || !response.body)
        throw new Error('Download request failed with status ' + response.status)

    if (resumeFrom > 0 && (response.status !== 206 || getContentRangeStart(response.headers) !== resumeFrom)) {
        if (response.body) {
            try {
                await response.body.cancel()
            } catch (err) {}
        }
        const err = new Error('Server did not honor the resume range request')
        err.code = 'resume_not_supported'
        err.status = response.status
        throw err
    }

    logger.info('Opened download stream', {
        url,
        status: response.status,
        resumeFrom: resumeFrom || 0,
        type: response.headers.get('content-type'),
        sourceKind: getDownloadSourceKind(url, response.headers.get('content-type'))
    })
    return Readable.fromWeb(response.body)
}
const download = {
    list: () => {
        files.forEach(refreshFilePresenceState)
        return clone(files).map(file => {
            const total = Number(file.total)
            const current = Number(file.current) || 0
            file.progress = total > 0 ? Math.floor((current / total) * 100) : 0
            if (file.completed && !file.missingOnDisk && file.filePath) {
                file.publicId = getPublicId(file)
                file.publicPath = getPublicPath(file)
            }
            return file
        }).reverse()
    },
    get: (name, url, streamId, filenameCb, metaUrl, metaId, metaType) => {
        ;(async () => {
            let headers
            try {
                headers = await fetchHeaders(url)
            } catch (err) {
                logDownloadFailure('Failed to probe download headers', {
                    url,
                    sourceKind: getDownloadSourceKind(url)
                }, err)
                filenameCb(false)
                return
            }

            const existingFile = download.find(url)
            const total = getPositiveNumber(headers.total) || getPositiveNumber((existingFile || {}).total)
            const type = headers.type
            const sourceKind = getDownloadSourceKind(url, type)
            const resumePlan = getResumePlan(existingFile, total, sourceKind)

            if (resumePlan && resumePlan.isComplete) {
                existingFile.completed = true
                existingFile.error = false
                existingFile.errorMessage = ''
                existingFile.stopped = false
                existingFile.missingOnDisk = false
                existingFile.current = resumePlan.current
                existingFile.total = resumePlan.current
                logger.info('Recovered completed direct download before retry', {
                    url,
                    filename: existingFile.filename,
                    filePath: existingFile.filePath,
                    size: resumePlan.current,
                    sourceKind
                })
                filenameCb(existingFile.filename)
                scheduleStateSave()
                return
            }

            if (existingFile) {
                if (resumePlan) {
                    removeTrackedDownload(url)
                    logger.info('Preparing to resume partial direct download', {
                        url,
                        filename: existingFile.filename,
                        filePath: existingFile.filePath,
                        current: resumePlan.current,
                        total: resumePlan.total,
                        sourceKind
                    })
                } else {
                    logger.warn('Replacing existing tracked download for URL', url)
                    download.remove(null, url)
                }
            }

            const filenameDecision = decideFilename(name, url, type, {
                contentDisposition: headers.contentDisposition,
                finalUrl: headers.finalUrl
            })
            const filename = resumePlan
                ? existingFile.filename
                : removeIllegalCharacters((filenameDecision || {}).filename)
            if ((!resumePlan && !filenameDecision) || !filename) {
                logDownloadFailure('Could not determine a filename for the download', {
                    url,
                    requestedTitle: name || '',
                    type,
                    finalUrl: headers.finalUrl,
                    contentDisposition: headers.contentDisposition,
                    sourceKind: getDownloadSourceKind(url, type),
                    detail: 'No usable title, server filename, or extension could be derived.'
                })
                filenameCb(false)
                return
            }

            logger.info('Starting download', {
                url,
                filename,
                filenameReason: resumePlan ? 'resuming existing partial download' : filenameDecision.reason,
                type,
                finalUrl: headers.finalUrl,
                contentDisposition: headers.contentDisposition,
                streamId,
                metaId,
                metaType,
                resumeSupported: headers.resumeSupported,
                sourceKind
            })

            let resolution
            try {
                resolution = await resolveTargetDirectory(metaUrl, metaId, metaType)
            } catch (err) {
                logger.error('Download could not start because no download folder is configured', {
                    url,
                    filename,
                    streamId,
                    metaId,
                    metaType,
                    sourceKind
                }, err)
                filenameCb(false)
                return
            }

            filenameCb(filename)
            const downDir = resolution.targetDir
            let filePath = resumePlan ? existingFile.filePath : path.join(downDir, filename)
            if (!resumePlan)
                filePath = checkFilePath(filePath)
            logger.info('Resolved download storage path', {
                url,
                filename,
                targetDir: downDir,
                filePath,
                sourceKind,
                metaId,
                metaType,
                metaUrl,
                metadata: getMetadataLogSnapshot(resolution.meta)
            })

            if (type && hlsTypes.includes(normalizeContentType(type))) {
                const args = [
                    '-c copy',
                    '-bsf:a aac_adtstoasc'
                ]
                const command = ffmpeg({ source: url, timeout: false })
                command.on('start', (commandLine) => {
                    logger.info('Spawned ffmpeg process', {
                        commandLine,
                        url,
                        filename,
                        sourceKind: getDownloadSourceKind(url, type)
                    })
                    console.log('Spawned Ffmpeg with command: ', commandLine);
                }).on('error', (err) => {
                    const idx = download.findIdx(url)
                    const reason = logDownloadFailure('ffmpeg reported an error', {
                        url,
                        filename,
                        sourceKind: getDownloadSourceKind(url, type)
                    }, err)
                    setDownloadErrorState(idx, reason)
                    scheduleStateSave()
                }).on('close', (err, msg) => {
                    const idx = download.findIdx(url)
                    if (err) {
                        if (idx > -1 && files[idx].error)
                            return
                        const reason = logDownloadFailure('ffmpeg closed with an error', {
                            url,
                            filename,
                            detail: msg || '',
                            sourceKind: getDownloadSourceKind(url, type)
                        }, err)
                        setDownloadErrorState(idx, reason)
                        scheduleStateSave()
                    }
                }).on('exit', (err, msg) => {
                    const idx = download.findIdx(url)
                    if (err) {
                        if (idx > -1 && files[idx].error)
                            return
                        const reason = logDownloadFailure('ffmpeg exited with an error', {
                            url,
                            filename,
                            detail: msg || '',
                            sourceKind: getDownloadSourceKind(url, type)
                        }, err)
                        setDownloadErrorState(idx, reason)
                        scheduleStateSave()
                    }
                })
                .on('end', (err, stdout, stderr) => {
                    const idx = download.findIdx(url)
                    if (idx > -1) {
                        let stats
                        try {
                            stats = fs.statSync(files[idx].filePath)
                        } catch (statErr) {
                            const reason = logDownloadFailure('Failed to finalize HLS download', {
                                url,
                                filename,
                                filePath: files[idx].filePath,
                                detail: 'ffmpeg ended but the saved file could not be inspected.',
                                sourceKind: getDownloadSourceKind(url, type)
                            }, statErr)
                            setDownloadErrorState(idx, reason)
                            scheduleStateSave()
                            return
                        }
                        files[idx].completed = true
                        files[idx].error = false
                        files[idx].errorMessage = ''
                        files[idx].stopped = false
                        files[idx].missingOnDisk = false
                        files[idx].current = (stats || {}).size || 0
                        files[idx].total = (stats || {}).size || 0
                        logger.info('Completed HLS download', {
                            url,
                            filename,
                            filePath: files[idx].filePath,
                            size: files[idx].total,
                            sourceKind: getDownloadSourceKind(url, type)
                        })
                        scheduleStateSave()
                    }
                })
                command.outputOptions(args)
                command.save(filePath)
                files.push({
                    filename,
                    url,
                    type,
                    streamId,
                    total: 0,
                    current: 0,
                    isHls: true,
                    time: Date.now(),
                    filePath,
                    errorMessage: '',
                    error: false,
                    completed: false,
                    missingOnDisk: false,
                    stopped: false,
                    resumeSupported: false,
                    sourceKind,
                    meta: { url: metaUrl, type: metaType, id: metaId },
                    getCommand: () => { return command }
                })
                scheduleStateSave()
            } else {
                let resumeFrom = resumePlan ? resumePlan.current : 0
                let writeStream
                const abortController = new AbortController()
                let stream
                const req = {
                    abort: () => {
                        abortController.abort()
                        if (stream)
                            stream.destroy()
                    }
                }

                const fileRecord = {
                    filename,
                    url,
                    type,
                    streamId,
                    total: resumePlan ? resumePlan.total : total,
                    current: resumeFrom,
                    time: Date.now(),
                    filePath,
                    errorMessage: '',
                    error: false,
                    completed: false,
                    missingOnDisk: false,
                    stopped: false,
                    resumeSupported: headers.resumeSupported,
                    sourceKind,
                    meta: { url: metaUrl, type: metaType, id: metaId },
                    getReq: () => { return req },
                    closeStream: () => {
                        try {
                            if (writeStream)
                                writeStream.end()
                        } catch(e) {}
                        return true
                    }
                }
                files.push(fileRecord)
                scheduleStateSave()

                try {
                    try {
                        stream = await openDownloadStream(url, abortController.signal, resumeFrom)
                    } catch (err) {
                        if (resumeFrom > 0 && err && err.code === 'resume_not_supported') {
                            logger.warn('Server does not support resuming this download, restarting from the beginning', {
                                url,
                                filename,
                                filePath,
                                resumeFrom,
                                status: err.status || 0,
                                sourceKind
                            })
                            resumeFrom = 0
                            fileRecord.current = 0
                            fileRecord.total = total
                            fileRecord.resumeSupported = false
                            stream = await openDownloadStream(url, abortController.signal, 0)
                        } else {
                            throw err
                        }
                    }
                } catch (err) {
                    const idx = download.findIdx(url)
                    const reason = logDownloadFailure('Failed to open the download stream', {
                        url,
                        filename,
                        total,
                        finalUrl: headers.finalUrl,
                        type,
                        sourceKind: getDownloadSourceKind(url, type)
                    }, err)
                    if (idx > -1 && files[idx] === fileRecord) {
                        setDownloadErrorState(idx, reason)
                        if (files[idx].closeStream)
                            files[idx].closeStream()
                        removeUnresumablePartial(files[idx], 'failed to open stream')
                    }
                    scheduleStateSave()
                    return
                }

                writeStream = fs.createWriteStream(filePath, { flags: resumeFrom > 0 ? 'a' : 'w' })
                stream.pipe(writeStream)

                writeStream.on('close', () => {
                    const idx = download.findIdx(url)
                    if (idx > -1 && files[idx] === fileRecord) {
                        if ((files[idx].error || files[idx].stopped) && files[idx].resumeSupported === false) {
                            removeUnresumablePartial(files[idx], files[idx].stopped ? 'stopped by user' : 'download failed')
                        } else if (files[idx].total > 0 && files[idx].current < files[idx].total && !files[idx].stopped && !files[idx].error) {
                            const reason = logDownloadFailure('Download stream closed before completion', {
                                url,
                                filename,
                                current: files[idx].current,
                                total: files[idx].total,
                                detail: 'The remote server closed the connection before the advertised content length was fully received.',
                                sourceKind: getDownloadSourceKind(url, type)
                            })
                            setDownloadErrorState(idx, reason)
                            if (files[idx].closeStream)
                                files[idx].closeStream()
                            removeUnresumablePartial(files[idx], 'stream closed before completion')
                        } else if (!files[idx].stopped && !files[idx].error) {
                            let stats
                            try {
                                stats = fs.statSync(files[idx].filePath)
                            } catch (statErr) {
                                const reason = logDownloadFailure('Failed to inspect the completed download on disk', {
                                    url,
                                    filename,
                                    filePath: files[idx].filePath,
                                    current: files[idx].current,
                                    total: files[idx].total,
                                    sourceKind: getDownloadSourceKind(url, type)
                                }, statErr)
                                setDownloadErrorState(idx, reason)
                                scheduleStateSave()
                                return
                            }
                            files[idx].completed = true
                            files[idx].error = false
                            files[idx].errorMessage = ''
                            files[idx].stopped = false
                            files[idx].missingOnDisk = false
                            files[idx].current = (stats || {}).size || files[idx].current
                            files[idx].total = (stats || {}).size || files[idx].total
                            logger.info('Completed direct download', {
                                url,
                                filename,
                                filePath: files[idx].filePath,
                                size: files[idx].current,
                                sourceKind: getDownloadSourceKind(url, type)
                            })
                        }
                        scheduleStateSave()
                    }
                })

                writeStream.on('error', err => {
                    const idx = download.findIdx(url)
                    const current = idx > -1 ? files[idx].current : 0
                    const totalBytes = idx > -1 ? files[idx].total : total
                    const reason = logDownloadFailure('Failed to write the download to disk', {
                        url,
                        filename,
                        filePath,
                        current,
                        total: totalBytes,
                        sourceKind: getDownloadSourceKind(url, type)
                    }, err)
                    if (idx > -1 && files[idx] === fileRecord) {
                        setDownloadErrorState(idx, reason)
                        if (files[idx].closeStream)
                            files[idx].closeStream()
                        removeUnresumablePartial(files[idx], 'write error')
                    }
                    scheduleStateSave()
                })

                stream.on('data', chunk => {
                    const idx = download.findIdx(url)
                    if (idx > -1 && files[idx] === fileRecord)
                        files[idx].current += chunk.length
                })

                stream.on('error', err => {
                    const idx = download.findIdx(url)
                    if (idx > -1 && files[idx] === fileRecord && !files[idx].stopped) {
                        const reason = logDownloadFailure('Download stream emitted an error', {
                            url,
                            filename,
                            current: files[idx].current,
                            total: files[idx].total,
                            sourceKind: getDownloadSourceKind(url, type)
                        }, err)
                        setDownloadErrorState(idx, reason)
                        if (files[idx].closeStream)
                            files[idx].closeStream()
                        removeUnresumablePartial(files[idx], 'stream error')
                        scheduleStateSave()
                    }
                })
            }

            if (metaUrl)
                getMeta(url, metaUrl, metaId, metaType)
        })()
    },
    remove: (filename, url) => {
        let file
        let meta = {}
        files.some((el, ij) => {
            if (el.url == url) {
                file = el
                meta = JSON.parse(JSON.stringify(file.meta))
                if (file.getReq) {
                    const req = file.getReq()
                    if (req) req.abort()
                }
                if (file.getCommand) {
                    const command = file.getCommand()
                    if ((command || {}).kill)
                        command.kill('SIGINT')
                }
                let waitFor
                if (files[ij].closeStream)
                    waitFor = files[ij].closeStream()
                files.splice(ij, 1)
                return true
            }
        })
        logger.warn('Removing download', { url, filename: (file || {}).filename || filename || '' })
        if (file) {
            try {
                fs.unlinkSync(file.filePath)
            } catch(e) {
                if (!e || e.code !== 'ENOENT')
                    logger.warn('Failed to remove downloaded file from disk', {
                        filePath: file.filePath,
                        error: (e || {}).message || (e || {}).code || String(e)
                    })
            }
            removeEmptyParentFolder(file.filePath)
        }
        if (meta.id && meta.type) {
            const keepMeta = files.some(el => {
                if (el.meta.id == meta.id && el.meta.type == meta.type)
                    return true
            })
            if (!keepMeta)
                metaDir.removeMeta(meta.id, meta.type)
        }
        scheduleStateSave()
        return true
    },
    stop: (filename, url) => {
        let file
        files.some((el, ij) => {
            if (el.url == url) {
                file = el
                if (file.getReq) {
                    const req = file.getReq()
                    if (req) req.abort()
                }
                if (file.getCommand) {
                    const command = file.getCommand()
                    if ((command || {}).kill)
                        command.kill('SIGINT')
                }
                let waitFor
                if (files[ij].closeStream)
                    waitFor = files[ij].closeStream()
                files[ij].stopped = true
                removeUnresumablePartial(files[ij], 'stopped by user')
                return true
            }
        })
        logger.warn('Marked download as stopped', { url, filename: (file || {}).filename || filename || '' })
        scheduleStateSave()
    },
    find: (url) => {
        let file
        files.some((el, ij) => {
            if (el.url == url) {
                file = el
                return true
            }
        })
        return file
    },
    findIdx: (url) => {
        let idx = -1
        files.some((el, ij) => {
            if (el.url == url) {
                idx = ij
                return true
            }
        })
        return idx
    },
    findById: (id, type) => {
        const fls = []
        files.some((el, ij) => {
            if (el.streamId == id && (el.meta || {}).type == type)
                fls.push(el)
        })
        return fls
    },
    findByPublicId: id => {
        let file
        files.some(el => {
            if (getPublicId(el) === id) {
                file = el
                return true
            }
        })
        return file
    },
    getPublicId,
    getPublicPath,
    cleanEnd: cb => {
        if (saveFilesTimer)
            clearTimeout(saveFilesTimer)
        persistFiles()
        logger.info('Persisted download list on app shutdown', { count: files.length })
        cb()
    }
}
module.exports = download
