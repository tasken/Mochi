# MochiNest 🍡

A cozy, zero-friction Web Bluetooth file manager and recursive tree uploader for Pixl.js.

Built to keep you in the flow state, MochiNest bypasses the stock client's flat-upload limits by letting you push entire nested folder trees directly to your hardware. With a calm marshmallow-inspired UI, robust operation tracking, and safe bulk file management, it takes the headache out of device storage. No command-line hassle, no firmware flashes—just a smooth, static web app that respects your time.

✨ **Built via pure vibe coding by:** Human intuition, GPT-5.4 and Gemini.

## What Is In This Folder

- `index.html`: standalone static UI
- `app.js`: BLE protocol client and recursive upload logic
- `upstream/pixl.js`: git submodule pointing at the original upstream project

## Upstream Source

The original Pixl.js repository is added as a git submodule at `upstream/pixl.js`.

```bash
git submodule update --init --recursive
```

To refresh it later:

```bash
git submodule update --remote upstream/pixl.js
```

## Run Locally

This app is standalone and does not need a build step.

You can use a local Python virtual environment with `invoke` to keep the server commands short and stable. These tasks do not auto-reload, so file changes will not restart the server.

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements-dev.txt
```

Then run one of these commands:

```bash
inv serve
inv serve-lan
inv serve-https
```

```bash
cd mochinest
python3 -m http.server 8443 --bind 127.0.0.1
```

Then open:

```text
http://127.0.0.1:8443
```

`localhost` is treated as a secure context by browsers, which is enough for Web Bluetooth.

## LAN Access

If you want to serve it on your LAN, you can bind to `0.0.0.0`, but remote Web Bluetooth access generally needs HTTPS instead of plain HTTP.

```bash
cd mochinest
python3 -m http.server 8443 --bind 0.0.0.0
```

The HTTPS invoke task defaults to `https://YOUR_LAN_IP:8443/` and reads `.cert/cert.pem` plus `.cert/key.pem`.

## License

This folder is derived from the GPL-2.0 project in the parent repository, so it keeps the same `GPL-2.0-only` licensing.