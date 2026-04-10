const { spawn } = require('child_process')

const electronBinary = require('electron')
const env = { ...process.env }

delete env.ELECTRON_RUN_AS_NODE

const child = spawn(electronBinary, ['.'], {
	stdio: 'inherit',
	env
})

child.on('error', err => {
	console.error(err)
	process.exit(1)
})

child.on('exit', code => {
	process.exit(code || 0)
})
