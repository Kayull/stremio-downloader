const fs = require('fs')
const path = require('path')
const { repoRoot } = require('./version-utils')

const buildRoot = path.join(repoRoot, 'build')
const tauriBinariesRoot = path.join(repoRoot, 'tauri', 'binaries')
const tauriTargetRoot = path.join(repoRoot, 'tauri', 'target')
const dsStorePaths = [
	path.join(repoRoot, '.DS_Store'),
	path.join(repoRoot, 'build', '.DS_Store'),
	path.join(repoRoot, 'tauri', '.DS_Store'),
	path.join(repoRoot, 'tauri', 'target', '.DS_Store'),
	path.join(repoRoot, 'tauri', 'release', '.DS_Store')
]

function removePath(targetPath) {
	fs.rmSync(targetPath, { recursive: true, force: true })
}

function pruneEmptyDirectory(targetPath) {
	if (!fs.existsSync(targetPath))
		return

	if (fs.readdirSync(targetPath).length === 0)
		fs.rmdirSync(targetPath)
}

function removeDsStoreFiles() {
	dsStorePaths.forEach(filePath => {
		fs.rmSync(filePath, { force: true })
	})
}

function removeTauriBundleRoots() {
	removePath(path.join(tauriTargetRoot, 'release', 'bundle'))
	if (!fs.existsSync(tauriTargetRoot))
		return

	fs.readdirSync(tauriTargetRoot, { withFileTypes: true }).forEach(entry => {
		if (!entry.isDirectory())
			return
		removePath(path.join(tauriTargetRoot, entry.name, 'release', 'bundle'))
	})
}

function cleanupGeneratedArtifacts() {
	removePath(buildRoot)
	removePath(tauriBinariesRoot)
	removeTauriBundleRoots()
	pruneEmptyDirectory(buildRoot)
	pruneEmptyDirectory(tauriBinariesRoot)
	removeDsStoreFiles()
}

module.exports = {
	cleanupGeneratedArtifacts
}

if (require.main === module) {
	cleanupGeneratedArtifacts()
	console.log('Removed generated build staging artifacts.')
}
