function request(method, url, filename, cb) {
	cb = cb || (() => {})
	return $.get('/api?method=' + method + (url ? ('&url=' + encodeURIComponent(url)) : '') + (filename ? ('&filename=' + encodeURIComponent(filename)) : ''), cb)
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

function formatExtension(filename) {
	const decoded = decodeDisplayValue(filename)
	const parts = decoded.split('.')
	if (parts.length < 2)
		return 'FILE'
	return parts.pop().toUpperCase()
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
	if (file.finished)
		return { label: 'Finished', className: 'status-finished', detail: 'Saved in download folder.' }
	if (file.stopped)
		return { label: 'Stopped', className: 'status-stopped', detail: 'Download stopped.' }
	if (file.isHls)
		return { label: 'Capturing', className: 'status-downloading', detail: 'Recording an HLS stream.' }
	return { label: 'Downloading', className: 'status-downloading', detail: clampProgress(file.progress) + '% complete.' }
}

function renderActionButton(label, icon, method, url, filename, accentClassName) {
	return '' +
		'<button type="button" class="action-button' + (accentClassName ? (' ' + accentClassName) : '') + ' js-action" aria-label="' + escapeAttribute(label) + '" title="' + escapeAttribute(label) + '"' +
			' data-method="' + escapeAttribute(method) + '"' +
			(url ? ' data-url="' + escapeAttribute(url) + '"' : '') +
			(filename ? ' data-filename="' + escapeAttribute(filename) + '"' : '') +
		'>' +
			'<span class="action-icon" aria-hidden="true">' + icon + '</span>' +
			'<span class="action-label">' + escapeHtml(label) + '</span>' +
		'</button>'
}

function iconSvg(name) {
	const icons = {
		trash: '<svg viewBox="0 0 24 24" focusable="false"><path d="M19,6 L19,18.5 C19,19.8807119 17.8807119,21 16.5,21 L7.5,21 C6.11928813,21 5,19.8807119 5,18.5 L5,6 L4.5,6 C4.22385763,6 4,5.77614237 4,5.5 C4,5.22385763 4.22385763,5 4.5,5 L9,5 L9,4.5 C9,3.67157288 9.67157288,3 10.5,3 L13.5,3 C14.3284271,3 15,3.67157288 15,4.5 L15,5 L19.5,5 C19.7761424,5 20,5.22385763 20,5.5 C20,5.77614237 19.7761424,6 19.5,6 L19,6 Z M6,6 L6,18.5 C6,19.3284271 6.67157288,20 7.5,20 L16.5,20 C17.3284271,20 18,19.3284271 18,18.5 L18,6 L6,6 Z M14,5 L14,4.5 C14,4.22385763 13.7761424,4 13.5,4 L10.5,4 C10.2238576,4 10,4.22385763 10,4.5 L10,5 L14,5 Z M14,9.5 C14,9.22385763 14.2238576,9 14.5,9 C14.7761424,9 15,9.22385763 15,9.5 L15,16.5 C15,16.7761424 14.7761424,17 14.5,17 C14.2238576,17 14,16.7761424 14,16.5 L14,9.5 Z M9,9.5 C9,9.22385763 9.22385763,9 9.5,9 C9.77614237,9 10,9.22385763 10,9.5 L10,16.5 C10,16.7761424 9.77614237,17 9.5,17 C9.22385763,17 9,16.7761424 9,16.5 L9,9.5 Z"></path></svg>',
		folder: '<svg viewBox="0 0 24 24" focusable="false"><path d="M21,8V19a1,1,0,0,1-1,1H4a1,1,0,0,1-1-1V5A1,1,0,0,1,4,4H9.59a1,1,0,0,1,.7.29l2.42,2.42a1,1,0,0,0,.7.29H20A1,1,0,0,1,21,8Z"></path></svg>',
		play: '<svg viewBox="0 0 24 24" focusable="false"><path d="M8 5v14l11-7L8 5Z"></path></svg>',
		stop: '<svg viewBox="0 0 24 24" focusable="false"><path d="M7 7h10v10H7V7Z"></path></svg>',
		restart: '<svg viewBox="0 0 24 24" focusable="false"><path d="M17.91 14c-.478 2.833-2.943 5-5.91 5-3.308 0-6-2.692-6-6s2.692-6 6-6h2.172l-2.086 2.086L13.5 10.5 18 6l-4.5-4.5-1.414 1.414L14.172 5H12c-4.418 0-8 3.582-8 8s3.582 8 8 8c4.08 0 7.438-3.055 7.93-7h-2.02z"></path></svg>',
		logs: '<svg viewBox="0 0 24 24" focusable="false"><path d="M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Zm0 2v12h14V6H5Zm3 2h8v2H8V8Zm0 4h8v2H8v-2Zm0 4h5v2H8v-2Z"></path></svg>'
	}

	return icons[name] || ''
}

function fileToCard(file) {
	const status = getStatusModel(file)
	const sourceKind = getSourceKindModel(file)
	const displayName = decodeDisplayValue(file.filename)
	const progress = clampProgress(file.progress)
	const metaPills = [
		'<span class="status-pill ' + status.className + '">' + escapeHtml(status.label) + '</span>',
		'<span class="meta-pill source-pill ' + sourceKind.className + '">' + escapeHtml(sourceKind.label) + '</span>',
		'<span class="meta-pill">' + escapeHtml(formatExtension(displayName)) + '</span>'
	]

	if (!file.finished && !file.error && !file.stopped && !file.missingOnDisk)
		metaPills.push('<span class="meta-pill">' + escapeHtml(file.isHls ? 'Live HLS stream' : progress + '% complete') + '</span>')

	let actionButtons = ''

	if (file.missingOnDisk)
		actionButtons += renderActionButton('Open Folder', iconSvg('folder'), 'open-folder', null, null)
	else if (file.error || file.stopped)
		actionButtons += renderActionButton('Retry', iconSvg('restart'), 'restart-download', file.url, file.filename, 'action-button-strong')
	else if (file.finished) {
		actionButtons += renderActionButton('Reveal', iconSvg('folder'), 'open-location', file.url, file.filename)
		actionButtons += renderActionButton('Play', iconSvg('play'), 'play-video', file.url, file.filename)
	} else
		actionButtons += renderActionButton('Stop', iconSvg('stop'), 'stop-download', file.url, file.filename)

	actionButtons += renderActionButton('Remove', iconSvg('trash'), 'remove-download', file.url, file.filename, 'action-button-danger')

	const progressBar = (!file.finished && !file.error && !file.stopped && !file.missingOnDisk)
		? '' +
			'<div class="progress-track' + (file.isHls ? ' progress-indeterminate' : '') + '">' +
				'<div class="progress-fill"' + (file.isHls ? '' : ' style="width: ' + progress + '%"') + '></div>' +
			'</div>'
		: ''

	return '' +
		'<article class="download-card">' +
			'<div class="download-main">' +
				'<h3 class="download-name">' + escapeHtml(displayName) + '</h3>' +
				'<p class="download-subtitle">' + escapeHtml(status.detail) + '</p>' +
				'<div class="download-meta">' + metaPills.join('') + '</div>' +
				progressBar +
			'</div>' +
			'<div class="download-actions">' + actionButtons + '</div>' +
		'</article>'
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

function updateResultCount(count) {
	$('#result-count').text(count + ' item' + (count === 1 ? '' : 's'))
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
			'<button type="button" class="dialog-button js-dialog-action ' + action.className + '"' +
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
		const folder = settings.folder || 'Unavailable'
		const useShowSubfolders = settings.useShowSubfolders !== false
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
		dialog.showModal()
		setTimeout(() => {
			document.activeElement.blur()
		})
	})
}

