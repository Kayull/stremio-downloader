const fs = require('fs')
const path = require('path')
const { repoRoot } = require('./version-utils')

const tauriTargetRoot = path.join(repoRoot, 'tauri', 'target')
const stalePathFragment = path.join('src-tauri', 'target')
const probeFileNames = new Set(['output', 'root-output'])

function fileContainsStalePath(filePath) {
	try {
		const content = fs.readFileSync(filePath, 'utf8')
		return content.includes(stalePathFragment)
	} catch (err) {
		return false
	}
}

function buildCacheNeedsReset(profile) {
	const buildRoot = path.join(tauriTargetRoot, profile, 'build')
	if (!fs.existsSync(buildRoot))
		return false

	for (const entry of fs.readdirSync(buildRoot, { withFileTypes: true })) {
		if (!entry.isDirectory())
			continue

		const entryRoot = path.join(buildRoot, entry.name)
		for (const fileName of probeFileNames) {
			const filePath = path.join(entryRoot, fileName)
			if (fs.existsSync(filePath) && fileContainsStalePath(filePath))
				return true
		}
	}

	return false
}

function resetProfileCache(profile) {
	const profileRoot = path.join(tauriTargetRoot, profile)
	const pathsToRemove = [
		path.join(profileRoot, 'build'),
		path.join(profileRoot, '.fingerprint')
	]

	pathsToRemove.forEach(targetPath => {
		fs.rmSync(targetPath, { recursive: true, force: true })
	})

	return pathsToRemove
}

function sanitizeTauriTargetCache() {
	if (!fs.existsSync(tauriTargetRoot))
		return

	const resetProfiles = ['debug', 'release'].filter(buildCacheNeedsReset)
	if (!resetProfiles.length)
		return

	resetProfiles.forEach(resetProfileCache)
	console.log('Reset stale Tauri target metadata for:', resetProfiles.join(', '))
}

sanitizeTauriTargetCache()
