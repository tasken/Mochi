// === Constants ===

const NUS_SERVICE_UUID = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";
const NUS_CHAR_TX_UUID = "6e400002-b5a3-f393-e0a9-e50e24dcca9e";
const NUS_CHAR_RX_UUID = "6e400003-b5a3-f393-e0a9-e50e24dcca9e";

const FRAME_HEADER_SIZE = 4;
const MAX_FILE_NAME_BYTES = 47;
const MAX_FILE_PATH_BYTES = 65;
const MAX_FOLDER_PATH_BYTES = 57;
const LARGE_DIR_THRESHOLD = 80;
const LONG_FILENAME_BYTES = 15;
const LARGE_BATCH_THRESHOLD = 200;
const PIXL_RELEASES_URL = "https://github.com/solosky/pixl.js/releases";
const PIXL_LATEST_API = "https://api.github.com/repos/solosky/pixl.js/releases/latest";
const DEV_MOCK_UPLOAD_BYTES_PER_SECOND = 192 * 1024;
const DEV_MOCK_UPLOAD_MIN_DURATION_MS = 180;
const DEV_MOCK_UPLOAD_MAX_DURATION_MS = 900;
const DEV_MOCK_UPLOAD_MAX_PROGRESS_UPDATES = 6;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const VFS_ERRORS = {
  0: "OK",
  1: "Command failed",
  [-1]: "Device error",
  [-2]: "Out of memory",
  [-3]: "End of file",
  [-4]: "Already exists",
  [-5]: "Name too long",
  [-6]: "Drive not found",
  [-7]: "Storage corrupted",
  [-90]: "Not found",
  [-91]: "No space left",
  [-99]: "Unsupported",
};

const CMD_NAMES = {
  0x01: "VERSION_INFO",
  0x10: "DRIVE_LIST",
  0x11: "DRIVE_FORMAT",
  0x12: "FILE_OPEN",
  0x13: "FILE_CLOSE",
  0x14: "FILE_READ",
  0x15: "FILE_WRITE",
  0x16: "DIR_READ",
  0x17: "DIR_CREATE",
  0x18: "REMOVE",
  0x19: "RENAME",
};

// === Utilities ===

function encodeString(value) {
  const bytes = encoder.encode(value);
  const output = new Uint8Array(2 + bytes.length);
  output[0] = bytes.length & 0xff;
  output[1] = (bytes.length >> 8) & 0xff;
  output.set(bytes, 2);
  return output;
}

function concatBytes(...chunks) {
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) { out.set(c, offset); offset += c.length; }
  return out;
}

function utf8Length(value) { return encoder.encode(value).length; }

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function escapeHtml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function getBaseName(path) {
  const parts = path.split("/").filter(Boolean);
  return parts.length === 0 ? "" : parts[parts.length - 1];
}

function getParentPath(path) {
  const i = path.lastIndexOf("/");
  return i <= 2 ? path.slice(0, 3) : path.slice(0, i);
}

function joinChildPath(parent, child) {
  const c = String(child || "").replace(/^\/+|\/+$/g, "");
  if (!c) return parent;
  return parent.endsWith("/") ? `${parent}${c}` : `${parent}/${c}`;
}

function validateRemotePath(path, kind) {
  const limit = kind === "folder" ? MAX_FOLDER_PATH_BYTES : MAX_FILE_PATH_BYTES;
  const len = utf8Length(path);
  if (len > limit) throw new Error(`${kind === "folder" ? "Folder" : "File"} path is ${len} bytes (max ${limit}): ${path}`);
  const base = getBaseName(path);
  if (base && utf8Length(base) > MAX_FILE_NAME_BYTES) throw new Error(`Name exceeds ${MAX_FILE_NAME_BYTES} bytes: ${base}`);
}

function sortEntries(entries) {
  return [...entries].sort((a, b) => {
    if (a.type !== b.type) return a.type === "DIR" ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
  });
}

function triggerDownload(data, filename) {
  const url = URL.createObjectURL(new Blob([data]));
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 200);
}

// === Binary cursor ===

class Cursor {
  constructor(bytes) { this.bytes = bytes; this.offset = 0; }
  remaining() { return this.bytes.length - this.offset; }
  u8() { return this.bytes[this.offset++]; }
  u16() { const v = this.bytes[this.offset] | (this.bytes[this.offset + 1] << 8); this.offset += 2; return v; }
  u32() { const view = new DataView(this.bytes.buffer, this.bytes.byteOffset + this.offset, 4); const v = view.getUint32(0, true); this.offset += 4; return v; }
  take(n) { const v = this.bytes.slice(this.offset, this.offset + n); this.offset += n; return v; }
  string() { return decoder.decode(this.take(this.u16())); }
}

// === BLE Client ===

class PixlToolsClient {
  constructor(logFn) {
    this._log = logFn;
    this.device = null;
    this.txChar = null;
    this.rxChar = null;
    this.queue = Promise.resolve();
    this.pending = null;
    this.chunking = false;
    this.rxParts = [];
    this.createdFolders = new Set();
    this._pendingTimer = null;
    this._intentionalDisconnect = false;
    this._reconnecting = false;
    this._abortReconnect = false;
    this._onNotification = this._onNotification.bind(this);
    this._onDisconnect = this._onDisconnect.bind(this);
    this.onDisconnect = null;
    this.onReconnecting = null;
    this.onReconnect = null;
  }

  async connect() {
    if (!navigator.bluetooth) throw new Error("Web Bluetooth is not available.");
    this._log("Requesting BLE device...");
    const device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [NUS_SERVICE_UUID] }],
      optionalServices: [NUS_SERVICE_UUID],
    });
    await this._setupGatt(device);
  }

  async _setupGatt(device) {
    device.removeEventListener("gattserverdisconnected", this._onDisconnect);
    device.addEventListener("gattserverdisconnected", this._onDisconnect);
    if (this.rxChar) this.rxChar.removeEventListener("characteristicvaluechanged", this._onNotification);
    const server = await device.gatt.connect();
    try {
      const service = await server.getPrimaryService(NUS_SERVICE_UUID);
      const chars = await service.getCharacteristics();
      this.txChar = null; this.rxChar = null;
      for (const c of chars) {
        if (c.uuid === NUS_CHAR_TX_UUID) this.txChar = c;
        else if (c.uuid === NUS_CHAR_RX_UUID) this.rxChar = c;
      }
      if (!this.txChar || !this.rxChar) throw new Error("NUS characteristics not found.");
      this.device = device;
      await this.rxChar.startNotifications();
      this.rxChar.addEventListener("characteristicvaluechanged", this._onNotification);
    } catch (err) {
      this.txChar = null; this.rxChar = null; this.device = null;
      if (server.connected) server.disconnect();
      throw err;
    }
    this.createdFolders.clear();
    this._log(`Connected to ${device.name || "BLE device"}.`);

    // Stale handle cleanup: close any dangling file handle from a prior session.
    // The device returns an error if no file was open; suppress that log entry.
    const savedLog = this._log;
    this._log = () => {};
    try {
      await this._sendCommand(0x13, Uint8Array.of(0));
    } finally {
      this._log = savedLog;
    }
  }

  disconnect() {
    if (this._reconnecting) {
      this._abortReconnect = true;
      return;
    }
    if (this.device && this.device.gatt.connected) {
      this._intentionalDisconnect = true;
      this.device.gatt.disconnect();
      return;
    }
    this._resetTransport("Disconnected.");
  }

  _resetTransport(reason) {
    if (this.rxChar) this.rxChar.removeEventListener("characteristicvaluechanged", this._onNotification);
    if (this.device) this.device.removeEventListener("gattserverdisconnected", this._onDisconnect);
    clearTimeout(this._pendingTimer); this._pendingTimer = null;
    if (this.pending) { this.pending.reject(new Error(reason)); this.pending = null; }
    this.device = null; this.txChar = null; this.rxChar = null;
    this.queue = Promise.resolve(); this.chunking = false; this.rxParts = [];
    this.createdFolders.clear();
  }

  _onDisconnect() {
    this._log("Device disconnected.");
    const savedDevice = this.device;
    const intentional = this._intentionalDisconnect;
    this._intentionalDisconnect = false;
    this._resetTransport("Device disconnected.");
    if (this._reconnecting) return;
    if (savedDevice && !intentional) {
      if (this.onReconnecting) this.onReconnecting();
      this._attemptReconnect(savedDevice);
    } else {
      if (this.onDisconnect) this.onDisconnect();
    }
  }

  async _attemptReconnect(device) {
    this._reconnecting = true;
    this._abortReconnect = false;
    const delays = [2000, 4000, 8000];
    for (const delay of delays) {
      await new Promise(r => setTimeout(r, delay));
      if (this._abortReconnect) {
        this._reconnecting = false;
        this._abortReconnect = false;
        return;
      }
      try {
        this._log("Reconnecting...");
        await this._setupGatt(device);
        this._reconnecting = false;
        if (this.onReconnect) this.onReconnect();
        return;
      } catch (_) {
        // try next delay
      }
    }
    this._reconnecting = false;
    if (this.onDisconnect) this.onDisconnect();
  }

  // --- Commands that return { ok, error, data } ---

  async getVersion() {
    const r = await this._sendCommand(0x01);
    if (r.status !== 0) return { ok: false, error: this._vfsError(r.status), data: null };
    const c = new Cursor(r.payload);
    const version = c.string();
    const bleAddress = c.remaining() > 0 ? c.string() : "";
    return { ok: true, error: null, data: { version, bleAddress } };
  }

  async listDrives() {
    const r = await this._sendCommand(0x10);
    if (r.status !== 0) return { ok: false, error: this._vfsError(r.status), data: null };
    const c = new Cursor(r.payload);
    const count = c.u8();
    const drives = [];
    for (let i = 0; i < count; i++) {
      drives.push({
        status: c.u8(),
        label: String.fromCharCode(c.u8()),
        name: c.string(),
        totalBytes: c.u32(),
        freeBytes: c.u32(),
      });
    }
    return { ok: true, error: null, data: drives };
  }

  async formatDrive(label) {
    const payload = Uint8Array.of(label.charCodeAt(0));
    const r = await this._sendCommand(0x11, payload);
    if (r.status !== 0) return { ok: false, error: this._vfsError(r.status), data: null };
    return { ok: true, error: null, data: null };
  }

  async readFolder(path) {
    const r = await this._sendCommand(0x16, encodeString(path));
    if (r.status !== 0) return { ok: false, error: this._vfsError(r.status), data: null };
    const c = new Cursor(r.payload);
    const entries = [];
    let truncated = false;
    while (c.remaining() >= 8) { // 8 = 2 (name_len u16) + 4 (size u32) + 1 (type) + 1 (meta_size)
      const nameLen = c.bytes[c.offset] | (c.bytes[c.offset + 1] << 8);
      if (c.remaining() < 2 + nameLen + 4 + 1 + 1) break;
      const name = c.string();
      const size = c.u32();
      const type = c.u8() === 1 ? "DIR" : "FILE";
      const metaSize = c.u8();
      if (c.remaining() < metaSize) { truncated = true; break; }
      const meta = { flags: 0, nfcTagHead: null, nfcTagTail: null };
      if (metaSize > 0) {
        const metaStart = c.offset;
        const metaEnd = metaStart + metaSize;
        let pos = metaStart;
        // Firmware TLV format (vfs_meta.c): type 1 (NOTES) skipped, types 2 (FLAGS) and 3 (NFC_TAG_ID) have no length prefix.
        while (pos < metaEnd) {
          const tlvType = c.bytes[pos];
          pos += 1;
          if (tlvType === 1) {
            // Notes: [len][...utf8...] — skip
            if (pos >= metaEnd || pos >= c.bytes.length) break;
            const len = c.bytes[pos]; pos += 1;
            pos += len;
          } else if (tlvType === 2) {
            // Flags: [flags_byte] — no length prefix
            if (pos >= metaEnd || pos >= c.bytes.length) break;
            meta.flags = c.bytes[pos]; pos += 1;
          } else if (tlvType === 3) {
            // NFC Tag ID: [head u32 LE][tail u32 LE] — no length prefix
            if (pos + 8 > metaEnd || pos + 8 > c.bytes.length) break;
            const mv = new DataView(c.bytes.buffer, c.bytes.byteOffset + pos, 8);
            meta.nfcTagHead = mv.getUint32(0, true);
            meta.nfcTagTail = mv.getUint32(4, true);
            pos += 8;
          } else {
            break; // unknown type, length unknown — cannot continue
          }
        }
        c.offset = Math.min(metaEnd, c.bytes.length);
      }
      entries.push({ name, size, type, meta });
    }
    truncated = truncated || c.remaining() > 0;
    return { ok: true, error: null, data: entries, truncated };
  }

  async createFolder(path) {
    const r = await this._sendCommand(0x17, encodeString(path));
    if (r.status !== 0) return { ok: false, error: this._vfsError(r.status), data: null };
    return { ok: true, error: null, data: null };
  }

  async removePath(path) {
    const r = await this._sendCommand(0x18, encodeString(path));
    if (r.status !== 0) return { ok: false, error: this._vfsError(r.status), data: null };
    return { ok: true, error: null, data: null };
  }

  async renamePath(oldPath, newPath) {
    const r = await this._sendCommand(0x19, concatBytes(encodeString(oldPath), encodeString(newPath)));
    if (r.status !== 0) return { ok: false, error: this._vfsError(r.status), data: null };
    return { ok: true, error: null, data: null };
  }

  async openFile(path, mode) {
    const payload = concatBytes(encodeString(path), Uint8Array.of(mode === "r" ? 0x08 : 0x16));
    const r = await this._sendCommand(0x12, payload);
    if (r.status !== 0) return { ok: false, error: this._vfsError(r.status), data: null };
    const c = new Cursor(r.payload);
    return { ok: true, error: null, data: c.u8() };
  }

  async writeFileChunk(fileId, chunk) {
    const r = await this._sendCommand(0x15, concatBytes(Uint8Array.of(fileId), chunk));
    if (r.status !== 0) return { ok: false, error: this._vfsError(r.status), data: null };
    return { ok: true, error: null, data: null };
  }

  async closeFile(fileId) {
    const r = await this._sendCommand(0x13, Uint8Array.of(fileId));
    if (r.status !== 0) return { ok: false, error: this._vfsError(r.status), data: null };
    return { ok: true, error: null, data: null };
  }

  async readFileData(path) {
    const openRes = await this.openFile(path, "r");
    if (!openRes.ok) return { ok: false, error: openRes.error, data: null };
    const fileId = openRes.data;
    try {
      const r = await this._sendCommand(0x14, Uint8Array.of(fileId));
      if (r.status !== 0) return { ok: false, error: this._vfsError(r.status), data: null };
      return { ok: true, error: null, data: r.payload };
    } finally {
      await this.closeFile(fileId).catch(() => {});
    }
  }

  // --- Higher-level helpers ---

  async ensureFolder(remotePath) {
    const root = remotePath.slice(0, 3);
    if (remotePath === root) return;
    const segments = remotePath.slice(3).split("/").filter(Boolean);
    let current = root;
    for (const seg of segments) {
      current = current === root ? `${root}${seg}` : `${current}/${seg}`;
      validateRemotePath(current, "folder");
      if (this.createdFolders.has(current)) continue;
      const res = await this.createFolder(current);
      if (!res.ok) {
        const parent = getParentPath(current);
        const listing = await this.readFolder(parent);
        if (!listing.ok) throw new Error(listing.error);
        const exists = listing.data.some(e => e.type === "DIR" && e.name === getBaseName(current));
        if (!exists) throw new Error(res.error);
        this._log(`Using existing ${current}`);
      } else {
        this._log(`Created ${current}`);
      }
      this.createdFolders.add(current);
    }
  }

  async uploadFile(remotePath, file, onProgress, abortSignal, chunkSize = 128) {
    validateRemotePath(remotePath, "file");
    const openRes = await this.openFile(remotePath, "w");
    if (!openRes.ok) throw new Error(openRes.error);
    const fileId = openRes.data;
    const bytes = new Uint8Array(await file.arrayBuffer());
    try {
      if (bytes.length === 0) { onProgress(0, 0); return; }
      let offset = 0;
      while (offset < bytes.length) {
        if (abortSignal && abortSignal.aborted) throw new Error("Upload aborted by user.");
        const end = Math.min(offset + chunkSize, bytes.length);
        const res = await this.writeFileChunk(fileId, bytes.slice(offset, end));
        if (!res.ok) throw new Error(res.error);
        offset = end;
        onProgress(offset, bytes.length);
      }
    } finally {
      await this.closeFile(fileId).catch(() => {});
    }
  }

  // --- Transport ---

  _vfsError(status) {
    const signed = status > 127 ? status - 256 : status;
    return VFS_ERRORS[signed] || `Unknown error (status ${signed})`;
  }

  _sendCommand(cmd, payload = new Uint8Array()) {
    const cmdName = CMD_NAMES[cmd] || `0x${cmd.toString(16)}`;
    const run = () => this._performCommand(cmd, payload, cmdName);
    this.queue = this.queue.catch((err) => { if (!this.txChar) return; throw err; }).then(run);
    return this.queue;
  }

  async _performCommand(cmd, payload, cmdName) {
    if (!this.txChar) throw new Error("Not connected.");
    this._log(`→ ${cmdName}${payload.length > 0 ? ` (${payload.length}B)` : ""}`);
    return new Promise(async (resolve, reject) => {
      this.pending = { resolve, reject, cmd };
      try {
        const frame = new Uint8Array(FRAME_HEADER_SIZE + payload.length);
        frame[0] = cmd; frame[1] = 0; frame[2] = 0; frame[3] = 0;
        frame.set(payload, FRAME_HEADER_SIZE);
        if (typeof this.txChar.writeValueWithResponse === "function") {
          await this.txChar.writeValueWithResponse(frame);
        } else {
          await this.txChar.writeValue(frame);
        }
        const pendingRef = this.pending;
        this._pendingTimer = setTimeout(() => {
          if (this.pending === pendingRef) {
            this.pending = null;
            this._pendingTimer = null;
            reject(new Error("Command timed out"));
          }
        }, 15000);
      } catch (err) {
        this.pending = null;
        reject(err);
      }
    });
  }

  _onNotification(event) {
    if (!this.pending) return;
    try {
      const incoming = new Uint8Array(
        event.target.value.buffer.slice(
          event.target.value.byteOffset,
          event.target.value.byteOffset + event.target.value.byteLength
        )
      );
      const chunk = incoming[2] | (incoming[3] << 8);
      const hasMore = (chunk & 0x8000) !== 0;
      if (hasMore) {
        if (!this.chunking) { this.rxParts = [incoming]; this.chunking = true; }
        else { this.rxParts.push(incoming.slice(FRAME_HEADER_SIZE)); }
        return;
      }
      let frame = incoming;
      if (this.chunking) {
        this.rxParts.push(incoming.slice(FRAME_HEADER_SIZE));
        frame = concatBytes(...this.rxParts);
        this.rxParts = []; this.chunking = false;
      }
      const response = {
        cmd: frame[0],
        status: frame[1],
        chunk: frame[2] | (frame[3] << 8),
        payload: frame.slice(FRAME_HEADER_SIZE),
      };
      const p = this.pending;
      clearTimeout(this._pendingTimer); this._pendingTimer = null;
      this.pending = null;
      const cmdName = CMD_NAMES[response.cmd] || `0x${response.cmd.toString(16)}`;
      if (response.status === 0) {
        this._log(`← ${cmdName} OK${response.payload.length > 0 ? ` (${response.payload.length}B)` : ""}`);
      } else {
        const errMsg = this._vfsError(response.status);
        this._log(`← ${cmdName} ERR: ${errMsg}`);
      }
      if (response.cmd !== p.cmd) {
        p.reject(new Error(`Unexpected response 0x${response.cmd.toString(16)} for 0x${p.cmd.toString(16)}`));
        return;
      }
      p.resolve(response);
    } catch (err) {
      clearTimeout(this._pendingTimer); this._pendingTimer = null;
      if (this.pending) { this.pending.reject(err); this.pending = null; }
      this.chunking = false; this.rxParts = [];
    }
  }
}

