function normalizeBase64Url(value) {
	if (!value || typeof value !== 'string')
		return ''

	let normalized = value.replace(/-/g, '+').replace(/_/g, '/')
	const remainder = normalized.length % 4
	if (remainder)
		normalized += '='.repeat(4 - remainder)
	return normalized
}

function tryDecodeSegment(segment) {
	try {
		return Buffer.from(normalizeBase64Url(segment), 'base64').toString('utf8')
	} catch (err) {
		return ''
	}
}

function urlContainsTorrentMarker(url) {
	if (!url || typeof url !== 'string')
		return false

	if (url.startsWith('http://127.0.0.1:11470/'))
		return true

	try {
		const parsed = new URL(url)
		const decodedUrl = decodeURIComponent(url)
		if (decodedUrl.includes('"type":"torrent"') || decodedUrl.includes("'type':'torrent'"))
			return true

		return parsed.pathname
			.split('/')
			.filter(Boolean)
			.some(segment => {
				const decodedSegment = tryDecodeSegment(segment)
				return decodedSegment.includes('"type":"torrent"')
			})
	} catch (err) {
		return false
	}
}

function getDownloadSourceKind(url, contentType) {
	if ((url || '').startsWith('http://127.0.0.1:11470/'))
		return 'torrent-via-stremio'
	if (urlContainsTorrentMarker(url))
		return 'torrent-remote-playback'
	if (contentType && [
		'video/m3u',
		'video/m3u8',
		'video/hls',
		'application/x-mpegurl',
		'vnd.apple.mpegURL',
		'video/mp2t',
		'application/vnd.apple.mpegurl'
	].includes(String(contentType).toLowerCase()))
		return 'hls-stream'
	return 'direct-http'
}

module.exports = {
	getDownloadSourceKind,
	urlContainsTorrentMarker
}
