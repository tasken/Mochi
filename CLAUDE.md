# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

MochiNest is a Web Bluetooth workspace for Pixl.js devices. It provides a browser-based tree uploader, remote file manager, and device diagnostic tools that communicate over BLE using the Pixl.js NUS (Nordic UART Service) file transfer protocol. The app is a static single-page application with no build step, no framework, and no bundler.

## Development Commands

```bash
# Set up dev environment (one-time)
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements-dev.txt

# Local development (localhost:8443, secure context for Web Bluetooth)
inv serve

# LAN access (binds 0.0.0.0)
inv serve-lan

# HTTPS for LAN devices (reads .cert/cert.pem and .cert/key.pem)
inv serve-https --host <your-ip> --bind 0.0.0.0 --port 8443

# Alternative: npm scripts (no invoke needed)
npm start
```

There are no tests, no linter, and no build step. The app is served as-is.

## Architecture

The app is being rebuilt as a single self-contained file:

- **`tools.html`** (new, in development): Single-file replacement with inline
  `<style>` and `<script type="module">`. Contains `PixlToolsClient` BLE client,
  tree upload, file manager, metadata browser/editor, drive format, and protocol
  log. Design spec: `docs/superpowers/specs/2026-04-12-device-tools-design.md`.

- **`legacy/`**: Previous app (`app.js`, `index.html`, `styles.css`) moved aside
  during the rebuild. Reference only.

## Key Protocol Details

- BLE service: NUS (Nordic UART Service) with TX/RX characteristics
- Frame header is 4 bytes; max ATT payload is 247 bytes
- File paths have firmware-imposed byte limits: file names ≤47 bytes, file paths ≤65 bytes, folder paths ≤57 bytes (UTF-8 encoded)
- Path validation (`validateRemotePath`) enforces these limits before any device operation
- The client caches folder listings per-path and invalidates after mutations
- Full protocol reference: `.local/ble-protocol-findings.md`

## Deployment

Deployed to GitHub Pages via `.github/workflows/deploy-pages.yml` on push to `main`. The workflow uses rsync with exclusions (`.git/`, `.github/`, `upstream/`, `scripts/`, etc.) and adds `.nojekyll`.

## Upstream

`upstream/pixl.js` is a git submodule pointing to [solosky/pixl.js](https://github.com/solosky/pixl.js). It is not served in production — it's reference material only.
