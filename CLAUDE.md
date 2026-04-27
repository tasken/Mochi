# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Mochi is a Web Bluetooth workspace for Pixl.js devices. It provides a browser-based tree uploader, remote file manager, and device diagnostic tools that communicate over BLE using the Pixl.js NUS (Nordic UART Service) file transfer protocol. The app is a static single-page application with no build step, no framework, and no bundler.

## Structure

```
app/        ← web app (deployed to GitHub Pages)
.github/    ← CI/CD workflows
server.py   ← dev server (HTTPS, serves app/)
tasks.py    ← personal invoke tasks (gitignored)
```

## Development Commands

```bash
# Set up dev environment (one-time)
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements-dev.txt

# Local development (serves app/ over HTTPS at localhost:8443)
inv serve

# LAN access
inv serve --bind 0.0.0.0 --host <your-ip>
```

There are no tests, no linter, and no build step. The app is served as-is from `app/`.

## Architecture

Three files in `app/`, no build step:

- **`app/index.html`** — App shell: topbar (connection, drive info, normalize), context panel (folder/file/upload states, bottom sheet on mobile), file browser (nav bar, breadcrumb, file table), and all modals (format, new folder, rename, delete, 3 normalize variants).
- **`app/styles.css`** — All styles: layout, topbar, context panel, modals, table, selection bar, responsive breakpoints, toast notifications.
- **`app/app.js`** — ES module: `PixlToolsClient` BLE client, `DevMockClient` mock for dev, connection state machine, drive panel, file browser, tree upload (`runUpload`), selection bar, NFC tag lookup, normalize (lowercase rename), and all modal/UI wiring.

## Key Protocol Details

- BLE service: NUS (Nordic UART Service) with TX/RX characteristics
- Frame header is 4 bytes; max ATT payload is 247 bytes
- File paths have firmware-imposed byte limits: file names ≤47 bytes, file paths ≤65 bytes, folder paths ≤57 bytes (UTF-8 encoded)
- Path validation (`validateRemotePath`) enforces these limits before any device operation
- Drive info command (`0x10`) returns `[total_bytes, free_bytes]` — the second field is **free**, not used
- The client caches folder listings per-path and invalidates after mutations

## Deployment

Deployed to GitHub Pages via `.github/workflows/deploy-pages.yml` on push to `main`. The workflow rsyncs `app/` directly to the Pages artifact — no exclusions needed.
