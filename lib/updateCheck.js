const fs = require('fs')
const path = require('path')
const logger = require('./logger')

const RELEASE_OWNER = 'Kayull'
const RELEASE_REPO = 'stremio-downloader'
const RELEASES_BASE_URL = `https://github.com/${RELEASE_OWNER}/${RELEASE_REPO}/releases`
const RELEASE_API_URL = `https://api.github.com/repos/${RELEASE_OWNER}/${RELEASE_REPO}/releases/latest`
const REQUEST_TIMEOUT_MS = 4000
const appRoot = path.resolve(__dirname, '..')

const state = {
	currentVersion: '',
	latestVersion: '',
	releaseUrl: RELEASES_BASE_URL,
	assets: [],
	updateAsset: null,
	updateAvailable: false,
	checkedAt: '',
	error: ''
}

let inFlight = null

function readCurrentVersion() {
	try {
		const versionFilePath = path.join(appRoot, 'VERSION')
		if (fs.existsSync(versionFilePath))
			return String(fs.readFileSync(versionFilePath, 'utf8') || '').trim()

		const packageJsonPath = path.join(appRoot, 'package.json')
		const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'))
		return String(packageJson.version || '').trim()
	} catch (err) {
		logger.warn('Could not read current app version for update check', err)
		return ''
	}
}

function normalizeVersion(version) {
	return String(version || '').trim().replace(/^v/i, '')
}

function parseVersion(version) {
	const normalized = normalizeVersion(version)
	const match = normalized.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/)
	if (!match)
		return null

	return {
		major: Number(match[1]),
		minor: Number(match[2]),
		patch: Number(match[3]),
		prerelease: match[4] || ''
	}
}

function compareVersions(left, right) {
	const a = parseVersion(left)
	const b = parseVersion(right)

	if (!a || !b)
		return 0

	if (a.major !== b.major)
		return a.major - b.major
	if (a.minor !== b.minor)
		return a.minor - b.minor
	if (a.patch !== b.patch)
		return a.patch - b.patch
	if (!a.prerelease && b.prerelease)
		return 1
	if (a.prerelease && !b.prerelease)
		return -1

	return a.prerelease.localeCompare(b.prerelease)
}

function getPlatformAssetRule(platform) {
	if (platform === 'darwin') {
		return {
			platform: 'darwin',
			platformAction: 'open-dmg',
			extension: '.dmg',
			pattern: /stremio-downloader-.*-macos-universal\.dmg$/i
		}
	}

	if (platform === 'win32') {
		return {
			platform: 'win32',
			platformAction: 'replace-windows-portable',
			extension: '.zip',
			pattern: /stremio-downloader-.*-windows-x64\.zip$/i
		}
	}

	return null
}

function normalizeReleaseAsset(asset) {
	const name = String((asset || {}).name || '').trim()
	const downloadUrl = String((asset || {}).browser_download_url || '').trim()
	if (!name || !downloadUrl)
		return null

	return {
		name,
		downloadUrl,
		size: Number((asset || {}).size) || 0,
		contentType: String((asset || {}).content_type || '')
	}
}

function selectUpdateAsset(assets, platform) {
	const rule = getPlatformAssetRule(platform || process.platform)
	if (!rule)
		return null

	const asset = (assets || []).find(candidate => rule.pattern.test(candidate.name))
	if (!asset)
		return null

	return Object.assign({}, asset, {
		platform: rule.platform,
		platformAction: rule.platformAction,
		extension: rule.extension
	})
}

function getSnapshot() {
	return Object.assign({}, state, {
		currentVersion: state.currentVersion || readCurrentVersion() || '',
		assets: state.assets.map(asset => Object.assign({}, asset)),
		updateAsset: state.updateAsset ? Object.assign({}, state.updateAsset) : null
	})
}

async function fetchLatestRelease() {
	const controller = new AbortController()
	const timeout = setTimeout(() => {
		controller.abort()
	}, REQUEST_TIMEOUT_MS)

	try {
		const response = await fetch(RELEASE_API_URL, {
			signal: controller.signal,
			headers: {
				accept: 'application/vnd.github+json',
				'user-agent': 'stremio-downloader-update-check'
			}
		})
		if (!response.ok)
			throw new Error('GitHub release check failed with status ' + response.status)

		const payload = await response.json()
		const latestVersion = normalizeVersion(payload.tag_name || payload.name || '')
		const releaseUrl = String(payload.html_url || RELEASES_BASE_URL)
		const assets = Array.isArray(payload.assets)
			? payload.assets.map(normalizeReleaseAsset).filter(Boolean)
			: []

		if (!latestVersion)
			throw new Error('GitHub release check returned no version tag')

		return {
			latestVersion,
			releaseUrl,
			assets
		}
	} finally {
		clearTimeout(timeout)
	}
}

async function check() {
	if (state.checkedAt)
		return getSnapshot()

	if (inFlight)
		return inFlight

	inFlight = (async () => {
		const currentVersion = normalizeVersion(readCurrentVersion())
		state.currentVersion = currentVersion
		state.error = ''

		try {
			const latestRelease = await fetchLatestRelease()
			state.latestVersion = latestRelease.latestVersion
			state.releaseUrl = latestRelease.releaseUrl
			state.assets = latestRelease.assets
			state.updateAvailable = !!currentVersion && compareVersions(latestRelease.latestVersion, currentVersion) > 0
			state.updateAsset = state.updateAvailable ? selectUpdateAsset(latestRelease.assets) : null
			state.checkedAt = new Date().toISOString()
			logger.info('Checked for application updates', {
				currentVersion: state.currentVersion,
				latestVersion: state.latestVersion,
				updateAvailable: state.updateAvailable,
				releaseUrl: state.releaseUrl,
				updateAsset: state.updateAsset ? state.updateAsset.name : ''
			})
			return getSnapshot()
		} catch (err) {
			state.checkedAt = new Date().toISOString()
			state.error = err.message || String(err)
			logger.warn('Application update check failed', {
				currentVersion: state.currentVersion,
				error: state.error
			})
			return getSnapshot()
		} finally {
			inFlight = null
		}
	})()

	return inFlight
}

function begin() {
	check().catch(() => {})
}

module.exports = {
	check,
	begin,
	getSnapshot,
	selectUpdateAsset,
	getReleaseUrl: version => `${RELEASES_BASE_URL}/tag/v${normalizeVersion(version)}`
}
