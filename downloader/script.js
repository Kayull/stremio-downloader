function buildApiUrl(method, url, filename, extraParams) {
	const params = new URLSearchParams()
	params.set('method', method)
	if (url)
		params.set('url', url)
	if (filename)
		params.set('filename', filename)
	Object.entries(extraParams || {}).forEach(([key, value]) => {
		if (value != null)
			params.set(key, value)
	})
	return '/api?' + params.toString()
}

function request(method, url, filename, cb, extraParams) {
	const jqxhr = $.ajax({
		url: buildApiUrl(method, url, filename, extraParams),
		type: 'GET',
		dataType: 'text'
	})

	if (cb)
		jqxhr.done(cb)

	return jqxhr
}

function requestPromise(method, url, filename, extraParams) {
	return new Promise((resolve, reject) => {
		request(method, url, filename, null, extraParams).done(resolve).fail(reject)
	})
}

function parseJsonResponse(responseText) {
	try {
		return JSON.parse(responseText || '{}')
	} catch (err) {
		return {}
	}
}

async function requestJson(method, url, filename, extraParams) {
	const responseText = await requestPromise(method, url, filename, extraParams)
	return parseJsonResponse(responseText)
}

function escapeHtml(value) {
	return String(value || '').replace(/[&<>"']/g, char => ({
		'&': '&amp;',
		'<': '&lt;',
		'>': '&gt;',
		'"': '&quot;',
		"'": '&#39;'
	}[char]))
}

function escapeAttribute(value) {
	return escapeHtml(value)
}

function decodeDisplayValue(value) {
	if (!value || typeof value !== 'string')
		return value || ''
	if (!value.includes('%'))
		return value
	try {
		return decodeURIComponent(value)
	} catch (err) {
		return value.replace(/%20/g, ' ')
	}
}

function clampProgress(progress) {
	const numeric = Number(progress)
	if (!Number.isFinite(numeric))
		return 0
	return Math.max(0, Math.min(100, Math.round(numeric)))
}

function cloneFiles(files) {
	return JSON.parse(JSON.stringify(files || []))
}

function normalizeThemeMode(value) {
	return value === 'light' ? 'light' : 'dark'
}

const LIST_REFRESH_INTERVAL_MS = 500
const desktopMode = new URLSearchParams(window.location.search).get('desktop') === '1'
const PENDING_ACTION_METHODS = ['remove-download', 'stop-download']
const THEME_STORAGE_KEY = 'stremio-downloader-theme-mode'

function formatExtension(filename) {
	const decoded = decodeDisplayValue(filename)
	const parts = decoded.split('.')
	if (parts.length < 2)
		return 'FILE'
	return parts.pop().toUpperCase()
}

function formatBytes(bytes) {
	const value = Number(bytes)
	if (!Number.isFinite(value) || value <= 0)
		return '0 B'

	const units = ['B', 'KB', 'MB', 'GB', 'TB']
	let size = value
	let unitIndex = 0
	while (size >= 1024 && unitIndex < units.length - 1) {
		size /= 1024
		unitIndex += 1
	}

	const decimals = size >= 100 || unitIndex === 0 ? 0 : 1
	return size.toFixed(decimals) + ' ' + units[unitIndex]
}

function formatEta(seconds) {
	const value = Number(seconds)
	if (!Number.isFinite(value) || value < 0)
		return null
	if (value < 60)
		return Math.max(1, Math.round(value)) + 's'

	const hours = Math.floor(value / 3600)
	const minutes = Math.floor((value % 3600) / 60)
	const secs = Math.floor(value % 60)

	if (hours > 0)
		return hours + 'h ' + String(minutes).padStart(2, '0') + 'm'
	if (minutes > 0)
		return minutes + 'm ' + String(secs).padStart(2, '0') + 's'
	return secs + 's'
}

function getDownloadStats(file) {
	if (file.completed || file.error || file.stopped || file.missingOnDisk)
		return []

	const now = Date.now()
	const startedAt = Number(file.time) || now
	const elapsedSeconds = Math.max((now - startedAt) / 1000, 1)
	const current = Math.max(0, Number(file.current) || 0)
	const total = Math.max(0, Number(file.total) || 0)
	const speed = current > 0 ? current / elapsedSeconds : 0
	const stats = []

	if (file.isHls) {
		stats.push('Captured ' + formatBytes(current))
		if (speed > 0)
			stats.push(formatBytes(speed) + '/s')
		return stats
	}

	if (total > 0)
		stats.push(formatBytes(current) + ' / ' + formatBytes(total))
	else
		stats.push(formatBytes(current))

	if (speed > 0)
		stats.push(formatBytes(speed) + '/s')

	if (total > current && speed > 0) {
		const eta = formatEta((total - current) / speed)
		if (eta)
			stats.push('ETA ' + eta)
	}

	return stats
}

