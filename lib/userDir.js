const fs = require('fs')
const path = require('path')
const os = require('os')

function getConfigDir() {
	if (process.platform === 'win32')
		return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'stremio-downloader')

	if (process.platform === 'darwin')
		return path.join(os.homedir(), 'Library', 'Application Support', 'stremio-downloader')

	return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'stremio-downloader')
}

const configDir = getConfigDir()

if (!fs.existsSync(configDir))
	fs.mkdirSync(configDir, { recursive: true })

module.exports = configDir
