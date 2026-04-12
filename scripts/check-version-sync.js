const path = require('path')
const { repoRoot, readVersion, readText } = require('./version-utils')

const packageJsonPath = path.join(repoRoot, 'package.json')
const packageLockPath = path.join(repoRoot, 'package-lock.json')
const tauriConfigPath = path.join(repoRoot, 'tauri', 'tauri.conf.json')
const cargoTomlPath = path.join(repoRoot, 'tauri', 'Cargo.toml')

function readJson(filePath) {
	return JSON.parse(readText(filePath))
}

function readCargoVersion() {
	const cargoToml = readText(cargoTomlPath)
	const match = cargoToml.match(/^version = "(.+)"$/m)
	if (!match)
		throw new Error('Could not locate Cargo version in ' + cargoTomlPath)

	return match[1]
}

function collectMismatches(expectedVersion) {
	const mismatches = []
	const packageJson = readJson(packageJsonPath)
	if (packageJson.version !== expectedVersion) {
		mismatches.push({
			file: 'package.json',
			expected: expectedVersion,
			actual: packageJson.version || '(missing)'
		})
	}

	const packageLock = readJson(packageLockPath)
	if (packageLock.version !== expectedVersion) {
		mismatches.push({
			file: 'package-lock.json',
			expected: expectedVersion,
			actual: packageLock.version || '(missing)'
		})
	}

	const packageLockRoot = (((packageLock || {}).packages || {})[''] || {}).version
	if (packageLockRoot !== expectedVersion) {
		mismatches.push({
			file: 'package-lock.json packages[""].version',
			expected: expectedVersion,
			actual: packageLockRoot || '(missing)'
		})
	}

	const tauriConfig = readJson(tauriConfigPath)
	if (tauriConfig.version !== expectedVersion) {
		mismatches.push({
			file: 'tauri/tauri.conf.json',
			expected: expectedVersion,
			actual: tauriConfig.version || '(missing)'
		})
	}

	const cargoVersion = readCargoVersion()
	if (cargoVersion !== expectedVersion) {
		mismatches.push({
			file: 'tauri/Cargo.toml',
			expected: expectedVersion,
			actual: cargoVersion || '(missing)'
		})
	}

	return mismatches
}

function main() {
	const expectedVersion = readVersion()
	const mismatches = collectMismatches(expectedVersion)

	if (!mismatches.length) {
		console.log('Version files are in sync at', expectedVersion)
		return
	}

	console.error('Version files are out of sync with VERSION=' + expectedVersion)
	mismatches.forEach(mismatch => {
		console.error('- ' + mismatch.file + ': expected ' + mismatch.expected + ', found ' + mismatch.actual)
	})
	console.error('Run `npm run version:sync` and commit the updated files.')
	process.exit(1)
}

main()