function getSourceKindModel(file) {
	const sourceKind = file.sourceKind || (file.isHls ? 'hls-stream' : 'direct-http')

	if (sourceKind === 'torrent-via-stremio' || sourceKind === 'torrent-remote-playback')
		return { label: 'Torrent', className: 'source-pill-torrent' }
	if (sourceKind === 'hls-stream')
		return { label: 'HLS', className: 'source-pill-hls' }
	return { label: 'Web DL', className: 'source-pill-web' }
}

function getStatusModel(file) {
	if (file.missingOnDisk)
		return { label: 'Missing', className: 'status-missing', detail: 'Download completed, but the file is not found in the download folder.' }
	if (file.error)
		return { label: 'Error', className: 'status-error', detail: 'Download failed.' }
	if (file.completed)
		return { label: 'Completed', className: 'status-completed', detail: 'Saved in download folder.' }
	if (file.stopped)
		return { label: 'Stopped', className: 'status-stopped', detail: 'Download stopped.' }
	if (file.isHls)
		return { label: 'Capturing', className: 'status-downloading', detail: '' }
	return { label: 'Downloading', className: 'status-downloading', detail: '' }
}

function getProgressPillMarkup(file, progress) {
	if (file.completed || file.error || file.stopped || file.missingOnDisk)
		return ''

	return '<span class="meta-pill progress-pill">' + escapeHtml(file.isHls ? 'Live HLS stream' : progress + '% complete') + '</span>'
}

function renderActionButton(label, icon, method, url, filename, accentClassName, playUrl) {
	return '' +
		'<button type="button" class="action-button' + (accentClassName ? (' ' + accentClassName) : '') + ' js-action" aria-label="' + escapeAttribute(label) + '" title="' + escapeAttribute(label) + '"' +
			' data-method="' + escapeAttribute(method) + '"' +
			(url ? ' data-url="' + escapeAttribute(url) + '"' : '') +
			(filename ? ' data-filename="' + escapeAttribute(filename) + '"' : '') +
			(playUrl ? ' data-play-url="' + escapeAttribute(playUrl) + '"' : '') +
		'>' +
			'<span class="action-icon" aria-hidden="true">' + icon + '</span>' +
			'<span class="action-label">' + escapeHtml(label) + '</span>' +
		'</button>'
}

