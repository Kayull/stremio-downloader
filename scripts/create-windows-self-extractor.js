const fs = require('fs')
const { once } = require('events')
const path = require('path')

const TRAILER_MARKER = Buffer.from('STREMIO_DOWNLOADER_PAYLOAD_V1', 'ascii')

function parseArgs(argv) {
	const args = {
		launcher: '',
		output: '',
		payload: ''
	}

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index]
		if (arg === '--launcher')
			args.launcher = argv[index + 1] || ''
		else if (arg === '--payload')
			args.payload = argv[index + 1] || ''
		else if (arg === '--output')
			args.output = argv[index + 1] || ''
	}

	return args
}

function ensureFile(filePath, label) {
	if (!filePath)
		throw new Error('Missing required argument: ' + label)
	if (!fs.existsSync(filePath))
		throw new Error(label + ' was not found: ' + filePath)
	if (!fs.statSync(filePath).isFile())
		throw new Error(label + ' must be a file: ' + filePath)
}

async function appendFile(sourcePath, targetStream) {
	const input = fs.createReadStream(sourcePath)
	for await (const chunk of input) {
		if (!targetStream.write(chunk))
			await once(targetStream, 'drain')
	}
}

async function createSelfExtractor(options) {
	const launcherPath = path.resolve(options.launcher)
	const payloadPath = path.resolve(options.payload)
	const outputPath = path.resolve(options.output)

	ensureFile(launcherPath, '--launcher')
	ensureFile(payloadPath, '--payload')
	fs.mkdirSync(path.dirname(outputPath), { recursive: true })
	fs.rmSync(outputPath, { force: true })

	fs.copyFileSync(launcherPath, outputPath)
	const payloadSize = fs.statSync(payloadPath).size
	const sizeBuffer = Buffer.alloc(8)
	sizeBuffer.writeBigInt64LE(BigInt(payloadSize), 0)

	const output = fs.createWriteStream(outputPath, { flags: 'a' })
	try {
		await appendFile(payloadPath, output)
		output.write(sizeBuffer)
		output.write(TRAILER_MARKER)
	} finally {
		await new Promise((resolve, reject) => {
			output.end(err => err ? reject(err) : resolve())
		})
	}

	console.log('Created Windows self-extracting release:', outputPath)
}

createSelfExtractor(parseArgs(process.argv.slice(2))).catch(err => {
	console.error(err && err.stack || String(err))
	process.exit(1)
})