// === Dev Mock Client ===

class DevMockClient {
  constructor() {
    this.onDisconnect = null;
    this.createdFolders = new Set(); // populated externally by browseFolder(); cleared by invalidateCache()
    this.isDriveFormatted = false;
  }

  async connect() {}

  disconnect() {
    this.onDisconnect?.();
  }

  async getVersion() {
    return { ok: true, data: { version: "2.14.0", bleAddress: "DE:V0:00:00:00:00" } };
  }

  async listDrives() {
    return {
      ok: true,
      data: [{
        label: "E",
        name: "E:",
        totalBytes: 8 * 1024 * 1024,
        freeBytes: this.isDriveFormatted ? 8 * 1024 * 1024 : 6 * 1024 * 1024,
      }],
    };
  }

  async readFolder(path) {
    if (this.isDriveFormatted) return { ok: true, data: [] };

    const fs = {
      "E:/": [
        { name: "nfc",        type: "DIR" },
        { name: "save",       type: "DIR" },
        { name: "README.txt", type: "FILE", size: 312, meta: { nfcTagHead: null, nfcTagTail: null } },
      ],
      "E:/nfc": [
        { name: "figures",    type: "DIR" },
        { name: "large-set", type: "DIR" },
        { name: "alpha.bin", type: "FILE", size: 540, meta: { nfcTagHead: 0x00000000, nfcTagTail: 0x00000002 } },
        { name: "bravo.bin", type: "FILE", size: 540, meta: { nfcTagHead: 0x05C00000, nfcTagTail: 0x04121302 } },
      ],
      "E:/nfc/figures": [
        { name: "charlie.bin", type: "FILE", size: 540, meta: { nfcTagHead: 0x01000000, nfcTagTail: 0x03530902 } },
        { name: "delta.bin",   type: "FILE", size: 540, meta: { nfcTagHead: 0x01000000, nfcTagTail: 0x03540902 } },
      ],
      "E:/save": [
        { name: "backup.bin", type: "FILE", size: 1229, meta: { nfcTagHead: null, nfcTagTail: null } },
      ],
      "E:/nfc/large-set": [
        { name: "super_smash_bros_ultimate_mario_classic_costume.bin", type: "FILE", size: 540, meta: { nfcTagHead: 0x01000060, nfcTagTail: 0x03530902 } },
        { name: "the_legend_of_zelda_breath_of_the_wild_link.bin",     type: "FILE", size: 540, meta: { nfcTagHead: 0x01000061, nfcTagTail: 0x03530902 } },
        { name: "animal_crossing_new_horizons_isabelle_summer.bin",     type: "FILE", size: 540, meta: { nfcTagHead: 0x01000062, nfcTagTail: 0x03530902 } },
        { name: "splatoon_3_inkling_girl_neon_pink_special_ed.bin",     type: "FILE", size: 540, meta: { nfcTagHead: 0x01000063, nfcTagTail: 0x03530902 } },
        { name: "pokemon_scarlet_violet_koraidon_full_power.bin",       type: "FILE", size: 540, meta: { nfcTagHead: 0x01000064, nfcTagTail: 0x03530902 } },
        ...Array.from({ length: 90 }, (_, i) => ({
          name: `tag_${String(i + 1).padStart(3, "0")}.bin`,
          type: "FILE",
          size: 540,
          meta: { nfcTagHead: 0x01000000 + i, nfcTagTail: 0x03530902 },
        })),
      ],
    };
    return { ok: true, data: fs[path] ?? [] };
  }

  // Mutations always succeed but are not reflected in readFolder (static mock).
  async createFolder()    { return { ok: true, data: null }; }
  async removePath(path)  {
    if (path && path.toLowerCase().endsWith("readme.txt")) {
      return { ok: false, error: "Permission denied (mock)" };
    }
    return { ok: true, data: null };
  }
  async renamePath()      { return { ok: true, data: null }; }
  async formatDrive()     {
    this.isDriveFormatted = true;
    this.createdFolders.clear();
    return { ok: true, data: null };
  }
  async openFile()        { return { ok: true, data: 0 }; }
  async writeFileChunk()  { return { ok: true, data: null }; }
  async closeFile()       { return { ok: true, data: null }; }
  async readFileData(path) {
    const mockFiles = {
      "E:/README.txt":                    { size: 312,  nfcTagHead: null,       nfcTagTail: null },
      "E:/nfc/alpha.bin":                  { size: 540,  nfcTagHead: 0x00000000, nfcTagTail: 0x00000002 },
      "E:/nfc/bravo.bin":                  { size: 540,  nfcTagHead: 0x05C00000, nfcTagTail: 0x04121302 },
      "E:/nfc/figures/charlie.bin":         { size: 540,  nfcTagHead: 0x01000000, nfcTagTail: 0x03530902 },
      "E:/nfc/figures/delta.bin":           { size: 540,  nfcTagHead: 0x01000000, nfcTagTail: 0x03540902 },
      "E:/save/backup.bin":                { size: 1229, nfcTagHead: null,       nfcTagTail: null },
    };
    // Generate mock entries for large-set files
    const largeMatch = path.match(/^E:\/nfc\/large-set\/tag_(\d+)\.bin$/);
    if (largeMatch) {
      const idx = parseInt(largeMatch[1], 10) - 1;
      const data = new Uint8Array(540);
      const dv = new DataView(data.buffer);
      dv.setUint32(84, 0x01000000 + idx, false);
      dv.setUint32(88, 0x03530902, false);
      return { ok: true, data };
    }
    const meta = mockFiles[path];
    const size = meta?.size ?? 32;
    const data = new Uint8Array(size);
    if (meta?.nfcTagHead != null && size >= 92) {
      const dv = new DataView(data.buffer);
      dv.setUint32(84, meta.nfcTagHead, false);
      dv.setUint32(88, meta.nfcTagTail, false);
    }
    return { ok: true, data };
  }
  async ensureFolder()    {}

  ensureUploadNotAborted(abortSignal) {
    if (abortSignal && abortSignal.aborted) throw new Error("Upload aborted by user.");
  }

  waitForMockUploadDelay(ms, abortSignal) {
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timer);
        abortSignal.removeEventListener("abort", onAbort);
        reject(new Error("Upload aborted by user."));
      };

      if (abortSignal) {
        if (abortSignal.aborted) {
          reject(new Error("Upload aborted by user."));
          return;
        }
        abortSignal.addEventListener("abort", onAbort, { once: true });
      }

      const timer = setTimeout(() => {
        abortSignal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
    });
  }

  async uploadFile(path, file, onProgress, abortSignal) {
    validateRemotePath(path, "file");

    const totalBytes = file.size || 0;
    if (totalBytes === 0) {
      onProgress(0, 0);
      return;
    }

    const simulatedDurationMs = Math.max(
      DEV_MOCK_UPLOAD_MIN_DURATION_MS,
      Math.min(DEV_MOCK_UPLOAD_MAX_DURATION_MS, Math.round(totalBytes / DEV_MOCK_UPLOAD_BYTES_PER_SECOND * 1000))
    );
    const progressUpdates = Math.max(
      2,
      Math.min(DEV_MOCK_UPLOAD_MAX_PROGRESS_UPDATES, Math.ceil(simulatedDurationMs / 140))
    );
    const updateIntervalMs = Math.max(70, Math.round(simulatedDurationMs / progressUpdates));

    this.ensureUploadNotAborted(abortSignal);
    for (let step = 1; step <= progressUpdates; step++) {
      await this.waitForMockUploadDelay(updateIntervalMs, abortSignal);
      const written = step === progressUpdates
        ? totalBytes
        : Math.max(1, Math.round(totalBytes * (step / progressUpdates)));
      onProgress(written, totalBytes);
    }
  }
}

// === DOM References ===