function iconSvg(name) {
	const icons = {
		trash: '<svg viewBox="0 0 24 24" focusable="false"><path d="M19,6 L19,18.5 C19,19.8807119 17.8807119,21 16.5,21 L7.5,21 C6.11928813,21 5,19.8807119 5,18.5 L5,6 L4.5,6 C4.22385763,6 4,5.77614237 4,5.5 C4,5.22385763 4.22385763,5 4.5,5 L9,5 L9,4.5 C9,3.67157288 9.67157288,3 10.5,3 L13.5,3 C14.3284271,3 15,3.67157288 15,4.5 L15,5 L19.5,5 C19.7761424,5 20,5.22385763 20,5.5 C20,5.77614237 19.7761424,6 19.5,6 L19,6 Z M6,6 L6,18.5 C6,19.3284271 6.67157288,20 7.5,20 L16.5,20 C17.3284271,20 18,19.3284271 18,18.5 L18,6 L6,6 Z M14,5 L14,4.5 C14,4.22385763 13.7761424,4 13.5,4 L10.5,4 C10.2238576,4 10,4.22385763 10,4.5 L10,5 L14,5 Z M14,9.5 C14,9.22385763 14.2238576,9 14.5,9 C14.7761424,9 15,9.22385763 15,9.5 L15,16.5 C15,16.7761424 14.7761424,17 14.5,17 C14.2238576,17 14,16.7761424 14,16.5 L14,9.5 Z M9,9.5 C9,9.22385763 9.22385763,9 9.5,9 C9.77614237,9 10,9.22385763 10,9.5 L10,16.5 C10,16.7761424 9.77614237,17 9.5,17 C9.22385763,17 9,16.7761424 9,16.5 L9,9.5 Z"></path></svg>',
		folder: '<svg viewBox="0 0 24 24" focusable="false"><path d="M21,8V19a1,1,0,0,1-1,1H4a1,1,0,0,1-1-1V5A1,1,0,0,1,4,4H9.59a1,1,0,0,1,.7.29l2.42,2.42a1,1,0,0,0,.7.29H20A1,1,0,0,1,21,8Z"></path></svg>',
		moon: '<svg viewBox="0 0 24 24" focusable="false"><path d="M21.64,13a1,1,0,0,0-1.05-.14,8.05,8.05,0,0,1-3.37.73A8.15,8.15,0,0,1,9.08,5.49a8.59,8.59,0,0,1,.25-2A1,1,0,0,0,8,2.36,10.14,10.14,0,1,0,22,14.05,1,1,0,0,0,21.64,13Zm-9.5,6.69A8.14,8.14,0,0,1,7.08,5.22v.27A10.15,10.15,0,0,0,17.22,15.63a9.79,9.79,0,0,0,2.1-.22A8.11,8.11,0,0,1,12.14,19.73Z"></path></svg>',
		sun: '<svg viewBox="0 0 24 24" focusable="false"><path d="M5.64,17l-.71.71a1,1,0,0,0,0,1.41,1,1,0,0,0,1.41,0l.71-.71A1,1,0,0,0,5.64,17ZM5,12a1,1,0,0,0-1-1H3a1,1,0,0,0,0,2H4A1,1,0,0,0,5,12Zm7-7a1,1,0,0,0,1-1V3a1,1,0,0,0-2,0V4A1,1,0,0,0,12,5ZM5.64,7.05a1,1,0,0,0,.7.29,1,1,0,0,0,.71-.29,1,1,0,0,0,0-1.41l-.71-.71A1,1,0,0,0,4.93,6.34Zm12,.29a1,1,0,0,0,.7-.29l.71-.71a1,1,0,1,0-1.41-1.41L17,5.64a1,1,0,0,0,0,1.41A1,1,0,0,0,17.66,7.34ZM21,11H20a1,1,0,0,0,0,2h1a1,1,0,0,0,0-2Zm-9,8a1,1,0,0,0-1,1v1a1,1,0,0,0,2,0V20A1,1,0,0,0,12,19ZM18.36,17A1,1,0,0,0,17,18.36l.71.71a1,1,0,0,0,1.41,0,1,1,0,0,0,0-1.41ZM12,6.5A5.5,5.5,0,1,0,17.5,12,5.51,5.51,0,0,0,12,6.5Zm0,9A3.5,3.5,0,1,1,15.5,12,3.5,3.5,0,0,1,12,15.5Z"></path></svg>',
		play: '<svg viewBox="0 0 24 24" focusable="false"><path d="M8 5v14l11-7L8 5Z"></path></svg>',
		stop: '<svg viewBox="0 0 24 24" focusable="false"><path d="M7 7h10v10H7V7Z"></path></svg>',
		restart: '<svg viewBox="0 0 24 24" focusable="false"><path d="M17.91 14c-.478 2.833-2.943 5-5.91 5-3.308 0-6-2.692-6-6s2.692-6 6-6h2.172l-2.086 2.086L13.5 10.5 18 6l-4.5-4.5-1.414 1.414L14.172 5H12c-4.418 0-8 3.582-8 8s3.582 8 8 8c4.08 0 7.438-3.055 7.93-7h-2.02z"></path></svg>',
		logs: '<svg viewBox="0 0 24 24" focusable="false"><path d="M5.293 5.293a1 1 0 0 1 1.414 0L12 10.586l5.293-5.293a1 1 0 1 1 1.414 1.414L13.414 12l5.293 5.293a1 1 0 0 1-1.414 1.414L12 13.414l-5.293 5.293a1 1 0 0 1-1.414-1.414L10.586 12 5.293 6.707a1 1 0 0 1 0-1.414z"></path></svg>'
	}

	return icons[name] || ''
}

function fileToCard(file) {
	const status = getStatusModel(file)
	const sourceKind = getSourceKindModel(file)
	const displayName = decodeDisplayValue(file.filename)
	const progress = clampProgress(file.progress)
	const downloadStats = getDownloadStats(file)
	const metaPills = [
		'<span class="status-pill ' + status.className + '">' + escapeHtml(status.label) + '</span>',
		'<span class="meta-pill source-pill ' + sourceKind.className + '">' + escapeHtml(sourceKind.label) + '</span>',
		'<span class="meta-pill">' + escapeHtml(formatExtension(displayName)) + '</span>'
	]
	const progressPill = getProgressPillMarkup(file, progress)

	let actionButtons = ''

	if (file.missingOnDisk)
		actionButtons += renderActionButton('Open Folder', iconSvg('folder'), 'open-folder', null, null)
	else if (file.error || file.stopped)
		actionButtons += renderActionButton('Retry', iconSvg('restart'), 'restart-download', file.url, file.filename, 'action-button-strong')
	else if (file.completed) {
		actionButtons += renderActionButton('Reveal', iconSvg('folder'), 'open-location', file.url, file.filename)
		actionButtons += renderActionButton('Play', iconSvg('play'), 'play-video', file.url, file.filename, null, file.playUrl)
	} else
		actionButtons += renderActionButton('Stop', iconSvg('stop'), 'stop-download', file.url, file.filename)

	actionButtons += renderActionButton('Remove', iconSvg('trash'), 'remove-download', file.url, file.filename, 'action-button-danger')

	const progressBar = (!file.completed && !file.error && !file.stopped && !file.missingOnDisk)
		? '' +
				'<div class="progress-track' + (file.isHls ? ' progress-indeterminate' : '') + '">' +
					'<div class="progress-fill"' + (file.isHls ? '' : ' style="width: ' + progress + '%"') + '></div>' +
				'</div>'
		: ''

	const statItems = []
	if (progressPill)
		statItems.push(progressPill)
	statItems.push(...downloadStats.map(stat => '<span class="download-stat">' + escapeHtml(stat) + '</span>'))
	const statsRow = statItems.length
		? '<div class="download-stats">' + statItems.join('') + '</div>'
		: ''

	return '' +
			'<article class="download-card">' +
				'<div class="download-main">' +
					'<h3 class="download-name">' + escapeHtml(displayName) + '</h3>' +
					'<p class="download-subtitle">' + escapeHtml(status.detail) + '</p>' +
					'<div class="download-meta">' + metaPills.join('') + '</div>' +
					statsRow +
				'</div>' +
				'<div class="download-actions">' + actionButtons + '</div>' +
				'<div class="download-progress-slot">' + progressBar + '</div>' +
			'</article>'
}

