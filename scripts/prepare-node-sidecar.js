const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const repoRoot = path.resolve(__dirname, '..')
const binariesDir = path.join(repoRoot, 'tauri', 'binaries')
const nodeRuntimeRoot = path.join(repoRoot, 'build', 'node-runtime')
const tauriTargetRoot = path.join(repoRoot, 'tauri', 'target')

function resolveHostTargetTriple() {
	if (process.env.TAURI_TARGET_TRIPLE)
		return process.env.TAURI_TARGET_TRIPLE

	if (process.platform === 'darwin') {
		if (process.arch === 'arm64')
			return 'aarch64-apple-darwin'
		if (process.arch === 'x64')
			return 'x86_64-apple-darwin'
	}

	if (process.platform === 'win32') {
		if (process.arch === 'arm64')
			return 'aarch64-pc-windows-msvc'
		if (process.arch === 'ia32')
			return 'i686-pc-windows-msvc'
		if (process.arch === 'x64')
			return 'x86_64-pc-windows-msvc'
	}

	if (process.platform === 'linux') {
		if (process.arch === 'arm64')
			return 'aarch64-unknown-linux-gnu'
		if (process.arch === 'arm')
			return 'armv7-unknown-linux-gnueabihf'
		if (process.arch === 'x64')
			return 'x86_64-unknown-linux-gnu'
	}

	throw new Error('Unsupported platform/architecture for a bundled Node runtime: ' + process.platform + '/' + process.arch)
}

function resolveRequestedTargetTriple() {
	if (process.env.TAURI_TARGET_TRIPLE)
		return process.env.TAURI_TARGET_TRIPLE

	return resolveHostTargetTriple()
}

function resolveTargetTriples() {
	const requestedTargetTriple = resolveRequestedTargetTriple()
	if (requestedTargetTriple === 'universal-apple-darwin')
		return ['aarch64-apple-darwin', 'x86_64-apple-darwin']

	return [requestedTargetTriple]
}

function getTargetTripleEnvName(targetTriple) {
	return 'DESKTOP_NODE_BIN_' + targetTriple.toUpperCase().replace(/[^A-Z0-9]/g, '_')
}

function getConfiguredNodeBinaryPath(targetTriple) {
	const explicitTargetBinary = process.env[getTargetTripleEnvName(targetTriple)]
	if (explicitTargetBinary)
		return path.resolve(explicitTargetBinary)

	const requestedTargetTriple = resolveRequestedTargetTriple()
	if (requestedTargetTriple !== 'universal-apple-darwin')
		return path.resolve(process.env.DESKTOP_NODE_BIN || process.execPath)

	if (targetTriple === resolveHostTargetTriple())
		return path.resolve(process.env.DESKTOP_NODE_BIN || process.execPath)

	throw new Error('Missing Node binary for ' + targetTriple + '. Set ' + getTargetTripleEnvName(targetTriple) + ' to a matching Node executable.')
}

function ensureExists(targetPath, message) {
	if (!fs.existsSync(targetPath))
		throw new Error(message + ': ' + targetPath)
}

function copyFile(sourcePath, targetPath, executable) {
	fs.mkdirSync(path.dirname(targetPath), { recursive: true })
	fs.copyFileSync(sourcePath, targetPath)
	if (process.platform === 'win32')
		return

	fs.chmodSync(targetPath, executable ? 0o755 : 0o644)
}

function copyDirectoryIfPresent(sourcePath, targetPath) {
	if (!fs.existsSync(sourcePath))
		return false

	fs.mkdirSync(path.dirname(targetPath), { recursive: true })
	fs.cpSync(sourcePath, targetPath, { recursive: true })
	return true
}

function getNodeBinaryName(nodeBinaryPath) {
	return path.basename(nodeBinaryPath)
}

function getStripArgs() {
	if (process.env.DESKTOP_STRIP_BINARIES !== '1')
		return null
	if (process.platform === 'darwin')
		return ['-S', '-x']
	if (process.platform === 'linux')
		return ['--strip-unneeded']
	return null
}

function stripBinaryIfPossible(targetPath) {
	const stripArgs = getStripArgs()
	if (!stripArgs)
		return

	try {
		execFileSync('strip', stripArgs.concat(targetPath), {
			stdio: 'ignore'
		})
		if (process.platform === 'darwin') {
			execFileSync('codesign', ['--force', '--sign', '-', targetPath], {
				stdio: 'ignore'
			})
		}
	} catch (err) {
		console.warn('Could not strip bundled binary:', targetPath)
		console.warn(err.message || String(err))
	}
}

function prepareUnixNodeRuntime(runtimeTargetRoot, nodeBinaryPath) {
	const sourcePrefix = path.resolve(path.dirname(nodeBinaryPath), '..')
	const sourceLibDir = path.join(sourcePrefix, 'lib')
	const targetBinDir = path.join(runtimeTargetRoot, 'bin')
	const targetLibDir = path.join(runtimeTargetRoot, 'lib')
	const targetNodeBinaryPath = path.join(targetBinDir, getNodeBinaryName(nodeBinaryPath))

	copyFile(nodeBinaryPath, targetNodeBinaryPath, true)
	stripBinaryIfPossible(targetNodeBinaryPath)

	if (fs.existsSync(sourceLibDir)) {
		fs.mkdirSync(targetLibDir, { recursive: true })
		fs.readdirSync(sourceLibDir)
			.filter(entry => entry.startsWith('libnode'))
			.forEach(entry => {
				const targetLibPath = path.join(targetLibDir, entry)
				copyFile(path.join(sourceLibDir, entry), targetLibPath, false)
				stripBinaryIfPossible(targetLibPath)
			})
	}
}

