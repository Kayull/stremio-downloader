const { cleanupGeneratedArtifacts } = require('./cleanup-generated')
const {
	buildEnvironment,
	ensureCargoAvailable,
	ensureRustTargets,
	parseTargetArg,
	resolveBuildTarget,
	runNodeScript,
	runTauriCommand
} = require('./tauri-cli-utils')

function run() {
	const extraArgs = process.argv.slice(2)
	const requestedTarget = resolveBuildTarget(extraArgs)
	const buildArgs = parseTargetArg(extraArgs) || !requestedTarget ? extraArgs : ['--target', requestedTarget].concat(extraArgs)
	const env = buildEnvironment(requestedTarget)

	ensureCargoAvailable('builds')
	ensureRustTargets(requestedTarget)
	runNodeScript('scripts/sync-version.js', [], env)
	runNodeScript('scripts/stage-desktop-runtime.js', [], env)
	runNodeScript('scripts/prepare-node-sidecar.js', [], env)
	runNodeScript('scripts/sanitize-tauri-target-cache.js', [], env)

	try {
		runTauriCommand('build', buildArgs, env)
		runNodeScript('scripts/finalize-tauri-build.js', [], env)
		runNodeScript('scripts/package-windows-release.js', [], env)
	} finally {
		cleanupGeneratedArtifacts()
	}
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
