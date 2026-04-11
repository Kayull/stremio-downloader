const fs = require('fs')
const path = require('path')
const { repoRoot, readVersion, readText, writeText } = require('./version-utils')

const packageJsonPath = path.join(repoRoot, 'package.json')
const packageLockPath = path.join(repoRoot, 'package-lock.json')
const tauriConfigPath = path.join(repoRoot, 'tauri', 'tauri.conf.json')
const cargoTomlPath = path.join(repoRoot, 'tauri', 'Cargo.toml')

function syncJsonVersion(filePath, version, mutator) {
	const data = JSON.parse(readText(filePath))
	mutator(data, version)
	writeText(filePath, JSON.stringify(data, null, 2) + '\n')
}

function syncCargoToml(version) {
	const cargoToml = readText(cargoTomlPath)
	const nextCargoToml = cargoToml.replace(/^version = ".*"$/m, 'version = "' + version + '"')
	if (cargoToml === nextCargoToml)
		return

	writeText(cargoTomlPath, nextCargoToml)
}

function syncVersion() {
	const version = readVersion()

	syncJsonVersion(packageJsonPath, version, data => {
		data.version = version
	})

	if (fs.existsSync(packageLockPath)) {
		syncJsonVersion(packageLockPath, version, data => {
			data.version = version
			if (data.packages && data.packages[''])
				data.packages[''].version = version
		})
	}

	syncJsonVersion(tauriConfigPath, version, data => {
		data.version = version
	})

	syncCargoToml(version)

	console.log('Synced project version to', version)
}

syncVersion()