function getFileKey(file) {
	return file.url || file.filename || String(file.time || '')
}

function getMetaPillsMarkup(file, status, sourceKind, displayName) {
	return [
		'<span class="status-pill ' + status.className + '">' + escapeHtml(status.label) + '</span>',
		'<span class="meta-pill source-pill ' + sourceKind.className + '">' + escapeHtml(sourceKind.label) + '</span>',
		'<span class="meta-pill">' + escapeHtml(formatExtension(displayName)) + '</span>'
	].join('')
}

function getActionButtonsMarkup(file) {
	let actionButtons = ''

	if (file.missingOnDisk)
		actionButtons += renderActionButton('Open Folder', iconSvg('folder'), 'open-folder', null, null)
	else if (file.error || file.stopped)
		actionButtons += renderActionButton('Retry', iconSvg('restart'), 'restart-download', file.url, file.filename, 'action-button-strong')
	else if (file.completed) {
		actionButtons += renderActionButton('Reveal', iconSvg('folder'), 'open-location', file.url, file.filename)
		actionButtons += renderActionButton('Play', iconSvg('play'), 'play-video', file.url, file.filename, null, file.playUrl)
	} else
		actionButtons += renderActionButton('Stop', iconSvg('stop'), 'stop-download', file.url, file.filename)

	actionButtons += renderActionButton('Remove', iconSvg('trash'), 'remove-download', file.url, file.filename, 'action-button-danger')
	return actionButtons
}

function getProgressMarkup(file, progress) {
	if (file.completed || file.error || file.stopped || file.missingOnDisk)
		return ''

	return '' +
		'<div class="progress-track' + (file.isHls ? ' progress-indeterminate' : '') + '">' +
			'<div class="progress-fill"' + (file.isHls ? '' : ' style="width: ' + progress + '%"') + '></div>' +
		'</div>'
}

function createDownloadCardElement(file) {
	const card = document.createElement('article')
	card.className = 'download-card'
	card.dataset.key = getFileKey(file)
	card.innerHTML = '' +
		'<div class="download-main">' +
			'<h3 class="download-name"></h3>' +
			'<p class="download-subtitle"></p>' +
			'<div class="download-meta"></div>' +
			'<div class="download-stats"></div>' +
		'</div>' +
		'<div class="download-actions"></div>' +
		'<div class="download-progress-slot"></div>'
	updateDownloadCardElement(card, file)
	return card
}

function updateDownloadCardElement(card, file) {
	const status = getStatusModel(file)
	const sourceKind = getSourceKindModel(file)
	const displayName = decodeDisplayValue(file.filename)
	const progress = clampProgress(file.progress)
	const downloadStats = getDownloadStats(file)
	const metaMarkup = getMetaPillsMarkup(file, status, sourceKind, displayName)
	const progressPill = getProgressPillMarkup(file, progress)
	const statItems = []
	if (progressPill)
		statItems.push(progressPill)
	statItems.push(...downloadStats.map(stat => '<span class="download-stat">' + escapeHtml(stat) + '</span>'))
	const statsMarkup = statItems.join('')
	const progressMarkup = getProgressMarkup(file, progress)
	const actionMarkup = getActionButtonsMarkup(file)

	card.dataset.key = getFileKey(file)
	card.querySelector('.download-name').textContent = displayName
	card.querySelector('.download-subtitle').textContent = status.detail
	card.querySelector('.download-meta').innerHTML = metaMarkup
	card.querySelector('.download-stats').innerHTML = statsMarkup
	card.querySelector('.download-progress-slot').innerHTML = progressMarkup

	const actions = card.querySelector('.download-actions')
	if (actions.dataset.signature !== actionMarkup) {
		actions.innerHTML = actionMarkup
		actions.dataset.signature = actionMarkup
	}
}

