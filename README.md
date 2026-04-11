# Stremio Downloader

Stremio Downloader runs as a local Node service with a browser UI. It can download streams from Stremio and exposes its own Stremio add-on so downloaded content stays on Stremio itself.

## Requirements

- Node.js 18 or newer
- To download torrents, the Stremio desktop app still needs to be running locally. (Debrid links usually still work without this since they are mostly direct web-dl links)
- Desktop app targets:
  - macOS: universal `.app` for Apple Silicon and Intel Macs. Building with Tauri requires macOS Catalina (10.15) or later.
  - Windows: x64 build target. Windows 10 or Windows 11 is recommended.
  - Linux: x64 AppImage build target. Built on Ubuntu 22.04; intended for modern x64 Linux distros with a glibc-based userspace.

## Install

```bash
npm install
```

## Repo layout

- `downloader/`: the actual downloader web UI.
- `lib/`: the local Node service, download logic, proxying, add-on API, and desktop helpers.
- `scripts/`: runtime entrypoints plus build/version helper scripts.
- `assets/`: shared app assets such as fonts and icons used by the UI/runtime.
- `tauri/`: the native desktop shell project.
- `packaging/`: desktop packaging icons.

Generated folders:

- `build/`: temporary staged runtime data used while preparing desktop builds.
- `tauri/binaries/`: temporary generated launcher sidecars for Tauri.
- `tauri/target/`: Rust/Tauri build cache.
- `tauri/release/`: final packaged app output, organised by version and platform.

The source of truth for the app version is the root `VERSION` file. Build scripts sync that version into `package.json`, `package-lock.json`, `tauri/tauri.conf.json`, and `tauri/Cargo.toml`.

## Run

```bash
npm start
```

This starts the local server, prints the local URL, and opens the downloader in your default browser.

If you do not want the browser to open automatically:

```bash
npm run start:no-open
```

## Desktop shell

The repo includes a Tauri v2 desktop shell that wraps the existing local Node service in a native window.

For desktop development, install the Rust toolchain plus Tauri's platform prerequisites, then run:

```bash
npm run tauri:dev
```

For packaged desktop builds:

```bash
npm run tauri:build
```

On macOS, `npm run tauri:build` defaults to a universal build unless you pass an explicit `--target ...`. If the second macOS Node runtime is missing locally, the build script caches the official download under `tauri/cache/node/` so later builds stay fast.

`npm run tauri:build` does the following:

1. Syncs the version from `VERSION`.
2. Stages the temporary desktop runtime and Node sidecar.
3. Runs the Tauri build.
4. Moves the final packaged artifact into:

```bash
tauri/release/<version>-<platform>/
```

5. Deletes temporary staging output such as `build/` and `tauri/binaries/`.

## Usage

1. Start the app with `npm start`.
2. In the downloader UI, press `Load Stremio`.
3. A separate browser tab opens with the proxied Stremio web app.
4. Log in to Stremio if needed.
5. Open the stream you want, select a source and the download should start. If not it should show an error either on Stremio or the downloader UI.

## Browser-based actions

- `Play` opens the downloaded local file in a new browser tab through the local service.
- `Reveal` opens the file location in Finder / Explorer / your desktop file manager.
- `Open Download Folder` opens the configured download directory locally.
- `Change Download Folder` uses a native folder picker from the local service.

## Notes

- You must log in after pressing `Load Stremio`, otherwise Stremio may use an anonymous session without your installed add-ons.
- Auth cookies from the proxied Stremio session are stored locally by the downloader service, so you should not need to log in again on every restart.
