const fs = require('fs')
const path = require('path')
const configDir = require('./userDir')

const logPath = path.join(configDir, 'app.log')
const maxEntries = 500

function timestamp() {
	return new Date().toISOString()
}

function stringifyPart(part) {
	if (part instanceof Error)
		return part.stack || part.message
	if (typeof part === 'string')
		return part
	try {
		return JSON.stringify(part, (key, value) => {
			if (value instanceof Error)
				return value.stack || value.message
			return value
		})
	} catch (err) {
		return String(part)
	}
}

function format(level, parts) {
	return '[' + timestamp() + '] [' + level + '] ' + parts.map(stringifyPart).join(' ')
}

function trimFile() {
	try {
		if (!fs.existsSync(logPath))
			return
		const entries = fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean)
		if (entries.length <= maxEntries)
			return
		fs.writeFileSync(logPath, entries.slice(entries.length - maxEntries).join('\n') + '\n')
	} catch (err) {}
}

function append(level, parts) {
	const line = format(level, parts)
	try {
		fs.appendFileSync(logPath, line + '\n')
		trimFile()
	} catch (err) {}
	return line
}

module.exports = {
	info: (...parts) => append('INFO', parts),
	warn: (...parts) => append('WARN', parts),
	error: (...parts) => append('ERROR', parts),
	list: () => {
		try {
			if (!fs.existsSync(logPath))
				return ''
			return fs.readFileSync(logPath, 'utf8')
		} catch (err) {
			return ''
		}
	},
	clear: () => {
		try {
			fs.writeFileSync(logPath, '')
		} catch (err) {}
		return true
	},
	getPath: () => logPath
}
