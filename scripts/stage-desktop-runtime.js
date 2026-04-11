const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const repoRoot = path.resolve(__dirname, '..')
const runtimeRoot = path.join(repoRoot, 'build', 'desktop-runtime')
const sourceNodeModules = path.join(repoRoot, 'node_modules')
const runtimeNodeModules = path.join(runtimeRoot, 'node_modules')
const runtimeEntries = [
	'assets',
	'downloader',
	'lib',
	'scripts/desktop-sidecar.js'
]

function getNpmCommand() {
	return process.platform === 'win32'
		? 'npm.cmd'
		: 'npm'
}

function ensureInstalledDependencies() {
	if (fs.existsSync(sourceNodeModules))
		return

	throw new Error('Install project dependencies before staging the desktop runtime.')
}

function resetRuntimeRoot() {
	fs.rmSync(runtimeRoot, { recursive: true, force: true })
	fs.mkdirSync(runtimeRoot, { recursive: true })
	fs.mkdirSync(runtimeNodeModules, { recursive: true })
}

function copyEntry(relativePath) {
	const sourcePath = path.join(repoRoot, relativePath)
	const targetPath = path.join(runtimeRoot, relativePath)
	fs.mkdirSync(path.dirname(targetPath), { recursive: true })
	fs.cpSync(sourcePath, targetPath, { recursive: true })
}

function getTopLevelPackagePath(relativePath) {
	const parts = relativePath.split(path.sep).filter(Boolean)
	if (!parts.length)
		return ''

	return parts[0].startsWith('@')
		? path.join(parts[0], parts[1] || '')
		: parts[0]
}

function listProductionTopLevelPackages() {
	const output = execFileSync(getNpmCommand(), ['ls', '--omit=dev', '--parseable', '--all'], {
		cwd: repoRoot,
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe']
	})

	const packagePaths = new Set()
	output.split(/\r?\n/).filter(Boolean).forEach(entry => {
		if (!entry.startsWith(sourceNodeModules + path.sep))
			return

		const relativePath = path.relative(sourceNodeModules, entry)
		const topLevelPath = getTopLevelPackagePath(relativePath)
		if (topLevelPath)
			packagePaths.add(path.join(sourceNodeModules, topLevelPath))
	})

	return Array.from(packagePaths).sort()
}

function copyProductionNodeModules() {
	const packagePaths = listProductionTopLevelPackages()
	packagePaths.forEach(packagePath => {
		const relativePath = path.relative(sourceNodeModules, packagePath)
		const targetPath = path.join(runtimeNodeModules, relativePath)
		fs.mkdirSync(path.dirname(targetPath), { recursive: true })
		fs.cpSync(packagePath, targetPath, { recursive: true })
	})
	return packagePaths.length
}

function writeRuntimePackageJson() {
	const sourcePackageJsonPath = path.join(repoRoot, 'package.json')
	const packageJson = JSON.parse(fs.readFileSync(sourcePackageJsonPath, 'utf8'))
	packageJson.scripts = {
		'desktop-sidecar': 'node scripts/desktop-sidecar.js'
	}
	delete packageJson.devDependencies
	fs.writeFileSync(path.join(runtimeRoot, 'package.json'), JSON.stringify(packageJson, null, 2) + '\n')
}

function stageDesktopRuntime() {
	ensureInstalledDependencies()
	resetRuntimeRoot()
	runtimeEntries.forEach(copyEntry)
	writeRuntimePackageJson()
	const copiedPackages = copyProductionNodeModules()

	console.log('Staged desktop runtime at ' + runtimeRoot)
	console.log('Copied ' + copiedPackages + ' production node_modules packages')
}

stageDesktopRuntime()
