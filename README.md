# Pixl.js

MochiNest is a Web Bluetooth workspace for Pixl.js. It combines a recursive tree uploader with a remote file manager, so you can move folder trees, create folders, browse storage, and clean up names directly from the browser.

The app stays on top of the existing Pixl.js BLE file protocol. Its goal is simple: make larger storage tasks practical without changing the firmware, and make slow device operations easier to follow while they run.

## Quick Start

1. Put the device in BLE File Transfer mode.
2. Open MochiNest in Chrome or Edge over `localhost` or HTTPS.
3. Connect the device and refresh the drive list.
4. Choose a drive and a destination folder.
5. Pick a workspace:
	Tree uploader for sending local files and folders.
	File manager for browsing storage, creating folders, lowercasing names, or deleting items.

## What Is In This Folder

- `index.html`: static application shell
- `styles.css`: UI styling and state-driven presentation
- `app.js`: BLE client, uploader, file manager, and activity state logic
- `upstream/pixl.js`: git submodule pointing at the upstream project

## Upstream Source

The upstream Pixl.js project is included as a git submodule at `upstream/pixl.js`.

Source repository: https://github.com/solosky/pixl.js

```bash
git submodule update --init --recursive
```

To refresh it later:

```bash
git submodule update --remote upstream/pixl.js
```

## Upstream Contributors

This workspace builds on Pixl.js, and the original project should remain clearly credited.

- Special thanks to `@Caleeeeeeeeeeeee` for the bootloader work.
- Special thanks to `@白橙` for the enclosure design.
- Special thanks to `@impeeza` for the documentation translation.

## Run Locally

MochiNest is a static app and does not need a build step.

For short local commands, create a virtual environment and install the dev dependency:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements-dev.txt
```

Then run one of the included tasks:

```bash
inv serve
inv serve-lan
inv serve-https
```

For a local-only session, open:

```text
http://localhost:8443
```

Browsers treat `localhost` as a secure context, which is enough for Web Bluetooth.

## HTTPS And LAN Use

Web Bluetooth from another device on your LAN generally needs HTTPS. The `serve-https` task reads `.cert/cert.pem` and `.cert/key.pem`.

You can override the advertised host, bind address, port, certificate path, and key path to match your setup:

```bash
inv serve-https --host <your-host> --bind 0.0.0.0 --port 8443 --cert .cert/cert.pem --key .cert/key.pem
```

## License

This folder derives from the GPL-2.0 project in the upstream repository, so it remains `GPL-2.0-only`.