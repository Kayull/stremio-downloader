const download = require('./download')
const { shell, dialog } = require('electron')
const events = require('./events')
const downloadDir = require('./downloadDir')
const tokenApi = require('./tokenDir')
const logger = require('./logger')
const { getDownloadSourceKind } = require('./sourceKind')

let endpoint


function openPath(targetPath) {
	shell.openPath(targetPath).then(errorMessage => {
		if (errorMessage) {
			logger.error('openPath failed for', targetPath, errorMessage)
			console.error(errorMessage)
		}
	}).catch(err => {
		logger.error('openPath threw for', targetPath, err)
		console.error(err)
	})
}

module.exports = {
	setEndpoint: str => {
		endpoint = str
	},
	router: (req, res) => {
		const parsed = new URL(req.url, 'http://127.0.0.1')
		const query = Object.fromEntries(parsed.searchParams.entries())
		if (query.method == 'add-download') {
			if (query.url) {
				let url = query.url
				if (url.startsWith('http://127.0.0.1:11470/')) {
					if (url.endsWith('/hls.m3u8'))
						url = url.replace('/hls.m3u8', '/')
				}
				logger.info('Received add-download request', {
					url,
					title: query.title || '',
					streamId: query.streamId || '',
					sourceKind: getDownloadSourceKind(url)
				})
				download.get(query.title, url, query.streamId, filename => {
					if (filename) {
						res.statusCode = 200
						res.end(filename)
					} else {
						res.statusCode = 500
						res.end('error')
					}
				}, query.metaUrl, query.metaId, query.metaType)
			} else {
				res.statusCode = 500
		        res.end('error')
			}
		} else if (query.method == 'remove-download') {
			if (query.url && query.filename) {
				download.remove(query.filename, query.url)
				res.statusCode = 200
				res.end(JSON.stringify({ done: true }))
			} else {
				res.statusCode = 500
		        res.end('error')
			}
		} else if (query.method == 'load-stremio') {
			logger.info('Opening Stremio web shell')
			shell.openExternal(endpoint + '/web/app.strem.io/shell-v4.4/')
			res.statusCode = 200
			res.end(JSON.stringify({ done: true }))
		} else if (query.method == 'focus-window') {
			events.emit('focus-window')
			res.statusCode = 200
			res.end(JSON.stringify({ done: true }))
		} else if (query.method == 'open-folder') {

			const downDir = downloadDir.get()
			logger.info('Opening download folder', downDir)

			openPath(downDir)

			res.statusCode = 200
			res.end(JSON.stringify({ done: true }))			

		} else if (query.method == 'change-folder') {

			let options = {
				properties: ['openDirectory']
			}

			dialog.showOpenDialog(options).then(result => {
				const dir = (result || {}).filePaths || []
				if (dir[0]) {
					logger.info('Changing download folder to', dir[0])
					downloadDir.set(dir[0])
				}
			}).catch(err => {
				logger.error('change-folder dialog failed', err)
				console.error(err)
			})

			res.statusCode = 200
			res.end(JSON.stringify({ done: true }))

		} else if (query.method == 'play-video') {
			if (query.url) {
				const file = download.find(query.url)
				if (!file || file.missingOnDisk || !file.filePath) {
					res.statusCode = 404
			        res.end('missing')
					return
				}
				logger.info('Opening downloaded file', (file || {}).filePath || query.url)

				openPath(file.filePath)

				res.statusCode = 200
				res.end(JSON.stringify({ done: true }))
			} else {
				res.statusCode = 500
		        res.end('error')
			}
		} else if (query.method == 'open-location') {

			if (query.url) {
				const file = download.find(query.url)
				if (!file || file.missingOnDisk || !file.filePath) {
					res.statusCode = 404
			        res.end('missing')
					return
				}
				logger.info('Revealing downloaded file', (file || {}).filePath || query.url)

				shell.showItemInFolder(file.filePath)

				res.statusCode = 200
				res.end(JSON.stringify({ done: true }))
			} else {
				res.statusCode = 500
		        res.end('error')
			}			

		} else if (query.method == 'restart-download') {

			if (query.url) {
				const file = download.find(query.url)
				logger.info('Restarting download', query.url, (file || {}).filename || '')

				let name = file.filename.split('.')

				name.pop()

				name = name.join('.')

				download.get(name, file.url, file.streamId, () => {}, file.meta.url, file.meta.id, file.meta.type)

				res.statusCode = 200
				res.end(JSON.stringify({ done: true }))
			} else {
				res.statusCode = 500
		        res.end('error')
			}			

		} else if (query.method == 'stop-download') {

			if (query.url && query.filename) {
				logger.warn('Stopping download', query.url, query.filename)
				download.stop(query.filename, query.url)
				res.statusCode = 200
				res.end(JSON.stringify({ done: true }))
			} else {
				res.statusCode = 500
		        res.end('error')
			}			

		} else if (query.method == 'install-addon') {
			const addonUrl = endpoint.replace('http:', 'stremio:') + '/addon-' + tokenApi.get() + '/manifest.json'
			logger.info('Opening addon install URL', addonUrl)
			shell.openExternal(addonUrl)
			res.statusCode = 200
			res.end(JSON.stringify({ done: true }))
		} else if (query.method == 'files') {
			res.statusCode = 200
			res.end(JSON.stringify(download.list()))
		} else if (query.method == 'download-settings') {
			res.statusCode = 200
			res.end(JSON.stringify(downloadDir.getSettings()))
		} else if (query.method == 'download-folder') {
			res.statusCode = 200
			res.end(downloadDir.get())
		} else if (query.method == 'set-use-show-subfolders') {
			downloadDir.setUseShowSubfolders(query.enabled === 'true')
			res.statusCode = 200
			res.end(JSON.stringify({ done: true }))
		} else if (query.method == 'logs') {
			res.statusCode = 200
			res.end(logger.list())
		} else if (query.method == 'clear-logs') {
			logger.warn('Clearing application logs')
			logger.clear()
			res.statusCode = 200
			res.end(JSON.stringify({ done: true }))
		} else if (query.method == 'open-log-location') {
			logger.info('Revealing log file', logger.getPath())
			shell.showItemInFolder(logger.getPath())
			res.statusCode = 200
			res.end(JSON.stringify({ done: true }))
		} else {
			logger.error('Unhandled API method', query.method || 'missing')
			res.statusCode = 500
	        res.end('error')
		}
	}
}