const el = {
  // Top bar
  btnConnect: document.getElementById("btnConnect"),
  btnDev: document.getElementById("btnDev"),
  topbarBadge: document.getElementById("topbarBadge"),
  topbarDrive: document.getElementById("topbarDrive"),
  topbarDriveInfo: document.getElementById("topbarDriveInfo"),
  topbarActionSep: document.getElementById("topbarActionSep"),
  btnFormat: document.getElementById("btnFormat"),
  btnRefresh: document.getElementById("btnRefresh"),
  btnNewFolder: document.getElementById("btnNewFolder"),
  btnMobileUp: document.getElementById("btnMobileUp"),
  mobileFolderName: document.getElementById("mobileFolderName"),
  ptrIndicator: document.getElementById("ptrIndicator"),
  navCommit: document.getElementById("navCommit"),
  btnNormalize: document.getElementById("btnNormalize"),
  btnLogToggle: document.getElementById("btnLogToggle"),
  connError: document.getElementById("connError"),

  // Main overlay
  mainOverlay: document.getElementById("mainOverlay"),
  mainOverlayIcon: document.getElementById("mainOverlayIcon"),
  mainOverlaySpinner: document.getElementById("mainOverlaySpinner"),
  mainOverlayTitle: document.getElementById("mainOverlayTitle"),
  mainOverlaySub: document.getElementById("mainOverlaySub"),
  btnConnectCta: document.getElementById("btnConnectCta"),

  // Context panel — folder state
  panelFolder: document.getElementById("panelFolder"),
  sidebarDropZone: document.getElementById("sidebarDropZone"),
  panelFolderName: document.getElementById("panelFolderName"),
  panelFolderPath: document.getElementById("panelFolderPath"),
  panelCurrentFolderName: document.getElementById("panelCurrentFolderName"),
  panelFolderCount: document.getElementById("panelFolderCount"),
  panelFolderSize: document.getElementById("panelFolderSize"),
  panelDriveBarFill: document.getElementById("panelDriveBarFill"),
  panelDriveUsage: document.getElementById("panelDriveUsage"),

  // Context panel — file/NFC tag state (right details panel)
  detailsPanel: document.getElementById("detailsPanel"),
  detailsSheetContainer: document.getElementById("detailsSheetContainer"),
  detailsSheetBackdrop: document.getElementById("detailsSheetBackdrop"),
  detailsHeroImgArea: document.getElementById("detailsHeroImgArea"),
  detailsHeroBand: document.getElementById("detailsHeroBand"),
  detailsFilePath: document.getElementById("detailsFilePath"),
  detailsKind: document.getElementById("detailsKind"),
  detailsPathInRow: document.getElementById("detailsPathInRow"),
  btnDetailsClose: document.getElementById("btnDetailsClose"),

  panelFileLabel: document.getElementById("panelFileLabel"),
  panelFileName: document.getElementById("panelFileName"),
  panelFileSize: document.getElementById("panelFileSize"),
  panelFileFlags: document.getElementById("panelFileFlags"),
  panelNfcTag: document.getElementById("panelNfcTag"),
  panelNfcTagContent: document.getElementById("panelNfcTagContent"),

  // Context panel — upload state
  panelUpload: document.getElementById("panelUpload"),
  btnPickFolder: document.getElementById("btnPickFolder"),
  btnPickFiles: document.getElementById("btnPickFiles"),
  uploadProgressTotal: document.getElementById("uploadProgressTotal"),
  uploadQueue: document.getElementById("uploadQueue"),
  btnUploadStart: document.getElementById("btnUploadStart"),
  btnUploadAbort: document.getElementById("btnUploadAbort"),
  btnUploadClear: document.getElementById("btnUploadClear"),
  folderInput: document.getElementById("folderInput"),
  filesInput: document.getElementById("filesInput"),
  btnUploadClose: document.getElementById("btnUploadClose"),

  // Log side sheet
  imgLightbox: document.getElementById("imgLightbox"),
  imgLightboxImg: document.getElementById("imgLightboxImg"),
  imgLightboxSide: document.getElementById("imgLightboxSide"),
  btnLightboxClose: document.getElementById("btnLightboxClose"),
  logOverlay: document.getElementById("logOverlay"),
  logSheetBackdrop: document.getElementById("logSheetBackdrop"),
  protocolLog: document.getElementById("protocolLog"),
  btnLogClose: document.getElementById("btnLogClose"),

  // Browser lock
  browserLockOverlay: document.getElementById("browserLockOverlay"),
  browserLockTitle: document.getElementById("browserLockTitle"),

  // Navigation bar
  navBreadcrumb: document.getElementById("navBreadcrumb"),

  // File table
  tableWrap: document.getElementById("tableWrap"),
  fileTable: document.getElementById("fileTable"),
  fileTableBody: document.getElementById("fileTableBody"),
  browserEmptyState: document.getElementById("browserEmptyState"),
  browserEmptyIcon: document.getElementById("browserEmptyIcon"),
  browserEmptyTitle: document.getElementById("browserEmptyTitle"),
  browserEmptySub: document.getElementById("browserEmptySub"),
  checkAll: document.getElementById("checkAll"),

  // Multi-select bar
  selectionBanner: document.getElementById("selectionBanner"),
  selectionCount: document.getElementById("selectionCount"),
  btnClearSelection: document.getElementById("btnClearSelection"),
  btnDeleteSelected: document.getElementById("btnDeleteSelected"),
  folderWarningBanner: document.getElementById("folderWarningBanner"),
  folderWarningText: document.getElementById("folderWarningText"),
  toastContainer: document.getElementById("toastContainer"),

  // Sheet (mobile bottom panel)
  sheetContainer: document.getElementById("sheetContainer"),
  sheetBackdrop: document.getElementById("sheetBackdrop"),
  contextPanel: document.getElementById("contextPanel"),
  btnSheetInfo: document.getElementById("btnSheetInfo"),
  btnSheetUpload: document.getElementById("btnSheetUpload"),

  // Sidebar action buttons


  // Modals
  formatModal: document.getElementById("formatModal"),
  btnFormatCancel: document.getElementById("btnFormatCancel"),
  btnFormatConfirm: document.getElementById("btnFormatConfirm"),

  newFolderModal: document.getElementById("newFolderModal"),
  newFolderPath: document.getElementById("newFolderPath"),
  newFolderInput: document.getElementById("newFolderInput"),
  newFolderError: document.getElementById("newFolderError"),
  btnNewFolderCancel: document.getElementById("btnNewFolderCancel"),
  btnNewFolderConfirm: document.getElementById("btnNewFolderConfirm"),

  renameModal: document.getElementById("renameModal"),
  renameInput: document.getElementById("renameInput"),
  renameError: document.getElementById("renameError"),
  btnRenameCancel: document.getElementById("btnRenameCancel"),
  btnRenameConfirm: document.getElementById("btnRenameConfirm"),

  deleteModal: document.getElementById("deleteModal"),
  deleteCount: document.getElementById("deleteCount"),
  deleteModalMsg: document.getElementById("deleteModalMsg"),
  btnDeleteCancel: document.getElementById("btnDeleteCancel"),
  btnDeleteConfirm: document.getElementById("btnDeleteConfirm"),

  uploadWarnModal: document.getElementById("uploadWarnModal"),
  uploadWarnMsg: document.getElementById("uploadWarnMsg"),
  btnUploadWarnCancel: document.getElementById("btnUploadWarnCancel"),
  btnUploadWarnConfirm: document.getElementById("btnUploadWarnConfirm"),

  sanitizeModalFiles: document.getElementById("sanitizeModalFiles"),
  btnSanitizeFilesCancel: document.getElementById("btnSanitizeFilesCancel"),
  btnSanitizeFilesConfirm: document.getElementById("btnSanitizeFilesConfirm"),

  sanitizeModalFolders: document.getElementById("sanitizeModalFolders"),
  btnSanitizeFoldersCancel: document.getElementById("btnSanitizeFoldersCancel"),
  btnSanitizeFoldersConfirm: document.getElementById("btnSanitizeFoldersConfirm"),

  sanitizeModalNone: document.getElementById("sanitizeModalNone"),
  sanitizeNonePath: document.getElementById("sanitizeNonePath"),
  btnSanitizeNoneCancel: document.getElementById("btnSanitizeNoneCancel"),
  btnSanitizeNoneConfirm: document.getElementById("btnSanitizeNoneConfirm"),
};

function validateElementBindings(bindings) {
  const missing = Object.entries(bindings)
    .filter(([, node]) => !node)
    .map(([name]) => name);

  if (missing.length > 0) {
    throw new Error(`Missing required DOM bindings: ${missing.join(", ")}`);
  }
}

validateElementBindings(el);

function setButtonDisabledState(button, options) {
  const { disabled = false, pseudoDisabled = false, reason = "" } = options;
  if (button.dataset.baseTitle === undefined) {
    button.dataset.baseTitle = button.getAttribute("title") || "";
  }

  if (pseudoDisabled) {
    button.disabled = false;
    button.setAttribute("aria-disabled", "true");
    if (reason) button.setAttribute("title", reason);
    return;
  }

  button.removeAttribute("aria-disabled");
  button.disabled = disabled;

  if (button.dataset.baseTitle) {
    button.setAttribute("title", button.dataset.baseTitle);
  } else {
    button.removeAttribute("title");
  }
}

// === App State ===

const state = {
  client: null,
  connState: "disconnected",
  drive: null,
  currentPath: "",
  entries: [],
  selectedNames: new Set(),
  drawerEntry: null,       // currently displayed file entry in panel
  panelMode: "folder",     // "folder" | "file" | "upload"
  panelPrevMode: "folder", // restored when upload panel closes
  uploadPlan: [],
  uploadWarnings: [],
  uploadActive: false,
  abortController: null,
  transferSpeed: "",
  uploadTotalCount: 0,
  uploadTotalBytes: 0,
  uploadCompletedCount: 0,
  uploadCompletedBytes: 0,
  folderCache: new Map(),
  truncated: false,
  disconnectToast: null,
};

function showInputError(inputEl, errorEl, message) {
  inputEl.setAttribute("aria-invalid", "true");
  errorEl.textContent = message;
  errorEl.hidden = false;
}

function clearInputError(inputEl, errorEl) {
  inputEl.removeAttribute("aria-invalid");
  errorEl.textContent = "";
  errorEl.hidden = true;
}

function validateSingleName(rawValue, label) {
  const value = rawValue.trim();
  if (!value) throw new Error(`${label} is required`);
  if (value.includes("/")) throw new Error(`${label} cannot contain /`);
  return value;
}

function ensureSiblingNameAvailable(name, currentName = "") {
  if (state.entries.some(entry => entry.name === name && entry.name !== currentName)) {
    throw new Error(`"${name}" already exists in this folder`);
  }
}

function readValidatedNameInput(inputEl, errorEl, options) {
  clearInputError(inputEl, errorEl);

  try {
    const value = validateSingleName(inputEl.value, options.label);
    if (options.currentName && value === options.currentName) {
      throw new Error(`${options.label} is unchanged`);
    }
    ensureSiblingNameAvailable(value, options.currentName);
    validateRemotePath(joinChildPath(state.currentPath || "E:/", value), options.kind);
    return value;
  } catch (err) {
    showInputError(inputEl, errorEl, err.message);
    inputEl.focus();
    inputEl.select();
    return null;
  }
}

function readCheckedRadioValue(name, label) {
  const selected = document.querySelector(`input[name="${name}"]:checked`);
  if (!selected) throw new Error(`${label} is required`);
  return selected.value;
}

function formatUploadInputFeedback(skipped) {
  if (skipped.length === 0) return "";

  const first = skipped[0];
  const more = skipped.length > 1 ? ` (+${skipped.length - 1} more)` : "";
  return `${first.path}: ${first.reason}${more}`;
}

// === Protocol Log ===

function log(msg, role) {
  if (!role) {
    if (msg.startsWith("\u2192")) role = "cmd";
    else if (msg.includes("ERR")) role = "err";
    else if (msg.startsWith("\u2190")) role = "ok";
  }
  const now = new Date();
  const ts = [now.getHours(), now.getMinutes(), now.getSeconds()]
    .map(n => String(n).padStart(2, "0")).join(":");
  const line = document.createElement("span");
  line.innerHTML = `<span class="ts">[${ts}]</span> ` +
    (role ? `<span class="${role}">${escapeHtml(msg)}</span>` : escapeHtml(msg)) +
    "\n";
  el.protocolLog.appendChild(line);
  el.protocolLog.scrollTop = el.protocolLog.scrollHeight;
}

// === Bottom Sheet (mobile) ===

function isMobileViewport() { return window.innerWidth <= 900; }
function openSheet() { el.sheetContainer.classList.add("open"); }
function closeSheet() { el.sheetContainer.classList.remove("open"); }
function openDetailsSheet() { el.detailsSheetContainer.classList.add("open"); }
function closeDetailsSheet() { el.detailsSheetContainer.classList.remove("open"); }

el.sheetBackdrop.addEventListener("click", closeSheet);

el.btnSheetInfo.addEventListener("click", () => { setPanelState("folder"); openSheet(); });
el.btnSheetUpload.addEventListener("click", () => { setPanelState("upload"); openSheet(); });

// Swipe-down on panel handle dismisses the sheet
let _sheetTouchY = 0;
el.contextPanel.addEventListener("touchstart", e => { _sheetTouchY = e.touches[0].clientY; }, { passive: true });
el.contextPanel.addEventListener("touchend", e => {
  if (e.changedTouches[0].clientY - _sheetTouchY > 60) closeSheet();
}, { passive: true });

// === Connection State Machine ===

function setConnState(newState) {
  state.connState = newState;

  const connected = newState === "connected";
  const connecting = newState === "connecting";
  const reconnecting = newState === "reconnecting";
  const disconnected = newState === "disconnected";

  // Main overlay
  el.mainOverlay.classList.toggle("active", !connected);
  el.mainOverlayIcon.hidden = connecting || reconnecting;
  el.mainOverlaySpinner.hidden = !(connecting || reconnecting);
  el.mainOverlayTitle.textContent = reconnecting ? "Reconnecting\u2026" : connecting ? "Connecting to Pixl.js\u2026" : "No device connected";
  el.mainOverlaySub.textContent = (connecting || reconnecting) ? "" : "Browse and manage files on your Pixl.js over Bluetooth.";
  el.btnConnectCta.hidden = connecting || reconnecting;
  el.btnConnectCta.disabled = connecting || reconnecting;

  // Disconnect button — visible when connected or reconnecting
  el.btnConnect.hidden = !(connected || reconnecting);
  el.btnDev.hidden = !shouldShowDevButton();

  // Topbar connected elements — keep visible during reconnecting
  el.topbarBadge.hidden = !(connected || reconnecting);
  el.topbarDrive.hidden = !(connected || reconnecting);
  el.topbarActionSep.hidden = !(connected || reconnecting);
  el.btnFormat.hidden = !(connected || reconnecting);
  el.btnRefresh.hidden = !(connected || reconnecting);
  el.btnNewFolder.hidden = !(connected || reconnecting);
  el.btnNormalize.hidden = !(connected || reconnecting);
  el.btnLogToggle.hidden = !(connected || reconnecting);
  el.btnSheetInfo.hidden = !(connected || reconnecting);
  el.btnSheetUpload.hidden = !(connected || reconnecting);
  if (!(connected || reconnecting)) el.btnMobileUp.hidden = true;

  // Error cleared on state change
  el.connError.hidden = true;
  el.connError.textContent = "";

  if (disconnected) {
    clearToasts({ keepErrors: true });
    state.drive = null;
    state.entries = [];
    state.selectedNames.clear();
    state.currentPath = "";
    setPanelState("folder");
    renderDrive(null);
    renderFileTable();
    renderBreadcrumb("");
    el.folderWarningBanner.hidden = true;
    el.folderWarningText.textContent = "";
    el.topbarBadge.textContent = "";
    el.topbarBadge.classList.remove("dev");
  }

  updateControls();
}

function showConnError(msg) {
  el.connError.textContent = msg;
  el.connError.hidden = false;
}

const MAX_TOASTS = 3;

// Toast copy contract:
// - Use a short summary plus optional detail.
// - Builders normalize copy to "Summary. Detail." sentence structure.
// - Success toasts auto-dismiss, warnings and errors stay sticky.
function normalizeToastPart(value) {
  const text = String(value || "").trim().replace(/\s+/g, " ");
  if (!text) return "";
  return text.replace(/[.!?]+$/, "");
}

