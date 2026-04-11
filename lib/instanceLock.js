const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const configDir = require('./userDir')

const lockPath = path.join(configDir, 'instance-lock.json')
const ownerToken = crypto.randomBytes(16).toString('hex')

function readLock() {
	if (!fs.existsSync(lockPath))
		return null

	try {
		const raw = fs.readFileSync(lockPath, 'utf8')
		return JSON.parse(raw)
	} catch (err) {
		return null
	}
}

function isProcessAlive(pid) {
	if (!Number.isInteger(pid) || pid <= 0)
		return false

	try {
		process.kill(pid, 0)
		return true
	} catch (err) {
		return err.code === 'EPERM'
	}
}

function buildLockData() {
	return {
		app: 'stremio-downloader',
		pid: process.pid,
		ownerToken,
		startedAt: new Date().toISOString(),
		status: 'starting'
	}
}

function writeLock(data) {
	fs.writeFileSync(lockPath, JSON.stringify(data))
	return data
}

module.exports = {
	acquire: () => {
		while (true) {
			try {
				const lockData = buildLockData()
				const fd = fs.openSync(lockPath, 'wx')
				try {
					fs.writeFileSync(fd, JSON.stringify(lockData))
				} finally {
					fs.closeSync(fd)
				}
				return { acquired: true, info: lockData }
			} catch (err) {
				if (err.code !== 'EEXIST')
					throw err

				const existing = readLock()
				if (existing && isProcessAlive(existing.pid))
					return { acquired: false, info: existing }

				try {
					fs.unlinkSync(lockPath)
				} catch (unlinkErr) {
					if (unlinkErr.code !== 'ENOENT')
						throw unlinkErr
				}
			}
		}
	},
	read: readLock,
	update: patch => {
		const current = readLock()
		if (!current || current.ownerToken !== ownerToken || current.pid !== process.pid)
			return false

		writeLock(Object.assign({}, current, patch, {
			pid: process.pid,
			ownerToken
		}))
		return true
	},
	release: () => {
		const current = readLock()
		if (!current || current.ownerToken !== ownerToken || current.pid !== process.pid)
			return false

		try {
			fs.unlinkSync(lockPath)
		} catch (err) {
			if (err.code !== 'ENOENT')
				return false
		}

		return true
	},
	getPath: () => lockPath
}
