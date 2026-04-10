const fs = require('fs')
const os = require('os')
const path = require('path')
const configDir = require('./userDir')

function getTempDir() {
	const tempDir = path.join(os.tmpdir(), 'StremioDownloader')

	if (!fs.existsSync(tempDir))
		fs.mkdirSync(tempDir, { recursive: true })

	return tempDir
}

function getUserSettingsPath() {
	return path.join(configDir, 'user-settings.json')
}

function readSettings() {
	const userSettingsPath = getUserSettingsPath()
	const settings = {}

	if (fs.existsSync(userSettingsPath)) {
		let fileData = fs.readFileSync(userSettingsPath, 'utf8')
		fileData = Buffer.isBuffer(fileData) ? fileData.toString() : fileData
		try {
			Object.assign(settings, JSON.parse(fileData) || {})
		} catch (e) {}
	}

	return settings
}

function writeSettings(settings) {
	fs.writeFileSync(getUserSettingsPath(), JSON.stringify(settings))
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
