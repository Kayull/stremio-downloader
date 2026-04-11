const download = require('./download')
const downloadDir = require('./downloadDir')
const tokenApi = require('./tokenDir')
const logger = require('./logger')
const systemShell = require('./systemShell')
const { getDownloadSourceKind } = require('./sourceKind')

let endpoint

function sendJson(res, statusCode, payload) {
	res.statusCode = statusCode
	res.setHeader('Content-Type', 'application/json; charset=utf-8')
	res.end(JSON.stringify(payload))
}

function sendText(res, statusCode, payload) {
	res.statusCode = statusCode
	res.setHeader('Content-Type', 'text/plain; charset=utf-8')
	res.end(payload)
}

function getStremioUrl() {
	return endpoint + '/web/app.strem.io/shell-v4.4/'
}

function getAddonInstallUrl() {
	return endpoint.replace('http:', 'stremio:') + '/addon-' + tokenApi.get() + '/manifest.json'
}

function getPlayUrl(file) {
	if (!file || file.missingOnDisk || !file.filePath)
		return ''

	const publicPath = download.getPublicPath(file)
	if (!publicPath)
		return ''

	return endpoint + '/files-' + tokenApi.get() + '/' + publicPath
}

module.exports = {
	setEndpoint: str => {
		endpoint = str
	},
	router: async (req, res) => {
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
						sendText(res, 200, filename)
					} else {
						sendText(res, 500, 'error')
					}
				}, query.metaUrl, query.metaId, query.metaType)
			} else {
				sendText(res, 500, 'error')
			}
		} else if (query.method == 'remove-download') {
			if (query.url && query.filename) {
				download.remove(query.filename, query.url)
				sendJson(res, 200, { done: true })
			} else {
				sendText(res, 500, 'error')
			}
		} else if (query.method == 'load-stremio') {
			sendJson(res, 200, { done: true, url: getStremioUrl() })
		} else if (query.method == 'open-folder') {
			const downDir = downloadDir.get()
			logger.info('Opening download folder', downDir)
			try {
				await systemShell.openPath(downDir)
				sendJson(res, 200, { done: true })
			} catch (err) {
				logger.error('open-folder failed', downDir, err)
				sendJson(res, 500, { done: false, error: err.code || 'open_failed', message: err.message || 'Could not open the download folder.' })
			}
		} else if (query.method == 'change-folder') {
			try {
				const folder = await systemShell.pickFolder()
				if (!folder) {
					sendJson(res, 200, { done: false, error: 'cancelled', message: 'Folder selection was cancelled.' })
					return
				}

				logger.info('Changing download folder to', folder)
				downloadDir.set(folder)
				sendJson(res, 200, { done: true, folder })
			} catch (err) {
				logger.warn('change-folder failed', err)
				sendJson(res, 200, {
					done: false,
					error: err.code || 'picker_failed',
					message: err.message || 'Could not open the folder picker.'
				})
			}
		} else if (query.method == 'play-video') {
			if (query.url) {
				const file = download.find(query.url)
				const playUrl = getPlayUrl(file)
				if (!playUrl) {
					sendText(res, 404, 'missing')
					return
				}
				sendJson(res, 200, { done: true, url: playUrl })
			} else {
				sendText(res, 500, 'error')
			}
		} else if (query.method == 'open-location') {
			if (query.url) {
				const file = download.find(query.url)
				if (!file || file.missingOnDisk || !file.filePath) {
					sendText(res, 404, 'missing')
					return
				}
				logger.info('Revealing downloaded file', (file || {}).filePath || query.url)
				try {
					await systemShell.revealPath(file.filePath)
					sendJson(res, 200, { done: true })
				} catch (err) {
					logger.error('open-location failed', file.filePath, err)
					sendJson(res, 500, { done: false, error: err.code || 'reveal_failed', message: err.message || 'Could not reveal the downloaded file.' })
				}
			} else {
				sendText(res, 500, 'error')
			}
		} else if (query.method == 'restart-download') {
			if (query.url) {
				const file = download.find(query.url)
				if (!file) {
					sendJson(res, 404, { done: false, error: 'missing', message: 'The requested download could not be found.' })
					return
				}
				logger.info('Restarting download', query.url, (file || {}).filename || '')

				let name = file.filename.split('.')

				name.pop()

				name = name.join('.')

				download.get(name, file.url, file.streamId, () => {}, file.meta.url, file.meta.id, file.meta.type)

				sendJson(res, 200, { done: true })
			} else {
				sendText(res, 500, 'error')
			}
		} else if (query.method == 'stop-download') {
			if (query.url && query.filename) {
				logger.warn('Stopping download', query.url, query.filename)
				download.stop(query.filename, query.url)
				sendJson(res, 200, { done: true })
			} else {
				sendText(res, 500, 'error')
			}
		} else if (query.method == 'install-addon') {
			const addonUrl = getAddonInstallUrl()
			logger.info('Opening addon install URL', addonUrl)
			sendJson(res, 200, { done: true, url: addonUrl })
		} else if (query.method == 'files') {
			const files = download.list().map(file => {
				if (file.publicPath)
					file.playUrl = endpoint + '/files-' + tokenApi.get() + '/' + file.publicPath
				return file
			})
			sendJson(res, 200, files)
		} else if (query.method == 'download-settings') {
			sendJson(res, 200, downloadDir.getSettings())
		} else if (query.method == 'download-folder') {
			sendText(res, 200, downloadDir.get())
		} else if (query.method == 'set-use-show-subfolders') {
			downloadDir.setUseShowSubfolders(query.enabled === 'true')
			sendJson(res, 200, { done: true })
		} else if (query.method == 'logs') {
			sendText(res, 200, logger.list())
		} else if (query.method == 'clear-logs') {
			logger.warn('Clearing application logs')
			logger.clear()
			sendJson(res, 200, { done: true })
		} else if (query.method == 'open-log-location') {
			logger.info('Revealing log file', logger.getPath())
			try {
				await systemShell.revealPath(logger.getPath())
				sendJson(res, 200, { done: true })
			} catch (err) {
				logger.error('open-log-location failed', logger.getPath(), err)
				sendJson(res, 500, { done: false, error: err.code || 'reveal_failed', message: err.message || 'Could not reveal the log file.' })
			}
		} else {
			logger.error('Unhandled API method', query.method || 'missing')
			sendText(res, 500, 'error')
		}
	}
}
