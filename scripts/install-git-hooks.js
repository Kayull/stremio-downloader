const fs = require('fs')
const path = require('path')
const { repoRoot, readText, writeText } = require('./version-utils')

const hooksSourceDir = path.join(repoRoot, 'scripts', 'git-hooks')
const gitDir = path.join(repoRoot, '.git')
const hooksDir = path.join(gitDir, 'hooks')
const managedMarker = 'stremio-downloader managed pre-commit hook'

function getHookPaths(name) {
	return {
		source: path.join(hooksSourceDir, name),
		target: path.join(hooksDir, name),
		local: path.join(hooksDir, name + '.local')
	}
}

function readIfExists(filePath) {
	if (!fs.existsSync(filePath))
		return ''
	return readText(filePath)
}

function isManaged(content) {
	return String(content || '').includes(managedMarker)
}

function ensureHookInstalled(name) {
	if (!fs.existsSync(gitDir)) {
		console.log('Skipping git hook install because .git was not found.')
		return
	}

	fs.mkdirSync(hooksDir, { recursive: true })

	const paths = getHookPaths(name)
	const sourceContent = readText(paths.source)
	const existingContent = readIfExists(paths.target)

	if (existingContent && !isManaged(existingContent)) {
		if (!fs.existsSync(paths.local)) {
			fs.renameSync(paths.target, paths.local)
			console.log('Moved existing ' + name + ' hook to ' + path.relative(repoRoot, paths.local))
		} else {
			console.warn('Skipping ' + name + ' hook install because an unmanaged hook already exists and ' + path.relative(repoRoot, paths.local) + ' is taken.')
			return
		}
	}

	if (existingContent !== sourceContent)
		writeText(paths.target, sourceContent)

	fs.chmodSync(paths.target, 0o755)
	console.log('Installed git hook:', path.relative(repoRoot, paths.target))
}

ensureHookInstalled('pre-commit')
