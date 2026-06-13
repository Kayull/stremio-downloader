const fs = require('fs')
const path = require('path')
const { Readable } = require('stream')
const { pipeline } = require('stream/promises')
const logger = require('./logger')
const updateCheck = require('./updateCheck')
const userDir = require('./userDir')
const systemShell = require('./systemShell')

const UPDATE_CACHE_DIR = path.join(userDir, 'updates')
const INSTALL_LOG_PATH = path.join(userDir, 'app-update-install.log')

const state = {
	downloaded: null,
	downloadInFlight: null,
	installInFlight: null
}

function createUpdateError(code, message, cause) {
	const err = new Error(message)
	err.code = code
	if (cause)
		err.cause = cause
	return err
}

function ensureUpdateCacheDir() {
	fs.mkdirSync(UPDATE_CACHE_DIR, { recursive: true })
	return UPDATE_CACHE_DIR
}

function sanitizeFilename(value) {
	return String(value || 'update')
		.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
		.replace(/\s+/g, ' ')
		.trim() || 'update'
}

function getAssetDownloadPath(version, asset) {
	const versionDir = path.join(ensureUpdateCacheDir(), sanitizeFilename(version || 'latest'))
	fs.mkdirSync(versionDir, { recursive: true })
	return path.join(versionDir, sanitizeFilename(asset.name))
}

function isCompleteDownloadedAsset(filePath, asset) {
	if (!filePath || !fs.existsSync(filePath))
		return false

	const stats = fs.statSync(filePath)
	if (!stats.isFile() || stats.size <= 0)
		return false

	return !asset.size || stats.size === asset.size
}

async function writeResponseToFile(response, targetPath) {
	const partialPath = targetPath + '.partial'
	fs.rmSync(partialPath, { force: true })
	await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(partialPath))
	fs.renameSync(partialPath, targetPath)
}

async function downloadAsset(asset, targetPath) {
	const response = await fetch(asset.downloadUrl, {
		headers: {
			accept: 'application/octet-stream',
			'user-agent': 'stremio-downloader-update-download'
		}
	})

	if (!response.ok)
		throw createUpdateError('download_failed', 'Update download failed with status ' + response.status)

	await writeResponseToFile(response, targetPath)

	if (!isCompleteDownloadedAsset(targetPath, asset))
		throw createUpdateError('invalid_download', 'The downloaded update file is incomplete.')
}

function toDownloadResult(version, asset, filePath) {
	return {
		done: true,
		version,
		filePath,
		assetName: asset.name,
		platformAction: asset.platformAction
	}
}

async function downloadLatestUpdate() {
	if (state.downloadInFlight)
		return state.downloadInFlight

	state.downloadInFlight = (async () => {
		const releaseInfo = await updateCheck.check()
		if (!releaseInfo.updateAvailable)
			throw createUpdateError('no_update', 'No application update is available.')

		const asset = releaseInfo.updateAsset
		if (!asset || !asset.downloadUrl)
			throw createUpdateError('missing_update_asset', 'No downloadable update is available for this platform.')

		const version = String(releaseInfo.latestVersion || '').trim()
		const filePath = getAssetDownloadPath(version, asset)
		if (!isCompleteDownloadedAsset(filePath, asset)) {
			logger.info('Downloading application update', {
				version,
				asset: asset.name,
				target: filePath
			})
			await downloadAsset(asset, filePath)
		} else {
			logger.info('Using cached application update', {
				version,
				asset: asset.name,
				target: filePath
			})
		}

		state.downloaded = {
			version,
			filePath,
			asset
		}
		return toDownloadResult(version, asset, filePath)
	})()

	try {
		return await state.downloadInFlight
	} finally {
		state.downloadInFlight = null
	}
}

function getDownloadedUpdate() {
	const downloaded = state.downloaded
	if (!downloaded || !downloaded.filePath || !downloaded.asset)
		throw createUpdateError('missing_download', 'Download the update before installing it.')
	if (!isCompleteDownloadedAsset(downloaded.filePath, downloaded.asset))
		throw createUpdateError('missing_download', 'The downloaded update file is no longer available.')

	return downloaded
}

