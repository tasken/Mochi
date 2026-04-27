# Mochi

Web Bluetooth workspace for [Pixl.js](https://github.com/solosky/pixl.js). Manage device storage from the browser over BLE, no firmware changes needed.

## Features

- **File browser** — navigate, create folders, rename, delete, multi-select
- **Tree uploader** — queue a local folder or files and upload with real-time progress
- **Normalize** — batch-rename files to lowercase, scoped to current folder or recursive
- **NFC tag info** — `.bin` files show character name, series, and Figure ID when recognized
- **Mobile-ready** — full-screen panels, pull-to-refresh, touch-friendly nav

## Run Locally

No build step. Web Bluetooth requires a secure context (HTTPS) and a Chromium-based browser (Chrome, Edge, Opera, Brave).

Generate a self-signed certificate first:

```bash
mkdir .cert
openssl req -x509 -newkey rsa:2048 -keyout .cert/key.pem -out .cert/cert.pem -days 365 -nodes -subj "/CN=localhost"
```

Then start the dev server (no dependencies beyond Python 3):

```bash
python3 scripts/server.py --bind 0.0.0.0 --cert .cert/cert.pem --key .cert/key.pem
```

Open `https://<your-ip>:8443` in a Chromium-based browser.

## Thanks

To the [solosky/pixl.js](https://github.com/solosky/pixl.js) firmware developers for the open BLE protocol and reference implementation.

## License

MIT — see [LICENSE](LICENSE).
