const { createRuntime } = require('../lib/runtime')
const logger = require('../lib/logger')

const PARENT_WATCH_INTERVAL_MS = 2000

function startParentWatch(appRuntime) {
	const expectedParentPid = Number(process.ppid)
	if (!Number.isInteger(expectedParentPid) || expectedParentPid <= 1)
		return

	const timer = setInterval(() => {
		if (appRuntime.isShuttingDown())
			return

		const currentParentPid = Number(process.ppid)
		if (currentParentPid === expectedParentPid)
			return

		logger.warn('Desktop sidecar lost parent process; shutting down', {
			expectedParentPid,
			currentParentPid
		})
		appRuntime.shutdown(0, 'parent_process_gone')
	}, PARENT_WATCH_INTERVAL_MS)

	if (typeof timer.unref === 'function')
		timer.unref()
}

function writeReady(runtime) {
	process.stdout.write(JSON.stringify({
		event: 'ready',
		baseUrl: runtime.baseUrl,
		downloaderUrl: runtime.downloaderUrl,
		stremioUrl: runtime.stremioUrl,
		alreadyRunning: runtime.alreadyRunning
	}) + '\n')
}

const appRuntime = createRuntime()
appRuntime.attachProcessHandlers()
startParentWatch(appRuntime)

;(async () => {
	const runtime = await appRuntime.start()
	writeReady(runtime)

	if (runtime.alreadyRunning)
		process.exit(0)
})().catch(err => {
	logger.error('Failed to start desktop sidecar', err)
	process.stderr.write(String((err && err.stack) || err || 'Unknown error') + '\n')
	process.exit(1)
})