function syncDownloadCards(files) {
	const container = document.getElementById('downloads')
	Array.from(container.children).forEach(child => {
		if (!child.classList.contains('download-card'))
			child.remove()
	})
	const existingCards = new Map(Array.from(container.querySelectorAll('.download-card')).map(card => [card.dataset.key, card]))

	files.forEach((file, index) => {
		const key = getFileKey(file)
		const currentNode = container.children[index]
		const card = existingCards.get(key) || createDownloadCardElement(file)
		updateDownloadCardElement(card, file)
		if (currentNode !== card)
			container.insertBefore(card, currentNode || null)
		existingCards.delete(key)
	})

	existingCards.forEach(card => {
		card.remove()
	})
}

function renderEmptyState(message, detail) {
	$('#downloads').html('' +
		'<div class="downloads-empty">' +
			'<div>' +
				'<strong>' + escapeHtml(message) + '</strong>' +
				'<span>' + escapeHtml(detail) + '</span>' +
			'</div>' +
		'</div>'
	)
}

function getStoredThemeMode() {
	try {
		const storedThemeMode = window.localStorage.getItem(THEME_STORAGE_KEY)
		return storedThemeMode ? normalizeThemeMode(storedThemeMode) : null
	} catch (err) {
		return null
	}
}

function setStoredThemeMode(mode) {
	try {
		window.localStorage.setItem(THEME_STORAGE_KEY, normalizeThemeMode(mode))
	} catch (err) {}
}

function updateThemeToggle() {
	const button = document.getElementById('theme-toggle')
	if (!button)
		return

	const isDarkMode = currentThemeMode === 'dark'
	button.setAttribute('aria-pressed', String(isDarkMode))
	button.setAttribute('title', isDarkMode ? 'Switch to light mode' : 'Switch to dark mode')

	const icon = button.querySelector('.theme-toggle-icon')
	if (icon)
		icon.innerHTML = iconSvg(isDarkMode ? 'sun' : 'moon')

	const label = button.querySelector('.theme-toggle-label')
	if (label)
		label.textContent = isDarkMode ? 'Light mode' : 'Dark mode'
}

function applyTheme(mode) {
	const nextThemeMode = normalizeThemeMode(mode)
	currentThemeMode = nextThemeMode
	document.body.dataset.theme = nextThemeMode
	updateThemeToggle()
}

function getSettingsModel(settings) {
	const model = settings && typeof settings === 'object' ? settings : {}
	return {
		folder: model.folder || 'Unavailable',
		useShowSubfolders: model.useShowSubfolders !== false,
		themeMode: normalizeThemeMode(model.themeMode)
	}
}

async function loadAppSettings() {
	const settings = getSettingsModel(await requestJson('download-settings'))
	const storedThemeMode = getStoredThemeMode()
	applyTheme(storedThemeMode || settings.themeMode)
	return settings
}

async function persistThemeMode(mode) {
	const nextThemeMode = normalizeThemeMode(mode)
	setStoredThemeMode(nextThemeMode)

	try {
		const result = await requestJson('set-theme-mode', null, null, { mode: nextThemeMode })
		const savedThemeMode = normalizeThemeMode(result.themeMode || nextThemeMode)
		setStoredThemeMode(savedThemeMode)
		return savedThemeMode
	} catch (err) {
		return nextThemeMode
	}
}

function isPendingActionMethod(method) {
	return PENDING_ACTION_METHODS.includes(method)
}

function getPendingActionId(method, url) {
	return method + '::' + String(url || '')
}

function getPendingActionLabel(method) {
	if (method === 'remove-download')
		return 'Removing'
	if (method === 'stop-download')
		return 'Stopping'
	return 'Processing'
}

function formatPendingActionText(action) {
	const name = decodeDisplayValue(action.filename) || 'download'
	return getPendingActionLabel(action.method) + ' ' + name
}

function updatePendingActionsDetail() {
	const detail = document.getElementById('pending-actions')
	if (!detail)
		return

	if (!pendingActions.length) {
		detail.textContent = ''
		detail.title = ''
		detail.classList.remove('is-visible')
		return
	}

	const previews = pendingActions.slice(0, 2).map(formatPendingActionText)
	const overflowCount = pendingActions.length - previews.length
	const summary = (pendingActions.length === 1 ? '1 pending action' : (pendingActions.length + ' pending actions')) +
		': ' +
		previews.join(' • ') +
		(overflowCount > 0 ? (' • +' + overflowCount + ' more') : '')

	detail.textContent = summary
	detail.title = summary
	detail.classList.add('is-visible')
}

