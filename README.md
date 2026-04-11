# Stremio Downloader

Stremio Downloader runs as a local Node service with a browser UI. It can download streams from Stremio and exposes its own Stremio add-on so downloaded content stays available offline.

## Requirements

- Node.js 18 or newer
- `ffmpeg-static` is bundled through npm
- To download torrents, the Stremio desktop app still needs to be running locally

## Install

```bash
npm install
```

## Run

```bash
npm start
```

This starts the local server, prints the local URL, and opens the downloader in your default browser.

If you do not want the browser to open automatically:

```bash
npm run start:no-open
```

## Usage

1. Start the app with `npm start`.
2. In the downloader UI, press `Load Stremio`.
3. A separate browser tab opens with the proxied Stremio web app.
4. Log in to Stremio if needed.
5. Open the stream you want. Instead of playing normally, the downloader captures it and adds it to the local queue.

The downloader UI stays available at the printed local URL and continues to show:

- active download progress
- finished / stopped / errored / missing-on-disk states
- logs
- retry, remove, reveal, and play actions
- download folder management
- add-on installation

## Browser-based actions

- `Play` opens the downloaded local file in a new browser tab through the local service.
- `Reveal` opens the file location in Finder / Explorer / your desktop file manager.
- `Open Download Folder` opens the configured download directory locally.
- `Change Download Folder` uses a native folder picker from the local service.

## Notes

- You must log in after pressing `Load Stremio`, otherwise Stremio may use an anonymous session without your installed add-ons.
- Auth cookies from the proxied Stremio session are now stored locally by the downloader service, so you should not need to log in again on every restart.
- Direct web streams and debrid streams should work on their own.
- Torrent downloads still require the Stremio desktop app and local torrent engine to be running.
