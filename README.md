# MochiNest

Web Bluetooth workspace for Pixl.js. Browse and manage device storage, upload folder trees, and clean up file names — all from the browser, over BLE, without changing the firmware.

## Quick Start

1. Put the device in BLE File Transfer mode.
2. Open MochiNest in Chrome or Edge (requires `localhost` or HTTPS).
3. Click **Connect to Pixl.js** on the start screen.
4. The file browser opens automatically at `E:/`.

## Features

- **File browser** — navigate folders with a clickable breadcrumb bar, create folders, refresh
- **File operations** — rename or delete individual files inline; bulk-delete via checkbox selection
- **Download** — single-file download per row, or bulk-download selected files (folders are skipped with a toast)
- **Tree uploader** — pick a local folder or files, queue them, and upload in one shot with real-time speed readout
- **Normalize** — rename files to lowercase on the device, with recursive and scoped options
- **NFC tag recognition** -- `.bin` files show their tag name when known
- **Protocol log** — toggle a live BLE command log for debugging
- **Dev mode** — mock BLE client with a static file tree for UI development without a device

## Run Locally

No build step. Requires a secure context for Web Bluetooth.

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements-dev.txt

inv serve                          # HTTPS on 0.0.0.0:8443 (LAN + localhost)
inv serve --bind 127.0.0.1        # localhost only
```

Reads `.cert/cert.pem` and `.cert/key.pem` for HTTPS.

## Files

| File | Purpose |
|---|---|
| `index.html` | App shell and all modals |
| `styles.css` | Layout, components, responsive styles |
| `app.js` | BLE client, file browser, uploader, all UI logic |
| `server.py` | Dev HTTPS server (used by `inv serve`) |

## Upstream

Built on [solosky/pixl.js](https://github.com/solosky/pixl.js) (GPL-2.0).
Special thanks to `@Caleeeeeeeeeeeee` (bootloader), `@白橙` (enclosure), and `@impeeza` (docs translation).

```bash
git submodule update --init --recursive
```

## License

GPL-2.0-only.
