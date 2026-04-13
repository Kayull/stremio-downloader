const {
	buildEnvironment,
	ensureCargoAvailable,
	parseTargetArg,
	runNodeScript,
	runTauriCommand
} = require('./tauri-cli-utils')

function resolveDevTarget(extraArgs) {
	return parseTargetArg(extraArgs) || process.env.TAURI_TARGET_TRIPLE || null
}

function run() {
	const extraArgs = process.argv.slice(2)
	const requestedTarget = resolveDevTarget(extraArgs)
	const env = buildEnvironment(requestedTarget)

	ensureCargoAvailable('development runs')
	runNodeScript('scripts/sanitize-tauri-target-cache.js', [], env)
	runTauriCommand('dev', extraArgs, env)
}

try {
	run()
} catch (err) {
	if (err && err.isUserFacing) {
		console.error(err.message || String(err))
		process.exit(1)
	}
	throw err
}
