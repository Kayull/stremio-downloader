const fs = require('fs')
const path = require('path')
const { execFile, spawn } = require('child_process')

function createShellError(code, message, cause) {
	const err = new Error(message)
	err.code = code
	if (cause)
		err.cause = cause
	return err
}

function spawnDetached(command, args) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			detached: true,
			stdio: 'ignore',
			windowsHide: true
		})

		let settled = false

		child.on('error', err => {
			if (settled)
				return
			settled = true
			reject(err)
		})

		child.on('spawn', () => {
			if (settled)
				return
			settled = true
			child.unref()
			resolve(true)
		})
	})
}

function execFileText(command, args) {
	return new Promise((resolve, reject) => {
		execFile(command, args, { encoding: 'utf8', windowsHide: true }, (err, stdout, stderr) => {
			if (err) {
				err.stdout = stdout
				err.stderr = stderr
				reject(err)
				return
			}

			resolve((stdout || '').trim())
		})
	})
}

function normalizePath(targetPath) {
	return path.resolve(String(targetPath || '').trim())
}

function ensureExistingPath(targetPath) {
	if (!targetPath)
		throw createShellError('invalid_path', 'No path was provided.')

	const resolvedPath = normalizePath(targetPath)
	if (!fs.existsSync(resolvedPath))
		throw createShellError('not_found', 'The requested path no longer exists.')

	return resolvedPath
}

function openTarget(target) {
	if (process.platform === 'darwin')
		return spawnDetached('open', [target])

	if (process.platform === 'win32')
		return spawnDetached('cmd', ['/c', 'start', '', target])

	return spawnDetached('xdg-open', [target])
}

async function openUrl(url) {
	if (!url)
		throw createShellError('invalid_url', 'No URL was provided.')

	try {
		await openTarget(String(url))
		return true
	} catch (err) {
		throw createShellError('open_failed', 'Could not open the requested URL.', err)
	}
}

async function openPath(targetPath) {
	const resolvedPath = ensureExistingPath(targetPath)

	try {
		await openTarget(resolvedPath)
		return true
	} catch (err) {
		throw createShellError('open_failed', 'Could not open the requested path.', err)
	}
}

async function revealPath(targetPath) {
	const resolvedPath = ensureExistingPath(targetPath)

	try {
		if (process.platform === 'darwin') {
			await spawnDetached('open', ['-R', resolvedPath])
			return true
		}

		if (process.platform === 'win32') {
			await spawnDetached('explorer.exe', ['/select,', resolvedPath])
			return true
		}

		await openPath(path.dirname(resolvedPath))
		return true
	} catch (err) {
		throw createShellError('reveal_failed', 'Could not reveal the requested path.', err)
	}
}

function normalizeSelectedFolder(folder) {
	const value = String(folder || '').trim()
	if (!value)
		return ''

	return normalizePath(value.replace(/[\r\n]+/g, ''))
}

async function pickFolderMac() {
	try {
		const folder = await execFileText('osascript', [
			'-e',
			'POSIX path of (choose folder with prompt "Select Download Folder")'
		])
		return normalizeSelectedFolder(folder)
	} catch (err) {
		const message = String((err.stderr || err.message || '')).toLowerCase()
		if (message.includes('user canceled') || message.includes('cancelled') || message.includes('canceled'))
			throw createShellError('cancelled', 'Folder selection was cancelled.', err)

		throw createShellError('picker_failed', 'The macOS folder picker failed to open.', err)
	}
}

async function pickFolderWindows() {
	try {
		const folder = await execFileText('powershell.exe', [
			'-NoProfile',
			'-STA',
			'-Command',
			[
				'Add-Type -AssemblyName System.Windows.Forms',
				"$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
				"$dialog.Description = 'Select Download Folder'",
				'$dialog.UseDescriptionForTitle = $true',
				'if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {',
				'  Write-Output $dialog.SelectedPath',
				'}'
			].join('; ')
		])

		if (!folder)
			throw createShellError('cancelled', 'Folder selection was cancelled.')

		return normalizeSelectedFolder(folder)
	} catch (err) {
		if (err.code === 'cancelled')
			throw err

		if (err.code === 'ENOENT')
			throw createShellError('unsupported', 'PowerShell is not available to open the Windows folder picker.', err)

		throw createShellError('picker_failed', 'The Windows folder picker failed to open.', err)
	}
}

async function pickFolderLinux() {
	const pickers = [
		{
			command: 'zenity',
			args: ['--file-selection', '--directory', '--title=Select Download Folder']
		},
		{
			command: 'kdialog',
			args: ['--getexistingdirectory', path.join(process.env.HOME || '/', ''), '--title', 'Select Download Folder']
		}
	]

	let sawMissingPicker = false

	for (const picker of pickers) {
		try {
			const folder = await execFileText(picker.command, picker.args)
			if (!folder)
				throw createShellError('cancelled', 'Folder selection was cancelled.')
			return normalizeSelectedFolder(folder)
		} catch (err) {
			if (err.code === 'ENOENT') {
				sawMissingPicker = true
				continue
			}

			if (err.code === 'cancelled')
				throw err

			if (typeof err.code === 'number' && err.code === 1)
				throw createShellError('cancelled', 'Folder selection was cancelled.', err)

			const stderr = String(err.stderr || '').toLowerCase()
			if (stderr.includes('cancel'))
				throw createShellError('cancelled', 'Folder selection was cancelled.', err)

			throw createShellError('picker_failed', 'The Linux folder picker failed to open.', err)
		}
	}

	if (sawMissingPicker)
		throw createShellError('unsupported', 'No supported Linux folder picker was found. Install zenity or kdialog.')

	throw createShellError('picker_failed', 'The Linux folder picker failed to open.')
}

async function pickFolder() {
	if (process.platform === 'darwin')
		return pickFolderMac()

	if (process.platform === 'win32')
		return pickFolderWindows()

	return pickFolderLinux()
}

module.exports = {
	createShellError,
	openUrl,
	openPath,
	revealPath,
	pickFolder
}
