const fs = require('fs')
const path = require('path')
const configDir = require('./userDir')

const settingsPath = path.join(configDir, 'user-settings.json')

function readSettings() {
	const settings = {}

	if (fs.existsSync(settingsPath)) {
		let fileData = fs.readFileSync(settingsPath, 'utf8')
		fileData = Buffer.isBuffer(fileData) ? fileData.toString() : fileData
		try {
			Object.assign(settings, JSON.parse(fileData) || {})
		} catch (err) {}
	}

	return settings
}

function writeSettings(settings) {
	fs.writeFileSync(settingsPath, JSON.stringify(settings))
	return settings
}

module.exports = {
	getPath: () => settingsPath,
	read: readSettings,
	write: writeSettings,
	update: updater => {
		const settings = readSettings()
		const nextSettings = typeof updater === 'function'
			? (updater(settings) || settings)
			: settings

		return writeSettings(nextSettings)
	}
}
