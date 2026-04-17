const os = require('os')
const path = require('path')
const userSettings = require('./userSettings')

function readSettings() {
	return userSettings.read()
}

function writeSettings(settings) {
	userSettings.write(settings)
}

function normalizeFolder(folder) {
	const value = String(folder || '').trim()
	if (!value)
		return ''

	return path.resolve(value)
}

function normalizeForComparison(targetPath) {
	const resolved = normalizeFolder(targetPath)
	if (!resolved)
		return ''

	const normalized = path.normalize(resolved).replace(/[\\\/]+$/, '')
	return process.platform === 'win32'
		? normalized.toLowerCase()
		: normalized
}

function isSameOrNestedPath(targetPath, rootPath) {
	const normalizedTargetPath = normalizeForComparison(targetPath)
	const normalizedRootPath = normalizeForComparison(rootPath)
	if (!normalizedTargetPath || !normalizedRootPath)
		return false
	if (normalizedTargetPath === normalizedRootPath)
		return true

	const relativePath = path.relative(normalizedRootPath, normalizedTargetPath)
	return !!relativePath && relativePath !== '..' && !relativePath.startsWith('..' + path.sep) && !path.isAbsolute(relativePath)
}

function listBlockedDownloadRoots() {
	const blockedRoots = new Set()
	const runtimeRoot = path.resolve(__dirname, '..')
	const bundledBuildRoot = path.resolve(runtimeRoot, '..')
	const resourceDir = process.env.STREMIO_DOWNLOADER_RESOURCE_DIR
	const appExeDir = process.env.STREMIO_DOWNLOADER_APP_EXE_DIR
	const legacyTempDownloadRoot = path.join(os.tmpdir(), 'StremioDownloader')

	;[
		runtimeRoot,
		bundledBuildRoot,
		resourceDir,
		appExeDir,
		legacyTempDownloadRoot
	].forEach(candidate => {
		const normalized = normalizeFolder(candidate)
		if (normalized)
			blockedRoots.add(normalized)
	})

	return Array.from(blockedRoots)
}

function isBlockedDownloadFolder(folder) {
	const normalizedFolder = normalizeFolder(folder)
	if (!normalizedFolder)
		return false

	return listBlockedDownloadRoots().some(blockedRoot => isSameOrNestedPath(normalizedFolder, blockedRoot))
}

function sanitizeFolderSetting(settings) {
	const configuredFolder = normalizeFolder((settings || {}).folder)
	if (!configuredFolder)
		return ''
	if (!isBlockedDownloadFolder(configuredFolder))
		return configuredFolder

	const nextSettings = Object.assign({}, settings)
	delete nextSettings.folder
	writeSettings(nextSettings)
	return ''
}

function getConfiguredFolder(settings) {
	return sanitizeFolderSetting(settings || readSettings())
}

function normalizeThemeMode(value) {
	return value === 'light' ? 'light' : 'dark'
}

function normalizeSkippedReleaseVersion(value) {
	return String(value || '').trim().replace(/^v/i, '')
}

function normalizeAutoDeleteEmptyShowFolders(value) {
	if (value === true)
		return true
	if (value === false)
		return false
	return null
}

module.exports = {
	get: () => {
		return getConfiguredFolder(readSettings())
	},
	set: folder => {
		const settings = readSettings()
		const normalizedFolder = normalizeFolder(folder)
		if (!normalizedFolder) {
			delete settings.folder
			writeSettings(settings)
			return ''
		}
		if (isBlockedDownloadFolder(normalizedFolder)) {
			const err = new Error('The app folder cannot be used as the download folder.')
			err.code = 'invalid_download_folder'
			throw err
		}
		settings.folder = normalizedFolder
		writeSettings(settings)
		return normalizedFolder
	},
	getSettings: () => {
		const settings = readSettings()
		const folder = getConfiguredFolder(settings)
		return {
			folder,
			hasFolder: !!folder,
			useShowSubfolders: settings.useShowSubfolders !== false,
			autoDeleteEmptyShowFolders: normalizeAutoDeleteEmptyShowFolders(settings.autoDeleteEmptyShowFolders),
			themeMode: normalizeThemeMode(settings.themeMode),
			skippedReleaseVersion: normalizeSkippedReleaseVersion(settings.skippedReleaseVersion)
		}
	},
	getUseShowSubfolders: () => {
		const settings = readSettings()
		return settings.useShowSubfolders !== false
	},
	setUseShowSubfolders: enabled => {
		const settings = readSettings()
		settings.useShowSubfolders = enabled !== false
		writeSettings(settings)
	},
	getAutoDeleteEmptyShowFolders: () => {
		const settings = readSettings()
		return normalizeAutoDeleteEmptyShowFolders(settings.autoDeleteEmptyShowFolders)
	},
	setAutoDeleteEmptyShowFolders: enabled => {
		const settings = readSettings()
		const normalized = normalizeAutoDeleteEmptyShowFolders(enabled)
		if (normalized === null)
			delete settings.autoDeleteEmptyShowFolders
		else
			settings.autoDeleteEmptyShowFolders = normalized
		writeSettings(settings)
		return normalized
	},
	getThemeMode: () => {
		const settings = readSettings()
		return normalizeThemeMode(settings.themeMode)
	},
	setThemeMode: mode => {
		const settings = readSettings()
		settings.themeMode = normalizeThemeMode(mode)
		writeSettings(settings)
	},
	getSkippedReleaseVersion: () => {
		const settings = readSettings()
		return normalizeSkippedReleaseVersion(settings.skippedReleaseVersion)
	},
	setSkippedReleaseVersion: version => {
		const settings = readSettings()
		const normalizedVersion = normalizeSkippedReleaseVersion(version)
		if (normalizedVersion)
			settings.skippedReleaseVersion = normalizedVersion
		else
			delete settings.skippedReleaseVersion
		writeSettings(settings)
	}
}
