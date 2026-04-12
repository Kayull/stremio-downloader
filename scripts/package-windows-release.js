const fs = require('fs')
const { execFileSync } = require('child_process')
const path = require('path')
const { repoRoot, readVersion, readText, getPlatformLabel, resolveTargetTriple } = require('./version-utils')

const tauriConfigPath = path.join(repoRoot, 'tauri', 'tauri.conf.json')

function readProductName() {
	const tauriConfig = JSON.parse(readText(tauriConfigPath))
	return String(tauriConfig.productName || '').trim()
}

function sanitizeWindowsFilenameSegment(value) {
	return String(value)
		.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
		.trim()
}

function isWindowsTarget() {
	return resolveTargetTriple().includes('windows')
}

function ensureWindowsHost() {
	if (process.platform !== 'win32') {
		throw new Error('Single-file Windows packaging must run on a Windows host.')
	}
}

function ensureExecutable(command, message) {
	try {
		execFileSync(command, ['--version'], {
			cwd: repoRoot,
			stdio: 'ignore'
		})
	} catch (err) {
		throw new Error(message)
	}
}

function ensureDotnetAvailable() {
	ensureExecutable(
		'dotnet',
		'The .NET SDK is required to build the Windows self-extracting launcher. Install .NET 8 SDK or newer.'
	)
}

function getReleaseDir() {
	return path.join(repoRoot, 'tauri', 'release', readVersion() + '-' + getPlatformLabel())
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

function compressReleasePayload(releaseDir, payloadZipPath) {
	fs.rmSync(payloadZipPath, { force: true })

	const escapedReleaseDir = releaseDir.replace(/'/g, "''")
	const escapedPayloadZipPath = payloadZipPath.replace(/'/g, "''")
	const script = [
		`$releaseDir = '${escapedReleaseDir}'`,
		`$payloadZip = '${escapedPayloadZipPath}'`,
		'Compress-Archive -Path (Join-Path $releaseDir \'*\') -DestinationPath $payloadZip'
	].join('; ')

	execFileSync('powershell.exe', ['-NoProfile', '-Command', script], {
		cwd: repoRoot,
		stdio: 'inherit'
	})
}

function publishLauncher(publishDir) {
	fs.rmSync(publishDir, { recursive: true, force: true })
	execFileSync('dotnet', [
		'publish',
		path.join('packaging', 'windows-launcher', 'StremioDownloader.WindowsLauncher.csproj'),
		'-c', 'Release',
		'-r', 'win-x64',
		'--self-contained', 'true',
		'-p:PublishSingleFile=true',
		'-p:EnableCompressionInSingleFile=true',
		'-p:DebugType=None',
		'-p:DebugSymbols=false',
		'-o', publishDir
	], {
		cwd: repoRoot,
		stdio: 'inherit'
	})

	const launcherPath = path.join(publishDir, 'StremioDownloaderLauncher.exe')
	if (!fs.existsSync(launcherPath))
		throw new Error('Published Windows launcher was not found: ' + launcherPath)

	return launcherPath
}

function createSelfExtractor(launcherPath, payloadZipPath, outputPath) {
	execFileSync(process.execPath, [
		path.join(repoRoot, 'scripts', 'create-windows-self-extractor.js'),
		'--launcher', launcherPath,
		'--payload', payloadZipPath,
		'--output', outputPath
	], {
		cwd: repoRoot,
		stdio: 'inherit'
	})
}

function clearDirectoryContents(targetDir) {
	fs.readdirSync(targetDir).forEach(entry => {
		fs.rmSync(path.join(targetDir, entry), { recursive: true, force: true })
	})
}

function packageWindowsRelease() {
	if (!isWindowsTarget()) {
		console.log('Skipping Windows single-file packaging for non-Windows target.')
		return
	}

	ensureWindowsHost()
	ensureDotnetAvailable()

	const releaseDir = getReleaseDir()
	const innerExecutablePath = ensurePortableReleaseLayout(releaseDir)
	const productName = readProductName()
	const finalExecutableName = sanitizeWindowsFilenameSegment(productName || '') || path.basename(innerExecutablePath, '.exe')
	const tempRoot = path.join(repoRoot, 'build', 'windows-single-file')
	const payloadZipPath = path.join(tempRoot, 'payload.zip')
	const launcherPublishDir = path.join(tempRoot, 'launcher')
	const wrappedExecutablePath = path.join(tempRoot, finalExecutableName + '.exe')

	fs.mkdirSync(tempRoot, { recursive: true })
	compressReleasePayload(releaseDir, payloadZipPath)
	const launcherPath = publishLauncher(launcherPublishDir)
	createSelfExtractor(launcherPath, payloadZipPath, wrappedExecutablePath)

	clearDirectoryContents(releaseDir)
	fs.copyFileSync(wrappedExecutablePath, path.join(releaseDir, finalExecutableName + '.exe'))

	console.log('Packaged single-file Windows release:', path.join(releaseDir, finalExecutableName + '.exe'))
}

packageWindowsRelease()
