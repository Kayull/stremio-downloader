const startServer = require('./server')
const download = require('./download')
const instanceLock = require('./instanceLock')
const logger = require('./logger')
const updateCheck = require('./updateCheck')

function createRuntime(options) {
	const runtimeOptions = Object.assign({
		exit: code => process.exit(code)
	}, options)

	let shuttingDown = false
	let httpServer = null
	let processHandlersAttached = false
	let currentRuntime = null

	function finishShutdown(exitCode) {
		download.cleanEnd(() => {
			instanceLock.release()
			runtimeOptions.exit(exitCode)
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

	function attachProcessHandlers() {
		if (processHandlersAttached)
			return

		processHandlersAttached = true
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
	}

	async function start() {
		currentRuntime = await startServer()
		updateCheck.begin()
		if (!currentRuntime.alreadyRunning)
			httpServer = currentRuntime.server
		return currentRuntime
	}

	return {
		start,
		shutdown,
		attachProcessHandlers,
		getRuntime: () => currentRuntime,
		isShuttingDown: () => shuttingDown
	}
}

module.exports = {
	createRuntime
}
