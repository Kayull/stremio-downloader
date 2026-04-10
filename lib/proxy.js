const httpProxy = require('http-proxy')
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')
const httpsAgent = require('https').globalAgent
const pUrl = require('url')

const defaultAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/610.0.3239.132 Safari/537.36'

const proxies = {}

let endpoint

function getDirPath(path) {
    let dirPath

    if (path.includes('/'))
        dirPath = path.substr(0, path.lastIndexOf('/') + 1)

    return dirPath
}

var scriptElm = fs.readFileSync(path.join(__dirname, 'inject.html'), 'utf8')
var scriptElmHead = fs.readFileSync(path.join(__dirname, 'injectHead.html'), 'utf8')

function decodeBody(body, contentEncoding) {
    switch ((contentEncoding || '').toLowerCase()) {
        case 'br':
            return zlib.brotliDecompressSync(body)
        case 'gzip':
            return zlib.gunzipSync(body)
        case 'deflate':
            return zlib.inflateSync(body)
        default:
            return body
    }
}

function modifyHtml( str ) {
    // Add or script to the page
    if (str.indexOf('</body>') > -1 ) {
        str = str.replace( '</body>', scriptElm + '</body>' );
    } else if ( str.indexOf( '</html>' ) > -1 ){
        str = str.replace( '</html>', scriptElm + '</html>' );
    } else {
        str = str + scriptElm;
    }

    if (str.indexOf('<head>') > -1 ) {
        str = str.replace( '<head>', '<head>' + scriptElmHead );
    }

    return str;
}

const web_o = Object.values(require('http-proxy/lib/http-proxy/passes/web-outgoing'));

const proxify = {

    setEndpoint: url => {
        endpoint = url
    },

    getEndpoint: () => {
        return endpoint
    },

    addProxy: (url, opts) => {

        const urlParser = pUrl.parse(url)

        const host = urlParser.host

        const result = endpoint + '/web/' + urlParser.host + (urlParser.path || '')

        if (process.send) {
            // is child
            process.send({ proxy: true, url, opts })
            return result
        }

        const path = urlParser.path

        const dirPath = getDirPath(path)

        if (proxies && proxies[host]) {
            proxies[host].paths[path] = opts
            if (dirPath && !proxies[host].paths[dirPath])
                proxies[host].paths[dirPath] = opts
            return result
        }

        proxies[host] = {
            host,
            protocol: urlParser.protocol,
            opts,
            paths: {}
        }

        proxies[host].paths[path] = opts

        if (dirPath && !proxies[host].paths[dirPath])
            proxies[host].paths[dirPath] = opts

        return result
    },

    createProxyServer: router => {

        const proxy = httpProxy.createProxyServer({ selfHandleResponse: true })

        proxy.on('error', e => {
            if (e) {
                console.error('http proxy error')
                console.error(e)
            }            
        })

        proxy.on('proxyRes', (proxyRes, request, response) => {
            proxyRes.headers['Access-Control-Allow-Origin'] = '*'
            for(var i=0; i < web_o.length; i++) {
              if(web_o[i](request, response, proxyRes, {})) { break; }
            }
            response.setHeader('Access-Control-Allow-Origin', '*')
            const contentType = proxyRes.headers['content-type'] || ''
            const shouldModifyHtml = contentType.match('text/html')
            const shouldModifyCss = request.url.includes('/blob.css')
            let body = []
            proxyRes.on('data', chunk => { body.push(chunk) })
            proxyRes.on('end', () => {
                    let rawBody = Buffer.concat(body)

                    // This disables chunked encoding
                    response.removeHeader('transfer-encoding')

                    // Disable cache for all http as well
                    response.setHeader('cache-control', 'no-cache')

                    if (shouldModifyHtml || shouldModifyCss) {
                        try {
                            rawBody = decodeBody(rawBody, proxyRes.headers['content-encoding'])
                            response.removeHeader('content-encoding')
                        } catch (e) {
                            console.error('failed decoding proxied response')
                            console.error(e)
                            response.end(rawBody)
                            return
                        }

                        let bodyText = rawBody.toString()

                        if (shouldModifyHtml) {
                            bodyText = modifyHtml(bodyText)
                        } else {
                            bodyText = bodyText.split("url('fonts/").join("url('" + endpoint + "/assets/fonts/")
                            bodyText = bodyText.split('url("fonts/').join('url("' + endpoint + '/assets/fonts/')
                        }

                        response.setHeader('content-length', Buffer.byteLength(bodyText))

                        response.end(bodyText)
                    } else {
                        response.setHeader('content-length', rawBody.length)
                        response.end(rawBody)
                    }
                })

        })

        router.all(/^\/web\/.*/, (req, res) => {

            var parts = req.url.split('/')

            var host = parts[2]

            parts.splice(0, 3)

            req.url = '/'+parts.join('/')

            let configProxy = {}
            let opts = {}
            let config = {}

            if (proxies[host]) {
                config = proxies[host]

                configProxy = { target: config.protocol+'//'+config.host }

                configProxy.headers = {
                    host: config.host,
                    agent: defaultAgent,
                }

                req.headers['host'] = configProxy.headers.host
                req.headers['user-agent'] = configProxy.headers.agent
                req.headers['accept-encoding'] = 'identity'

                opts = config.paths[req.url] || config.paths[getDirPath(req.url)] || config.opts || {}

                if (opts.headers)
                    for (let key in opts.headers)
                        configProxy.headers[key] = req.headers[key] = opts.headers[key]

                if (config.protocol == 'https:')
                    configProxy.agent = httpsAgent

                res.setHeader('Access-Control-Allow-Origin', '*')

            }

            if (!configProxy.target) {
                res.writeHead(500)
                res.end(JSON.stringify({ err: 'handler error' }))
            } else {
                proxy.web(req, res, configProxy)
            }

        })

    }
}

module.exports = proxify