function createToast(options) {
  const {
    tone = "success",
    summary = "",
    detail = "",
    message = "",
    html = "",
    sticky = tone === "error" || tone === "warning",
    actionLabel = "",
    actionUrl = "",
    onAction = null,
  } = options;

  // Resolve summary/detail from legacy `message` string if needed
  let resolvedSummary = summary;
  let resolvedDetail = detail;
  if (!resolvedSummary && message) {
    const parts = message.replace(/[.!?]+$/, "").split(/\.\s+/);
    resolvedSummary = parts[0] || "";
    resolvedDetail = parts.slice(1).join(". ");
  }

  const hasHtml = typeof html === "string" && html.trim() !== "";
  if (!hasHtml && !resolvedSummary) return null;

  const iconMap = { success: "check", error: "error", warning: "warning", info: "info" };

  const toast = document.createElement("div");
  toast.className = `toast ${tone}`;

  // Icon
  const icon = document.createElement("span");
  icon.className = "toast-icon";
  icon.textContent = iconMap[tone] || "info";
  toast.appendChild(icon);

  // Body
  const body = document.createElement("div");
  body.className = "toast-body";
  if (hasHtml) {
    body.innerHTML = html;
  } else {
    const s = document.createElement("span");
    s.className = "toast-summary";
    s.textContent = resolvedSummary;
    body.appendChild(s);
    if (resolvedDetail) {
      const d = document.createElement("span");
      d.className = "toast-detail";
      d.textContent = resolvedDetail;
      body.appendChild(d);
    }
  }
  toast.appendChild(body);

  // Optional action button
  if (actionLabel) {
    const btn = document.createElement("button");
    btn.className = "toast-action";
    btn.textContent = actionLabel;
    btn.addEventListener("click", () => {
      if (actionUrl) window.open(actionUrl, "_blank", "noopener");
      if (onAction) onAction();
      removeToast(toast);
    });
    toast.appendChild(btn);
  }

  // Close button (always shown)
  const closeBtn = document.createElement("button");
  closeBtn.className = "toast-close";
  closeBtn.setAttribute("aria-label", "Dismiss");
  closeBtn.innerHTML = '<span class="ms-sm">close</span>';
  closeBtn.addEventListener("click", () => removeToast(toast));
  toast.appendChild(closeBtn);

  appendToast(toast);

  if (!sticky) {
    setTimeout(() => removeToast(toast), 2500);
  }

  return toast;
}

function showSuccessToast(summary, detail = "") {
  return createToast({ tone: "success", summary: normalizeToastPart(summary), detail: normalizeToastPart(detail), sticky: false });
}

function showErrorToast(summary, detail = "") {
  return createToast({ tone: "error", summary: normalizeToastPart(summary), detail: normalizeToastPart(detail) });
}

function showWarningToast(summary, detail = "") {
  return createToast({ tone: "warning", summary: normalizeToastPart(summary), detail: normalizeToastPart(detail) });
}

function appendToast(toast) {
  toast.classList.add("visible");
  el.toastContainer.appendChild(toast);
  const toasts = el.toastContainer.querySelectorAll(".toast");
  if (toasts.length > MAX_TOASTS) removeToast(toasts[0]);
}

function removeToast(toast) {
  if (!toast || !toast.parentNode) return;
  toast.classList.remove("visible");
  setTimeout(() => toast.remove(), 200);
}

function clearToasts({ keepErrors = false } = {}) {
  const toasts = Array.from(el.toastContainer.querySelectorAll(".toast"));
  for (const toast of toasts) {
    if (keepErrors && toast.classList.contains("error")) continue;
    removeToast(toast);
  }
}

// === Connection ===

function shouldShowDevButton() {
  return isDevMode && state.connState === "disconnected";
}

function compareSemver(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
  }
  return 0;
}

async function checkFirmwareVersion(deviceVersion) {
  try {
    const resp = await fetch(PIXL_LATEST_API);
    if (!resp.ok) return;
    const data = await resp.json();
    const latest = data.tag_name;
    if (!latest) return;
    if (compareSemver(deviceVersion, latest) < 0) {
      createToast({
        tone: "info",
        summary: `Firmware ${latest} available`,
        detail: `You have ${deviceVersion}`,
        actionLabel: "Download",
        actionUrl: PIXL_RELEASES_URL,
      });
    }
  } catch (_) { /* network error, skip silently */ }
}

async function connectOrDisconnect() {
  if (state.connState === "connected" || state.connState === "reconnecting") {
    if (state.client) state.client.disconnect();
    setConnState("disconnected");
    return;
  }

  setConnState("connecting");
  clearToasts();

  state.client = new PixlToolsClient(log);
  state.client.onDisconnect = () => {
    const wasReconnecting = state.connState === "reconnecting";
    if (state.disconnectToast) { removeToast(state.disconnectToast); state.disconnectToast = null; }
    if (state.connState !== "disconnected") setConnState("disconnected");
    if (wasReconnecting) showErrorToast("Reconnection timed out");
  };
  state.client.onReconnecting = () => {
    if (state.abortController) state.abortController.abort();
    setConnState("reconnecting");
    state.disconnectToast = showErrorToast("Disconnected", "Attempting to reconnect...");
  };
  state.client.onReconnect = async () => {
    if (state.disconnectToast) { removeToast(state.disconnectToast); state.disconnectToast = null; }
    setConnState("connected");
    showSuccessToast("Reconnected");
    if (state.currentPath) {
      invalidateCache();
      await browseFolder(state.currentPath);
    }
  };

  try {
    await state.client.connect();
    setConnState("connected");
    showSuccessToast("Connection complete");

    // Get version info
    const ver = await state.client.getVersion();
    if (ver.ok) {
      const parts = [];
      if (ver.data.version) parts.push(ver.data.version);
      if (ver.data.bleAddress) parts.push(ver.data.bleAddress);
      el.topbarBadge.textContent = `Pixl.js${parts.length ? " · " + parts.join(" · ") : ""}`;
      checkFirmwareVersion(ver.data.version);
    } else {
      el.topbarBadge.textContent = "Pixl.js";
    }

    // List drives
    const dr = await state.client.listDrives();
    if (dr.ok && dr.data.length > 0) {
      state.drive = dr.data[0];
      renderDrive(state.drive);
    }

    // Browse root
    await browseFolder("E:/");

  } catch (err) {
    log(`Connection failed: ${err.message}`);
    showConnError(err.message);
    showErrorToast("Connection failed");
    setConnState("disconnected");
  }
}

async function devConnect() {
  if (state.connState === "connected") return;
  setConnState("connecting");
  state.client = new DevMockClient();
  state.client.onDisconnect = () => setConnState("disconnected");
  setConnState("connected");
  showSuccessToast("Connection complete");

  log("\u2192 getVersion()", "cmd");
  const ver = await state.client.getVersion();
  log(`\u2190 version=${ver.data.version} ble=${ver.data.bleAddress}`, "ok");
  el.topbarBadge.textContent = "Mock device";
  el.topbarBadge.classList.add("dev");
  checkFirmwareVersion(ver.data.version);

  log("\u2192 listDrives()", "cmd");
  const dr = await state.client.listDrives();
  log("\u2190 drives=[E: 8.0 MB, 2.0 MB used]", "ok");
  if (dr.ok && dr.data.length > 0) {
    state.drive = dr.data[0];
    renderDrive(state.drive);
  }

  log("\u2192 readFolder(E:/)", "cmd");
  await browseFolder("E:/");
  log("\u2190 3 entries (2 dirs, 1 file)", "ok");
}

// === Drive Panel ===

function renderDrive(driveData) {
  if (!driveData) {
    el.panelDriveBarFill.style.width = "0%";
    el.panelDriveBarFill.classList.remove("high");
    el.panelDriveUsage.innerHTML = "";
    el.topbarDriveInfo.textContent = "—";
    return;
  }
  const freeBytes = driveData.freeBytes ?? (driveData.totalBytes - (driveData.usedBytes ?? 0));
  const usedBytes = driveData.totalBytes - freeBytes;
  const pct = driveData.totalBytes > 0
    ? Math.round((usedBytes / driveData.totalBytes) * 100)
    : 0;
  el.panelDriveBarFill.style.width = `${pct}%`;
  el.panelDriveBarFill.classList.toggle("high", pct >= 85);
  const used = formatBytes(usedBytes);
  const free = formatBytes(freeBytes);
  el.panelDriveUsage.innerHTML = `<span>${escapeHtml(used)} used</span><span>${escapeHtml(free)} free</span>`;
  el.topbarDriveInfo.textContent = `${free} free`;
}

// === Format Modal ===

function openModal(modalEl) { modalEl.classList.add("open"); }
function closeModal(modalEl) {
  if (modalEl === el.newFolderModal) clearInputError(el.newFolderInput, el.newFolderError);
  if (modalEl === el.renameModal) clearInputError(el.renameInput, el.renameError);
  modalEl.classList.remove("open");
}

let _formatCountdown = null;

el.btnFormat.addEventListener("click", () => {
  el.btnFormatConfirm.disabled = true;
  el.btnFormatConfirm.textContent = "Wait (5s)";
  let sec = 5;
  clearInterval(_formatCountdown);
  _formatCountdown = setInterval(() => {
    sec--;
    if (sec > 0) {
      el.btnFormatConfirm.textContent = `Wait (${sec}s)`;
    } else {
      clearInterval(_formatCountdown);
      _formatCountdown = null;
      el.btnFormatConfirm.textContent = "Format drive";
      el.btnFormatConfirm.disabled = false;
    }
  }, 1000);
  openModal(el.formatModal);
});
// Generic close button delegate for all modals
document.querySelectorAll("[data-modal-close]").forEach(btn => {
  btn.addEventListener("click", () => closeModal(btn.closest(".modal-overlay")));
});

// Escape key — close lightbox, then topmost modal, then log sheet
document.addEventListener("keydown", e => {
  if (e.key !== "Escape") return;
  if (!el.imgLightbox.hidden) { e.preventDefault(); closeLightbox(); return; }
  const openModal = document.querySelector(".modal-overlay.open");
  if (openModal) { e.preventDefault(); closeModal(openModal); return; }
  if (el.logOverlay && el.logOverlay.classList.contains("open")) { e.preventDefault(); el.logOverlay.classList.remove("open"); }
});

el.btnFormatCancel.addEventListener("click", () => {
  clearInterval(_formatCountdown);
  _formatCountdown = null;
  el.btnFormatConfirm.textContent = "Format drive";
  closeModal(el.formatModal);
});

el.btnFormatConfirm.addEventListener("click", async () => {
  closeModal(el.formatModal);
  if (!state.client) return;
  try {
    el.btnFormatConfirm.disabled = true;
    const res = await state.client.formatDrive("E");
    if (res.ok) {
      log("Drive E: formatted successfully.");
      showSuccessToast("Format complete");
      invalidateCache();
      // Refresh drive info
      const dr = await state.client.listDrives();
      if (dr.ok && dr.data.length > 0) {
        state.drive = dr.data[0];
        renderDrive(state.drive);
      }
      await browseFolder("E:/");
    } else {
      log(`Format failed: ${res.error}`, "err");
      showErrorToast("Format failed");
    }
  } catch (err) {
    log(`Format error: ${err.message}`, "err");
    showErrorToast("Format failed");
  } finally {
    el.btnFormatConfirm.disabled = false;
  }
});

// Close modals on backdrop click
for (const modal of [el.formatModal, el.newFolderModal, el.renameModal, el.deleteModal,
    el.sanitizeModalFiles, el.sanitizeModalFolders, el.sanitizeModalNone]) {
  modal.addEventListener("click", (e) => {
    if (e.target === modal) {
      if (modal === el.formatModal) {
        clearInterval(_formatCountdown);
        _formatCountdown = null;
        el.btnFormatConfirm.textContent = "Format drive";
      }
      closeModal(modal);
    }
  });
}

// === Update Controls ===

function updateControls() {
  const connected = state.connState === "connected";
  const uploading = state.uploadActive;
  const atRoot = !state.currentPath || state.currentPath === "E:/";
  el.btnRefresh.disabled = !connected || uploading;
  el.btnNewFolder.disabled = !connected || uploading;
  el.sidebarDropZone.setAttribute("aria-disabled", String(!connected || uploading));
  el.btnNormalize.disabled = !connected || uploading;
  el.btnFormat.disabled = !connected || uploading;
  el.btnPickFolder.disabled = !connected || uploading;
  el.btnPickFiles.disabled = !connected || uploading;
  el.btnUploadStart.disabled = !connected || uploading || state.uploadPlan.length === 0;
  el.btnUploadAbort.disabled = !uploading;
  setButtonDisabledState(el.btnUploadClear, {
    disabled: !uploading && state.uploadPlan.length === 0,
    pseudoDisabled: uploading,
    reason: "The queue cannot be cleared while an upload is in progress.",
  });
  setButtonDisabledState(el.btnUploadClose, {
    disabled: false,
    pseudoDisabled: uploading,
    reason: "This panel cannot be closed while an upload is in progress.",
  });
}

// === Cache ===

function invalidateCache() {
  state.folderCache.clear();
  if (state.client) state.client.createdFolders.clear();
}

// === File Browser ===

async function browseFolder(path) {
  if (!state.client || state.connState !== "connected") return;

  // Check cache first
  let entries, truncated = false;
  const cached = state.folderCache.get(path);
  if (cached) {
    entries = cached.entries;
    truncated = cached.truncated;
  } else {    try {
      let res;
      for (let attempt = 1; attempt <= 3; attempt++) {
        res = await state.client.readFolder(path);
        if (!res.ok || !res.truncated) break;
        log(`Directory listing for ${path} truncated on attempt ${attempt}, retrying…`, "err");
      }
      if (!res.ok) {
        log(`Failed to read ${path}: ${res.error}`, "err");
        return;
      }
      entries = sortEntries(res.data);
      truncated = res.truncated || false;
      state.folderCache.set(path, { entries, truncated });
      for (const e of entries) {
        if (e.type === "DIR") state.client.createdFolders.add(joinChildPath(path, e.name));
      }
      if (truncated) {
        log(`Warning: directory listing for ${path} was truncated (${entries.length} entries received)`, "err");
      } else if (entries.length >= LARGE_DIR_THRESHOLD) {
        log(`Warning: ${path} has ${entries.length} entries, above the ${LARGE_DIR_THRESHOLD}-item threshold`, "err");
      }
    } catch (err) {
      log(`Error reading ${path}: ${err.message}`, "err");
      return;
    }
  }

  // Update warning banner for current folder (always, whether cached or fresh)
  if (truncated) {
    el.folderWarningBanner.hidden = false;
    el.folderWarningText.textContent = "Directory listing may be incomplete. Some entries could not be received over BLE.";
  } else if (entries.length >= LARGE_DIR_THRESHOLD) {
    el.folderWarningBanner.hidden = false;
    el.folderWarningText.textContent = `This folder has ${entries.length} items. Browsing and uploads may be slow or unreliable over BLE.`;
  } else {
    el.folderWarningBanner.hidden = true;
    el.folderWarningText.textContent = "";
  }

  state.currentPath = path;
  state.entries = entries;
  state.truncated = truncated;
  state.selectedNames.clear();
  renderBreadcrumb(path);
  renderFileTable();
  if (state.panelMode !== "upload") setPanelState("folder");
  if (isMobileViewport()) { closeSheet(); closeDetailsSheet(); }
  updateControls();
}

// === Render File Table ===

// NFC tag API lookup — session cache to avoid re-fetching the same ID
const _nfcTagCache = new Map();

async function lookupNfcTag(head, tail) {
  const key = `${head >>> 0}:${tail >>> 0}`;
  if (_nfcTagCache.has(key)) return _nfcTagCache.get(key);
  const headHex = (head >>> 0).toString(16).toUpperCase().padStart(8, "0");
  const tailHex = (tail >>> 0).toString(16).toUpperCase().padStart(8, "0");
  let info = null;
  try {
    const res = await fetch(`https://amiiboapi.org/api/amiibo/?head=${headHex}&tail=${tailHex}`);
    if (res.ok) info = (await res.json()).amiibo?.[0] ?? null;
  } catch { /* network unavailable — leave null */ }
  _nfcTagCache.set(key, info);
  return info;
}

