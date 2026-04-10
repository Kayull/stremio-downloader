const fs = require('fs')
const path = require('path')

const defaultAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/610.0.3239.132 Safari/537.36'
const blockedResponseHeaders = new Set([
	'access-control-allow-origin',
	'connection',
	'content-encoding',
	'content-length',
	'keep-alive',
	'proxy-authenticate',
	'proxy-authorization',
	'te',
	'trailer',
	'transfer-encoding',
	'upgrade'
])
const blockedRequestHeaders = new Set([
	'accept-encoding',
	'connection',
	'content-length',
	'host'
])

const proxies = {}

let endpoint

function getDirPath(urlPath) {
	if (!urlPath.includes('/'))
		return undefined

	return urlPath.slice(0, urlPath.lastIndexOf('/') + 1)
}

function toProxyPath(urlObject) {
	return (urlObject.pathname || '/') + (urlObject.search || '')
}

function readInjectedFragment(filename) {
	try {
		return fs.readFileSync(path.join(__dirname, filename), 'utf8')
	} catch (err) {
		return ''
	}
}

function modifyHtml(str) {
	const scriptElm = readInjectedFragment('inject.html')
	const scriptElmHead = readInjectedFragment('injectHead.html')

	if (str.indexOf('</body>') > -1) {
		str = str.replace('</body>', scriptElm + '</body>')
	} else if (str.indexOf('</html>') > -1) {
		str = str.replace('</html>', scriptElm + '</html>')
	} else {
		str = str + scriptElm
	}

	if (str.indexOf('<head>') > -1)
		str = str.replace('<head>', '<head>' + scriptElmHead)

	return str
}

function buildRequestHeaders(req, config, opts) {
	const headers = new Headers()

	Object.entries(req.headers).forEach(([key, value]) => {
		if (blockedRequestHeaders.has(key.toLowerCase()) || value == null)
			return

		if (Array.isArray(value))
			headers.set(key, value.join(', '))
		else
			headers.set(key, value)
	})

	headers.set('host', config.host)
	headers.set('user-agent', defaultAgent)
	headers.set('accept-encoding', 'identity')

	if ((opts || {}).headers)
		Object.entries(opts.headers).forEach(([key, value]) => {
			headers.set(key, value)
		})

	return headers
}

async function readRequestBody(req) {
	const chunks = []

	for await (const chunk of req)
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))

	return Buffer.concat(chunks)
}

function applyResponseHeaders(upstream, res) {
	upstream.headers.forEach((value, key) => {
		if (blockedResponseHeaders.has(key.toLowerCase()))
			return

		res.setHeader(key, value)
	})

	res.setHeader('Access-Control-Allow-Origin', '*')
	res.setHeader('cache-control', 'no-cache')
}

function logProxyError(err, req, target) {
	console.error('http proxy error')
	if (req)
		console.error((req.method || 'GET') + ' ' + (req.originalUrl || req.url || ''))
	if (target)
		console.error('target: ' + target)
	console.error(err)
}

function sendProxyError(res, err) {
	if (res.headersSent)
		return

	const statusCode = err.name === 'AbortError' ? 504 : 502
	res.writeHead(statusCode, { 'Content-Type': 'application/json' })
	res.end(JSON.stringify({
		err: err.code || (err.name === 'AbortError' ? 'ETIMEDOUT' : 'proxy_error'),
		message: err.message || 'Proxy request failed'
	}))
}

function getProxyConfig(host, reqPath) {
	const config = proxies[host]
	if (!config)
		return { config: null, opts: {} }

	return {
		config,
		opts: config.paths[reqPath] || config.paths[getDirPath(reqPath)] || config.opts || {}
	}
}

const proxify = {
	setEndpoint: url => {
		endpoint = url
	},

	getEndpoint: () => {
		return endpoint
	},

	addProxy: (url, opts) => {
		const parsedUrl = new URL(url)
		const host = parsedUrl.host
		const proxyPath = toProxyPath(parsedUrl)
		const result = endpoint + '/web/' + parsedUrl.host + proxyPath

		if (process.send) {
			process.send({ proxy: true, url, opts })
			return result
		}

		const dirPath = getDirPath(proxyPath)

		if (proxies[host]) {
			proxies[host].paths[proxyPath] = opts
			if (dirPath && !proxies[host].paths[dirPath])
				proxies[host].paths[dirPath] = opts
			return result
		}

		proxies[host] = {
			host,
			protocol: parsedUrl.protocol,
			opts,
			paths: {}
		}

		proxies[host].paths[proxyPath] = opts

		if (dirPath && !proxies[host].paths[dirPath])
			proxies[host].paths[dirPath] = opts

		return result
	},

	createProxyServer: router => {
		router.all(/^\/web\/.*/, async (req, res) => {
			const incomingPath = req.originalUrl || req.url
			const match = incomingPath.match(/^\/web\/([^/]+)(\/.*)?$/)

			if (!match) {
				res.writeHead(500)
				res.end(JSON.stringify({ err: 'handler error' }))
				return
			}

			const host = match[1]
			req.url = match[2] || '/'

			const { config, opts } = getProxyConfig(host, req.url)
			if (!config) {
				res.writeHead(500)
				res.end(JSON.stringify({ err: 'handler error' }))
				return
			}

			const targetUrl = new URL(req.url, config.protocol + '//' + config.host)
			const controller = new AbortController()
			const timeout = setTimeout(() => controller.abort(), 30000)

			try {
				let body
				if (!['GET', 'HEAD'].includes(req.method))
					body = await readRequestBody(req)

				const upstream = await fetch(targetUrl, {
					method: req.method,
					headers: buildRequestHeaders(req, config, opts),
					body,
					redirect: 'follow',
					signal: controller.signal
				})

				clearTimeout(timeout)

				res.statusCode = upstream.status
				res.statusMessage = upstream.statusText
				applyResponseHeaders(upstream, res)

				if (req.method === 'HEAD') {
					res.end()
					return
				}

				const contentType = upstream.headers.get('content-type') || ''
				const shouldModifyHtml = contentType.includes('text/html')
				const shouldModifyCss = req.url.includes('/blob.css')
				let responseBody = Buffer.from(await upstream.arrayBuffer())

				if (shouldModifyHtml) {
					responseBody = Buffer.from(modifyHtml(responseBody.toString()))
				} else if (shouldModifyCss) {
					let bodyText = responseBody.toString()
					bodyText = bodyText.split("url('fonts/").join("url('" + endpoint + "/assets/fonts/")
					bodyText = bodyText.split('url("fonts/').join('url("' + endpoint + '/assets/fonts/')
					responseBody = Buffer.from(bodyText)
				}

				res.setHeader('content-length', responseBody.length)
				res.end(responseBody)
			} catch (err) {
				clearTimeout(timeout)
				logProxyError(err, req, targetUrl.toString())
				sendProxyError(res, err)
			}
		})
	}
}

module.exports = proxify