function applyFileAction(files, method, url) {
	const list = Array.isArray(files) ? files : []

	if (!url)
		return list.slice()

	if (method === 'remove-download')
		return list.filter(file => file.url !== url)

	if (method === 'stop-download') {
		return list.map(file => file.url === url
			? Object.assign({}, file, { stopped: true })
			: file
		)
	}

	return list.slice()
}

function getVisibleFiles(files) {
	return pendingActions.reduce((nextFiles, action) => applyFileAction(nextFiles, action.method, action.url), cloneFiles(files))
}

function syncCurrentFiles() {
	currentFiles = getVisibleFiles(serverFiles)
	renderDownloads()
}

function addPendingAction(method, url, filename) {
	if (!isPendingActionMethod(method) || !url)
		return null

	const actionId = getPendingActionId(method, url)
	if (pendingActions.some(action => action.id === actionId))
		return actionId

	pendingActions = pendingActions.concat({
		id: actionId,
		method,
		url,
		filename: decodeDisplayValue(filename)
	})
	syncCurrentFiles()
	return actionId
}

function removePendingAction(actionId) {
	if (!actionId)
		return

	const nextPendingActions = pendingActions.filter(action => action.id !== actionId)
	if (nextPendingActions.length === pendingActions.length)
		return

	pendingActions = nextPendingActions
	syncCurrentFiles()
}

function renderLogViewer(query) {
	const logViewer = dialog.querySelector('.log-viewer')
	const searchMeta = dialog.querySelector('.dialog-search-meta')
	if (!logViewer)
		return

	const lines = String(currentLogText || '').split('\n')
	const normalizedQuery = (query || '').trim().toLowerCase()
	const filteredLines = normalizedQuery
		? lines.filter(line => line.toLowerCase().includes(normalizedQuery))
		: lines
	const visibleLines = filteredLines.filter(line => line.length > 0)
	const content = filteredLines.join('\n').trim() || (normalizedQuery ? 'No log lines match this search.' : 'No logs yet.')

	logViewer.textContent = content

	if (searchMeta)
		searchMeta.textContent = normalizedQuery
			? ('Showing ' + visibleLines.length + ' of ' + lines.filter(line => line.length > 0).length + ' lines')
			: ''

	logViewer.scrollTop = normalizedQuery ? 0 : logViewer.scrollHeight
}

function updateResultCount(count) {
	$('#result-count').text(count + ' item' + (count === 1 ? '' : 's'))
}

function getRequestFailureMessage(err, fallbackMessage) {
	const payload = parseJsonResponse((err || {}).responseText)
	return payload.message || fallbackMessage || 'The action could not be completed.'
}

function showErrorDialog(title, copy) {
	showDialog(title, copy, [
		{
			label: 'Close',
			className: 'dialog-button-primary',
			closeOnly: true
		}
	])
}

function getStremioUrl() {
	return window.location.origin + '/web/app.strem.io/shell-v4.4/'
}

function openBrowserUrl(url, target) {
	if (!url)
		return false

	const openedWindow = window.open(url, target || '_blank', 'noopener')
	if (openedWindow)
		openedWindow.opener = null
	return !!openedWindow
}

function openStremioInBrowser() {
	openBrowserUrl(getStremioUrl(), '_blank')
}

function getLaunchParams() {
	return desktopMode
		? { launch: 'true' }
		: null
}

function showDialog(title, copy, actions) {
	dialog.classList.remove('dialog-large')
	dialog.classList.remove('dialog-options')
	let str = '' +
		'<div class="dialog-stack">' +
			'<div>' +
				'<h2 class="dialog-title">' + escapeHtml(title) + '</h2>' +
				'<p class="dialog-copy">' + escapeHtml(copy) + '</p>' +
			'</div>'

	actions.forEach(action => {
		str += '' +
			'<button type="button" class="dialog-button js-dialog-action ' + (action.className || '') + '"' +
				(action.method ? ' data-method="' + escapeAttribute(action.method) + '"' : '') +
				(action.url ? ' data-url="' + escapeAttribute(action.url) + '"' : '') +
				(action.filename ? ' data-filename="' + escapeAttribute(action.filename) + '"' : '') +
				(action.closeOnly ? ' data-close-only="true"' : '') +
			'>' +
				escapeHtml(action.label) +
			'</button>'
	})

	str += '</div>'

	$('#dialog').html(str)
	if (!dialog.open)
		dialog.showModal()
	setTimeout(() => {
		document.activeElement.blur()
	})
}

