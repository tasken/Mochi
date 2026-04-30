# Mochi

Web Bluetooth file manager for [Pixl.js](https://github.com/solosky/pixl.js) — browse, upload, and organize device storage from the browser over BLE, no firmware changes needed.

## Features

- **File browser** — navigate folders, rename, delete, and multi-select files on the device
- **Tree uploader** — drop a local folder or files to upload with real-time progress
- **Sync** — diff local and device trees, push changes, and remove orphaned files
- **NFC tag lookup** — `.bin` files show character name and series from the AmiiboAPI

## Running locally

Web Bluetooth requires HTTPS and a Chromium-based browser (Chrome, Edge, Brave).

Generate a self-signed cert once:

```bash
mkdir -p .cert
openssl req -x509 -newkey rsa:2048 -keyout .cert/key.pem -out .cert/cert.pem \
  -days 365 -nodes -subj "/CN=localhost"
```

Install the task runner and start the server:

```bash
pip install invoke
inv serve
```

For LAN access (e.g. from a phone on the same network):

```bash
inv serve --bind 0.0.0.0 --host <your-local-ip>
```

> Click **Dev** in the top bar to simulate a connected device without hardware.

## License

MIT — see [LICENSE](LICENSE).
