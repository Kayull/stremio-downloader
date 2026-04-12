const express = require('express')
const cors = require('cors')
const fs = require('fs')
const path = require('path')
const proxy = require('./proxy')
const api = require('./api')
const download = require('./download')
const tokenApi = require('./tokenDir')
const addonApi = require('./addon')
const logger = require('./logger')
const instanceLock = require('./instanceLock')
const userSettings = require('./userSettings')

const DEFAULT_SERVER_PORT = 8189
const SERVER_PORT_CANDIDATES = [8189, 8190, 8191, 8192, 8193]

function isValidPort(port) {
	return Number.isInteger(port) && port > 0 && port <= 65535
}

function buildUrls(serverPort) {
	const baseUrl = 'http://127.0.0.1:' + serverPort

	return {
		baseUrl,
		downloaderUrl: baseUrl + '/downloader/',
		stremioUrl: baseUrl + '/web/app.strem.io/shell-v4.4/'
	}
}

function getPreferredPorts() {
	return SERVER_PORT_CANDIDATES.slice()
}

function clearLegacyServerPortSetting() {
	userSettings.update(settings => {
		if (!Object.prototype.hasOwnProperty.call(settings, 'serverPort'))
			return settings

		const nextSettings = Object.assign({}, settings)
		delete nextSettings.serverPort
		return nextSettings
	})
}

async function isDownloaderReachable(urls) {
	const controller = new AbortController()
	const timeout = setTimeout(() => {
		controller.abort()
	}, 800)

	try {
		const settingsResponse = await fetch(urls.baseUrl + '/api?method=download-settings', {
			signal: controller.signal
		})
		if (!settingsResponse.ok)
			return false

		const payload = await settingsResponse.json()
		if (!payload || typeof payload.folder !== 'string' || typeof payload.useShowSubfolders !== 'boolean')
			return false

		const downloaderResponse = await fetch(urls.downloaderUrl, {
			signal: controller.signal
		})
		if (!downloaderResponse.ok)
			return false

		const body = await downloaderResponse.text()
		return body.includes('Stremio Downloader')
	} catch (err) {
		return false
	} finally {
		clearTimeout(timeout)
	}
}

function getUrlsFromInstanceInfo(info) {
	if (!info || typeof info !== 'object')
		return buildUrls(DEFAULT_SERVER_PORT)

	if (info.baseUrl && info.downloaderUrl && info.stremioUrl)
		return {
			baseUrl: info.baseUrl,
			downloaderUrl: info.downloaderUrl,
			stremioUrl: info.stremioUrl
		}

	const port = Number(info.port)
	return buildUrls(isValidPort(port) ? port : DEFAULT_SERVER_PORT)
}

function getMountedFileId(reqPath) {
	const parts = String(reqPath || '')
		.split('/')
		.map(part => part.trim())
		.filter(Boolean)

	return parts[0] || ''
}

function createTrackedFileHandler() {
	return (req, res) => {
		if (!['GET', 'HEAD'].includes(req.method)) {
			res.statusCode = 405
			res.end('Method Not Allowed')
			return
		}

		const fileId = getMountedFileId(req.path)
		if (!fileId) {
			res.statusCode = 404
			res.end('Not Found')
			return
		}

		const file = download.findByPublicId(fileId)
		if (!file || !file.filePath || file.missingOnDisk || !fs.existsSync(file.filePath)) {
			res.statusCode = 404
			res.end('Not Found')
			return
		}

		res.setHeader('Cache-Control', 'no-cache')
		res.sendFile(file.filePath)
	}
}

async function init(cb) {
	const { default: getPort } = await import('get-port')
	clearLegacyServerPortSetting()

	const router = express()
	
	router.disable('x-powered-by')
	router.use(cors())

	proxy.createProxyServer(router)

	router.get('/', (req, res) => {
		res.redirect('/downloader/')
	})

	router.use('/assets', express.static(path.join(__dirname, '..', 'assets')))

	router.use('/downloader', express.static(path.join(__dirname, '..', 'downloader')))

	router.use('/vendor/jquery', express.static(path.join(__dirname, '..', 'node_modules', 'jquery', 'dist')))

	router.use('/api', api.router)

	const token = tokenApi.get()

	router.use('/files-'+token, createTrackedFileHandler())

	router.use('/addon-'+token, addonApi.handler)

	const lock = instanceLock.acquire()
	if (!lock.acquired) {
		const urls = getUrlsFromInstanceInfo(lock.info)
		if (await isDownloaderReachable(urls)) {
			logger.info('Detected existing Stremio Downloader instance', {
				pid: lock.info && lock.info.pid,
				status: lock.info && lock.info.status,
				...urls
			})
			return {
				server: null,
				router: null,
				token,
				alreadyRunning: true,
				...urls
			}
		}

		logger.warn('Ignoring existing instance lock because the local downloader UI is not reachable', {
			pid: lock.info && lock.info.pid,
			status: lock.info && lock.info.status,
			...urls
		})
	}

	try {
		const preferredPorts = getPreferredPorts()
		for (const preferredPort of preferredPorts) {
			const existingUrls = buildUrls(preferredPort)
			if (await isDownloaderReachable(existingUrls)) {
				instanceLock.release()
				logger.info('Detected existing Stremio Downloader without lock file', existingUrls)
				return {
					server: null,
					router: null,
					token,
					alreadyRunning: true,
					...existingUrls
				}
			}
		}

		const serverPort = await getPort({ port: preferredPorts })
		const urls = buildUrls(serverPort)

		if (!preferredPorts.includes(serverPort)) {
			logger.warn('Preferred server ports unavailable, using dynamic port', {
				preferredPorts,
				serverPort
			})
		} else if (serverPort !== preferredPorts[0]) {
			logger.warn('Primary server port unavailable, using fallback port', {
				preferredPorts,
				serverPort
			})
		}

		instanceLock.update({
			port: serverPort,
			status: 'starting',
			...urls
		})

		return await new Promise((resolve, reject) => {
			const server = router.listen(serverPort)

			server.once('error', err => {
				instanceLock.release()
				reject(err)
			})

			server.once('listening', () => {
				proxy.setEndpoint(urls.baseUrl)

				api.setEndpoint(urls.baseUrl)

				addonApi.setEndpoint(urls.baseUrl + '/files-' + token)

				proxy.addProxy('https://app.strem.io/shell-v4.4/#/')
				instanceLock.update({
					port: serverPort,
					status: 'ready',
					...urls
				})

				logger.info('Stremio Downloader server running', urls)

				if (typeof cb === 'function')
					cb(urls)

				resolve({
					server,
					router,
					token,
					alreadyRunning: false,
					...urls
				})
			})
		})
	} catch (err) {
		instanceLock.release()
		throw err
	}
}

module.exports = init