function options() {
	request('download-settings', null, null, settingsResponse => {
		let settings = {}
		try {
			settings = JSON.parse(settingsResponse || '{}')
		} catch (err) {}
		const settingsModel = getSettingsModel(settings)
		const folder = settingsModel.folder
		const useShowSubfolders = settingsModel.useShowSubfolders
		dialog.classList.remove('dialog-large')
		dialog.classList.add('dialog-options')
			$('#dialog').html('' +
			'<div class="dialog-stack dialog-stack-options">' +
				'<div>' +
					'<h2 class="dialog-title">Downloader options</h2>' +
				'</div>' +
				'<div class="dialog-info-card">' +
					'<span class="dialog-info-label">Download Folder</span>' +
					'<code class="dialog-info-value">' + escapeHtml(folder || 'Unavailable') + '</code>' +
				'</div>' +
				'<label class="dialog-toggle-card">' +
					'<span class="dialog-toggle-copy">' +
						'<strong>Store episodes in their show subfolder</strong>' +
						'<span>Series downloads are placed into a subfolder named from Stremio metadata.</span>' +
					'</span>' +
					'<input id="useShowSubfolders" class="dialog-toggle-input" type="checkbox"' + (useShowSubfolders ? ' checked' : '') + '>' +
					'<span class="dialog-toggle-switch" aria-hidden="true"></span>' +
				'</label>' +
				'<div class="dialog-actions-grid">' +
					'<button type="button" class="dialog-button dialog-button-primary js-dialog-action" data-method="open-folder">Open Download Folder</button>' +
					'<button type="button" class="dialog-button dialog-button-secondary js-dialog-action" data-method="change-folder">Change Download Folder</button>' +
					'<button type="button" class="dialog-button dialog-button-secondary js-dialog-action" data-method="show-logs">View Logs</button>' +
					'<button type="button" class="dialog-button dialog-button-secondary js-dialog-action" data-method="install-addon">Install Downloader as Add-on</button>' +
				'</div>' +
				'<button type="button" class="dialog-button dialog-button-warning js-dialog-action" data-close-only="true">Close</button>' +
			'</div>'
		)
		if (!dialog.open)
			dialog.showModal()
		setTimeout(() => {
			document.activeElement.blur()
		})
	})
}

function showLogs() {
	request('logs', null, null, logs => {
		currentLogText = String(logs || '').trim()
		dialog.classList.remove('dialog-options')
		dialog.classList.add('dialog-large')
		$('#dialog').html('' +
			'<div class="dialog-stack dialog-stack-logs">' +
				'<div class="dialog-header-row">' +
					'<div>' +
						'<h2 class="dialog-title">Application Logs</h2>' +
						'<p class="dialog-copy">Recent downloader events, content-type checks, and error details.</p>' +
					'</div>' +
					'<button type="button" class="dialog-icon-button js-dialog-action" data-close-only="true" aria-label="Close logs">×</button>' +
				'</div>' +
				'<div class="dialog-search-row">' +
					'<input id="logSearch" class="dialog-search-input" type="search" placeholder="Search logs">' +
					'<span class="dialog-search-meta"></span>' +
				'</div>' +
				'<pre class="log-viewer"></pre>' +
				'<div class="dialog-actions-row">' +
					'<button type="button" class="dialog-button dialog-button-secondary js-dialog-action" data-method="open-log-location">' + iconSvg('folder') + '<span>Reveal Log File</span></button>' +
					'<button type="button" class="dialog-button dialog-button-secondary js-dialog-action" data-method="clear-logs">' + iconSvg('trash') + '<span>Clear Logs</span></button>' +
					'<button type="button" class="dialog-button dialog-button-primary js-dialog-action" data-close-only="true">' + iconSvg('logs') + '<span>Close</span></button>' +
					'</div>' +
				'</div>'
			)
			const wasOpen = dialog.open
			if (!wasOpen)
				dialog.showModal()
			renderLogViewer('')
		})
	}

function includes(str, query) {
	return decodeDisplayValue(str).split('.').join(' ').toLowerCase().includes((query || '').toLowerCase())
}

function renderDownloads() {
	const query = ($('#query').val() || '').trim()
	const filteredFiles = currentFiles.filter(file => includes(file.filename, query))

	updateResultCount(filteredFiles.length)
	updatePendingActionsDetail()

	if (currentFiles.length === 0) {
		$('#no-downloads').fadeIn()
		renderEmptyState('No downloads yet', 'Start downloading content from Stremio to see it here.')
		return
	}

	$('#no-downloads').hide()

	if (!filteredFiles.length) {
		renderEmptyState('No matches found', 'Try a broader title, source, season, codec, or extension in the search box.')
		return
	}

	syncDownloadCards(filteredFiles)
}

let dialog
let serverFiles = []
let currentFiles = []
let currentLogText = ''
let pendingActions = []
let currentThemeMode = 'dark'

