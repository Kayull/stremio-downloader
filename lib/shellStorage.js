const fs = require('fs')
const path = require('path')
const configDir = require('./userDir')
const logger = require('./logger')

const storagePath = path.join(configDir, 'shell-storage.json')
let hasLoggedWrite = false

function createEmptySnapshot() {
	return {
		localStorage: {},
		sessionStorage: {}
	}
}

function normalizeStorageArea(area) {
	const normalized = {}

	if (!area || typeof area !== 'object')
		return normalized

	Object.entries(area).forEach(([key, value]) => {
		const normalizedKey = String(key || '').trim()
		if (!normalizedKey)
			return

		normalized[normalizedKey] = String(value == null ? '' : value)
	})

	return normalized
}

function normalizeSnapshot(snapshot) {
	const nextSnapshot = createEmptySnapshot()

	if (!snapshot || typeof snapshot !== 'object')
		return nextSnapshot

	nextSnapshot.localStorage = normalizeStorageArea(snapshot.localStorage)
	nextSnapshot.sessionStorage = normalizeStorageArea(snapshot.sessionStorage)

	return nextSnapshot
}

function countSnapshotEntries(snapshot) {
	const normalizedSnapshot = normalizeSnapshot(snapshot)
	return Object.keys(normalizedSnapshot.localStorage).length + Object.keys(normalizedSnapshot.sessionStorage).length
}

function readSnapshot() {
	if (!fs.existsSync(storagePath))
		return createEmptySnapshot()

	try {
		const fileData = fs.readFileSync(storagePath, 'utf8')
		return normalizeSnapshot(JSON.parse(fileData || '{}'))
	} catch (err) {
		return createEmptySnapshot()
	}
}

function writeSnapshot(snapshot) {
	const previousSnapshot = readSnapshot()
	const normalizedSnapshot = normalizeSnapshot(snapshot)

	if (JSON.stringify(previousSnapshot) === JSON.stringify(normalizedSnapshot))
		return {
			snapshot: normalizedSnapshot,
			changed: false
		}

	fs.writeFileSync(storagePath, JSON.stringify(normalizedSnapshot))
	if (!hasLoggedWrite) {
		hasLoggedWrite = true
		logger.info('Saved shell storage snapshot', {
			path: storagePath,
			entries: countSnapshotEntries(normalizedSnapshot)
		})
	}
	return {
		snapshot: normalizedSnapshot,
		changed: true
	}
}

module.exports = {
	getPath: () => storagePath,
	read: readSnapshot,
	write: writeSnapshot,
	countEntries: countSnapshotEntries
}
