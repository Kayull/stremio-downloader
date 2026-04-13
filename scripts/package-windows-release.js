const fs = require('fs')
const { execFileSync } = require('child_process')
const path = require('path')
const { repoRoot, readVersion, getPlatformLabel, resolveTargetTriple } = require('./version-utils')
const { resolveWindowsSystemExecutable } = require('./tauri-cli-utils')

function isWindowsTarget() {
	return resolveTargetTriple().includes('windows')
}

function ensureWindowsHost() {
	if (process.platform !== 'win32')
		throw new Error('Portable Windows zip packaging must run on a Windows host.')
}

function getReleaseDir() {
	return path.join(repoRoot, 'tauri', 'release', readVersion() + '-' + getPlatformLabel())
}

function getReleaseZipPath(releaseDir) {
	return path.join(path.dirname(releaseDir), path.basename(releaseDir) + '.zip')
}

function getReleaseEntries(releaseDir) {
	return fs.readdirSync(releaseDir, { withFileTypes: true }).filter(entry => !entry.name.startsWith('.'))
}

function ensurePortableReleaseLayout(releaseDir) {
	if (!fs.existsSync(releaseDir))
		throw new Error('Windows release directory not found: ' + releaseDir)

	const entries = getReleaseEntries(releaseDir)
	if (!entries.length)
		throw new Error('Windows release directory is empty: ' + releaseDir)

	const mainExecutable = entries.find(entry =>
		entry.isFile() &&
		entry.name.toLowerCase().endsWith('.exe') &&
		entry.name.toLowerCase() !== 'node-launcher.exe'
	)

	if (!mainExecutable)
		throw new Error('Portable Windows app executable not found in ' + releaseDir)

	return path.join(releaseDir, mainExecutable.name)
}

function compressReleaseFolder(releaseDir, zipPath) {
	fs.rmSync(zipPath, { force: true })

	const escapedReleaseDir = releaseDir.replace(/'/g, "''")
	const escapedZipPath = zipPath.replace(/'/g, "''")
	const escapedParentDir = path.dirname(releaseDir).replace(/'/g, "''")
	const releaseFolderName = path.basename(releaseDir).replace(/'/g, "''")
	const powershellCommand = resolveWindowsSystemExecutable([
		'System32\\WindowsPowerShell\\v1.0\\powershell.exe'
	]) || 'powershell.exe'
	const script = [
		`Set-Location '${escapedParentDir}'`,
		`$zipPath = '${escapedZipPath}'`,
		`Compress-Archive -Path '${releaseFolderName}' -DestinationPath $zipPath`
	].join('; ')

	execFileSync(powershellCommand, ['-NoProfile', '-Command', script], {
		cwd: repoRoot,
		stdio: 'inherit'
	})
}

function packageWindowsRelease() {
	if (!isWindowsTarget()) {
		console.log('Skipping Windows portable zip packaging for non-Windows target.')
		return
	}

	ensureWindowsHost()

	const releaseDir = getReleaseDir()
	ensurePortableReleaseLayout(releaseDir)
	const zipPath = getReleaseZipPath(releaseDir)

	compressReleaseFolder(releaseDir, zipPath)

	console.log('Packaged portable Windows release zip:', zipPath)
}

packageWindowsRelease()
