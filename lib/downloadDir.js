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
			useShowSubfolders: settings.useShowSubfolders !== false
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
	}
}
