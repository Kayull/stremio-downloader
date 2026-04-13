const fs = require('fs')
const { execFileSync } = require('child_process')
const path = require('path')
const { repoRoot } = require('./version-utils')

const UNIVERSAL_MAC_TARGET = 'universal-apple-darwin'

function getNodeScriptPath(relativePath) {
	return path.join(repoRoot, relativePath)
}

function createUserFacingError(message) {
	const error = new Error(message)
	error.isUserFacing = true
	return error
}

function resolveCargoBinDir() {
	if (process.platform !== 'win32' || !process.env.USERPROFILE)
		return null

	const cargoBinDir = path.join(process.env.USERPROFILE, '.cargo', 'bin')
	return fs.existsSync(cargoBinDir) ? cargoBinDir : null
}

function resolveWindowsSystemExecutable(relativePathCandidates) {
	if (process.platform !== 'win32')
		return null

	const windowsDir = process.env.WINDIR || process.env.windir || 'C:\\Windows'
	for (const relativePath of relativePathCandidates || []) {
		const candidatePath = path.join(windowsDir, relativePath)
		if (fs.existsSync(candidatePath))
			return candidatePath
	}

	return null
}

function resolveExecutable(command) {
	if (process.platform !== 'win32')
		return command

	const cargoBinDir = resolveCargoBinDir()
	if (!cargoBinDir)
		return command

	const candidatePath = path.join(cargoBinDir, command + '.exe')
	return fs.existsSync(candidatePath) ? candidatePath : command
}

function ensureExecutable(command, args, message) {
	try {
		execFileSync(resolveExecutable(command), args || ['--version'], {
			cwd: repoRoot,
			stdio: 'ignore'
		})
	} catch (err) {
		throw createUserFacingError(message)
	}
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

function runTauriCommand(commandName, extraArgs, env) {
	const tauriArgs = [commandName].concat(extraArgs || [])

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

	ensureExecutable(
		'rustup',
		['--version'],
		'`rustup` is required for universal macOS builds so the script can install both Apple targets. Install the Rust toolchain via https://rustup.rs/ and restart your shell.'
	)
	execFileSync(resolveExecutable('rustup'), ['target', 'add', 'aarch64-apple-darwin', 'x86_64-apple-darwin'], {
		cwd: repoRoot,
		stdio: 'inherit'
	})
}

function ensureCargoAvailable(commandDescription) {
	ensureExecutable(
		'cargo',
		['--version'],
		'`cargo` was not found on PATH. Tauri ' + commandDescription + ' requires the Rust toolchain. Install Rust via https://rustup.rs/, ensure `%USERPROFILE%\\.cargo\\bin` is on PATH, then restart your shell and rerun the command.'
	)
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
	const cargoBinDir = resolveCargoBinDir()

	if (targetTriple)
		env.TAURI_TARGET_TRIPLE = targetTriple

	if (cargoBinDir) {
		const pathEntries = String(env.PATH || '').split(path.delimiter).filter(Boolean)
		const normalizedCargoBinDir = cargoBinDir.toLowerCase()
		const hasCargoBinDir = pathEntries.some(entry => entry.toLowerCase() === normalizedCargoBinDir)
		if (!hasCargoBinDir)
			env.PATH = cargoBinDir + path.delimiter + (env.PATH || '')
	}

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

module.exports = {
	buildEnvironment,
	createUserFacingError,
	ensureCargoAvailable,
	ensureRustTargets,
	parseTargetArg,
	resolveExecutable,
	resolveWindowsSystemExecutable,
	resolveBuildTarget,
	runNodeScript,
	runTauriCommand
}
