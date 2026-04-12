# Stremio Downloader


This project is an actively maintained fork of [BurningSands70/stremio-downloader](https://github.com/BurningSands70/stremio-downloader). If you run into bugs feel free to open an issue.

## Usage

Download the latest release for your platform from the [Releases page](../../releases/latest), then open the app.

Once the app is open:

1. Press `Load Stremio`.
2. A separate browser tab opens with the proxied Stremio web app.
3. Log in to Stremio if needed.
4. Open the stream you want, select a source and the download should start. If not it should show an error either on Stremio or the downloader UI.

## Build from source

### Requirements

- Node.js 18 or newer
- Rust toolchain plus Tauri's platform prerequisites for your OS
- On Windows, `npm run build` also requires the .NET 8 SDK or newer to produce the single-file self-extracting `.exe`.
- To download torrents, the Stremio desktop app still needs to be running locally. (Debrid links usually still work without this since they are mostly direct web-dl links)
- Desktop app targets:
  - macOS: universal `.dmg` for Apple Silicon and Intel Macs. Building with Tauri requires macOS Catalina (10.15) or later.
  - Windows: a single self-extracting x64 `.exe` release asset. Windows 10 or Windows 11 is recommended.
  - Linux: x64 AppImage build target. Built on Ubuntu 22.04; intended for modern x64 Linux distros with a glibc-based userspace.

### Install

```bash
npm install
```

### Run

```bash
npm run dev
```

This starts the desktop app in development mode.

### Build

```bash
npm run build
```

On macOS, `npm run build` defaults to a universal build unless you pass an explicit `--target ...`. 

`npm run build` does the following:

1. Syncs the version from `VERSION`.
2. Stages the temporary desktop runtime and Node sidecar.
3. Runs the Tauri build.
4. Moves the final packaged artifact into:

```bash
tauri/release/<version>-<platform>/
```

On Windows, `npm run build` produces a single self-extracting `.exe` inside the release folder.

5. Deletes temporary staging output such as `build/` and `tauri/binaries/`.

### Repo layout

- `downloader/`: the downloader frontend bundled into the desktop app.
- `lib/`: the local service, download logic, proxying, add-on API, and desktop helpers.
- `scripts/`: build, packaging, and version helper scripts.
- `assets/`: shared app assets such as fonts and icons used by the UI/runtime.
- `tauri/`: the native desktop app project.
- `packaging/`: desktop packaging icons.

Generated folders:

- `build/`: temporary staged runtime data used while preparing desktop builds.
- `tauri/binaries/`: temporary generated launcher sidecars for Tauri.
- `tauri/target/`: Rust/Tauri build cache.
- `tauri/release/`: final packaged app output, organised by version and platform.

The source of truth for the app version is the root `VERSION` file. Build scripts sync that version into `package.json`, `package-lock.json`, `tauri/tauri.conf.json`, and `tauri/Cargo.toml`.

## Actions

- `Play` opens the downloaded local file in a new browser tab through the local service.
- `Reveal` opens the file location in Finder / Explorer / your desktop file manager.
- `Open Download Folder` opens the configured download directory locally.
- `Change Download Folder` uses a native folder picker from the local service.

## Notes

- You must log in after pressing `Load Stremio`, otherwise Stremio may use an anonymous session without your installed add-ons.
- Auth cookies from the proxied Stremio session are stored locally by the downloader service, so you should not need to log in again on every restart.