function getParentPid() {
	const pid = Number(process.env.STREMIO_DOWNLOADER_PARENT_PID || 0)
	return Number.isInteger(pid) && pid > 0 ? pid : 0
}

function writeHelperScript(fileName, content) {
	const helperDir = path.join(ensureUpdateCacheDir(), 'helpers')
	fs.mkdirSync(helperDir, { recursive: true })
	const scriptPath = path.join(helperDir, fileName)
	fs.writeFileSync(scriptPath, content)
	if (process.platform !== 'win32')
		fs.chmodSync(scriptPath, 0o755)
	return scriptPath
}

function buildMacInstallScript() {
	return `#!/bin/sh
set -u

PARENT_PID="$1"
SIDECAR_PID="$2"
DMG_PATH="$3"
LOG_PATH="$4"

log() {
  printf '[%s] %s\\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$1" >> "$LOG_PATH" 2>/dev/null || true
}

wait_for_exit() {
  PID_VALUE="$1"
  if [ -z "$PID_VALUE" ] || [ "$PID_VALUE" = "0" ]; then
    return 0
  fi

  while kill -0 "$PID_VALUE" 2>/dev/null; do
    sleep 0.5
  done
}

log "Waiting for Stremio Downloader sidecar to exit before opening update DMG."
wait_for_exit "$SIDECAR_PID"

if [ -n "$PARENT_PID" ] && [ "$PARENT_PID" != "0" ] && kill -0 "$PARENT_PID" 2>/dev/null; then
  log "Terminating Stremio Downloader desktop process."
  kill -TERM "$PARENT_PID" 2>/dev/null || true
fi
wait_for_exit "$PARENT_PID"

log "Opening downloaded update DMG: $DMG_PATH"
/usr/bin/open "$DMG_PATH" >> "$LOG_PATH" 2>&1 || log "Failed to open downloaded update DMG."
`
}

function buildWindowsInstallScript() {
	return `param(
  [int]$ParentPid,
  [int]$SidecarPid,
  [string]$ZipPath,
  [string]$AppDir,
  [string]$LogPath
)

$ErrorActionPreference = 'Stop'

function Write-InstallLog([string]$Message) {
  try {
    $timestamp = [DateTime]::UtcNow.ToString('o')
    Add-Content -LiteralPath $LogPath -Value "[$timestamp] $Message"
  } catch {}
}

function Wait-ForProcessExit([int]$Pid) {
  if ($Pid -le 0) {
    return
  }

  while (Get-Process -Id $Pid -ErrorAction SilentlyContinue) {
    Start-Sleep -Milliseconds 500
  }
}

try {
  Write-InstallLog "Waiting for Stremio Downloader sidecar to exit before replacing portable app files."
  Wait-ForProcessExit $SidecarPid

  $parentProcess = Get-Process -Id $ParentPid -ErrorAction SilentlyContinue
  if ($parentProcess) {
    Write-InstallLog "Terminating Stremio Downloader desktop process."
    Stop-Process -Id $ParentPid -Force -ErrorAction SilentlyContinue
  }
  Wait-ForProcessExit $ParentPid

  if (-not (Test-Path -LiteralPath $ZipPath -PathType Leaf)) {
    throw "Downloaded update zip was not found: $ZipPath"
  }
  if (-not (Test-Path -LiteralPath $AppDir -PathType Container)) {
    throw "Application directory was not found: $AppDir"
  }

  $stageRoot = Join-Path (Split-Path -Parent $ZipPath) ("staged-" + [Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $stageRoot -Force | Out-Null
  Write-InstallLog "Extracting update zip to $stageRoot"
  Expand-Archive -LiteralPath $ZipPath -DestinationPath $stageRoot -Force

  $sourceDir = $stageRoot
  $sourceMainExe = Get-ChildItem -LiteralPath $sourceDir -File -Filter '*.exe' -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -ne 'node-launcher.exe' } |
    Select-Object -First 1

  if (-not $sourceMainExe) {
    $sourceDirCandidate = Get-ChildItem -LiteralPath $stageRoot -Directory -ErrorAction SilentlyContinue |
      Where-Object {
        Get-ChildItem -LiteralPath $_.FullName -File -Filter '*.exe' -ErrorAction SilentlyContinue |
          Where-Object { $_.Name -ne 'node-launcher.exe' }
      } |
      Select-Object -First 1

    if ($sourceDirCandidate) {
      $sourceDir = $sourceDirCandidate.FullName
      $sourceMainExe = Get-ChildItem -LiteralPath $sourceDir -File -Filter '*.exe' -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -ne 'node-launcher.exe' } |
        Select-Object -First 1
    }
  }

  if (-not $sourceMainExe) {
    throw "Could not find the updated Stremio Downloader executable in the extracted zip."
  }

  Write-InstallLog "Copying update files from $sourceDir to $AppDir"
  Get-ChildItem -LiteralPath $sourceDir -Force | ForEach-Object {
    $targetPath = Join-Path $AppDir $_.Name
    if (Test-Path -LiteralPath $targetPath) {
      Remove-Item -LiteralPath $targetPath -Recurse -Force
    }
    Copy-Item -LiteralPath $_.FullName -Destination $targetPath -Recurse -Force
  }

  $updatedExePath = Join-Path $AppDir $sourceMainExe.Name
  Write-InstallLog "Launching updated Stremio Downloader executable: $updatedExePath"
  Start-Process -FilePath $updatedExePath
} catch {
  Write-InstallLog ("Update install failed: " + $_.Exception.Message)
}
`
}

