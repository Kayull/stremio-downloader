const startServer = require('../lib/server')
const download = require('../lib/download')
const instanceLock = require('../lib/instanceLock')
const logger = require('../lib/logger')
const systemShell = require('../lib/systemShell')

const shouldOpenBrowser = !process.argv.includes('--no-open') && process.env.OPEN_BROWSER !== '0'

let shuttingDown = false
let httpServer = null

function finishShutdown(exitCode) {
	download.cleanEnd(() => {
		instanceLock.release()
		process.exit(exitCode)
	})
}

function shutdown(exitCode, reason, err) {
	if (shuttingDown)
		return

	shuttingDown = true
	logger.info('Shutting down Stremio Downloader', { reason })
	if (err)
		logger.error('Shutdown triggered by error', err)

	const timeout = setTimeout(() => {
		logger.warn('Forcing shutdown after timeout')
		finishShutdown(exitCode)
	}, 5000)

	if (httpServer) {
		httpServer.close(() => {
			clearTimeout(timeout)
			finishShutdown(exitCode)
		})
		return
	}

	clearTimeout(timeout)
	finishShutdown(exitCode)
}

process.on('SIGINT', () => shutdown(0, 'SIGINT'))
process.on('SIGTERM', () => shutdown(0, 'SIGTERM'))

process.on('uncaughtException', err => {
	logger.error('Uncaught exception', err)
	shutdown(1, 'uncaughtException', err)
})

process.on('unhandledRejection', err => {
	logger.error('Unhandled rejection', err)
	shutdown(1, 'unhandledRejection', err)
})

;(async () => {
	const runtime = await startServer()
	if (!runtime.alreadyRunning)
		httpServer = runtime.server

	if (runtime.alreadyRunning) {
		console.log('Stremio Downloader already running at: ' + runtime.baseUrl)
		logger.info('Using existing Stremio Downloader runtime', {
			baseUrl: runtime.baseUrl,
			downloaderUrl: runtime.downloaderUrl,
			autoOpen: shouldOpenBrowser
		})
	} else {
		console.log('Stremio Downloader running at: ' + runtime.baseUrl)
		logger.info('CLI runtime ready', {
			baseUrl: runtime.baseUrl,
			downloaderUrl: runtime.downloaderUrl,
			autoOpen: shouldOpenBrowser
		})
	}

	if (!shouldOpenBrowser) {
		if (runtime.alreadyRunning)
			process.exit(0)
		return
	}

	try {
		await systemShell.openUrl(runtime.baseUrl)
		logger.info('Opened downloader in default browser', runtime.baseUrl)
	} catch (err) {
		logger.warn('Failed to open browser automatically', err)
		console.error('Could not open the browser automatically. Open this URL manually:', runtime.baseUrl)
	}

	if (runtime.alreadyRunning)
		process.exit(0)
})().catch(err => {
	logger.error('Failed to start Stremio Downloader', err)
	console.error(err)
	process.exit(1)
})
