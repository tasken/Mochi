# Mochi

A browser-based tool to manage files and update firmware on [Pixl.js](https://github.com/solosky/pixl.js)-based NFC devices over Bluetooth. No app, no drivers, nothing extra.

**[Try it](https://tasken.github.io/Mochi/)** (requires Chrome, Edge, or Brave).

![Mochi file browser showing a connected device with folders and files](screenshot.png)

## File management

Connect your device and manage its storage directly from the browser:

- **File browser**: navigate folders, rename, delete, and multi-select files
- **Tree uploader**: drop a local folder or files to upload with real-time progress
- **Sync**: diff local and device trees, push changes, and remove orphaned files
- **Normalize**: lowercase-rename files and folders for firmware compatibility
- **Format**: wipe and reformat the device drive
- **NFC tag lookup**: `.bin` files show character name and series from [AmiiboAPI](https://amiiboapi.org/)

## Firmware update

Flash firmware directly over Bluetooth using Nordic Secure DFU. No extra tools required.

- **Auto-detect device mode**: connects to devices in normal or update mode from a single flow
- **Connected shortcut**: devices already paired from the file browser reboot into update mode automatically, no extra pairing needed
- **Release picker**: choose from the built-in release list or use a local `.zip` file
- **Live progress**: real-time transfer speed, progress bar, and stage-by-stage status
- **Resilient transfers**: packet receipt notifications, CRC verification, and automatic retry on failure
- **Update notifications**: badge when a newer firmware version is available

Compatible with [Pixl.js](https://github.com/solosky/pixl.js)-based devices (allmiibo, amiibotool, Wuzplay, Flashiibo, and others).

## Development

To run the app locally:

```bash
# Generate a self-signed cert (one-time)
mkdir -p .cert
openssl req -x509 -newkey rsa:2048 -keyout .cert/key.pem -out .cert/cert.pem \
  -days 365 -nodes -subj "/CN=localhost"

# Start the dev server (HTTPS at localhost:8443)
python3 server.py --cert .cert/cert.pem --key .cert/key.pem
```

> Click **Mock device** in the top bar to simulate a connected device without hardware. The button is only visible in local dev mode.

## License

MIT. See [LICENSE](LICENSE).

## Libraries

- [JSZip](https://stuk.github.io/jszip/) for reading firmware `.zip` packages in the browser
- [Material Symbols](https://fonts.google.com/icons) for iconography
- [IBM Plex Mono](https://fonts.google.com/specimen/IBM+Plex+Mono) for monospace typography

## Thanks

- [solosky/pixl.js](https://github.com/solosky/pixl.js) for the open-source firmware that makes all of this possible
- [thegecko/web-bluetooth-dfu](https://github.com/thegecko/web-bluetooth-dfu) for the original Web Bluetooth Nordic Secure DFU implementation that served as the foundation for the firmware update module
- [Nordic Semiconductor](https://www.nordicsemi.com/) for the Secure DFU protocol specification and [reference implementations](https://github.com/NordicSemiconductor/pc-nrfutil)
- [AmiiboAPI](https://amiiboapi.org/) for the NFC tag character database
