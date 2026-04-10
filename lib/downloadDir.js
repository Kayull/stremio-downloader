const fs = require('fs')
const os = require('os')
const path = require('path')
const configDir = require('./userDir')

module.exports = {
	get: () => {
		const tempDir = path.join(os.tmpdir(), 'StremioDownloader')

		if (!fs.existsSync(tempDir))
			fs.mkdirSync(tempDir, { recursive: true })

		const userSettingsPath = path.join(configDir, 'user-settings.json')

		let downloadFolder

		if (fs.existsSync(userSettingsPath)) {
			let fileData = fs.readFileSync(userSettingsPath, 'utf8')
			fileData = Buffer.isBuffer(fileData) ? fileData.toString() : fileData
			let obj
			try {
				obj = JSON.parse(fileData)
			} catch(e) {

			}

			if ((obj || {}).folder)
				downloadFolder = obj.folder
		}

		if (!downloadFolder)
			downloadFolder = tempDir

		return downloadFolder
	},
	set: folder => {
		const userSettingsPath = path.join(configDir, 'user-settings.json')

		fs.writeFileSync(userSettingsPath, JSON.stringify({ folder }))
	}
}