async function spawnMacInstallHelper(downloaded) {
	const scriptPath = writeHelperScript('install-update-macos.sh', buildMacInstallScript())
	await systemShell.spawnDetached('/bin/sh', [
		scriptPath,
		String(getParentPid()),
		String(process.pid),
		downloaded.filePath,
		INSTALL_LOG_PATH
	])
}

async function spawnWindowsInstallHelper(downloaded) {
	const appDir = String(process.env.STREMIO_DOWNLOADER_APP_EXE_DIR || '').trim()
	if (!appDir || !fs.existsSync(appDir))
		throw createUpdateError('missing_app_dir', 'Could not resolve the current app folder for update installation.')

	const scriptPath = writeHelperScript('install-update-windows.ps1', buildWindowsInstallScript())
	const powershellCommand = systemShell.resolveWindowsExecutable('powershell.exe', [
		'System32\\WindowsPowerShell\\v1.0\\powershell.exe'
	])

	await systemShell.spawnDetached(powershellCommand, [
		'-NoProfile',
		'-ExecutionPolicy',
		'Bypass',
		'-File',
		scriptPath,
		String(getParentPid()),
		String(process.pid),
		downloaded.filePath,
		appDir,
		INSTALL_LOG_PATH
	])
}

async function prepareInstallAfterQuit() {
	if (state.installInFlight)
		return state.installInFlight

	state.installInFlight = (async () => {
		const downloaded = getDownloadedUpdate()

		if (downloaded.asset.platformAction === 'open-dmg') {
			await spawnMacInstallHelper(downloaded)
		} else if (downloaded.asset.platformAction === 'replace-windows-portable') {
			await spawnWindowsInstallHelper(downloaded)
		} else {
			throw createUpdateError('unsupported_platform', 'Automatic update installation is not supported on this platform.')
		}

		logger.info('Prepared application update installation after quit', {
			version: downloaded.version,
			filePath: downloaded.filePath,
			platformAction: downloaded.asset.platformAction
		})

		return {
			done: true,
			version: downloaded.version,
			filePath: downloaded.filePath,
			platformAction: downloaded.asset.platformAction
		}
	})()

	try {
		return await state.installInFlight
	} finally {
		state.installInFlight = null
	}
}

module.exports = {
	downloadLatestUpdate,
	prepareInstallAfterQuit,
	getDownloadedUpdate
}