function nfcSeriesGradient(series) {
  if (!series) return "linear-gradient(135deg, #8b5cf6, #d946ef)";
  const map = [
    ["super smash",       "linear-gradient(135deg, #1e1b4b, #312e81)"],
    ["super mario",       "linear-gradient(135deg, #ef4444, #dc2626)"],
    ["mario kart",        "linear-gradient(135deg, #ef4444, #f59e0b)"],
    ["mario sports",      "linear-gradient(135deg, #ef4444, #22c55e)"],
    ["8-bit",             "linear-gradient(135deg, #dc2626, #7f1d1d)"],
    ["zelda",             "linear-gradient(135deg, #10b981, #0d9488)"],
    ["pokemon",           "linear-gradient(135deg, #f59e0b, #d97706)"],
    ["animal crossing",   "linear-gradient(135deg, #84cc16, #65a30d)"],
    ["splatoon",          "linear-gradient(135deg, #f97316, #ea580c)"],
    ["fire emblem",       "linear-gradient(135deg, #3b82f6, #2563eb)"],
    ["metroid",           "linear-gradient(135deg, #f97316, #dc2626)"],
    ["kirby",             "linear-gradient(135deg, #ec4899, #db2777)"],
    ["donkey kong",       "linear-gradient(135deg, #f59e0b, #dc2626)"],
    ["star fox",          "linear-gradient(135deg, #8b5cf6, #7c3aed)"],
    ["pikmin",            "linear-gradient(135deg, #84cc16, #10b981)"],
    ["yoshi",             "linear-gradient(135deg, #22c55e, #16a34a)"],
    ["xenoblade",         "linear-gradient(135deg, #0284c7, #0d9488)"],
    ["mega man",          "linear-gradient(135deg, #0ea5e9, #0284c7)"],
    ["monster hunter",    "linear-gradient(135deg, #92400e, #78350f)"],
    ["shovel knight",     "linear-gradient(135deg, #1d4ed8, #1e40af)"],
    ["street fighter",    "linear-gradient(135deg, #dc2626, #ca8a04)"],
    ["diablo",            "linear-gradient(135deg, #991b1b, #450a0a)"],
    ["yu-gi-oh",          "linear-gradient(135deg, #7c3aed, #d97706)"],
    ["super nintendo",    "linear-gradient(135deg, #ef4444, #16a34a)"],
    ["skylanders",        "linear-gradient(135deg, #7c3aed, #1d4ed8)"],
    ["chibi-robo",        "linear-gradient(135deg, #06b6d4, #0891b2)"],
    ["power pros",        "linear-gradient(135deg, #1d4ed8, #15803d)"],
    ["boxboy",            "linear-gradient(135deg, #374151, #111827)"],
  ];
  const lower = series.toLowerCase();
  for (const [key, grad] of map) {
    if (lower.includes(key)) return grad;
  }
  let h = 0;
  for (const c of series) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const hue = h % 360;
  return `linear-gradient(135deg, hsl(${hue},60%,45%), hsl(${(hue+40)%360},65%,40%))`;
}

function renderNfcTagField(head, tail, info) {
  const uid = `${(head >>> 0).toString(16).toUpperCase().padStart(8, "0")}:${(tail >>> 0).toString(16).toUpperCase().padStart(8, "0")}`;
  if (!info) {
    return `<div class="details-nfc-row"><span class="details-nfc-label">Figure ID</span><span class="details-nfc-value details-nfc-mono js-copy-id" title="Copy ID">${escapeHtml(uid)}</span></div>`;
  }
  const rows = [];
  if (info.name) rows.push(`<div class="details-nfc-row"><span class="details-nfc-label">Character</span><span class="details-nfc-value">${escapeHtml(info.name)}</span></div>`);
  if (info.amiiboSeries) rows.push(`<div class="details-nfc-row"><span class="details-nfc-label">Series</span><span class="details-nfc-value">${escapeHtml(info.amiiboSeries)}</span></div>`);
  if (info.gameSeries) rows.push(`<div class="details-nfc-row"><span class="details-nfc-label">Game</span><span class="details-nfc-value">${escapeHtml(info.gameSeries)}</span></div>`);
  if (info.type) rows.push(`<div class="details-nfc-row"><span class="details-nfc-label">Type</span><span class="details-nfc-value">${escapeHtml(info.type)}</span></div>`);
  if (info.release?.na) rows.push(`<div class="details-nfc-row"><span class="details-nfc-label">Released</span><span class="details-nfc-value">${escapeHtml(info.release.na)}</span></div>`);
  rows.push(`<div class="details-nfc-row"><span class="details-nfc-label">Figure ID</span><span class="details-nfc-value details-nfc-mono js-copy-id" title="Copy ID">${escapeHtml(uid)}</span></div>`);
  return rows.join("");
}

function wireNfcTagCopyButtons() {
  el.panelNfcTagContent.querySelectorAll(".js-copy-id").forEach(node => {
    node.addEventListener("click", () => navigator.clipboard?.writeText(node.textContent || ""));
  });
}

function applyNfcTagDisplay(entry, head, tail) {
  if ((head >>> 0) === 0 && (tail >>> 0) === 0) {
    el.panelNfcTagContent.innerHTML = `<div class="details-nfc-row"><span class="details-nfc-label">Figure ID</span><span class="details-nfc-value" style="color:#9ca3af">Not an NFC tag file</span></div>`;
    return;
  }
  const key = `${head >>> 0}:${tail >>> 0}`;
  if (_nfcTagCache.has(key)) {
    const info = _nfcTagCache.get(key);
    el.panelNfcTagContent.innerHTML = renderNfcTagField(head, tail, info);
    wireNfcTagCopyButtons();
    _applyNfcHero(entry, info, head, tail);
    return;
  }
  const uidStr = `${(head >>> 0).toString(16).toUpperCase().padStart(8,"0")}:${(tail >>> 0).toString(16).toUpperCase().padStart(8,"0")}`;
  el.panelNfcTagContent.innerHTML = `<div class="details-nfc-row"><span class="details-nfc-label">Figure ID</span><span class="details-nfc-value details-nfc-mono">${escapeHtml(uidStr)}</span></div>`;
  lookupNfcTag(head, tail).then(info => {
    if (state.drawerEntry !== entry) return;
    el.panelNfcTagContent.innerHTML = renderNfcTagField(head, tail, info);
    wireNfcTagCopyButtons();
    _applyNfcHero(entry, info, head, tail);
  });
}

