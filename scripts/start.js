const logger = require('../lib/logger')
const { createRuntime } = require('../lib/runtime')
const systemShell = require('../lib/systemShell')

const shouldOpenBrowser = !process.argv.includes('--no-open') && process.env.OPEN_BROWSER !== '0'

const appRuntime = createRuntime()
appRuntime.attachProcessHandlers()

;(async () => {
	const runtime = await appRuntime.start()

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
