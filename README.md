# MochiNest

Web Bluetooth workspace for Pixl.js. Browse and manage device storage, upload folder trees, and clean up file names — all from the browser, over BLE, without changing the firmware.

## Features

- **File browser** — navigate folders, create folders, rename, delete
- **Bulk operations** — checkbox selection for multi-delete and multi-download
- **Tree uploader** — queue a local folder and upload in one shot with a real-time speed readout
- **Normalize** — rename files to lowercase on the device, recursively or scoped to a folder
- **NFC tag recognition** — `.bin` files show their tag name and series when known
- **Mobile-friendly** — responsive layout with a bottom sheet context panel on small screens
- **Dev mode** — mock BLE client for UI development without a device

## Run Locally

No build step. Requires a secure context for Web Bluetooth.

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements-dev.txt
inv serve   # HTTPS on localhost:8443
```

Reads `.cert/cert.pem` and `.cert/key.pem` for HTTPS.

## Upstream

Built on [solosky/pixl.js](https://github.com/solosky/pixl.js) (GPL-2.0).

## License

GPL-2.0-only.
