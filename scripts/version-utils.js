const fs = require('fs')
const path = require('path')

const repoRoot = path.resolve(__dirname, '..')
const versionFilePath = path.join(repoRoot, 'VERSION')

function resolveTargetTriple() {
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

	throw new Error('Unsupported platform/architecture: ' + process.platform + '/' + process.arch)
}

function getPlatformLabel() {
	const triple = resolveTargetTriple()

	if (triple === 'universal-apple-darwin')
		return 'macos-universal'

	if (triple.includes('apple-darwin'))
		return triple.startsWith('aarch64-') ? 'macos-arm64' : 'macos-x64'

	if (triple.includes('windows'))
		return triple.startsWith('aarch64-') ? 'windows-arm64' : triple.startsWith('i686-') ? 'windows-x86' : 'windows-x64'

	if (triple.includes('linux'))
		return triple.startsWith('aarch64-')
			? 'linux-arm64'
			: triple.startsWith('armv7-')
				? 'linux-armv7'
				: 'linux-x64'

	return triple
}

function readText(filePath) {
	return fs.readFileSync(filePath, 'utf8')
}

function writeText(filePath, value) {
	fs.writeFileSync(filePath, value)
}

function readVersion() {
	const version = readText(versionFilePath).trim()
	if (!version)
		throw new Error('VERSION is empty.')

	if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version))
		throw new Error('VERSION must look like a semantic version. Received: ' + version)

	return version
}

module.exports = {
	repoRoot,
	versionFilePath,
	readText,
	writeText,
	readVersion,
	resolveTargetTriple,
	getPlatformLabel
}