function showLogs() {
	request('logs', null, null, logs => {
		const safeLogs = escapeHtml((logs || '').trim() || 'No logs yet.')
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
				'<pre class="log-viewer">' + safeLogs + '</pre>' +
				'<div class="dialog-actions-row">' +
					'<button type="button" class="dialog-button dialog-button-secondary js-dialog-action" data-method="open-log-location">' + iconSvg('folder') + '<span>Reveal Log File</span></button>' +
					'<button type="button" class="dialog-button dialog-button-secondary js-dialog-action" data-method="clear-logs">' + iconSvg('trash') + '<span>Clear Logs</span></button>' +
					'<button type="button" class="dialog-button dialog-button-primary js-dialog-action" data-close-only="true">' + iconSvg('logs') + '<span>Close</span></button>' +
				'</div>' +
			'</div>'
		)
		if (dialog.open)
			return
		dialog.showModal()
		const logViewer = dialog.querySelector('.log-viewer')
		if (logViewer)
			logViewer.scrollTop = logViewer.scrollHeight
	})
}

function includes(str, query) {
	return decodeDisplayValue(str).split('.').join(' ').toLowerCase().includes((query || '').toLowerCase())
}

function renderDownloads() {
	const query = ($('#query').val() || '').trim()
	const filteredFiles = currentFiles.filter(file => includes(file.filename, query))

	updateResultCount(filteredFiles.length)

	if (currentFiles.length === 0) {
		$('#no-downloads').fadeIn()
		renderEmptyState('No downloads yet', 'Open Stremio, choose a stream, and the downloader will start tracking it here.')
		return
	}

	$('#no-downloads').hide()

	if (!filteredFiles.length) {
		renderEmptyState('No matches found', 'Try a broader title, source, season, codec, or extension in the search box.')
		return
	}

	$('#downloads').html(filteredFiles.map(fileToCard).join(''))
}

function applyOptimisticUpdate(method, url) {
	if (!url)
		return false

	if (method === 'remove-download') {
		currentFiles = currentFiles.filter(file => file.url !== url)
		return true
	}

	if (method === 'stop-download') {
		currentFiles = currentFiles.map(file => file.url === url
			? Object.assign({}, file, { stopped: true })
			: file
		)
		return true
	}

	return false
}

let dialog
let currentFiles = []

$(document).ready(() => {
	dialog = document.querySelector('dialog')

	dialogPolyfill.registerDialog(dialog)

	$('#query').on('input', () => {
		renderDownloads()
	})

	$('#downloads').on('click', '.js-action', function () {
		const { method, url, filename } = this.dataset
		apiCall(method, url, filename)
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
		apiCall(method, url, filename)
	})

	$('#dialog').on('change', '#useShowSubfolders', function () {
		$.get('/api?method=set-use-show-subfolders&enabled=' + encodeURIComponent(String(this.checked)))
	})

	function update() {
		request('files', null, null, files => {
			try { currentFiles = JSON.parse(files) } catch (e) { currentFiles = [] }
			renderDownloads()
		})

		setTimeout(update, 2000)
	}

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

function apiCall(method, url, filename) {
	const previousFiles = cloneFiles(currentFiles)
	const didOptimisticallyUpdate = applyOptimisticUpdate(method, url)

	if (didOptimisticallyUpdate)
		renderDownloads()

	request(method, url, decodeDisplayValue(filename), null).fail(() => {
		if (!didOptimisticallyUpdate)
			return
		currentFiles = previousFiles
		renderDownloads()
	})

	if (method !== 'logs')
		closeDialog()
}

function closeDialog() {
	if (dialog)
		dialog.classList.remove('dialog-large')
	if (dialog)
		dialog.classList.remove('dialog-options')
	if (dialog && dialog.open)
		dialog.close()
}
