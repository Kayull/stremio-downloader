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
        const parts = origPath.split('.')
        nr++
        parts[parts.length -2] = parts[parts.length -2] + ' (' + nr + ')'
        const newFilePath = parts.join('.')
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
function decideFilename(name, url, contentType) {
    name = decodeFilenamePart(name)
    let isHls = false
    if (contentType && hlsTypes.includes(contentType.toLowerCase()))
        isHls = true
    const ext = isHls ? 'mp4' : mime.extension(contentType)
    if (name && ext)
        return name + '.' + ext
    let filename = url.split('/').pop()
    if ((filename || '').includes('?'))
        filename = filename.split('?')[0]
    filename = decodeFilenamePart(filename)
    if (!filename || filename.length < 4 || !filename.includes('.') || isHls) {
        if (contentType) {
            if (name)
                return name + '.' + ext
            else
                return 'Unknown.' + ext
        } else
            return false
    } else
        return filename
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

function removeEmptyParentFolder(filePath) {
    if (!filePath)
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

    if (entries.length)
        return

    try {
        fs.rmdirSync(parentDir)
        logger.info('Removed empty download folder', parentDir)
    } catch (err) {}
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

    if (!downloadDir.getUseShowSubfolders() || metaType !== 'series')
        return { targetDir: downDir, meta: null }

    const meta = await getMetaObjectForPath(metaUrl, metaId, metaType)
    const showName = removeIllegalCharacters((meta || {}).name || '')

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

async function probeDownload(url, method, extraHeaders) {
    const response = await fetch(url, {
        method,
        redirect: 'follow',
        headers: extraHeaders
    })

    return response
}

async function fetchHeaders(url) {
    let response = await probeDownload(url, 'HEAD')

    if (response.status === 405) {
        logger.warn('HEAD rejected for download probe, retrying with GET', { url, sourceKind: getDownloadSourceKind(url) })
        response = await probeDownload(url, 'GET', { Range: 'bytes=0-0' })
        if (response.body) {
            try {
                await response.body.cancel()
            } catch (err) {}
        }
    }

    if (!response.ok)
        throw new Error('Request failed with status ' + response.status)

    const headers = {
        total: getTotalFromHeaders(response.headers),
        type: response.headers.get('content-type')
    }
    logger.info('Fetched download headers', { url, total: headers.total, type: headers.type, sourceKind: getDownloadSourceKind(url, headers.type) })
    return headers
}

async function openDownloadStream(url, signal) {
    const response = await fetch(url, {
        method: 'GET',
        redirect: 'follow',
        signal
    })

    if (!response.ok || !response.body)
        throw new Error('Download request failed with status ' + response.status)

    logger.info('Opened download stream', {
        url,
        status: response.status,
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
                logger.error('Failed to fetch headers for download', { url, sourceKind: getDownloadSourceKind(url) }, err)
                filenameCb(false)
                return
            }

            const total = headers.total
            const type = headers.type
            const sourceKind = getDownloadSourceKind(url, type)

            files.some((el, ij) => {
                if (el.url == url) {
                    logger.warn('Replacing existing tracked download for URL', url)
                    const waitFor = download.remove(null, url)
                    return true
                }
            })

            const filename = removeIllegalCharacters(decideFilename(name, url, type))
            if (!filename) {
                logger.error('Could not decide filename for download', { name, url, type, sourceKind: getDownloadSourceKind(url, type) })
                filenameCb(false)
                return
            }

            logger.info('Starting download', {
                url,
                filename,
                type,
                streamId,
                metaId,
                metaType,
                sourceKind
            })
            filenameCb(filename)

            const resolution = await resolveTargetDirectory(metaUrl, metaId, metaType)
            const downDir = resolution.targetDir
            let filePath = path.join(downDir, filename)
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

            if (type && hlsTypes.includes(type.toLowerCase())) {
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
                    logger.error('ffmpeg error', { url, filename, error: err, sourceKind: getDownloadSourceKind(url, type) })
                    if (idx > -1 && !files[idx].stopped)
                        files[idx].error = true
                    scheduleStateSave()
                }).on('close', (err, msg) => {
                    const idx = download.findIdx(url)
                    if (err)
                        logger.error('ffmpeg close event reported error', { url, filename, error: err, message: msg, sourceKind: getDownloadSourceKind(url, type) })
                    if (idx > -1 && err && !files[idx].stopped)
                        files[idx].error = true
                    if (err)
                        scheduleStateSave()
                }).on('exit', (err, msg) => {
                    const idx = download.findIdx(url)
                    if (err)
                        logger.error('ffmpeg exit event reported error', { url, filename, error: err, message: msg, sourceKind: getDownloadSourceKind(url, type) })
                    if (idx > -1 && err && !files[idx].stopped)
                        files[idx].error = true
                    if (err)
                        scheduleStateSave()
                })
                .on('end', (err, stdout, stderr) => {
                    const idx = download.findIdx(url)
                    if (idx > -1) {
                        const stats = fs.statSync(files[idx].filePath)
                        files[idx].completed = true
                        files[idx].error = false
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
                    error: false,
                    completed: false,
                    missingOnDisk: false,
                    stopped: false,
                    sourceKind,
                    meta: { url: metaUrl, type: metaType, id: metaId },
                    getCommand: () => { return command }
                })
                scheduleStateSave()
            } else {
                const writeStream = fs.createWriteStream(filePath)
                const abortController = new AbortController()
                let stream
                const req = {
                    abort: () => {
                        abortController.abort()
                        if (stream)
                            stream.destroy()
                    }
                }

                files.push({
                    filename,
                    url,
                    type,
                    streamId,
                    total,
                    current: 0,
                    time: Date.now(),
                    filePath,
                    error: false,
                    completed: false,
                    missingOnDisk: false,
                    stopped: false,
                    sourceKind,
                    meta: { url: metaUrl, type: metaType, id: metaId },
                    getReq: () => { return req },
                    closeStream: () => {
                        try {
                            writeStream.end()
                        } catch(e) {}
                        return true
                    }
                })
                scheduleStateSave()

                try {
                    stream = await openDownloadStream(url, abortController.signal)
                } catch (err) {
                    logger.error('Failed to open download stream', { url, filename, error: err, sourceKind: getDownloadSourceKind(url, type) })
                    const idx = download.findIdx(url)
                    if (idx > -1) {
                        files[idx].error = true
                        if (files[idx].closeStream)
                            files[idx].closeStream()
                    }
                    scheduleStateSave()
                    return
                }

                stream.pipe(writeStream).on('close', () => {
                    const idx = download.findIdx(url)
                    if (idx > -1) {
                        if (files[idx].current < files[idx].total && !files[idx].stopped) {
                            files[idx].error = true
                            logger.error('Download closed before completion', {
                                url,
                                filename,
                                current: files[idx].current,
                                total: files[idx].total,
                                sourceKind: getDownloadSourceKind(url, type)
                            })
                            if (files[idx].closeStream)
                                files[idx].closeStream()
                        } else if (!files[idx].stopped) {
                            const stats = fs.statSync(files[idx].filePath)
                            files[idx].completed = true
                            files[idx].error = false
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

                stream.on('data', chunk => {
                    const idx = download.findIdx(url)
                    if (idx > -1)
                        files[idx].current += chunk.length
                })

                stream.on('error', err => {
                    const idx = download.findIdx(url)
                    if (idx > -1 && !files[idx].stopped) {
                        files[idx].error = true
                        logger.error('Download stream errored', {
                            url,
                            filename,
                            current: files[idx].current,
                            total: files[idx].total,
                            error: err,
                            sourceKind: getDownloadSourceKind(url, type)
                        })
                        if (files[idx].closeStream)
                            files[idx].closeStream()
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
                removeEmptyParentFolder(file.filePath)
            } catch(e) {}
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
