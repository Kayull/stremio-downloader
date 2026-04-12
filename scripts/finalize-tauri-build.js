const fs = require('fs')
const path = require('path')
const {
	repoRoot,
	readVersion,
	readText,
	getPlatformLabel,
	resolveTargetTriple
} = require('./version-utils')

const releaseRoot = path.join(repoRoot, 'tauri', 'release')
const tauriConfigPath = path.join(repoRoot, 'tauri', 'tauri.conf.json')

function readProductName() {
	const tauriConfig = JSON.parse(readText(tauriConfigPath))
	return String(tauriConfig.productName || '').trim()
}

function movePath(sourcePath, targetPath) {
	fs.mkdirSync(path.dirname(targetPath), { recursive: true })
	fs.rmSync(targetPath, { recursive: true, force: true })
	try {
		fs.renameSync(sourcePath, targetPath)
	} catch (err) {
		if (err.code !== 'EXDEV')
			throw err

		fs.cpSync(sourcePath, targetPath, { recursive: true })
		fs.rmSync(sourcePath, { recursive: true, force: true })
	}
}

function copyPath(sourcePath, targetPath) {
	fs.mkdirSync(path.dirname(targetPath), { recursive: true })
	fs.rmSync(targetPath, { recursive: true, force: true })

	const stats = fs.statSync(sourcePath)
	if (stats.isDirectory()) {
		fs.cpSync(sourcePath, targetPath, { recursive: true })
		return
	}

	fs.copyFileSync(sourcePath, targetPath)
}

function getBundleRootCandidates() {
	const candidates = []
	if (process.env.TAURI_TARGET_TRIPLE) {
		candidates.push(path.join(repoRoot, 'tauri', 'target', process.env.TAURI_TARGET_TRIPLE, 'release', 'bundle'))
	}
	candidates.push(path.join(repoRoot, 'tauri', 'target', 'release', 'bundle'))
	return candidates
}

function getTargetReleaseCandidates() {
	const candidates = []
	if (process.env.TAURI_TARGET_TRIPLE) {
		candidates.push(path.join(repoRoot, 'tauri', 'target', process.env.TAURI_TARGET_TRIPLE, 'release'))
	}
	candidates.push(path.join(repoRoot, 'tauri', 'target', 'release'))
	return candidates
}

function isFinalBundleArtifact(artifactPath) {
	const artifactName = path.basename(artifactPath)

	if (artifactName.endsWith('.app'))
		return true

	return [
		'.dmg',
		'.pkg',
		'.msi',
		'.exe',
		'.AppImage',
		'.deb',
		'.rpm'
	].some(extension => artifactName.endsWith(extension))
}

function listBundleArtifacts() {
	const bundleRoot = getBundleRootCandidates().find(candidate => fs.existsSync(candidate))
	if (!bundleRoot)
		throw new Error('Tauri bundle output not found. Checked: ' + getBundleRootCandidates().join(', '))

	const artifacts = []
	fs.readdirSync(bundleRoot, { withFileTypes: true }).forEach(entry => {
		if (!entry.isDirectory())
			return

		const platformBundleDir = path.join(bundleRoot, entry.name)
		fs.readdirSync(platformBundleDir, { withFileTypes: true }).forEach(artifactEntry => {
			const artifactPath = path.join(platformBundleDir, artifactEntry.name)
			if (isFinalBundleArtifact(artifactPath))
				artifacts.push(artifactPath)
		})
	})

	if (!artifacts.length)
		throw new Error('No packaged bundle artifacts were found in ' + bundleRoot)

	return { bundleRoot, artifacts }
}

function isWindowsTarget() {
	return resolveTargetTriple().includes('windows')
}

function sanitizeWindowsFilenameSegment(value) {
	return String(value)
		.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
		.trim()
}

function findPortableWindowsReleaseRoot() {
	const releaseRootCandidate = getTargetReleaseCandidates().find(candidate => fs.existsSync(candidate))
	if (!releaseRootCandidate)
		throw new Error('Tauri release output not found. Checked: ' + getTargetReleaseCandidates().join(', '))

	return releaseRootCandidate
}

function getPortableWindowsArtifacts(releaseDir) {
	const entries = fs.readdirSync(releaseDir, { withFileTypes: true })
	const executableEntries = entries.filter(entry =>
		entry.isFile() &&
		entry.name.toLowerCase().endsWith('.exe')
	)

	const mainExecutable = executableEntries.find(entry => entry.name !== 'node-launcher.exe')
	if (!mainExecutable) {
		throw new Error('Portable Windows executable not found in ' + releaseDir)
	}

	const supportEntries = entries.filter(entry => {
		if (entry.name === mainExecutable.name)
			return false

		if (entry.isDirectory())
			return entry.name === '_up_'

		const lowerName = entry.name.toLowerCase()
		return lowerName.endsWith('.exe') || lowerName.endsWith('.dll')
	})

	return {
		mainExecutable: path.join(releaseDir, mainExecutable.name),
		supportPaths: supportEntries.map(entry => path.join(releaseDir, entry.name))
	}
}

function finalizePortableWindowsOutput(outputDir, productName) {
	const releaseDir = findPortableWindowsReleaseRoot()
	const { mainExecutable, supportPaths } = getPortableWindowsArtifacts(releaseDir)
	const portableExecutableName = sanitizeWindowsFilenameSegment(productName || '') || path.basename(mainExecutable, '.exe')
	const targetExecutablePath = path.join(outputDir, portableExecutableName + '.exe')

	copyPath(mainExecutable, targetExecutablePath)
	supportPaths.forEach(sourcePath => {
		const targetPath = path.join(outputDir, path.basename(sourcePath))
		copyPath(sourcePath, targetPath)
	})
}

function finalizeBuildOutput() {
	const version = readVersion()
	const productName = readProductName()
	const platformLabel = getPlatformLabel()
	if (!productName)
		throw new Error('Missing Tauri productName.')

	const outputDir = path.join(releaseRoot, version + '-' + platformLabel)

	fs.rmSync(outputDir, { recursive: true, force: true })
	fs.mkdirSync(outputDir, { recursive: true })

	if (isWindowsTarget()) {
		finalizePortableWindowsOutput(outputDir, productName)
	} else {
		const { bundleRoot, artifacts } = listBundleArtifacts()

		artifacts.forEach(sourcePath => {
			const targetPath = path.join(outputDir, path.basename(sourcePath))
			movePath(sourcePath, targetPath)
		})

		fs.rmSync(bundleRoot, { recursive: true, force: true })
	}

	console.log('Final release output:', outputDir)
}

finalizeBuildOutput()
