const fs = require('fs')
const path = require('path')
const configDir = require('./userDir')
const logger = require('./logger')
const userSettings = require('./userSettings')

const storagePath = path.join(configDir, 'shell-storage.json')
const AUTH_STORAGE_KEYS = ['authKey', 'user']
const AUTH_RELATED_KEY_PATTERN = /(auth|user|token|session|profile|account|login|logout)/i
let volatileSnapshot = createEmptySnapshot()

function createEmptySnapshot() {
	return {
		localStorage: {},
		sessionStorage: {}
	}
}

function shouldPersistLoginState() {
	return userSettings.read().persistLoginState !== false
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

function removeAuthKeys(snapshot) {
	const nextSnapshot = normalizeSnapshot(snapshot)
	AUTH_STORAGE_KEYS.forEach(key => {
		delete nextSnapshot.localStorage[key]
		delete nextSnapshot.sessionStorage[key]
	})
	return nextSnapshot
}

function extractAuthKeys(snapshot) {
	const normalizedSnapshot = normalizeSnapshot(snapshot)
	const nextSnapshot = createEmptySnapshot()

	AUTH_STORAGE_KEYS.forEach(key => {
		const localValue = String(normalizedSnapshot.localStorage[key] || '').trim()
		const sessionValue = String(normalizedSnapshot.sessionStorage[key] || '').trim()

		if (localValue)
			nextSnapshot.localStorage[key] = normalizedSnapshot.localStorage[key]
		if (sessionValue)
			nextSnapshot.sessionStorage[key] = normalizedSnapshot.sessionStorage[key]
	})

	return nextSnapshot
}

function mergeSnapshots(baseSnapshot, overlaySnapshot) {
	return {
		localStorage: Object.assign({}, normalizeSnapshot(baseSnapshot).localStorage, normalizeSnapshot(overlaySnapshot).localStorage),
		sessionStorage: Object.assign({}, normalizeSnapshot(baseSnapshot).sessionStorage, normalizeSnapshot(overlaySnapshot).sessionStorage)
	}
}

function countSnapshotEntries(snapshot) {
	const normalizedSnapshot = normalizeSnapshot(snapshot)
	return Object.keys(normalizedSnapshot.localStorage).length + Object.keys(normalizedSnapshot.sessionStorage).length
}

function listPresentAuthKeys(snapshot) {
	const normalizedSnapshot = normalizeSnapshot(snapshot)
	return AUTH_STORAGE_KEYS.filter(key => {
		const localValue = String(normalizedSnapshot.localStorage[key] || '').trim()
		const sessionValue = String(normalizedSnapshot.sessionStorage[key] || '').trim()
		return !!(localValue || sessionValue)
	})
}

function getSnapshotSummary(snapshot, options) {
	const normalizedSnapshot = normalizeSnapshot(snapshot)
	const persistLoginState = shouldPersistLoginState()
	const persistedSnapshot = persistLoginState
		? normalizedSnapshot
		: removeAuthKeys(normalizedSnapshot)
	const inMemoryAuthSnapshot = persistLoginState
		? createEmptySnapshot()
		: extractAuthKeys(normalizedSnapshot)
	const authKeys = listPresentAuthKeys(normalizedSnapshot)
	const inMemoryAuthKeys = listPresentAuthKeys(inMemoryAuthSnapshot)
	const summary = {
		entries: countSnapshotEntries(normalizedSnapshot),
		localEntries: Object.keys(normalizedSnapshot.localStorage).length,
		sessionEntries: Object.keys(normalizedSnapshot.sessionStorage).length,
		persistedEntries: countSnapshotEntries(persistedSnapshot),
		authKeys,
		inMemoryAuthKeys,
		restoringLoginState: authKeys.length > 0,
		loginStateStoredInMemoryOnly: authKeys.length > 0 && !persistLoginState,
		loginStateStoredOnDisk: authKeys.length > 0 && persistLoginState,
		loginStatePersistence: authKeys.length > 0
			? (persistLoginState ? 'disk' : 'memory')
			: 'none'
	}

	return Object.assign(summary, options || {})
}

function areSnapshotsEqual(leftSnapshot, rightSnapshot) {
	return JSON.stringify(normalizeSnapshot(leftSnapshot)) === JSON.stringify(normalizeSnapshot(rightSnapshot))
}

function diffStorageArea(previousArea, nextArea) {
	const previous = normalizeStorageArea(previousArea)
	const next = normalizeStorageArea(nextArea)
	const previousKeys = Object.keys(previous)
	const nextKeys = Object.keys(next)
	const added = nextKeys.filter(key => !(key in previous)).sort()
	const removed = previousKeys.filter(key => !(key in next)).sort()
	const changed = nextKeys
		.filter(key => key in previous && previous[key] !== next[key])
		.sort()

	return {
		added,
		removed,
		changed
	}
}

function getSnapshotDiff(previousSnapshot, nextSnapshot) {
	const previous = normalizeSnapshot(previousSnapshot)
	const next = normalizeSnapshot(nextSnapshot)
	return {
		localStorage: diffStorageArea(previous.localStorage, next.localStorage),
		sessionStorage: diffStorageArea(previous.sessionStorage, next.sessionStorage)
	}
}

function listInterestingKeys(diff) {
	return Array.from(new Set([
		...diff.localStorage.added,
		...diff.localStorage.removed,
		...diff.localStorage.changed,
		...diff.sessionStorage.added,
		...diff.sessionStorage.removed,
		...diff.sessionStorage.changed
	].filter(key => AUTH_RELATED_KEY_PATTERN.test(key)))).sort()
}

function countDiffEntries(diff) {
	return diff.localStorage.added.length +
		diff.localStorage.removed.length +
		diff.localStorage.changed.length +
		diff.sessionStorage.added.length +
		diff.sessionStorage.removed.length +
		diff.sessionStorage.changed.length
}

function getSnapshotChangeMeta(previousSnapshot, nextSnapshot) {
	const diff = getSnapshotDiff(previousSnapshot, nextSnapshot)
	const authRelatedKeys = listInterestingKeys(diff)
	return {
		diff,
		authRelatedKeys,
		hasChanges: countDiffEntries(diff) > 0,
		hasAuthRelatedChanges: authRelatedKeys.length > 0
	}
}

function logSnapshotDiff(changeMeta) {
	if (!changeMeta.hasAuthRelatedChanges)
		return

	logger.info('Shell storage key changes', {
		localAdded: changeMeta.diff.localStorage.added,
		localRemoved: changeMeta.diff.localStorage.removed,
		localChanged: changeMeta.diff.localStorage.changed,
		sessionAdded: changeMeta.diff.sessionStorage.added,
		sessionRemoved: changeMeta.diff.sessionStorage.removed,
		sessionChanged: changeMeta.diff.sessionStorage.changed,
		authRelatedKeys: changeMeta.authRelatedKeys
	})
}

function readSnapshot() {
	if (!shouldPersistLoginState())
		return createEmptySnapshot()

	let persistedSnapshot = createEmptySnapshot()

	if (!fs.existsSync(storagePath))
		return mergeSnapshots(persistedSnapshot, volatileSnapshot)

	try {
		const fileData = fs.readFileSync(storagePath, 'utf8')
		persistedSnapshot = normalizeSnapshot(JSON.parse(fileData || '{}'))
	} catch (err) {
		persistedSnapshot = createEmptySnapshot()
	}

	return mergeSnapshots(persistedSnapshot, volatileSnapshot)
}

function clearSnapshot(reason) {
	const hadSnapshot = fs.existsSync(storagePath)
	const previousVolatileSnapshot = volatileSnapshot
	volatileSnapshot = createEmptySnapshot()

	try {
		fs.rmSync(storagePath, { force: true })
	} catch (err) {}

	if (listPresentAuthKeys(previousVolatileSnapshot).length) {
		logger.info('Cleared shell login state', {
			authKeys: listPresentAuthKeys(previousVolatileSnapshot),
			reason: reason || 'manual'
		})
	}

	if (hadSnapshot) {
		logger.info('Cleared shell storage snapshot', {
			path: storagePath,
			reason: reason || 'manual'
		})
	}

	return {
		snapshot: createEmptySnapshot(),
		changed: hadSnapshot
	}
}

function writePersistedSnapshot(persistedSnapshot) {
	if (countSnapshotEntries(persistedSnapshot)) {
		fs.writeFileSync(storagePath, JSON.stringify(persistedSnapshot))
		return
	}

	try {
		fs.rmSync(storagePath, { force: true })
	} catch (err) {}
}

function clearLoginState(reason) {
	const previousSnapshot = readSnapshot()
	const previousVolatileSnapshot = volatileSnapshot
	let persistedSnapshot = createEmptySnapshot()

	if (fs.existsSync(storagePath)) {
		try {
			const fileData = fs.readFileSync(storagePath, 'utf8')
			persistedSnapshot = removeAuthKeys(JSON.parse(fileData || '{}'))
		} catch (err) {
			persistedSnapshot = createEmptySnapshot()
		}
	}

	volatileSnapshot = createEmptySnapshot()
	const effectiveSnapshot = mergeSnapshots(persistedSnapshot, volatileSnapshot)

	if (listPresentAuthKeys(previousVolatileSnapshot).length) {
		logger.info('Cleared shell login state', {
			authKeys: listPresentAuthKeys(previousVolatileSnapshot),
			reason: reason || 'manual'
		})
	}

	if (areSnapshotsEqual(previousSnapshot, effectiveSnapshot))
		return {
			snapshot: effectiveSnapshot,
			changed: false
		}

	const changeMeta = getSnapshotChangeMeta(previousSnapshot, effectiveSnapshot)
	logSnapshotDiff(changeMeta)
	writePersistedSnapshot(persistedSnapshot)
	logger.info('Cleared persisted shell login state', {
		path: storagePath,
		reason: reason || 'manual'
	})

	return {
		snapshot: effectiveSnapshot,
		changed: true
	}
}

function writeSnapshot(snapshot) {
	if (!shouldPersistLoginState()) {
		volatileSnapshot = createEmptySnapshot()
		return {
			snapshot: createEmptySnapshot(),
			changed: false
		}
	}

	const previousSnapshot = readSnapshot()
	const normalizedSnapshot = normalizeSnapshot(snapshot)
	const persistedSnapshot = normalizedSnapshot
	volatileSnapshot = createEmptySnapshot()
	const effectiveSnapshot = mergeSnapshots(persistedSnapshot, volatileSnapshot)
	const previousAuthKeys = listPresentAuthKeys(previousSnapshot)
	const currentAuthKeys = listPresentAuthKeys(effectiveSnapshot)

	if (!previousAuthKeys.length && currentAuthKeys.length) {
		logger.info('Detected persisted shell login state', {
			authKeys: currentAuthKeys
		})
	} else if (previousAuthKeys.length && !currentAuthKeys.length) {
		logger.info('Cleared shell login state', {
			authKeys: previousAuthKeys,
			reason: 'missing_auth_keys_in_shell_storage_update'
		})
	}

	if (areSnapshotsEqual(previousSnapshot, effectiveSnapshot))
		return {
			snapshot: effectiveSnapshot,
			changed: false
		}

	const changeMeta = getSnapshotChangeMeta(previousSnapshot, effectiveSnapshot)
	logSnapshotDiff(changeMeta)
	writePersistedSnapshot(persistedSnapshot)
	const authStateChanged = JSON.stringify(previousAuthKeys) !== JSON.stringify(currentAuthKeys)
	if (authStateChanged) {
		logger.info('Saved shell storage snapshot', getSnapshotSummary(effectiveSnapshot, {
			path: storagePath
		}))
	}
	return {
		snapshot: effectiveSnapshot,
		changed: true
	}
}

module.exports = {
	getPath: () => storagePath,
	read: readSnapshot,
	write: writeSnapshot,
	clearSnapshot,
	clearLoginState,
	countEntries: countSnapshotEntries,
	getSummary: getSnapshotSummary
}