function _gradientTextColor(gradientCss) {
  // Try hex color first
  const hexMatch = gradientCss.match(/#([0-9a-f]{6})/i);
  if (hexMatch) {
    const h = hexMatch[1];
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    // Perceived luminance
    const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return lum > 0.52 ? "#1f2937" : "#ffffff";
  }
  // Try hsl()
  const hslMatch = gradientCss.match(/hsl\((\d+),\s*(\d+)%,\s*(\d+)%\)/);
  if (hslMatch) {
    return parseInt(hslMatch[3]) > 55 ? "#1f2937" : "#ffffff";
  }
  return "#ffffff";
}

function _applyNfcHero(entry, info, head, tail) {
  if (!info) return;
  const grad = nfcSeriesGradient(info.gameSeries || info.amiiboSeries);
  const textColor = _gradientTextColor(grad);

  // Image
  if (info.image) {
    el.detailsHeroImgArea.textContent = "";
    const wrap = document.createElement("div");
    wrap.className = "details-hero-img-wrap";
    const img = document.createElement("img");
    img.src = encodeURI(info.image);
    img.alt = info.name || entry.name;
    img.loading = "lazy";
    const zoomIcon = document.createElement("span");
    zoomIcon.className = "details-hero-zoom-icon";
    wrap.appendChild(img);
    wrap.appendChild(zoomIcon);
    el.detailsHeroImgArea.appendChild(wrap);
    wrap.addEventListener("click", () => {
      openLightbox(info.image, info.name || entry.name, info, head, tail, entry);
    });
  }

  // Color band with series + name + game
  const series = escapeHtml(info.amiiboSeries || info.gameSeries || "");
  const name = escapeHtml(info.name || entry.name);
  const game = info.gameSeries && info.gameSeries !== (info.amiiboSeries || "") ? escapeHtml(info.gameSeries) : "";
  el.detailsHeroBand.innerHTML =
    (series ? `<div class="details-hero-series" style="color:${textColor}">${series}</div>` : "") +
    `<div class="details-hero-name" style="color:${textColor}">${name}</div>` +
    (game ? `<div class="details-hero-game" style="color:${textColor}">${game}</div>` : "");
  el.detailsHeroBand.style.background = grad;
  el.detailsHeroBand.hidden = false;
}

function getBrowserEmptyStateContent() {
  if (state.currentPath === "E:/") {
    return {
      icon: "storage",
      title: "This device is empty",
      sub: "There are no files or folders to display on this device.",
    };
  }

  return {
    icon: "folder_open",
    title: "This folder is empty",
    sub: "There are no files or folders to display in this folder.",
  };
}

function renderFileTable() {
  const showEmptyState = state.connState === "connected" && !!state.currentPath && state.entries.length === 0;
  const showTable = state.connState === "connected" && state.entries.length > 0;

  el.tableWrap.classList.toggle("is-empty", showEmptyState);
  el.browserEmptyState.hidden = !showEmptyState;
  el.fileTable.hidden = !showTable;

  if (showEmptyState) {
    const emptyState = getBrowserEmptyStateContent();
    el.browserEmptyIcon.textContent = emptyState.icon;
    el.browserEmptyTitle.textContent = emptyState.title;
    el.browserEmptySub.textContent = emptyState.sub;
    el.fileTableBody.innerHTML = "";
    updateSelectionBar();
    return;
  }

  if (!showTable) {
    el.fileTableBody.innerHTML = "";
    updateSelectionBar();
    return;
  }

  const rows = [];
  for (const entry of state.entries) {
    const isDir = entry.type === "DIR";
    const size = isDir ? "\u2014" : formatBytes(entry.size);
    const isPanelActive = state.drawerEntry && state.drawerEntry.name === entry.name;
    const isSelected = state.selectedNames.has(entry.name);

    const nameWarn = utf8Length(entry.name) > LONG_FILENAME_BYTES;
    const iconHtml = isDir
      ? `<span class="cell-name-icon folder"><span class="ms-sm">folder</span></span>`
      : `<span class="cell-name-icon file"><span class="ms-sm">insert_drive_file</span></span>`;
    const nameCell = isDir
      ? `<td class="cell-name folder"><span class="cell-name-inner">${iconHtml}${escapeHtml(entry.name)}</span></td>`
      : `<td class="cell-name"><span class="cell-name-inner">${iconHtml}${escapeHtml(entry.name)}</span></td>`;

    const classes = [isPanelActive ? "panel-active" : "", isSelected ? "selected" : "", nameWarn ? "row-warn" : ""].filter(Boolean).join(" ");
    rows.push(
      `<tr data-name="${escapeHtml(entry.name)}"${classes ? ` class="${classes}"` : ''}>` +
      `<td class="cell-check"><input type="checkbox"${isSelected ? " checked" : ""}></td>` +
      nameCell +
      `<td class="cell-size">${size}</td>` +
      `<td class="cell-actions">` +
      (nameWarn ? `<span class="ms-sm warn-icon cell-warn-icon" title="Filename is ${utf8Length(entry.name)} bytes, exceeding the ${LONG_FILENAME_BYTES}-byte firmware limit. Rename to a shorter name before writing to device.">warning</span>` : "") +
      (!isDir ? `<button class="btn-icon ghost" data-action="download" title="Download"><span class="ms-sm">download</span></button>` : "") +
      `<button class="btn-icon ghost" data-action="rename" title="Rename"><span class="ms-sm">edit</span></button>` +
      `<button class="btn-icon ghost" data-action="delete" title="Delete"><span class="ms-sm">delete</span></button>` +
      `</td>` +
      `</tr>`
    );
  }
  el.fileTableBody.innerHTML = rows.join("");
  updateSelectionBar();
}

// === Navigation Breadcrumb ===

function renderBreadcrumb(path) {
  if (!path) {
    el.navBreadcrumb.innerHTML = "";
    el.mobileFolderName.textContent = "";
    el.btnMobileUp.hidden = true;
    el.btnMobileUp.disabled = false;
    el.btnMobileUp.querySelector(".ms").textContent = "arrow_back";
    return;
  }
  const trimmed = path.endsWith("/") ? path.slice(0, -1) : path;
  const parts = trimmed.split("/");
  const crumbs = parts.map((part, i) => ({
    label: part,
    path: i === 0 ? "E:/" : parts.slice(0, i + 1).join("/"),
  }));
  el.navBreadcrumb.innerHTML = crumbs.map((c, i) => {
    const isActive = i === crumbs.length - 1;
    const label = i === 0
      ? `<span class="ms nav-home-icon">home</span>`
      : escapeHtml(c.label);
    return (i > 0 ? '<span class="nav-sep">›</span>' : "") +
      `<button class="nav-crumb${isActive ? " active" : ""}" data-path="${escapeHtml(c.path)}">${label}</button>`;
  }).join("");

  // Mobile: show current folder name; swap icon between home (root) and arrow_back (subfolder)
  const isRoot = path === "E:/";
  el.mobileFolderName.textContent = isRoot ? "Pixl.js" : (getBaseName(trimmed) || "Pixl.js");
  el.btnMobileUp.hidden = false;
  el.btnMobileUp.disabled = isRoot;
  el.btnMobileUp.querySelector(".ms").textContent = isRoot ? "home" : "arrow_back";
}

// === Selection Bar ===

function updateSelectionBar() {
  const count = state.selectedNames.size;
  const hasSelection = count > 0;
  el.selectionBanner.hidden = !hasSelection;
  el.selectionCount.textContent = `${count} selected`;
  el.checkAll.checked = state.entries.length > 0 && count === state.entries.length;
  el.checkAll.indeterminate = hasSelection && count < state.entries.length;
}

function applySelectionToRows(checked) {
  for (const row of el.fileTableBody.querySelectorAll("tr[data-name]")) {
    const cb = row.querySelector("input[type=checkbox]");
    if (cb) cb.checked = checked;
    row.classList.toggle("selected", checked);
  }
}

// === File Table Event Delegation ===

el.fileTableBody.addEventListener("click", (e) => {
  const row = e.target.closest("tr");
  if (!row || !row.dataset.name) return;
  const name = row.dataset.name;
  const entry = state.entries.find(en => en.name === name);
  if (!entry) return;

  // Checkbox click
  const checkbox = e.target.closest("input[type=checkbox]");
  if (checkbox) {
    if (checkbox.checked) {
      state.selectedNames.add(name);
    } else {
      state.selectedNames.delete(name);
    }
    row.classList.toggle("selected", checkbox.checked);
    updateSelectionBar();
    return;
  }

  // Action buttons
  const actionBtn = e.target.closest(".cell-actions button[data-action]");
  if (actionBtn) {
    if (actionBtn.dataset.action === "rename") {
      openRenameModal(entry.name);
    } else if (actionBtn.dataset.action === "delete") {
      el.deleteCount.textContent = "1";
      el.deleteModalMsg.textContent = `Permanently delete "${entry.name}"? This action cannot be undone.`;
      state.selectedNames.clear();
      state.selectedNames.add(entry.name);
      openModal(el.deleteModal);
    } else if (actionBtn.dataset.action === "download") {
      const filePath = joinChildPath(state.currentPath, entry.name);
      state.client.readFileData(filePath).then(res => {
        if (!res.ok) { log(`Download failed: ${res.error}`); return; }
        triggerDownload(res.data, entry.name);
      }).catch(err => log(`Download failed: ${err.message}`));
    }
    return;
  }

  // Folder/file name click — navigate or open details
  const nameCell = e.target.closest(".cell-name");
  if (nameCell) {
    if (entry.type === "DIR") {
      browseFolder(joinChildPath(state.currentPath, entry.name));
    } else {
      setPanelState("file", entry);
      if (isMobileViewport()) openDetailsSheet();
    }
    return;
  }

  // Click anywhere else on the row (e.g. size cell) — same behaviour
  if (entry.type === "DIR") {
    browseFolder(joinChildPath(state.currentPath, entry.name));
  } else {
    setPanelState("file", entry);
    if (isMobileViewport()) openDetailsSheet();
  }
});

// Check-all header checkbox
el.checkAll.addEventListener("change", () => {
  const checked = el.checkAll.checked;
  state.selectedNames.clear();
  if (checked) {
    for (const entry of state.entries) state.selectedNames.add(entry.name);
  }
  applySelectionToRows(checked);
  updateSelectionBar();
});

el.btnDeleteSelected.addEventListener("click", () => {
  const count = state.selectedNames.size;
  if (count === 0) return;
  el.deleteCount.textContent = String(count);
  el.deleteModalMsg.textContent = `Permanently delete ${count === 1 ? "1 item" : `${count} items`}? This action cannot be undone.`;
  openModal(el.deleteModal);
});

el.btnClearSelection.addEventListener("click", () => {
  state.selectedNames.clear();
  applySelectionToRows(false);
  updateSelectionBar();
});

// Navigation bar — breadcrumb handles all navigation (including home crumb)
el.navBreadcrumb.addEventListener("click", (e) => {
  const crumb = e.target.closest(".nav-crumb");
  if (!crumb || !crumb.dataset.path) return;
  if (crumb.dataset.path !== state.currentPath) browseFolder(crumb.dataset.path);
});

// Toolbar buttons
el.btnRefresh.addEventListener("click", () => {
  if (state.currentPath) {
    state.folderCache.delete(state.currentPath);
    browseFolder(state.currentPath);
  }
});

// Mobile back button — navigate up one level
el.btnMobileUp.addEventListener("click", () => {
  if (state.currentPath && state.currentPath !== "E:/") {
    browseFolder(getParentPath(state.currentPath));
  }
});

// Pull-to-refresh (mobile)
{
  const PTR_THRESHOLD = 72; // px of pull needed to trigger
  const PTR_MAX = 96;       // max visual pull height
  let _ptrStartY = 0;
  let _ptrActive = false;

  function _ptrReset() {
    _ptrActive = false;
    el.ptrIndicator.style.height = "";
    el.ptrIndicator.classList.remove("ptr-pulling", "ptr-ready", "ptr-loading");
  }

  el.tableWrap.addEventListener("touchstart", e => {
    if (el.tableWrap.scrollTop === 0 && e.touches.length === 1) {
      _ptrStartY = e.touches[0].clientY;
      _ptrActive = true;
    }
  }, { passive: true });

  el.tableWrap.addEventListener("touchmove", e => {
    if (!_ptrActive) return;
    const dy = e.touches[0].clientY - _ptrStartY;
    if (dy <= 0) { _ptrReset(); return; }
    const h = Math.min(dy * 0.45, PTR_MAX);
    el.ptrIndicator.style.height = `${h}px`;
    el.ptrIndicator.classList.add("ptr-pulling");
    el.ptrIndicator.classList.toggle("ptr-ready", dy >= PTR_THRESHOLD);
    const rotation = Math.min((dy / PTR_THRESHOLD) * 180, 360);
    el.ptrIndicator.querySelector(".ptr-icon").style.transform = `rotate(${rotation}deg)`;
  }, { passive: true });

  el.tableWrap.addEventListener("touchend", () => {
    if (!_ptrActive) return;
    const h = parseFloat(el.ptrIndicator.style.height) || 0;
    if (h >= PTR_THRESHOLD * 0.45 && state.currentPath && state.connected) {
      el.ptrIndicator.classList.add("ptr-loading");
      el.ptrIndicator.classList.remove("ptr-ready");
      el.ptrIndicator.querySelector(".ptr-icon").style.transform = "";
      state.folderCache.delete(state.currentPath);
      browseFolder(state.currentPath).finally(() => _ptrReset());
    } else {
      _ptrReset();
    }
  }, { passive: true });
}

// New folder modal
el.btnNewFolder.addEventListener("click", () => {
  el.newFolderPath.textContent = state.currentPath || "E:/";
  el.newFolderInput.value = "";
  clearInputError(el.newFolderInput, el.newFolderError);
  openModal(el.newFolderModal);
  el.newFolderInput.focus();
});

el.btnNewFolderCancel.addEventListener("click", () => closeModal(el.newFolderModal));

el.btnNewFolderConfirm.addEventListener("click", async () => {
  if (!state.client) return;

  const name = readValidatedNameInput(el.newFolderInput, el.newFolderError, {
    label: "Folder name",
    kind: "folder",
    currentName: "",
  });
  if (!name) return;

  closeModal(el.newFolderModal);

  try {
    const folderPath = joinChildPath(state.currentPath, name);
    const res = await state.client.createFolder(folderPath);
    if (res.ok) {
      log(`Created folder: ${folderPath}`);
      showSuccessToast("Successfully created the folder");
      state.folderCache.delete(state.currentPath);
      await browseFolder(state.currentPath);
    } else {
      log(`Failed to create folder: ${res.error}`, "err");
      showErrorToast("Could not create the folder");
    }
  } catch (err) {
    log(`Failed to create folder: ${err.message}`, "err");
    showErrorToast("Could not create the folder");
  }
});

el.btnDeleteCancel.addEventListener("click", () => closeModal(el.deleteModal));
el.btnRenameCancel.addEventListener("click", () => closeModal(el.renameModal));

// Normalize modal
el.btnNormalize.addEventListener("click", () => {
  el.sanitizeNonePath.textContent = state.currentPath || "E:/";
  openModal(el.sanitizeModalNone);
});

el.btnSanitizeFilesCancel.addEventListener("click", () => closeModal(el.sanitizeModalFiles));
el.btnSanitizeFoldersCancel.addEventListener("click", () => closeModal(el.sanitizeModalFolders));
el.btnSanitizeNoneCancel.addEventListener("click", () => closeModal(el.sanitizeModalNone));

// === Context Panel ===

function setPanelState(mode, entry) {
  // Left panel toggles between folder info and upload
  el.panelFolder.hidden = (mode === "upload");
  el.panelUpload.hidden = (mode !== "upload");

  // Right details panel shows only for file mode
  el.detailsPanel.hidden = (mode !== "file");

  if (mode === "upload") {
    state.panelPrevMode = state.panelMode === "upload" ? state.panelPrevMode : state.panelMode;
    state.panelMode = "upload";
    if (isMobileViewport()) closeDetailsSheet();
    return;
  }

  if (mode === "file" && entry) {
    state.drawerEntry = entry;
    state.panelMode = "file";

    // Populate file fields
    el.panelFileName.textContent = entry.name;
    el.panelFileSize.textContent = formatBytes(entry.size);
    el.detailsKind.textContent = entry.type === "FILE" ? "File" : "Folder";
    const fullPath = joinChildPath(state.currentPath, entry.name);
    el.detailsFilePath.textContent = fullPath;
    if (el.detailsPathInRow) el.detailsPathInRow.textContent = fullPath;

    // Reset hero to neutral state
    el.detailsHeroImgArea.innerHTML = `<span class="ms details-hero-file-icon" id="detailsHeroIcon">insert_drive_file</span>`;
    el.detailsHeroBand.hidden = true;
    el.detailsHeroBand.style.background = "";
    el.detailsHeroBand.innerHTML = "";

    // Flags
    const flagDefs = [
      { bit: 0x02, label: "Hidden" },
      { bit: 0x04, label: "System" },
      { bit: 0x01, label: "Read-only" },
    ];
    const flags = entry.meta ? entry.meta.flags : 0;
    el.panelFileFlags.innerHTML = flagDefs.map(f => {
      const active = (flags & f.bit) !== 0;
      return `<div class="details-flag-row"><span class="ms-sm details-flag-icon${active ? " is-active" : ""}">check</span> ${escapeHtml(f.label)}</div>`;
    }).join("");

    // NFC tag section — only for .bin files
    el.panelFileLabel.textContent = entry.name.toLowerCase().endsWith(".bin") ? "NFC Tag" : "Details";
    const isBin = entry.type === "FILE" && entry.name.toLowerCase().endsWith(".bin");
    el.panelNfcTag.hidden = !isBin;
    if (!isBin) {
      el.panelNfcTagContent.innerHTML = "";
    } else {
      const metaHead = entry.meta ? entry.meta.nfcTagHead : null;
      const metaTail = entry.meta ? entry.meta.nfcTagTail : null;
      if (metaHead != null) {
        applyNfcTagDisplay(entry, metaHead, metaTail);
      } else if (state.client) {
        el.panelNfcTagContent.innerHTML = `<div class="details-nfc-row"><span class="details-nfc-label">Figure ID</span><span class="details-nfc-value" style="color:#9ca3af">Loading\u2026</span></div>`;
        const filePath = joinChildPath(state.currentPath, entry.name);
        state.client.readFileData(filePath).then(res => {
          if (state.drawerEntry !== entry) return;
          if (res.ok && res.data.length >= 92) {
            const dv = new DataView(res.data.buffer, res.data.byteOffset);
            const head = dv.getUint32(84, false);
            const tail = dv.getUint32(88, false);
            applyNfcTagDisplay(entry, head, tail);
          } else {
            el.panelNfcTagContent.innerHTML = `<div class="details-nfc-row"><span class="details-nfc-label">Figure ID</span><span class="details-nfc-value" style="color:#9ca3af">Not a valid NFC file</span></div>`;
          }
        }).catch(() => {
          if (state.drawerEntry === entry) el.panelNfcTagContent.innerHTML = `<div class="details-nfc-row"><span class="details-nfc-label">Error</span><span class="details-nfc-value" style="color:#e11d48">Failed to read file</span></div>`;
        });
      } else {
        el.panelNfcTagContent.innerHTML = `<div class="details-nfc-row"><span class="details-nfc-label">Figure ID</span><span class="details-nfc-value" style="color:#9ca3af">Not connected</span></div>`;
      }
    }

    // Highlight active row
    for (const row of el.fileTableBody.querySelectorAll("tr[data-name]")) {
      row.classList.toggle("panel-active", row.dataset.name === entry.name);
    }
    return;
  }

  // Default: folder state
  state.drawerEntry = null;
  state.panelMode = "folder";
  if (isMobileViewport()) closeDetailsSheet();

  // Clear row highlight
  for (const row of el.fileTableBody.querySelectorAll("tr[data-name]")) {
    row.classList.remove("panel-active");
  }

  // Populate folder info
  if (state.currentPath) {
    el.panelFolderName.textContent = "Pixl.js";
    el.panelFolderPath.textContent = state.drive ? state.drive.name : "E:/";
    const folderBaseName = state.currentPath === "E:/" ? "Root" : (getBaseName(state.currentPath) || state.currentPath);
    el.panelCurrentFolderName.textContent = folderBaseName;
    const fileCount = state.entries.filter(e => e.type === "FILE").length;
    const dirCount = state.entries.filter(e => e.type === "DIR").length;
    const parts = [];
    if (fileCount) parts.push(`${fileCount} file${fileCount !== 1 ? "s" : ""}`);
    if (dirCount) parts.push(`${dirCount} folder${dirCount !== 1 ? "s" : ""}`);
    el.panelFolderCount.textContent = state.entries.length ? parts.join(", ") : "Empty";
    const totalBytes = state.entries.reduce((sum, e) => sum + (e.size || 0), 0);
    el.panelFolderSize.textContent = totalBytes > 0 ? formatBytes(totalBytes) + " total" : "";
  } else {
    el.panelFolderName.textContent = "Pixl.js";
    el.panelFolderPath.textContent = "";
    el.panelCurrentFolderName.textContent = "—";
    el.panelFolderCount.textContent = "";
    el.panelFolderSize.textContent = "";
  }
  // Drive bar updated by renderDrive
}

// Panel rename button — renames the currently displayed file
// Details panel close button
el.btnDetailsClose.addEventListener("click", () => {
  setPanelState("folder");
  if (isMobileViewport()) closeDetailsSheet();
});

// Details sheet backdrop click
el.detailsSheetBackdrop.addEventListener("click", () => {
  setPanelState("folder");
  closeDetailsSheet();
});

function openRenameModal(name) {
  renameTarget = name;
  el.renameInput.value = name;
  clearInputError(el.renameInput, el.renameError);
  openModal(el.renameModal);
  el.renameInput.focus();
  el.renameInput.select();
}

// === Log side sheet ===

function openLogSheet() { el.logOverlay.classList.add("open"); }
function closeLogSheet() { el.logOverlay.classList.remove("open"); }

el.btnLogToggle.addEventListener("click", () => {
  el.logOverlay.classList.contains("open") ? closeLogSheet() : openLogSheet();
});
el.btnLogClose.addEventListener("click", closeLogSheet);
el.logSheetBackdrop.addEventListener("click", closeLogSheet);

// === Image lightbox ===

function openLightbox(src, alt, info, head, tail, entry) {
  el.imgLightboxImg.src = src;
  el.imgLightboxImg.alt = alt || "";

  if (info) {
    const grad = nfcSeriesGradient(info.gameSeries || info.amiiboSeries);
    const tc = _gradientTextColor(grad);
    const uid = (head != null && tail != null)
      ? `${(head >>> 0).toString(16).toUpperCase().padStart(8,"0")}:${(tail >>> 0).toString(16).toUpperCase().padStart(8,"0")}`
      : null;
    const rows = [];
    if (info.name) rows.push(["Character", info.name, false]);
    if (info.amiiboSeries) rows.push(["Series", info.amiiboSeries, false]);
    if (info.gameSeries) rows.push(["Game", info.gameSeries, false]);
    if (info.type) rows.push(["Type", info.type, false]);
    if (info.release?.na) rows.push(["Released", info.release.na, false]);
    if (uid) rows.push(["Figure ID", uid, true]);
    if (entry?.size != null) rows.push(["Size", formatBytes(entry.size), false]);
    if (entry?.name) rows.push(["File", entry.name, false]);

    const rowsHtml = rows.map(([label, value, mono]) =>
      `<div class="img-lightbox-row">` +
      `<span class="img-lightbox-row-label">${escapeHtml(label)}</span>` +
      `<span class="img-lightbox-row-value${mono ? " img-lightbox-row-mono js-copy-id" : ""}"` +
      (mono ? ` title="Copy"` : "") +
      `>${escapeHtml(value)}</span>` +
      `</div>`
    ).join("");

    const lbSeries = info.amiiboSeries || info.gameSeries || "";
    const lbGame = info.gameSeries && info.gameSeries !== (info.amiiboSeries || "") ? info.gameSeries : "";
    el.imgLightboxSide.innerHTML =
      `<div class="img-lightbox-band" style="background:${grad}">` +
        (lbSeries ? `<div class="img-lightbox-series" style="color:${tc}">${escapeHtml(lbSeries)}</div>` : "") +
        `<div class="img-lightbox-name" style="color:${tc}">${escapeHtml(info.name || alt || "")}</div>` +
        (lbGame ? `<div class="img-lightbox-game" style="color:${tc}">${escapeHtml(lbGame)}</div>` : "") +
      `</div>` +
      `<div class="img-lightbox-rows">${rowsHtml}</div>`;
  } else {
    el.imgLightboxSide.innerHTML = "";
  }

  el.imgLightboxSide.querySelectorAll(".js-copy-id").forEach(node => {
    node.addEventListener("click", () => navigator.clipboard?.writeText(node.textContent || ""));
  });
  el.imgLightbox.hidden = false;
}

function closeLightbox() {
  el.imgLightbox.hidden = true;
  el.imgLightboxImg.src = "";
  el.imgLightboxSide.innerHTML = "";
}

el.btnLightboxClose.addEventListener("click", closeLightbox);
el.imgLightbox.addEventListener("click", (e) => {
  if (e.target === el.imgLightbox || e.target.classList.contains("img-lightbox-inner")) closeLightbox();
});

// === Upload panel toggle ===

el.sidebarDropZone.addEventListener("click", () => {
  if (el.sidebarDropZone.getAttribute("aria-disabled") === "true") return;
  el.filesInput.click();
});

el.sidebarDropZone.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); el.sidebarDropZone.click(); }
});

