const { EventEmitter } = require('events')
const { spawn } = require('child_process')
const ffmpegPath = require('ffmpeg-static')

function splitOption(option) {
	if (Array.isArray(option))
		return option

	return String(option).split(/\s+/).filter(Boolean)
}

function quoteArg(arg) {
	if (!/[^\w./:=+-]/.test(arg))
		return arg

	return `"${String(arg).replace(/"/g, '\\"')}"`
}

class FfmpegCommand extends EventEmitter {
	constructor(options) {
		super()
		this.source = options.source
		this.outputArgs = []
		this.child = null
	}

	outputOptions(args) {
		const values = Array.isArray(args) ? args : [args]
		values.forEach(arg => {
			this.outputArgs.push(...splitOption(arg))
		})
		return this
	}

	save(filePath) {
		const args = ['-y', '-i', this.source, ...this.outputArgs, filePath]
		const commandLine = [ffmpegPath, ...args].map(quoteArg).join(' ')

		this.child = spawn(ffmpegPath, args, {
			stdio: ['ignore', 'ignore', 'pipe']
		})

		let stderr = ''

		this.emit('start', commandLine)

		this.child.stderr.on('data', chunk => {
			stderr += chunk.toString()
		})

		this.child.on('error', err => {
			this.emit('error', err)
		})

		this.child.on('close', code => {
			this.emit('close', code, stderr)
			if (code === 0)
				this.emit('end', null, '', stderr)
		})

		this.child.on('exit', code => {
			this.emit('exit', code, stderr)
		})

		return this
	}

	kill(signal) {
		if (this.child)
			this.child.kill(signal)
	}
}

module.exports = options => {
	return new FfmpegCommand(options)
}
