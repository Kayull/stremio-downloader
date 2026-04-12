const fs = require('fs')
const path = require('path')
const configDir = require('./userDir')
const logger = require('./logger')

const jarPath = path.join(configDir, 'proxy-cookies.json')

let loaded = false
let cookies = []

function load() {
	if (loaded)
		return

	loaded = true

	if (!fs.existsSync(jarPath))
		return

	try {
		const fileData = JSON.parse(fs.readFileSync(jarPath, 'utf8') || '{}')
		if (Array.isArray(fileData.cookies))
			cookies = fileData.cookies
	} catch (err) {
		cookies = []
	}

	removeExpiredCookies()

	if (cookies.length) {
		logger.info('Loaded proxy cookie jar', {
			path: jarPath,
			count: cookies.length
		})
	}
}

function save(logContext) {
	try {
		fs.writeFileSync(jarPath, JSON.stringify({ cookies }))
		if (logContext) {
			logger.info('Saved proxy cookie jar', Object.assign({
				path: jarPath,
				count: cookies.length
			}, logContext))
		}
	} catch (err) {
		logger.warn('Failed to save proxy cookie jar', {
			path: jarPath,
			message: err.message || 'Unknown error'
		})
	}
}

function normalizeDomain(domain) {
	return String(domain || '').trim().replace(/^\./, '').toLowerCase()
}

function getDefaultCookiePath(requestPath) {
	const pathname = String(requestPath || '/')

	if (!pathname.startsWith('/'))
		return '/'

	if (pathname === '/')
		return '/'

	const lastSlash = pathname.lastIndexOf('/')
	if (lastSlash <= 0)
		return '/'

	return pathname.slice(0, lastSlash + 1)
}

function removeExpiredCookies() {
	const now = Date.now()
	const previousLength = cookies.length

	cookies = cookies.filter(cookie => {
		if (!cookie || !cookie.name || !cookie.domain || !cookie.path)
			return false

		if (!cookie.expiresAt)
			return true

		return Number(cookie.expiresAt) > now
	})

	return cookies.length !== previousLength
}

function parseIncomingCookies(headerValue) {
	if (!headerValue)
		return []

	return String(headerValue)
		.split(';')
		.map(part => part.trim())
		.filter(Boolean)
		.map(part => {
			const separatorIndex = part.indexOf('=')
			if (separatorIndex === -1)
				return null

			return {
				name: part.slice(0, separatorIndex).trim(),
				value: part.slice(separatorIndex + 1).trim()
			}
		})
		.filter(Boolean)
}

function parseSetCookie(setCookieValue, hostname, requestPath) {
	const parts = String(setCookieValue || '')
		.split(';')
		.map(part => part.trim())
		.filter(Boolean)

	if (!parts.length)
		return null

	const separatorIndex = parts[0].indexOf('=')
	if (separatorIndex <= 0)
		return null

	const cookie = {
		name: parts[0].slice(0, separatorIndex).trim(),
		value: parts[0].slice(separatorIndex + 1),
		domain: normalizeDomain(hostname),
		hostOnly: true,
		path: getDefaultCookiePath(requestPath),
		secure: false,
		httpOnly: false,
		sameSite: '',
		expiresAt: null
	}

	parts.slice(1).forEach(part => {
		const attributeSeparator = part.indexOf('=')
		const key = (attributeSeparator === -1 ? part : part.slice(0, attributeSeparator)).trim().toLowerCase()
		const value = attributeSeparator === -1 ? '' : part.slice(attributeSeparator + 1).trim()

		if (key === 'domain' && value) {
			cookie.domain = normalizeDomain(value)
			cookie.hostOnly = false
		} else if (key === 'path' && value) {
			cookie.path = value.startsWith('/') ? value : '/'
		} else if (key === 'max-age') {
			const seconds = Number(value)
			if (Number.isFinite(seconds))
				cookie.expiresAt = Date.now() + (seconds * 1000)
		} else if (key === 'expires') {
			const timestamp = Date.parse(value)
			if (!Number.isNaN(timestamp))
				cookie.expiresAt = timestamp
		} else if (key === 'secure') {
			cookie.secure = true
		} else if (key === 'httponly') {
			cookie.httpOnly = true
		} else if (key === 'samesite') {
			cookie.sameSite = value
		}
	})

	return cookie
}

function cookieDomainMatches(cookie, hostname) {
	const normalizedHost = normalizeDomain(hostname)
	if (cookie.hostOnly)
		return normalizedHost === cookie.domain

	return normalizedHost === cookie.domain || normalizedHost.endsWith('.' + cookie.domain)
}

function cookiePathMatches(cookie, requestPath) {
	const pathname = String(requestPath || '/')
	const cookiePath = cookie.path || '/'

	if (pathname === cookiePath)
		return true

	if (!pathname.startsWith(cookiePath))
		return false

	if (cookiePath.endsWith('/'))
		return true

	return pathname.charAt(cookiePath.length) === '/'
}

function upsertCookie(nextCookie) {
	cookies = cookies
		.filter(cookie => {
			return !(cookie.name === nextCookie.name &&
				cookie.domain === nextCookie.domain &&
				cookie.path === nextCookie.path)
		})

	if (!nextCookie.expiresAt || Number(nextCookie.expiresAt) > Date.now())
		cookies.push(nextCookie)

	return true
}

module.exports = {
	getCookieHeader: (targetUrl, incomingCookieHeader) => {
		load()
		if (removeExpiredCookies())
			save({ reason: 'expired_cleanup' })

		const url = typeof targetUrl === 'string' ? new URL(targetUrl) : targetUrl
		const matchingCookies = cookies
			.filter(cookie => cookieDomainMatches(cookie, url.hostname) && cookiePathMatches(cookie, url.pathname) && (!cookie.secure || url.protocol === 'https:'))
			.sort((left, right) => String(right.path || '').length - String(left.path || '').length)

		const seenNames = new Set()
		const cookiePairs = []

		matchingCookies.forEach(cookie => {
			cookiePairs.push(cookie.name + '=' + cookie.value)
			seenNames.add(cookie.name)
		})

		parseIncomingCookies(incomingCookieHeader).forEach(cookie => {
			if (seenNames.has(cookie.name))
				return
			cookiePairs.push(cookie.name + '=' + cookie.value)
		})

		return cookiePairs.join('; ')
	},
	storeFromResponse: (targetUrl, setCookieValues) => {
		load()

		const values = Array.isArray(setCookieValues) ? setCookieValues : []
		if (!values.length)
			return 0

		const url = typeof targetUrl === 'string' ? new URL(targetUrl) : targetUrl
		let changed = false

		values.forEach(value => {
			const parsed = parseSetCookie(value, url.hostname, url.pathname)
			if (!parsed)
				return

			changed = upsertCookie(parsed) || changed
		})

		changed = removeExpiredCookies() || changed

		if (changed) {
			save({
				reason: 'set-cookie',
				targetHost: url.hostname,
				received: values.length
			})
		}

		return values.length
	}
}