let _dropZoneCounter = 0;
el.sidebarDropZone.addEventListener("dragenter", (e) => {
  e.preventDefault();
  _dropZoneCounter++;
  el.sidebarDropZone.classList.add("drag-over");
});
el.sidebarDropZone.addEventListener("dragleave", () => {
  _dropZoneCounter--;
  if (_dropZoneCounter <= 0) { _dropZoneCounter = 0; el.sidebarDropZone.classList.remove("drag-over"); }
});
el.sidebarDropZone.addEventListener("dragover", (e) => { e.preventDefault(); });
el.sidebarDropZone.addEventListener("drop", (e) => {
  e.preventDefault();
  _dropZoneCounter = 0;
  el.sidebarDropZone.classList.remove("drag-over");
  if (el.sidebarDropZone.getAttribute("aria-disabled") === "true") return;
  const files = e.dataTransfer.files;
  if (!files || files.length === 0) return;
  const collected = collectFromFiles(files);
  buildUploadPlan(collected.folders, collected.files);
  setPanelState("upload");
});

el.btnUploadClose.addEventListener("click", () => {
  if (el.btnUploadClose.getAttribute("aria-disabled") === "true") return;
  // Return to previous panel state
  if (state.panelPrevMode === "file" && state.drawerEntry) {
    setPanelState("file", state.drawerEntry);
  } else {
    setPanelState("folder");
  }
});

// === Connect button ===

el.btnConnect.addEventListener("click", connectOrDisconnect);
el.btnConnectCta.addEventListener("click", connectOrDisconnect);

// === Keyboard: Enter in new-folder input ===

el.newFolderInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    el.btnNewFolderConfirm.click();
  }
});

el.newFolderInput.addEventListener("input", () => {
  clearInputError(el.newFolderInput, el.newFolderError);
});

el.renameInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    el.btnRenameConfirm.click();
  }
});

el.renameInput.addEventListener("input", () => {
  clearInputError(el.renameInput, el.renameError);
});

let renameTarget = "";

// --- Rename confirm ---

el.btnRenameConfirm.addEventListener("click", async () => {
  if (!state.client) return;

  const entry = state.entries.find(e => e.name === renameTarget);
  const kind = entry && entry.type === "DIR" ? "folder" : "file";
  const newName = readValidatedNameInput(el.renameInput, el.renameError, {
    label: "Name",
    kind,
    currentName: renameTarget,
  });
  if (!newName) return;

  closeModal(el.renameModal);

  try {
    const oldPath = joinChildPath(state.currentPath, renameTarget);
    const newPath = joinChildPath(state.currentPath, newName);
    const res = await state.client.renamePath(oldPath, newPath);
    if (res.ok) {
      log(`Renamed: ${renameTarget} \u2192 ${newName}`);
      showSuccessToast("Successfully renamed the item");
    } else {
      log(`Rename failed: ${res.error}`, "err");
      showErrorToast("Could not rename the item");
    }
  } catch (err) {
    log(`Failed to rename: ${err.message}`, "err");
    showErrorToast("Could not rename the item");
  } finally {
    invalidateCache();
    await browseFolder(state.currentPath);
  }
});

// --- Delete confirm ---