function prepareWindowsNodeRuntime(runtimeTargetRoot, nodeBinaryPath) {
	const sourceDir = path.dirname(nodeBinaryPath)
	const targetBinDir = path.join(runtimeTargetRoot, 'bin')

	copyFile(nodeBinaryPath, path.join(targetBinDir, getNodeBinaryName(nodeBinaryPath)), true)

	fs.readdirSync(sourceDir)
		.filter(entry => entry.toLowerCase().endsWith('.dll'))
		.forEach(entry => {
			copyFile(path.join(sourceDir, entry), path.join(targetBinDir, entry), false)
		})
}

function buildUnixLauncher(targetTriples, repoNodeRoot, packagedNodeRoot, nodeBinaryName) {
	const archSelector = targetTriples.length > 1
		? [
			'ARCH=$(uname -m)',
			'case "$ARCH" in',
			'  arm64|aarch64)',
			'    TARGET_TRIPLE="aarch64-apple-darwin"',
			'    ;;',
			'  x86_64)',
			'    TARGET_TRIPLE="x86_64-apple-darwin"',
			'    ;;',
			'  *)',
			'    echo "Unsupported macOS architecture: $ARCH" >&2',
			'    exit 1',
			'    ;;',
			'esac'
		].join('\n')
		: 'TARGET_TRIPLE="' + targetTriples[0] + '"'

	return `#!/bin/sh
set -eu

SELF_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
${archSelector}
PACKAGED_NODE="${packagedNodeRoot}/$TARGET_TRIPLE/bin/${nodeBinaryName}"
DEV_NODE="${repoNodeRoot}/$TARGET_TRIPLE/bin/${nodeBinaryName}"

if [ -x "$PACKAGED_NODE" ]; then
  exec "$PACKAGED_NODE" "$@"
fi

if [ -x "$DEV_NODE" ]; then
  exec "$DEV_NODE" "$@"
fi

echo "Bundled Node runtime not found. Checked: $PACKAGED_NODE and $DEV_NODE" >&2
exit 1
`
}

function prepareLauncher(requestedTargetTriple, targetTriples, nodeBinaryName, launcherTargetTriple) {
	const resolvedLauncherTargetTriple = launcherTargetTriple || requestedTargetTriple
	const launcherName = 'node-launcher-' + resolvedLauncherTargetTriple + (process.platform === 'win32' ? '.exe' : '')
	const launcherPath = path.join(binariesDir, launcherName)

	fs.mkdirSync(binariesDir, { recursive: true })
	if (process.platform === 'win32') {
		const sourceNodeBinaryPath = path.join(nodeRuntimeRoot, resolvedLauncherTargetTriple, 'bin', nodeBinaryName)
		copyFile(sourceNodeBinaryPath, launcherPath, true)
		return launcherPath
	}

	const packagedNodeRoot = '$SELF_DIR/../Resources/_up_/build/node-runtime'
	const repoNodeRoot = nodeRuntimeRoot.replace(/"/g, '\\"')
	const content = buildUnixLauncher(
		launcherTargetTriple ? [resolvedLauncherTargetTriple] : targetTriples,
		repoNodeRoot,
		packagedNodeRoot,
		nodeBinaryName
	)

	fs.writeFileSync(launcherPath, content)
	if (process.platform !== 'win32')
		fs.chmodSync(launcherPath, 0o755)

	return launcherPath
}

function prepareNodeSidecar() {
	const requestedTargetTriple = resolveRequestedTargetTriple()
	const targetTriples = resolveTargetTriples()
	let launcherNodeBinaryName = 'node'

	targetTriples.forEach(targetTriple => {
		const nodeBinaryPath = getConfiguredNodeBinaryPath(targetTriple)
		const runtimeTargetRoot = path.join(nodeRuntimeRoot, targetTriple)

		ensureExists(nodeBinaryPath, 'Node binary not found')
		fs.rmSync(runtimeTargetRoot, { recursive: true, force: true })

		if (process.platform === 'win32')
			prepareWindowsNodeRuntime(runtimeTargetRoot, nodeBinaryPath)
		else
			prepareUnixNodeRuntime(runtimeTargetRoot, nodeBinaryPath)

		launcherNodeBinaryName = getNodeBinaryName(nodeBinaryPath)
		console.log('Prepared bundled Node runtime:', runtimeTargetRoot)
	})

	if (requestedTargetTriple === 'universal-apple-darwin') {
		const universalLauncherPath = prepareLauncher(requestedTargetTriple, targetTriples, launcherNodeBinaryName)
		console.log('Prepared Tauri launcher sidecar:', universalLauncherPath)
	}

	const launcherTargetTriples = requestedTargetTriple === 'universal-apple-darwin' ? targetTriples : [requestedTargetTriple]
	launcherTargetTriples.forEach(targetTriple => {
		const launcherPath = prepareLauncher(requestedTargetTriple, targetTriples, launcherNodeBinaryName, targetTriple)
		console.log('Prepared Tauri launcher sidecar:', launcherPath)
	})
}

function clearTauriCopiedRuntimeArtifacts() {
	if (!fs.existsSync(tauriTargetRoot))
		return

	fs.readdirSync(tauriTargetRoot).forEach(entry => {
		const copiedBuildRoot = path.join(tauriTargetRoot, entry, '_up_', 'build')
		fs.rmSync(path.join(copiedBuildRoot, 'desktop-runtime'), { recursive: true, force: true })
		fs.rmSync(path.join(copiedBuildRoot, 'node-runtime'), { recursive: true, force: true })
	})
}

clearTauriCopiedRuntimeArtifacts()
prepareNodeSidecar()
