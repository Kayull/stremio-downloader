const express = require('express')
const cors = require('cors')
const path = require('path')
const proxy = require('./proxy')
const api = require('./api')
const downloadDir = require('./downloadDir')
const tokenApi = require('./tokenDir')
const addonApi = require('./addon')
const logger = require('./logger')

async function init(cb) {

	const { default: getPort } = await import('get-port')

	const router = express()
	
	router.use(cors())

	proxy.createProxyServer(router)

	router.use('/assets', express.static(path.join(__dirname, '..', 'assets')))

	router.use('/downloader', express.static(path.join(__dirname, '..', 'downloader')))

	router.use('/vendor/jquery', express.static(path.join(__dirname, '..', 'node_modules', 'jquery', 'dist')))

	router.use('/vendor/mdl', express.static(path.join(__dirname, '..', 'node_modules', 'material-design-lite')))

	router.use('/api', api.router)

	const token = tokenApi.get()

	router.use('/files-'+token, express.static(downloadDir.get()))

	router.use('/addon-'+token, addonApi.handler)

	const serverPort = await getPort({ port: 8189 })

	const server = router.listen(serverPort, () => {

		const url = 'http://127.0.0.1:' + serverPort

		proxy.setEndpoint(url)

		api.setEndpoint(url)

		addonApi.setEndpoint(url + '/files-' + token)

		proxy.addProxy('https://app.strem.io/shell-v4.4/#/')

		const downloaderUrl = url + '/downloader/'

		console.log('Stremio Downloader server running at: ' + downloaderUrl)
		logger.info('Stremio Downloader server running', downloaderUrl)

		cb(url)

	})

}

module.exports = init