el.btnDeleteConfirm.addEventListener("click", async () => {
  closeModal(el.deleteModal);
  if (!state.client || state.selectedNames.size === 0) return;

  const selected = state.entries.filter(e => state.selectedNames.has(e.name));
  const paths = selected.map(e => ({
    path: joinChildPath(state.currentPath, e.name),
    type: e.type,
    name: e.name,
  }));

  // Sort: deepest-first by "/" count, files before folders at same depth
  paths.sort((a, b) => {
    const depthA = (a.path.match(/\//g) || []).length;
    const depthB = (b.path.match(/\//g) || []).length;
    if (depthA !== depthB) return depthB - depthA;
    if (a.type !== b.type) return a.type === "FILE" ? -1 : 1;
    return 0;
  });

  el.browserLockOverlay.classList.add("active");
  el.browserLockTitle.textContent = "Deleting…";
  updateControls();
  let deleted = 0;
  const failedPaths = [];
  const total = paths.length;
  try {
    for (const item of paths) {
      try {
        const res = await state.client.removePath(item.path);
        if (res.ok) {
          deleted++;
        } else {
          failedPaths.push(item.path);
          log(`Delete failed: ${item.path}: ${res.error}`, "err");
        }
      } catch (err) {
        failedPaths.push(item.path);
        log(`Failed to delete: ${item.path}: ${err.message}`, "err");
      }
    }
    log(`Deleted ${deleted} of ${total} ${total === 1 ? "item" : "items"}.`);
    if (deleted === total) {
      showSuccessToast(`Successfully deleted ${deleted} ${deleted === 1 ? "item" : "items"}`);
    } else if (deleted > 0) {
      const failedPathText = failedPaths.length > 1 ? `${failedPaths[0]} (+${failedPaths.length - 1} more)` : failedPaths[0];
      showErrorToast(`Deleted ${deleted} of ${total} ${total === 1 ? "item" : "items"}`, `Failed: ${failedPathText}`);
    } else {
      const failedPathText = failedPaths.length > 1 ? `${failedPaths[0]} (+${failedPaths.length - 1} more)` : failedPaths[0];
      showErrorToast(`Could not delete ${total === 1 ? "the item" : "the selected items"}`, failedPathText ? `Failed: ${failedPathText}` : "No items were deleted");
    }
  } finally {
    el.browserLockOverlay.classList.remove("active");
    updateControls();
    invalidateCache();
    await browseFolder(state.currentPath);
  }
});

// --- Sanitize helpers ---

function buildSanitizeOps(entries, parentPath, allSiblings = entries) {
  const ops = [];
  const skipped = [];
  const existing = new Set(allSiblings.map(e => e.name));
  const groups = new Map();
  for (const e of entries) {
    const lower = e.name.toLowerCase();
    if (lower === e.name) continue;
    if (!groups.has(lower)) groups.set(lower, []);
    groups.get(lower).push(e);
  }
  for (const [lower, group] of groups) {
    if (group.length > 1) {
      for (const e of group) skipped.push({ name: e.name, reason: `Collision: multiple -> ${lower}` });
      continue;
    }
    const [e] = group;
    if (existing.has(lower)) {
      skipped.push({ name: e.name, reason: `Already exists as ${lower}` });
      continue;
    }
    const from = joinChildPath(parentPath, e.name);
    const to = joinChildPath(parentPath, lower);
    const kind = e.type === "DIR" ? "folder" : "file";
    try {
      validateRemotePath(to, kind);
    } catch (err) {
      skipped.push({ name: e.name, reason: err.message });
      continue;
    }
    ops.push({ from, to, type: e.type, name: e.name });
  }
  return { ops, skipped };
}

async function collectEntriesRecursive(path) {
  const snapshots = [];
  const queue = [path];
  while (queue.length > 0) {
    const folder = queue.shift();
    const res = await state.client.readFolder(folder);
    if (!res.ok) { log(`Scan failed: ${folder}: ${res.error}`, "err"); continue; }
    const entries = sortEntries(res.data);
    snapshots.push({ parentPath: folder, entries });
    for (const e of entries) {
      if (e.type === "DIR") queue.push(joinChildPath(folder, e.name));
    }
  }
  return snapshots;
}

async function executeSanitize(allOps, allSkipped) {
  // Sort: files first, then folder renames deepest-first
  allOps.sort((a, b) => {
    if (a.type !== b.type) return a.type === "FILE" ? -1 : 1;
    // For folders, deepest first
    const depthA = (a.from.match(/\//g) || []).length;
    const depthB = (b.from.match(/\//g) || []).length;
    return depthB - depthA;
  });

  let renamed = 0;
  for (const op of allOps) {
    try {
      const res = await state.client.renamePath(op.from, op.to);
      if (res.ok) {
        renamed++;
      } else {
        log(`Failed to rename: ${op.name}: ${res.error}`, "err");
      }
    } catch (err) {
      log(`Failed to rename: ${op.name}: ${err.message}`, "err");
    }
  }

  const parts = [`${renamed} renamed`];
  if (allSkipped.length > 0) {
    parts.push(`${allSkipped.length} skipped`);
    for (const s of allSkipped) {
      log(`Skipped ${s.name}: ${s.reason}`, "err");
    }
  }
  log(`Normalized: ${parts.join(", ")}`);
  const renamedText = `${renamed} ${renamed === 1 ? "item" : "items"}`;
  const totalText = `${allOps.length} ${allOps.length === 1 ? "item" : "items"}`;
  const skippedText = allSkipped.length > 0 ? `Skipped ${allSkipped.length} ${allSkipped.length === 1 ? "item" : "items"}` : "";
  if (renamed === allOps.length && renamed > 0) {
    showSuccessToast(`Successfully normalized ${renamedText}`, skippedText);
  } else if (renamed > 0) {
    showErrorToast(`Normalized ${renamedText} of ${totalText}`, skippedText);
  } else if (allOps.length > 0) {
    showErrorToast("Could not normalize any items");
  } else {
    showSuccessToast("No items needed normalization", skippedText);
  }
}

async function withBrowserLock(title, fn) {
  el.browserLockOverlay.classList.add("active");
  el.browserLockTitle.textContent = title;
  updateControls();
  try {
    await fn();
  } catch (err) {
    log(err.message, "err");
    showErrorToast("Could not normalize the selected items", err.message);
  } finally {
    el.browserLockOverlay.classList.remove("active");
    updateControls();
    invalidateCache();
    await browseFolder(state.currentPath);
  }
}

// --- Sanitize: files confirm ---

el.btnSanitizeFilesConfirm.addEventListener("click", async () => {
  closeModal(el.sanitizeModalFiles);
  if (!state.client) return;
  await withBrowserLock("Normalizing…", async () => {
    const selected = state.entries.filter(e => state.selectedNames.has(e.name) && e.type === "FILE");
    const { ops, skipped } = buildSanitizeOps(selected, state.currentPath, state.entries);
    await executeSanitize(ops, skipped);
  });
});

// --- Sanitize: folders confirm ---

el.btnSanitizeFoldersConfirm.addEventListener("click", async () => {
  closeModal(el.sanitizeModalFolders);
  if (!state.client) return;

  let scope;
  try {
    scope = readCheckedRadioValue("sanitizeFolderScope", "Normalize scope");
  } catch (err) {
    showErrorToast("Could not start normalization", err.message);
    return;
  }

  await withBrowserLock("Normalizing…", async () => {
    const allOps = [];
    const allSkipped = [];

    if (scope === "selected") {
      const selected = state.entries.filter(e => state.selectedNames.has(e.name));
      const { ops, skipped } = buildSanitizeOps(selected, state.currentPath, state.entries);
      allOps.push(...ops);
      allSkipped.push(...skipped);
    } else {
      const selectedEntries = state.entries.filter(e => state.selectedNames.has(e.name));
      const selectedFolders = selectedEntries.filter(e => e.type === "DIR");
      for (const folder of selectedFolders) {
        const folderPath = joinChildPath(state.currentPath, folder.name);
        const snapshots = await collectEntriesRecursive(folderPath);
        for (const snap of snapshots) {
          const { ops, skipped } = buildSanitizeOps(snap.entries, snap.parentPath);
          allOps.push(...ops);
          allSkipped.push(...skipped);
        }
      }
      // Also rename the selected items themselves (shallower than contents, renamed last by executeSanitize sort)
      const { ops, skipped } = buildSanitizeOps(selectedEntries, state.currentPath, state.entries);
      allOps.push(...ops);
      allSkipped.push(...skipped);
    }

    await executeSanitize(allOps, allSkipped);
  });
});

// --- Sanitize: none confirm ---

el.btnSanitizeNoneConfirm.addEventListener("click", async () => {
  closeModal(el.sanitizeModalNone);
  if (!state.client) return;

  let scope;
  try {
    scope = readCheckedRadioValue("sanitizeNoneScope", "Normalize scope");
  } catch (err) {
    showErrorToast("Could not start normalization", err.message);
    return;
  }

  await withBrowserLock("Normalizing…", async () => {
    const allOps = [];
    const allSkipped = [];

    if (scope === "files") {
      const files = state.entries.filter(e => e.type === "FILE");
      const { ops, skipped } = buildSanitizeOps(files, state.currentPath, state.entries);
      allOps.push(...ops);
      allSkipped.push(...skipped);
    } else if (scope === "filesAndFolders") {
      const { ops, skipped } = buildSanitizeOps(state.entries, state.currentPath);
      allOps.push(...ops);
      allSkipped.push(...skipped);
    } else {
      const snapshots = await collectEntriesRecursive(state.currentPath);
      for (const snap of snapshots) {
        const { ops, skipped } = buildSanitizeOps(snap.entries, snap.parentPath);
        allOps.push(...ops);
        allSkipped.push(...skipped);
      }
    }

    await executeSanitize(allOps, allSkipped);
  });
});

// --- File/folder collection helpers ---

function collectFoldersFromPath(relPath, set) {
  const parts = relPath.split("/").filter(Boolean);
  for (let i = 1; i < parts.length; i++) set.add(parts.slice(0, i).join("/"));
}

async function collectFromDirHandle(handle) {
  const folders = new Set();
  const files = [];
  async function walk(dir, pfx) {
    if (pfx) folders.add(pfx);
    for await (const [name, child] of dir.entries()) {
      const rel = pfx ? `${pfx}/${name}` : name;
      if (child.kind === "directory") {
        await walk(child, rel);
      } else {
        const f = await child.getFile();
        files.push({ relativePath: rel, file: f });
        collectFoldersFromPath(rel, folders);
      }
    }
  }
  await walk(handle, "");
  return { folders, files };
}

async function collectFromWebkitDir(fileList) {
  const folders = new Set();
  const files = [];
  for (const f of Array.from(fileList)) {
    const raw = f.webkitRelativePath || f.name;
    const segs = raw.split("/").filter(Boolean);
    const rel = segs.slice(1).join("/") || f.name;
    files.push({ relativePath: rel, file: f });
    collectFoldersFromPath(rel, folders);
  }
  return { folders, files };
}

function collectFromFiles(fileList) {
  return {
    folders: new Set(),
    files: Array.from(fileList).map(f => ({ relativePath: f.name, file: f })),
  };
}

// --- Upload queue rendering ---

function getQueueStatusIcon(status) {
  switch (status) {
    case "done": return '<span class="ms-sm queue-icon done">check_circle</span>';
    case "active": return '<span class="ms-sm spin queue-icon active">sync</span>';
    case "pending": return '<span class="ms-sm queue-icon pending">schedule</span>';
    case "error": return '<span class="ms-sm queue-icon error">error</span>';
    case "aborted": return '<span class="ms-sm queue-icon aborted">block</span>';
    default: return '';
  }
}

function resetUploadProgress(plan = state.uploadPlan) {
  state.uploadTotalCount = plan.length;
  state.uploadTotalBytes = plan.reduce((sum, item) => sum + item.size, 0);
  state.uploadCompletedCount = 0;
  state.uploadCompletedBytes = 0;
}

function consumeCompletedUploadItem(item) {
  state.uploadCompletedCount += 1;
  state.uploadCompletedBytes += item.size;
  state.uploadPlan = state.uploadPlan.filter(candidate => candidate.id !== item.id);
  state.uploadWarnings = checkUploadPlanWarnings(state.uploadPlan);
}

function renderUploadSummary() {
  if (state.uploadTotalCount === 0) {
    el.uploadProgressTotal.textContent = "No uploads queued";
    return;
  }

  const transferredBytes = state.uploadPlan.reduce((sum, item) => sum + item.transferred, 0);
  const visibleBytes = Math.min(state.uploadTotalBytes, state.uploadCompletedBytes + transferredBytes);
  const totalPct = state.uploadTotalBytes > 0
    ? Math.round((visibleBytes / state.uploadTotalBytes) * 100)
    : (state.uploadCompletedCount === state.uploadTotalCount ? 100 : 0);
  const remainingCount = state.uploadPlan.length;
  const remainingText = remainingCount === 1 ? "1 remaining" : `${remainingCount} remaining`;
  const speedStr = state.transferSpeed
    ? ` \u00b7 <span class="queue-summary-speed">${escapeHtml(state.transferSpeed)}</span>`
    : "";

  el.uploadProgressTotal.innerHTML =
    `<span>${state.uploadCompletedCount} / ${state.uploadTotalCount} items \u00b7 ${remainingText}</span>` +
    `<span>${totalPct}% (${escapeHtml(formatBytes(visibleBytes))} / ${escapeHtml(formatBytes(state.uploadTotalBytes))})${speedStr}</span>`;
}

function renderUploadQueue() {
  renderUploadSummary();

  if (state.uploadPlan.length === 0) {
    const emptyText = state.uploadTotalCount > 0 ? "No remaining uploads" : "No uploads queued";
    el.uploadQueue.innerHTML = `<div class="queue-empty">${emptyText}</div>`;
    return;
  }

  const items = [];

  for (const item of state.uploadPlan) {
    const icon = getQueueStatusIcon(item.status);
    const baseName = escapeHtml(getBaseName(item.remotePath));
    const title = escapeHtml(item.remotePath);

    if (item.kind === "folder") {
      items.push(
        `<div class="queue-item">` +
        `${icon}` +
        `<span class="queue-name" title="${title}">${baseName}/</span>` +
        `<span class="queue-status ${item.status}">${item.status}</span>` +
        `</div>`
      );
    } else {
      const pct = item.size > 0 ? Math.round((item.transferred / item.size) * 100) : (item.status === "done" ? 100 : 0);
      const pctStr = item.status === "done" ? "done" : item.status === "pending" ? "pending" : item.status === "aborted" ? "aborted" : item.status === "error" ? "error" : `${pct}%`;
      items.push(
        `<div class="queue-item">` +
        `${icon}` +
        `<span class="queue-name" title="${title}">${baseName}</span>` +
        `<div class="queue-bar"><div class="queue-bar-fill" style="width:${pct}%"></div></div>` +
        `<span class="queue-status ${item.status}">${pctStr}</span>` +
        `</div>`
      );
    }
  }

  el.uploadQueue.innerHTML = items.join("");

  // Render upload warnings banner (from checkUploadPlanWarnings)
  if (state.uploadWarnings && state.uploadWarnings.length > 0 && !state.uploadActive) {
    const bannerLines = state.uploadWarnings.map(w => `<li>${escapeHtml(w)}</li>`).join("");
    const banner = document.createElement("div");
    banner.className = "queue-warning";
    banner.innerHTML =
      `<div class="queue-warning-header">` +
      `<span class="ms-sm">warning</span> Upload warnings` +
      `</div>` +
      `<ul>${bannerLines}</ul>`;
    el.uploadQueue.prepend(banner);
  }
}

// --- Upload plan building ---

let planSeed = 0;

function buildUploadPlan(folders, files) {
  const base = state.currentPath || "E:/";
  const sortedFolders = [...folders].sort((a, b) => {
    const d = a.split("/").length - b.split("/").length;
    return d !== 0 ? d : a.localeCompare(b);
  });
  const plan = [];
  const skipped = [];

  for (const rel of sortedFolders) {
    const remote = joinChildPath(base, rel);
    try {
      validateRemotePath(remote, "folder");
    } catch (err) {
      log(`Skipping folder ${rel}: ${err.message}`, "err");
      skipped.push({ path: rel, reason: err.message });
      continue;
    }
    plan.push({ id: ++planSeed, kind: "folder", localPath: rel, remotePath: remote, size: 0, file: null, transferred: 0, status: "pending" });
  }

  for (const entry of files) {
    const remote = joinChildPath(base, entry.relativePath);
    try {
      validateRemotePath(remote, "file");
    } catch (err) {
      log(`Skipping file ${entry.relativePath}: ${err.message}`, "err");
      skipped.push({ path: entry.relativePath, reason: err.message });
      continue;
    }
    plan.push({ id: ++planSeed, kind: "file", localPath: entry.relativePath, remotePath: remote, size: entry.file.size, file: entry.file, transferred: 0, status: "pending" });
  }

  state.uploadPlan = plan;
  state.uploadWarnings = checkUploadPlanWarnings(plan);
  resetUploadProgress(plan);
  renderUploadQueue();
  updateControls();

  if (plan.length === 0) {
    if (skipped.length > 0) {
      showErrorToast("Could not add any upload items", formatUploadInputFeedback(skipped));
    } else {
      showWarningToast("No upload items were added");
    }
    return;
  }

  if (skipped.length > 0) {
    const countText = skipped.length === 1 ? "1 invalid upload item" : `${skipped.length} invalid upload items`;
    showWarningToast(`Skipped ${countText}`, formatUploadInputFeedback(skipped));
  }
}

function checkUploadPlanWarnings(plan) {
  const warnings = [];
  // Per-directory density check
  const perDir = new Map();
  for (const item of plan) {
    const parent = getParentPath(item.remotePath);
    perDir.set(parent, (perDir.get(parent) || 0) + 1);
  }
  // Add cached entry counts for existing items
  for (const [dir, planned] of perDir) {
    const cached = state.folderCache.get(dir);
    const existing = cached ? cached.entries.length : 0;
    const total = planned + existing;
    if (total >= LARGE_DIR_THRESHOLD) {
      warnings.push(`${dir} will have ${total} items (${existing} existing + ${planned} new), which may cause slow or unreliable BLE directory reads`);
    }
  }
  // Total batch size check
  if (plan.length >= LARGE_BATCH_THRESHOLD) {
    const mins = Math.ceil(plan.length * 0.75 / 60);
    warnings.push(`This upload has ${plan.length} items. Protocol overhead alone may take ${mins}+ minutes, and long transfers risk connection drops`);
  }
  return warnings;
}

function showUploadWarningModal(warnings) {
  return new Promise(resolve => {
    const lines = warnings.map(w => `<li>${escapeHtml(w)}</li>`).join("");
    el.uploadWarnMsg.innerHTML =
      `<ul class="modal-list">${lines}</ul>` +
      `<p class="modal-note">You can still proceed, but the upload may be slow or fail partway through.</p>`;
    openModal(el.uploadWarnModal);
    const onConfirm = () => { cleanup(); resolve(true); };
    const onCancel = () => { cleanup(); resolve(false); };
    const cleanup = () => {
      el.btnUploadWarnConfirm.removeEventListener("click", onConfirm);
      el.btnUploadWarnCancel.removeEventListener("click", onCancel);
      closeModal(el.uploadWarnModal);
    };
    el.btnUploadWarnConfirm.addEventListener("click", onConfirm);
    el.btnUploadWarnCancel.addEventListener("click", onCancel);
  });
}

// --- Upload execution ---

async function runUpload() {
  if (!state.client || state.connState !== "connected" || state.uploadActive || state.uploadPlan.length === 0) return;

  if (state.uploadWarnings && state.uploadWarnings.length > 0) {
    const confirmed = await showUploadWarningModal(state.uploadWarnings);
    if (!confirmed) return;
  }

  state.uploadActive = true;
  state.abortController = new AbortController();
  el.browserLockOverlay.classList.add("active");
  el.browserLockTitle.textContent = "Uploading…";

  updateControls();

  resetUploadProgress(state.uploadPlan);

  // Reset statuses
  for (const item of state.uploadPlan) { item.transferred = 0; item.status = "pending"; }
  renderUploadQueue();

  const folderItems = state.uploadPlan.filter(i => i.kind === "folder");
  const fileItems = state.uploadPlan.filter(i => i.kind === "file");

  try {
    // Create folders (shallow-first)
    for (const item of folderItems) {
      if (state.abortController.signal.aborted) throw new Error("Aborted.");
      item.status = "active";
      renderUploadQueue();
      await state.client.ensureFolder(item.remotePath);
      item.transferred = item.size;
      consumeCompletedUploadItem(item);
      renderUploadQueue();
    }

    // Upload files
    for (const item of fileItems) {
      if (state.abortController.signal.aborted) throw new Error("Aborted.");
      item.status = "active";
      renderUploadQueue();
      const parent = getParentPath(item.remotePath);
      await state.client.ensureFolder(parent);
      const fileStartTime = performance.now();
      let lastSpeedUpdate = 0;
      await state.client.uploadFile(item.remotePath, item.file, (written, total) => {
        item.transferred = written;
        const now = performance.now();
        if (now - lastSpeedUpdate >= 150 || written === total) {
          lastSpeedUpdate = now;
          const elapsed = (now - fileStartTime) / 1000;
          if (elapsed > 0 && written > 0) {
            const bps = written / elapsed;
            state.transferSpeed = bps < 1000
              ? `${Math.round(bps)} B/s`
              : `${(bps / 1024).toFixed(1)} KB/s`;
          }
        }
        renderUploadQueue();
      }, state.abortController.signal);
      item.transferred = item.size;
      consumeCompletedUploadItem(item);
      renderUploadQueue();
    }
    const uploadedFileText = fileItems.length === 1 ? "1 file" : `${fileItems.length} files`;
    log(`Successfully uploaded ${uploadedFileText}.`);
    showSuccessToast(`Successfully uploaded ${uploadedFileText}`);
  } catch (err) {
    log(`Upload error: ${err.message}`, "err");
    const isReconnecting = state.connState === "reconnecting";
    const isConnectionLoss = !isReconnecting && /GATT|NetworkError|disconnected/i.test(err.message);
    const isUserAbort = !isReconnecting && !isConnectionLoss && state.abortController && state.abortController.signal.aborted;
    if (isUserAbort) {
      showErrorToast("Upload was cancelled");
    } else if (!isReconnecting && !isConnectionLoss) {
      showErrorToast("Could not complete the upload");
    }
    const active = state.uploadPlan.find(i => i.status === "active");
    if (active) active.status = isUserAbort ? "aborted" : "error";
    if (!isReconnecting && !isConnectionLoss) {
      for (const item of state.uploadPlan) { if (item.status === "pending") item.status = "aborted"; }
    }
    renderUploadQueue();
  } finally {
    state.uploadActive = false;
    state.abortController = null;
    state.transferSpeed = "";
    el.browserLockOverlay.classList.remove("active");
    updateControls();
    if (state.connState === "connected" && state.client && state.client.device) {
      invalidateCache();
      if (state.currentPath) {
        try { await browseFolder(state.currentPath); } catch (_) { /* connection may be dropping */ }
      }
    }
  }
}

// --- Upload event handlers ---

el.btnPickFolder.addEventListener("click", async () => {
  try {
    if (typeof window.showDirectoryPicker === "function") {
      const handle = await window.showDirectoryPicker({ mode: "read" });
      const collected = await collectFromDirHandle(handle);
      buildUploadPlan(collected.folders, collected.files);
    } else {
      el.folderInput.click();
    }
  } catch (err) {
    if (err.name !== "AbortError") log(`Picker error: ${err.message}`, "err");
  }
});

el.folderInput.addEventListener("change", async (e) => {
  if (!e.target.files || e.target.files.length === 0) return;
  const collected = await collectFromWebkitDir(e.target.files);
  buildUploadPlan(collected.folders, collected.files);
  e.target.value = "";
});

el.btnPickFiles.addEventListener("click", () => el.filesInput.click());

el.filesInput.addEventListener("change", (e) => {
  if (!e.target.files || e.target.files.length === 0) return;
  const collected = collectFromFiles(e.target.files);
  buildUploadPlan(collected.folders, collected.files);
  setPanelState("upload");
  e.target.value = "";
});

el.btnUploadStart.addEventListener("click", runUpload);

el.btnUploadAbort.addEventListener("click", () => {
  if (state.abortController) {
    state.abortController.abort();
    log("Upload cancelled.");
  }
});

el.btnUploadClear.addEventListener("click", () => {
  if (el.btnUploadClear.getAttribute("aria-disabled") === "true") return;
  state.uploadPlan = [];
  state.uploadWarnings = [];
  resetUploadProgress([]);
  renderUploadQueue();
  updateControls();
});

// === Initial state ===

const _buildCommit = document.querySelector('meta[name="build-commit"]')?.content;
const _buildBranch = document.querySelector('meta[name="build-branch"]')?.content;

if (_buildCommit && _buildCommit !== "dev") el.navCommit.textContent = _buildCommit;

const isDevMode = _buildCommit === "dev" || (_buildBranch && _buildBranch !== "main") || (!_buildCommit && !_buildBranch);
if (isDevMode) {
  el.btnDev.addEventListener("click", devConnect);
  if (_buildCommit === "dev") el.navCommit.textContent = "dev";
}

setConnState("disconnected");
updateControls();
