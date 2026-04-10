const mime = require('mime-types')
const fs = require('fs')
const path = require('path')
const { Readable } = require('stream')
const downloadDir = require('./downloadDir')
const filelist = require('./fileList')
const metaDir = require('./metaDir')
const ffmpeg = require('./ffmpeg')
const logger = require('./logger')
const files = filelist.get()
const isWin = process.platform === 'win32'
files.forEach((el, ij) => {
    if (!el.error && (!el.finished || !el.filePath || !fs.existsSync(el.filePath))) {
        files[ij].error = true
        logger.warn('Marking stale download as errored on startup', el.filename || el.url || 'unknown')
    }
})
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

async function fetchHeaders(url) {
    const response = await fetch(url, {
        method: 'HEAD',
        redirect: 'follow'
    })

    if (!response.ok)
        throw new Error('Request failed with status ' + response.status)

    const headers = {
        total: response.headers.get('content-length'),
        type: response.headers.get('content-type')
    }
    logger.info('Fetched download headers', { url, total: headers.total, type: headers.type })
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

    logger.info('Opened download stream', { url, status: response.status, type: response.headers.get('content-type') })
    return Readable.fromWeb(response.body)
}
const download = {
    list: () => {
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
                logger.error('Failed to fetch headers for download', url, err)
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
                logger.error('Could not decide filename for download', { name, url, type })
                filenameCb(false)
                return
            }

            logger.info('Starting download', { url, filename, type, streamId, metaId, metaType })
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
                    logger.info('Spawned ffmpeg process', commandLine)
                    console.log('Spawned Ffmpeg with command: ', commandLine);
                }).on('error', (err) => {
                    const idx = download.findIdx(url)
                    logger.error('ffmpeg error', { url, filename, error: err })
                    if (idx > -1 && !files[idx].stopped)
                        files[idx].error = true
                }).on('close', (err, msg) => {
                    const idx = download.findIdx(url)
                    if (err)
                        logger.error('ffmpeg close event reported error', { url, filename, error: err, message: msg })
                    if (idx > -1 && err && !files[idx].stopped)
                        files[idx].error = true
                }).on('exit', (err, msg) => {
                    const idx = download.findIdx(url)
                    if (err)
                        logger.error('ffmpeg exit event reported error', { url, filename, error: err, message: msg })
                    if (idx > -1 && err && !files[idx].stopped)
                        files[idx].error = true
                })
                .on('end', (err, stdout, stderr) => {
                    const idx = download.findIdx(url)
                    if (idx > -1) {
                        files[idx].finished = true
                        const stats = fs.statSync(files[idx].filePath)
                        files[idx].total = (stats || {}).size || 0
                        logger.info('Completed HLS download', { url, filename, filePath: files[idx].filePath, size: files[idx].total })
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
                    logger.error('Failed to open download stream', { url, filename, error: err })
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
                                total: files[idx].total
                            })
                            if (files[idx].closeStream)
                                files[idx].closeStream()
                        } else if (!files[idx].stopped) {
                            files[idx].finished = true
                            logger.info('Completed direct download', {
                                url,
                                filename,
                                filePath: files[idx].filePath,
                                size: files[idx].current
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
                            error: err
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
