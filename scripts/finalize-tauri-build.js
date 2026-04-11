const fs = require('fs')
const path = require('path')
const { repoRoot, readVersion, readText, getPlatformLabel } = require('./version-utils')

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

function getBundleRootCandidates() {
	const candidates = []
	if (process.env.TAURI_TARGET_TRIPLE) {
		candidates.push(path.join(repoRoot, 'tauri', 'target', process.env.TAURI_TARGET_TRIPLE, 'release', 'bundle'))
	}
	candidates.push(path.join(repoRoot, 'tauri', 'target', 'release', 'bundle'))
	return candidates
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
			artifacts.push(path.join(platformBundleDir, artifactEntry.name))
		})
	})

	if (!artifacts.length)
		throw new Error('No packaged bundle artifacts were found in ' + bundleRoot)

	return { bundleRoot, artifacts }
}

function finalizeBuildOutput() {
	const version = readVersion()
	const productName = readProductName()
	const platformLabel = getPlatformLabel()
	if (!productName)
		throw new Error('Missing Tauri productName.')

	const outputDir = path.join(releaseRoot, version + '-' + platformLabel)
	const { bundleRoot, artifacts } = listBundleArtifacts()

	fs.rmSync(outputDir, { recursive: true, force: true })
	fs.mkdirSync(outputDir, { recursive: true })

	artifacts.forEach(sourcePath => {
		const targetPath = path.join(outputDir, path.basename(sourcePath))
		movePath(sourcePath, targetPath)
	})

	fs.rmSync(bundleRoot, { recursive: true, force: true })

	console.log('Final release output:', outputDir)
}

finalizeBuildOutput()
