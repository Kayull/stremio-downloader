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

	const serverPort = await getPort({ port: 8189 })

	return new Promise(resolve => {
		const server = router.listen(serverPort, () => {
			const url = 'http://127.0.0.1:' + serverPort
			const urls = {
				baseUrl: url,
				downloaderUrl: url + '/downloader/',
				stremioUrl: url + '/web/app.strem.io/shell-v4.4/'
			}

			proxy.setEndpoint(url)

			api.setEndpoint(url)

			addonApi.setEndpoint(url + '/files-' + token)

			proxy.addProxy('https://app.strem.io/shell-v4.4/#/')

			logger.info('Stremio Downloader server running', urls)

			if (typeof cb === 'function')
				cb(urls)

			resolve({
				server,
				router,
				token,
				...urls
			})
		})
	})
}

module.exports = init
