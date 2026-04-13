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

function getWindowsDirectory() {
	const value = String(process.env.windir || process.env.WINDIR || 'C:\\Windows').trim()
	return value || 'C:\\Windows'
}

function resolveWindowsExecutable(command, relativePathCandidates) {
	if (process.platform !== 'win32')
		return command

	const candidates = []
	if (Array.isArray(relativePathCandidates)) {
		const windowsDir = getWindowsDirectory()
		relativePathCandidates.forEach(relativePath => {
			candidates.push(path.join(windowsDir, relativePath))
		})
	}

	candidates.push(command)

	const existingCandidate = candidates.find(candidate => {
		if (!candidate)
			return false
		if (candidate === command)
			return true
		return fs.existsSync(candidate)
	})

	return existingCandidate || command
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

function escapePowerShellSingleQuoted(value) {
	return String(value || '').replace(/'/g, "''")
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
		return spawnDetached(resolveWindowsExecutable('cmd.exe', ['System32\\cmd.exe']), ['/c', 'start', '', target])

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
		if (process.platform === 'win32') {
			const powershellCommand = resolveWindowsExecutable('powershell.exe', [
				'System32\\WindowsPowerShell\\v1.0\\powershell.exe'
			])
			try {
				await execFileText(powershellCommand, [
					'-NoProfile',
					'-Command',
					`Start-Process -FilePath explorer.exe -ArgumentList '"${escapePowerShellSingleQuoted(resolvedPath)}"'`
				])
			} catch (err) {
				await spawnDetached(resolveWindowsExecutable('cmd.exe', ['System32\\cmd.exe']), ['/c', 'start', '', resolvedPath])
			}
			return true
		}

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
			const powershellCommand = resolveWindowsExecutable('powershell.exe', [
				'System32\\WindowsPowerShell\\v1.0\\powershell.exe'
			])
			try {
				await execFileText(powershellCommand, [
					'-NoProfile',
					'-Command',
					`Start-Process -FilePath explorer.exe -ArgumentList '/select,"${escapePowerShellSingleQuoted(resolvedPath)}"'`
				])
			} catch (err) {
				await spawnDetached(resolveWindowsExecutable('cmd.exe', ['System32\\cmd.exe']), [
					'/c',
					'start',
					'',
					resolveWindowsExecutable('explorer.exe', ['explorer.exe']),
					`"/select,${resolvedPath}"`
				])
			}
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
	const powershellCommand = resolveWindowsExecutable('powershell.exe', [
		'System32\\WindowsPowerShell\\v1.0\\powershell.exe'
	])
	const pwshCommand = resolveWindowsExecutable('pwsh.exe', [
		'System32\\WindowsPowerShell\\v1.0\\pwsh.exe',
		'System32\\pwsh.exe'
	])
	const pickerCommands = [
		{
			command: powershellCommand,
			args: [
				'-NoProfile',
				'-STA',
				'-Command'
			]
		},
		{
			command: pwshCommand,
			args: [
				'-NoProfile',
				'-STA',
				'-Command'
			]
		}
	]
	const pickerScript = [
		'Add-Type -AssemblyName System.Windows.Forms',
		"$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
		"$dialog.Description = 'Select Download Folder'",
		'$dialog.UseDescriptionForTitle = $true',
		'if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {',
		'  Write-Output $dialog.SelectedPath',
		'}'
	].join('; ')

	try {
		let lastError = null
		let sawMissingPicker = false

		for (const picker of pickerCommands) {
			try {
				const folder = await execFileText(picker.command, picker.args.concat(pickerScript))
				if (!folder)
					throw createShellError('cancelled', 'Folder selection was cancelled.')

				return normalizeSelectedFolder(folder)
			} catch (err) {
				if (err.code === 'cancelled')
					throw err

				if (err.code === 'ENOENT') {
					sawMissingPicker = true
					lastError = err
					continue
				}

				lastError = err
				break
			}
		}

		if (sawMissingPicker)
			throw createShellError('unsupported', 'PowerShell is not available to open the Windows folder picker.', lastError)
		throw lastError || createShellError('picker_failed', 'The Windows folder picker failed to open.')
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
