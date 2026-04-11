# Stremio Downloader

Stremio Downloader runs as a local Node service with a browser UI. It can download streams from Stremio and exposes its own Stremio add-on so downloaded content stays on Stremio itself.

## Requirements

- Node.js 18 or newer
- To download torrents, the Stremio desktop app still needs to be running locally. (Debrid links usually still work without this since they are mostly direct web-dl links)

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
5. Open the stream you want, select a source and the download should start. If not it should show an error either on Stremio or the downloader UI.

## Browser-based actions

- `Play` opens the downloaded local file in a new browser tab through the local service.
- `Reveal` opens the file location in Finder / Explorer / your desktop file manager.
- `Open Download Folder` opens the configured download directory locally.
- `Change Download Folder` uses a native folder picker from the local service.

## Notes

- You must log in after pressing `Load Stremio`, otherwise Stremio may use an anonymous session without your installed add-ons.
- Auth cookies from the proxied Stremio session are stored locally by the downloader service, so you should not need to log in again on every restart.