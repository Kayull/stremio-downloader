const { createRuntime } = require('../lib/runtime')
const logger = require('../lib/logger')

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
