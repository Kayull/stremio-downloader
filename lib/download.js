const mime = require('mime-types')
const fs = require('fs')
const path = require('path')
const { Readable } = require('stream')
const downloadDir = require('./downloadDir')
const filelist = require('./fileList')
const metaDir = require('./metaDir')
const ffmpeg = require('./ffmpeg')
const logger = require('./logger')
const { getDownloadSourceKind } = require('./sourceKind')
const files = filelist.get()
const isWin = process.platform === 'win32'

function refreshFilePresenceState(file) {
    const fileExists = file.filePath && fs.existsSync(file.filePath)

    if (file.finished) {
        if (!fileExists) {
            const wasMissing = !!file.missingOnDisk
            file.missingOnDisk = true
            file.error = false
            if (!wasMissing)
                logger.warn('Finished download is missing on disk', file.filename || file.url || 'unknown')
        } else {
            if (file.missingOnDisk)
                logger.info('Missing finished download is available on disk again', file.filename || file.url || 'unknown')
            file.missingOnDisk = false
        }
        return
    }

    file.missingOnDisk = false
}

function recoverInterruptedStoredDownload(file) {
    refreshFilePresenceState(file)

    if (file.finished)
        return

    const hasActiveRuntimeHandle = typeof file.getReq === 'function' || typeof file.getCommand === 'function'

    if (!file.error && !file.stopped && !hasActiveRuntimeHandle) {
        file.error = true
        logger.warn('Marking interrupted unfinished download as errored on startup', file.filename || file.url || 'unknown')
    }
}

files.forEach(recoverInterruptedStoredDownload)
filelist.set(files)
function saveFiles() {
    saveFilesTimer = null
    const waitFor = filelist.set(files)
    saveFilesTimer = setTimeout(saveFiles, 60 * 60 * 1000)
}
// no need to save on app start
let saveFilesTimer = setTimeout(saveFiles, 60 * 60 * 1000)
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
function removeIllegalCharacters(name) {

    if (!name)
        return false

    if (isWin) {
        // illegal characters on windows are: < > : " / \ | ? *
        return name.replace(/\<|\>|\:|\"|\/|\\|\||\?|\*/g,' ').replace(/  +/g, ' ')
    } else {
        // illegal characters on Linux / OSX are: /
        return name.split('/').join(' ').replace(/  +/g, ' ')
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
                sourceKind: getDownloadSourceKind(url, type)
            })
            filenameCb(filename)

            const downDir = downloadDir.get()
            let filePath = path.join(downDir, filename)
            filePath = checkFilePath(filePath)

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
                }).on('close', (err, msg) => {
                    const idx = download.findIdx(url)
                    if (err)
                        logger.error('ffmpeg close event reported error', { url, filename, error: err, message: msg, sourceKind: getDownloadSourceKind(url, type) })
                    if (idx > -1 && err && !files[idx].stopped)
                        files[idx].error = true
                }).on('exit', (err, msg) => {
                    const idx = download.findIdx(url)
                    if (err)
                        logger.error('ffmpeg exit event reported error', { url, filename, error: err, message: msg, sourceKind: getDownloadSourceKind(url, type) })
                    if (idx > -1 && err && !files[idx].stopped)
                        files[idx].error = true
                })
                .on('end', (err, stdout, stderr) => {
                    const idx = download.findIdx(url)
                    if (idx > -1) {
                        files[idx].finished = true
                        files[idx].missingOnDisk = false
                        const stats = fs.statSync(files[idx].filePath)
                        files[idx].total = (stats || {}).size || 0
                        logger.info('Completed HLS download', {
                            url,
                            filename,
                            filePath: files[idx].filePath,
                            size: files[idx].total,
                            sourceKind: getDownloadSourceKind(url, type)
                        })
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
                    finished: false,
                    missingOnDisk: false,
                    stopped: false,
                    meta: { url: metaUrl, type: metaType, id: metaId },
                    getCommand: () => { return command }
                })
            } else {
                const writeStream = fs.createWriteStream(filePath)
                const abortController = new AbortController()
                let stream

                try {
                    stream = await openDownloadStream(url, abortController.signal)
                } catch (err) {
                    logger.error('Failed to open download stream', { url, filename, error: err, sourceKind: getDownloadSourceKind(url, type) })
                    files.push({
                        filename,
                        url,
                        type,
                        streamId,
                        total,
                        current: 0,
                        time: Date.now(),
                        filePath,
                        error: true,
                        finished: false,
                        missingOnDisk: false,
                        stopped: false,
                        meta: { url: metaUrl, type: metaType, id: metaId },
                        getReq: () => ({
                            abort: () => abortController.abort()
                        }),
                        closeStream: () => {
                            try {
                                writeStream.end()
                            } catch(e) {}
                            return true
                        }
                    })
                    return
                }

                const req = {
                    abort: () => {
                        abortController.abort()
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
                    finished: false,
                    missingOnDisk: false,
                    stopped: false,
                    meta: { url: metaUrl, type: metaType, id: metaId },
                    getReq: () => { return req },
                    closeStream: () => {
                        try {
                            writeStream.end()
                        } catch(e) {}
                        return true
                    }
                })

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
                            files[idx].finished = true
                            files[idx].missingOnDisk = false
                            logger.info('Completed direct download', {
                                url,
                                filename,
                                filePath: files[idx].filePath,
                                size: files[idx].current,
                                sourceKind: getDownloadSourceKind(url, type)
                            })
                        }
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
    cleanEnd: cb => {
        if (saveFilesTimer)
            clearTimeout(saveFilesTimer)
        filelist.set(files)
        logger.info('Persisted download list on app shutdown', { count: files.length })
        cb()
    }
}
module.exports = download
