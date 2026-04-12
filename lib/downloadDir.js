const fs = require('fs')
const os = require('os')
const path = require('path')
const userSettings = require('./userSettings')

function getTempDir() {
	const tempDir = path.join(os.tmpdir(), 'StremioDownloader')

	if (!fs.existsSync(tempDir))
		fs.mkdirSync(tempDir, { recursive: true })

	return tempDir
}

function readSettings() {
	return userSettings.read()
}

function writeSettings(settings) {
	userSettings.write(settings)
}

function normalizeThemeMode(value) {
	return value === 'light' ? 'light' : 'dark'
}

function normalizeSkippedReleaseVersion(value) {
	return String(value || '').trim().replace(/^v/i, '')
}

module.exports = {
	get: () => {
		const settings = readSettings()
		return settings.folder || getTempDir()
	},
	set: folder => {
		const settings = readSettings()
		settings.folder = folder
		writeSettings(settings)
	},
	getSettings: () => {
		const settings = readSettings()
		return {
			folder: settings.folder || getTempDir(),
			useShowSubfolders: settings.useShowSubfolders !== false,
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
