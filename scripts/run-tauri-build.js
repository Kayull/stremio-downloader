const fs = require('fs')
const { execFileSync } = require('child_process')
const path = require('path')
const { repoRoot } = require('./version-utils')
const { cleanupGeneratedArtifacts } = require('./cleanup-generated')

const UNIVERSAL_MAC_TARGET = 'universal-apple-darwin'

function getNodeScriptPath(relativePath) {
	return path.join(repoRoot, relativePath)
}

function getTauriCommandPath() {
	if (process.platform === 'win32') {
		return path.join(
			repoRoot,
			'node_modules',
			'@tauri-apps',
			'cli',
			'tauri.js'
		)
	}

	return path.join(
		repoRoot,
		'node_modules',
		'.bin',
		'tauri'
	)
}

function runNodeScript(relativePath, extraArgs, env) {
	execFileSync(process.execPath, [getNodeScriptPath(relativePath)].concat(extraArgs || []), {
		cwd: repoRoot,
		stdio: 'inherit',
		env: env || process.env
	})
}

function runTauriBuild(extraArgs, env) {
	const tauriArgs = ['build'].concat(extraArgs || [])

	if (process.platform === 'win32') {
		execFileSync(process.execPath, [getTauriCommandPath()].concat(tauriArgs), {
			cwd: repoRoot,
			stdio: 'inherit',
			env: env || process.env
		})
		return
	}

	execFileSync(getTauriCommandPath(), tauriArgs, {
		cwd: repoRoot,
		stdio: 'inherit',
		env: env || process.env
	})
}

function parseTargetArg(args) {
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index]
		if (arg === '--target')
			return args[index + 1] || null
		if (arg.startsWith('--target='))
			return arg.slice('--target='.length)
	}

	return null
}

function getHostDarwinTriple() {
	if (process.platform !== 'darwin')
		return null
	return process.arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin'
}

function getTargetSpecificNodeEnvName(targetTriple) {
	return 'DESKTOP_NODE_BIN_' + targetTriple.toUpperCase().replace(/[^A-Z0-9]/g, '_')
}

function resolveBuildTarget(extraArgs) {
	const explicitTarget = parseTargetArg(extraArgs)
	if (explicitTarget)
		return explicitTarget

	if (process.env.TAURI_TARGET_TRIPLE)
		return process.env.TAURI_TARGET_TRIPLE

	if (process.platform === 'darwin')
		return UNIVERSAL_MAC_TARGET

	return null
}

function ensureRustTargets(targetTriple) {
	if (process.platform !== 'darwin' || targetTriple !== UNIVERSAL_MAC_TARGET)
		return

	execFileSync('rustup', ['target', 'add', 'aarch64-apple-darwin', 'x86_64-apple-darwin'], {
		cwd: repoRoot,
		stdio: 'inherit'
	})
}

function ensureCachedNodeRuntime(version, archivePlatform) {
	const cacheRoot = path.join(repoRoot, 'tauri', 'cache', 'node')
	const archiveName = `node-v${version}-${archivePlatform}.tar.gz`
	const archivePath = path.join(cacheRoot, archiveName)
	const extractedRoot = path.join(cacheRoot, `node-v${version}-${archivePlatform}`)
	const nodeBinaryPath = path.join(extractedRoot, 'bin', 'node')

	if (fs.existsSync(nodeBinaryPath))
		return nodeBinaryPath

	fs.mkdirSync(cacheRoot, { recursive: true })
	if (!fs.existsSync(archivePath)) {
		const downloadUrl = `https://nodejs.org/dist/v${version}/${archiveName}`
		execFileSync('curl', ['-fsSL', downloadUrl, '-o', archivePath], {
			cwd: repoRoot,
			stdio: 'inherit'
		})
	}

	fs.rmSync(extractedRoot, { recursive: true, force: true })
	execFileSync('tar', ['-xzf', archivePath, '-C', cacheRoot], {
		cwd: repoRoot,
		stdio: 'inherit'
	})

	if (!fs.existsSync(nodeBinaryPath))
		throw new Error('Downloaded Node runtime did not contain an executable at ' + nodeBinaryPath)

	return nodeBinaryPath
}

function buildEnvironment(targetTriple) {
	const env = { ...process.env }

	if (targetTriple)
		env.TAURI_TARGET_TRIPLE = targetTriple

	if (process.platform !== 'darwin' || targetTriple !== UNIVERSAL_MAC_TARGET)
		return env

	const hostTargetTriple = getHostDarwinTriple()
	const nodeVersion = process.version.slice(1)
	const targetTriples = ['aarch64-apple-darwin', 'x86_64-apple-darwin']

	targetTriples.forEach(target => {
		const envName = getTargetSpecificNodeEnvName(target)
		if (env[envName])
			return

		if (target === hostTargetTriple) {
			env[envName] = path.resolve(env.DESKTOP_NODE_BIN || process.execPath)
			return
		}

		const archivePlatform = target === 'aarch64-apple-darwin' ? 'darwin-arm64' : 'darwin-x64'
		env[envName] = ensureCachedNodeRuntime(nodeVersion, archivePlatform)
	})

	return env
}

function run() {
	const extraArgs = process.argv.slice(2)
	const requestedTarget = resolveBuildTarget(extraArgs)
	const buildArgs = parseTargetArg(extraArgs) || !requestedTarget ? extraArgs : ['--target', requestedTarget].concat(extraArgs)
	const env = buildEnvironment(requestedTarget)

	ensureRustTargets(requestedTarget)
	runNodeScript('scripts/sync-version.js', [], env)
	runNodeScript('scripts/stage-desktop-runtime.js', [], env)
	runNodeScript('scripts/prepare-node-sidecar.js', [], env)
	runNodeScript('scripts/sanitize-tauri-target-cache.js', [], env)

	try {
		runTauriBuild(buildArgs, env)
		runNodeScript('scripts/finalize-tauri-build.js', [], env)
		runNodeScript('scripts/package-windows-release.js', [], env)
	} finally {
		cleanupGeneratedArtifacts()
	}
}

run()