$(document).ready(() => {
	window.name = 'stremio-downloader'
	document.body.classList.toggle('desktop-shell', desktopMode)
	dialog = document.querySelector('dialog')

	dialogPolyfill.registerDialog(dialog)

	$('#query').on('input', () => {
		renderDownloads()
	})

	$('#downloads').on('click', '.js-action', function () {
		const { method, url, filename, playUrl } = this.dataset
		handleAction(method, url, filename, { playUrl })
	})

	$('#dialog').on('click', '.js-dialog-action', function () {
		if (this.dataset.closeOnly === 'true') {
			closeDialog()
			return
		}
		const { method, url, filename } = this.dataset
		if (method === 'show-logs') {
			closeDialog()
			showLogs()
			return
		}
		if (method === 'clear-logs') {
			request('clear-logs', null, null, () => {
				showLogs()
			})
			return
		}
		handleAction(method, url, filename)
	})

	$('#dialog').on('change', '#useShowSubfolders', function () {
		request('set-use-show-subfolders', null, null, null, { enabled: String(this.checked) })
	})

	$('#theme-toggle').on('click', async () => {
		const nextThemeMode = currentThemeMode === 'dark' ? 'light' : 'dark'
		applyTheme(nextThemeMode)
		applyTheme(await persistThemeMode(nextThemeMode))
	})

	$('#dialog').on('input', '#logSearch', function () {
		renderLogViewer(this.value)
	})

	function update() {
		request('files', null, null, files => {
			try { serverFiles = JSON.parse(files) } catch (e) { serverFiles = [] }
			syncCurrentFiles()
		})

		setTimeout(update, LIST_REFRESH_INTERVAL_MS)
	}

	applyTheme(getStoredThemeMode() || 'dark')

	loadAppSettings().catch(() => {
		applyTheme(getStoredThemeMode() || 'dark')
	})

	update()

	function checkEngine() {
		$.ajax({
			url: 'http://127.0.0.1:11470/settings',
			type: 'GET',
			success: () => {
				if ($('#no-engine').css('display') == 'block')
					$('#no-engine').css('display', 'none')
			},
			error: () => {
				if ($('#no-engine').css('display') == 'none')
					$('#no-engine').fadeIn()
			}
		})

		setTimeout(checkEngine, 5000)
	}

	checkEngine()
})

async function apiCall(method, url, filename) {
	const normalizedFilename = decodeDisplayValue(filename)
	const pendingActionId = addPendingAction(method, url, normalizedFilename)

	try {
		await requestPromise(method, url, normalizedFilename)
		if (pendingActionId)
			serverFiles = applyFileAction(serverFiles, method, url)
		if (pendingActionId)
			removePendingAction(pendingActionId)
		if (method !== 'logs')
			closeDialog()
	} catch (err) {
		if (pendingActionId)
			removePendingAction(pendingActionId)
		showErrorDialog('Action failed', getRequestFailureMessage(err))
	}
}

async function handleChangeFolder() {
	const result = await requestJson('change-folder')
	if (result.done) {
		options()
		return
	}

	if (result.error === 'cancelled')
		return

	showErrorDialog('Download folder not changed', result.message || 'Could not open a native folder picker on this system.')
}

async function handleLoadStremio() {
	if (desktopMode) {
		const result = await requestJson('load-stremio', null, null, getLaunchParams())
		if (!result.done)
			throw new Error(result.message || 'Could not open Stremio.')
		return
	}

	openStremioInBrowser()
}

async function handleInstallAddon() {
	const result = await requestJson('install-addon', null, null, getLaunchParams())
	if (!result.url) {
		showErrorDialog('Could not install add-on', 'The local service did not return a Stremio add-on URL.')
		return
	}

	closeDialog()
	if (desktopMode)
		return

	window.location.assign(result.url)
}

async function handlePlay(fileUrl, filename, playUrl) {
	if (playUrl && !desktopMode) {
		openBrowserUrl(playUrl, '_blank')
		return
	}

	const result = await requestJson('play-video', fileUrl, decodeDisplayValue(filename), getLaunchParams())
	if (!result.url)
		throw new Error('The downloaded file is no longer available.')

	if (desktopMode)
		return

	openBrowserUrl(result.url, '_blank')
}

async function handleAction(method, url, filename, options) {
	try {
		if (method === 'load-stremio') {
			await handleLoadStremio()
			return
		}

		if (method === 'change-folder') {
			await handleChangeFolder()
			return
		}

		if (method === 'install-addon') {
			await handleInstallAddon()
			return
		}

		if (method === 'play-video') {
			await handlePlay(url, filename, (options || {}).playUrl)
			closeDialog()
			return
		}

		await apiCall(method, url, filename)
	} catch (err) {
		showErrorDialog('Action failed', getRequestFailureMessage(err, err.message))
	}
}

function closeDialog() {
	if (dialog)
		dialog.classList.remove('dialog-large')
	if (dialog)
		dialog.classList.remove('dialog-options')
	if (dialog && dialog.open)
		dialog.close()
}
