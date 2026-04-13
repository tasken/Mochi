// === Constants ===

const NUS_SERVICE_UUID = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";
const NUS_CHAR_TX_UUID = "6e400002-b5a3-f393-e0a9-e50e24dcca9e";
const NUS_CHAR_RX_UUID = "6e400003-b5a3-f393-e0a9-e50e24dcca9e";

const FRAME_HEADER_SIZE = 4;
const MAX_ATT_BYTES = 247;
const MAX_FILE_NAME_BYTES = 47;
const MAX_FILE_PATH_BYTES = 65;
const MAX_FOLDER_PATH_BYTES = 57;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const VFS_ERRORS = {
  0: "OK",
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
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function getBaseName(path) {
  const parts = path.split("/").filter(Boolean);
  return parts.length === 0 ? "" : parts[parts.length - 1];
}

function getParentPath(path) {
  const i = path.lastIndexOf("/");
  return i <= 2 ? path.slice(0, 3) : path.slice(0, i);
}

function getDriveRoot(drive) {
  return drive ? `${drive}:/` : "";
}

function joinChildPath(parent, child) {
  const c = String(child || "").replace(/^\/+|\/+$/g, "");
  if (!c) return parent;
  return parent.endsWith("/") ? `${parent}${c}` : `${parent}/${c}`;
}

function normalizeBasePath(input) {
  let v = (input || "/").trim().replace(/\\/g, "/");
  if (!v.startsWith("/")) v = `/${v}`;
  v = v.replace(/\/+/g, "/");
  if (v.length > 1 && v.endsWith("/")) v = v.slice(0, -1);
  return v || "/";
}

function joinRemotePath(drive, basePath, relativePath) {
  const base = normalizeBasePath(basePath);
  const d = drive.endsWith(":") ? drive.slice(0, -1) : drive;
  const root = `${d}:${base}`;
  const rel = (relativePath || "").replace(/\\/g, "/").split("/").filter(Boolean).join("/");
  if (!rel) return root;
  return root.endsWith("/") ? `${root}${rel}` : `${root}/${rel}`;
}

function normalizeAbsolutePath(input, drive) {
  const root = getDriveRoot(drive);
  if (!root) return "";
  let v = (input || root).trim().replace(/\\/g, "/");
  if (!v) return root;
  const m = v.match(/^([A-Za-z]):(.*)$/);
  if (m) {
    const d = m[1].toUpperCase();
    if (drive && d !== drive.toUpperCase()) throw new Error(`Drive mismatch: expected ${drive}:, got ${d}:`);
    let rest = m[2] || "/";
    if (!rest.startsWith("/")) rest = `/${rest}`;
    rest = rest.replace(/\/+/g, "/");
    if (rest.length > 1 && rest.endsWith("/")) rest = rest.slice(0, -1);
    return `${d}:${rest || "/"}`;
  }
  return joinRemotePath(drive, v.startsWith("/") ? v : `/${v}`, "");
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

function itemCount(n, noun) { return `${n} ${noun}${n === 1 ? "" : "s"}`; }

function nextFrame() { return new Promise(r => requestAnimationFrame(r)); }

async function yieldToBrowser(i, interval = 24) {
  if (i > 0 && i % interval === 0) await nextFrame();
}

// === Binary cursor ===

class Cursor {
  constructor(bytes) { this.bytes = bytes; this.offset = 0; }
  remaining() { return this.bytes.length - this.offset; }
  u8() { return this.bytes[this.offset++]; }
  i8() { const v = this.bytes[this.offset++]; return v > 127 ? v - 256 : v; }
  u16() { const v = this.bytes[this.offset] | (this.bytes[this.offset + 1] << 8); this.offset += 2; return v; }
  u32() { const view = new DataView(this.bytes.buffer, this.bytes.byteOffset + this.offset, 4); const v = view.getUint32(0, true); this.offset += 4; return v; }
  take(n) { const v = this.bytes.slice(this.offset, this.offset + n); this.offset += n; return v; }
  skip(n) { this.offset += n; }
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
    this._onNotification = this._onNotification.bind(this);
    this._onDisconnect = this._onDisconnect.bind(this);
    this.onDisconnect = null;
  }

  async connect() {
    if (!navigator.bluetooth) throw new Error("Web Bluetooth is not available.");
    this._log("Requesting BLE device...");
    const device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [NUS_SERVICE_UUID] }],
      optionalServices: [NUS_SERVICE_UUID],
    });
    device.addEventListener("gattserverdisconnected", this._onDisconnect);
    const server = await device.gatt.connect();
    const service = await server.getPrimaryService(NUS_SERVICE_UUID);
    const chars = await service.getCharacteristics();
    for (const c of chars) {
      if (c.uuid === NUS_CHAR_TX_UUID) this.txChar = c;
      else if (c.uuid === NUS_CHAR_RX_UUID) this.rxChar = c;
    }
    if (!this.txChar || !this.rxChar) throw new Error("NUS characteristics not found.");
    this.device = device;
    await this.rxChar.startNotifications();
    this.rxChar.addEventListener("characteristicvaluechanged", this._onNotification);
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
    if (this.device && this.device.gatt.connected) { this.device.gatt.disconnect(); return; }
    this._resetTransport("Disconnected.");
  }

  _resetTransport(reason) {
    if (this.rxChar) this.rxChar.removeEventListener("characteristicvaluechanged", this._onNotification);
    if (this.device) this.device.removeEventListener("gattserverdisconnected", this._onDisconnect);
    if (this.pending) { this.pending.reject(new Error(reason)); this.pending = null; }
    this.device = null; this.txChar = null; this.rxChar = null;
    this.queue = Promise.resolve(); this.chunking = false; this.rxParts = [];
    this.createdFolders.clear();
  }

  _onDisconnect() {
    this._log("Device disconnected.");
    this._resetTransport("Device disconnected.");
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
        usedBytes: c.u32(),
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
    while (c.remaining() > 0) {
      const name = c.string();
      const size = c.u32();
      const type = c.u8() === 1 ? "DIR" : "FILE";
      const metaSize = c.u8();
      const meta = { flags: 0, notes: "", amiiboHead: null, amiiboTail: null, raw: null };
      if (metaSize > 0) {
        const metaStart = c.offset;
        meta.raw = c.bytes.slice(metaStart, metaStart + metaSize);
        const metaEnd = metaStart + metaSize;
        let pos = metaStart;
        // Firmware TLV format (vfs_meta.c): each type has its own fixed structure —
        // type 1 (NOTES) has a length byte; types 2 (FLAGS) and 3 (AMIIBO_ID) do not.
        while (pos < metaEnd) {
          const tlvType = c.bytes[pos];
          pos += 1;
          if (tlvType === 1) {
            // Notes: [len][...utf8...]
            if (pos >= metaEnd) break;
            const len = c.bytes[pos]; pos += 1;
            if (pos + len > metaEnd) break;
            meta.notes = decoder.decode(c.bytes.slice(pos, pos + len));
            pos += len;
          } else if (tlvType === 2) {
            // Flags: [flags_byte] — no length prefix
            if (pos >= metaEnd) break;
            meta.flags = c.bytes[pos]; pos += 1;
          } else if (tlvType === 3) {
            // Amiibo ID: [head u32 LE][tail u32 LE] — no length prefix
            if (pos + 8 > metaEnd) break;
            const mv = new DataView(c.bytes.buffer, c.bytes.byteOffset + pos, 8);
            meta.amiiboHead = mv.getUint32(0, true);
            meta.amiiboTail = mv.getUint32(4, true);
            pos += 8;
          } else {
            break; // unknown type, length unknown — cannot continue
          }
        }
        c.offset = metaEnd;
      }
      entries.push({ name, size, type, meta });
    }
    return { ok: true, error: null, data: entries };
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
    const r = await this._sendCommand(0x14, Uint8Array.of(fileId));
    await this.closeFile(fileId);
    if (r.status !== 0) return { ok: false, error: this._vfsError(r.status), data: null };
    return { ok: true, error: null, data: r.payload };
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
      await this.closeFile(fileId);
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
    this.queue = this.queue.catch(() => undefined).then(run);
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
      } catch (err) {
        this.pending = null;
        reject(err);
      }
    });
  }

  _onNotification(event) {
    if (!this.pending) return;
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
  }
}

// === DOM References ===

const el = {
  // Top bar
  btnConnect: document.getElementById("btnConnect"),
  topbarBadge: document.getElementById("topbarBadge"),
  topbarDrive: document.getElementById("topbarDrive"),
  topbarDriveInfo: document.getElementById("topbarDriveInfo"),
  topbarDiv: document.getElementById("topbarDiv"),
  topbarBreadcrumb: document.getElementById("topbarBreadcrumb"),
  btnFormat: document.getElementById("btnFormat"),
  btnUp: document.getElementById("btnUp"),
  btnRefresh: document.getElementById("btnRefresh"),
  btnNewFolder: document.getElementById("btnNewFolder"),
  btnUploadToggle: document.getElementById("btnUploadToggle"),
  btnLogToggle: document.getElementById("btnLogToggle"),
  connError: document.getElementById("connError"),

  // Main overlay
  mainOverlay: document.getElementById("mainOverlay"),
  mainOverlayIcon: document.getElementById("mainOverlayIcon"),
  mainOverlaySpinner: document.getElementById("mainOverlaySpinner"),
  mainOverlayTitle: document.getElementById("mainOverlayTitle"),
  mainOverlaySub: document.getElementById("mainOverlaySub"),

  // Context panel — folder state
  panelFolder: document.getElementById("panelFolder"),
  panelFolderName: document.getElementById("panelFolderName"),
  panelFolderPath: document.getElementById("panelFolderPath"),
  panelFolderCount: document.getElementById("panelFolderCount"),
  panelDriveBarFill: document.getElementById("panelDriveBarFill"),
  panelDriveUsage: document.getElementById("panelDriveUsage"),

  // Context panel — file/amiibo state
  panelFile: document.getElementById("panelFile"),
  panelFileLabel: document.getElementById("panelFileLabel"),
  panelFileName: document.getElementById("panelFileName"),
  panelFileSize: document.getElementById("panelFileSize"),
  panelFileFlags: document.getElementById("panelFileFlags"),
  panelFileNotes: document.getElementById("panelFileNotes"),
  panelAmiibo: document.getElementById("panelAmiibo"),
  panelAmiiboContent: document.getElementById("panelAmiiboContent"),
  panelBtnRename: document.getElementById("panelBtnRename"),
  panelBtnDelete: document.getElementById("panelBtnDelete"),

  // Context panel — upload state
  panelUpload: document.getElementById("panelUpload"),
  btnPickFolder: document.getElementById("btnPickFolder"),
  btnPickFiles: document.getElementById("btnPickFiles"),
  uploadQueue: document.getElementById("uploadQueue"),
  btnUploadStart: document.getElementById("btnUploadStart"),
  btnUploadAbort: document.getElementById("btnUploadAbort"),
  btnUploadClear: document.getElementById("btnUploadClear"),
  folderInput: document.getElementById("folderInput"),
  filesInput: document.getElementById("filesInput"),
  btnUploadClose: document.getElementById("btnUploadClose"),

  // Log overlay
  logOverlay: document.getElementById("logOverlay"),
  protocolLog: document.getElementById("protocolLog"),
  btnLogClose: document.getElementById("btnLogClose"),

  // Browser lock
  browserLockOverlay: document.getElementById("browserLockOverlay"),
  browserLockTitle: document.getElementById("browserLockTitle"),

  // Selection bar
  selectionBar: document.getElementById("selectionBar"),
  selectionCount: document.getElementById("selectionCount"),
  btnLowercase: document.getElementById("btnLowercase"),
  btnDelete: document.getElementById("btnDelete"),
  btnSelectAll: document.getElementById("btnSelectAll"),
  btnClearSelection: document.getElementById("btnClearSelection"),

  // File table
  checkAll: document.getElementById("checkAll"),
  fileTableBody: document.getElementById("fileTableBody"),

  // Modals
  formatModal: document.getElementById("formatModal"),
  formatModalMsg: document.getElementById("formatModalMsg"),
  btnFormatCancel: document.getElementById("btnFormatCancel"),
  btnFormatConfirm: document.getElementById("btnFormatConfirm"),

  newFolderModal: document.getElementById("newFolderModal"),
  newFolderPath: document.getElementById("newFolderPath"),
  newFolderInput: document.getElementById("newFolderInput"),
  btnNewFolderCancel: document.getElementById("btnNewFolderCancel"),
  btnNewFolderConfirm: document.getElementById("btnNewFolderConfirm"),

  renameModal: document.getElementById("renameModal"),
  renameInput: document.getElementById("renameInput"),
  btnRenameCancel: document.getElementById("btnRenameCancel"),
  btnRenameConfirm: document.getElementById("btnRenameConfirm"),

  deleteModal: document.getElementById("deleteModal"),
  deleteCount: document.getElementById("deleteCount"),
  deleteModalMsg: document.getElementById("deleteModalMsg"),
  btnDeleteCancel: document.getElementById("btnDeleteCancel"),
  btnDeleteConfirm: document.getElementById("btnDeleteConfirm"),

  sanitizeModalFiles: document.getElementById("sanitizeModalFiles"),
  sanitizeFilesCount: document.getElementById("sanitizeFilesCount"),
  sanitizeFilesList: document.getElementById("sanitizeFilesList"),
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
  uploadActive: false,
  abortController: null,
  transferSpeed: "",
  folderCache: new Map(),
};

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

// === Connection State Machine ===


function setConnState(newState) {
  state.connState = newState;

  const connected = newState === "connected";
  const connecting = newState === "connecting";
  const disconnected = newState === "disconnected";

  // Main overlay
  el.mainOverlay.classList.toggle("active", !connected);
  el.mainOverlayIcon.hidden = connecting;
  el.mainOverlaySpinner.hidden = !connecting;
  el.mainOverlayTitle.textContent = connecting ? "Connecting to device\u2026" : "No device connected";
  el.mainOverlaySub.textContent = connecting ? "" : "Click Connect above to get started.";

  // Connect button
  if (disconnected) {
    el.btnConnect.innerHTML = '<span class="ms">bluetooth</span> Connect';
    el.btnConnect.className = "primary";
    el.btnConnect.disabled = false;
    el.btnConnect.style.display = "";
  } else if (connecting) {
    el.btnConnect.innerHTML = '<md-circular-progress indeterminate></md-circular-progress> Connecting\u2026';
    el.btnConnect.className = "btn-connecting";
    el.btnConnect.disabled = true;
    el.btnConnect.style.display = "";
  } else {
    // connected — button becomes Disconnect
    el.btnConnect.innerHTML = '<span class="ms">bluetooth_disabled</span> Disconnect';
    el.btnConnect.className = "danger";
    el.btnConnect.disabled = false;
    el.btnConnect.style.display = "";
  }

  // Topbar connected elements
  el.topbarBadge.hidden = !connected;
  el.topbarDrive.hidden = !connected;
  el.topbarDiv.hidden = !connected;
  el.topbarBreadcrumb.hidden = !connected;
  el.btnUp.hidden = !connected;
  el.btnRefresh.hidden = !connected;
  el.btnNewFolder.hidden = !connected;
  el.btnUploadToggle.hidden = !connected;
  el.btnLogToggle.hidden = !connected;

  // Error cleared on state change
  el.connError.hidden = true;
  el.connError.textContent = "";

  if (disconnected) {
    state.drive = null;
    state.entries = [];
    state.selectedNames.clear();
    state.currentPath = "";
    setPanelState("folder");
    renderDrive(null);
    renderFileTable();
    updateSelectionBar();
    el.topbarBreadcrumb.textContent = "";
    el.topbarBadge.textContent = "";
  }

  updateControls();
}

function showConnError(msg) {
  el.connError.textContent = msg;
  el.connError.hidden = false;
}

// === Connection ===

async function connectOrDisconnect() {
  if (state.connState === "connected") {
    if (state.client) state.client.disconnect();
    setConnState("disconnected");
    return;
  }

  setConnState("connecting");

  if (!state.client) {
    state.client = new PixlToolsClient(log);
    state.client.onDisconnect = () => setConnState("disconnected");
  }

  try {
    await state.client.connect();
    setConnState("connected");

    // Get version info
    const ver = await state.client.getVersion();
    if (ver.ok) {
      const parts = [];
      if (ver.data.version) parts.push(ver.data.version);
      if (ver.data.bleAddress) parts.push(ver.data.bleAddress);
      el.topbarBadge.textContent = `● Pixl.js${parts.length ? " · " + parts.join(" · ") : ""}`;
    } else {
      el.topbarBadge.textContent = "● Pixl.js";
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
    setConnState("disconnected");
  }
}

// === Drive Panel ===

function renderDrive(driveData) {
  if (!driveData) {
    el.panelDriveBarFill.style.width = "0%";
    el.panelDriveBarFill.classList.remove("high");
    el.panelDriveUsage.textContent = "";
    el.topbarDriveInfo.textContent = "—";
    return;
  }
  const pct = driveData.totalBytes > 0
    ? Math.round((driveData.usedBytes / driveData.totalBytes) * 100)
    : 0;
  el.panelDriveBarFill.style.width = `${pct}%`;
  el.panelDriveBarFill.classList.toggle("high", pct >= 85);
  const used = formatBytes(driveData.usedBytes);
  const total = formatBytes(driveData.totalBytes);
  el.panelDriveUsage.textContent = `${used} / ${total}`;
  el.topbarDriveInfo.textContent = `${used} / ${total}`;
}

// === Format Modal ===

function openModal(modalEl) { modalEl.classList.add("open"); }
function closeModal(modalEl) { modalEl.classList.remove("open"); }

el.btnFormat.addEventListener("click", () => openModal(el.formatModal));
el.btnFormatCancel.addEventListener("click", () => closeModal(el.formatModal));

el.btnFormatConfirm.addEventListener("click", async () => {
  closeModal(el.formatModal);
  if (!state.client) return;
  try {
    el.btnFormatConfirm.disabled = true;
    const res = await state.client.formatDrive("E");
    if (res.ok) {
      log("Drive E: formatted successfully.");
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
    }
  } catch (err) {
    log(`Format error: ${err.message}`, "err");
  } finally {
    el.btnFormatConfirm.disabled = false;
  }
});

// Close modals on backdrop click
for (const modal of [el.formatModal, el.newFolderModal, el.renameModal, el.deleteModal,
    el.sanitizeModalFiles, el.sanitizeModalFolders, el.sanitizeModalNone]) {
  modal.addEventListener("click", (e) => {
    if (e.target === modal) closeModal(modal);
  });
}

// === Update Controls ===

function updateControls() {
  const connected = state.connState === "connected";
  const uploading = state.uploadActive;
  el.btnUp.disabled = !connected || uploading || !state.currentPath || state.currentPath === "E:/";
  el.btnRefresh.disabled = !connected || uploading;
  el.btnNewFolder.disabled = !connected || uploading;
  el.btnFormat.disabled = !connected || uploading;
  el.checkAll.disabled = !connected || state.entries.length === 0;
  el.btnPickFolder.disabled = !connected || uploading;
  el.btnPickFiles.disabled = !connected || uploading;
  el.btnUploadStart.disabled = !connected || uploading || state.uploadPlan.length === 0;
  el.btnUploadAbort.disabled = !uploading;
  el.btnUploadClear.disabled = uploading || state.uploadPlan.length === 0;
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
  let entries = state.folderCache.get(path);
  if (!entries) {
    try {
      const res = await state.client.readFolder(path);
      if (!res.ok) {
        log(`Failed to read ${path}: ${res.error}`, "err");
        return;
      }
      entries = sortEntries(res.data);
      state.folderCache.set(path, entries);
      for (const e of entries) {
        if (e.type === "DIR") state.client.createdFolders.add(joinChildPath(path, e.name));
      }
    } catch (err) {
      log(`Error reading ${path}: ${err.message}`, "err");
      return;
    }
  }

  state.currentPath = path;
  state.entries = entries;
  state.selectedNames.clear();
  setPanelState("folder");
  el.pathDisplay.textContent = path;
  el.checkAll.checked = false;
  renderFileTable();
  updateSelectionBar();
  updateControls();
}

// === Render File Table ===

function formatFlagShort(flags) {
  const parts = [];
  if (flags & 0x01) parts.push("R");
  if (flags & 0x02) parts.push("H");
  if (flags & 0x04) parts.push("S");
  return parts.length > 0 ? parts.join(", ") : "\u2014";
}

function formatAmiiboHex(head, tail) {
  if (head == null || tail == null) return "\u2014";
  const h = (head >>> 0).toString(16).toUpperCase().padStart(8, "0");
  const t = (tail >>> 0).toString(16).toUpperCase().padStart(8, "0");
  return `${h}:${t}`;
}

// AmiiboAPI lookup — session cache to avoid re-fetching the same ID
const _amiiboCache = new Map();

async function lookupAmiibo(head, tail) {
  const key = `${head >>> 0}:${tail >>> 0}`;
  if (_amiiboCache.has(key)) return _amiiboCache.get(key);
  const headHex = (head >>> 0).toString(16).toUpperCase().padStart(8, "0");
  const tailHex = (tail >>> 0).toString(16).toUpperCase().padStart(8, "0");
  let info = null;
  try {
    const res = await fetch(`https://amiiboapi.org/api/amiibo/?head=${headHex}&tail=${tailHex}`);
    if (res.ok) info = (await res.json()).amiibo?.[0] ?? null;
  } catch { /* network unavailable — leave null */ }
  _amiiboCache.set(key, info);
  return info;
}

function renderAmiiboField(head, tail, info) {
  const hex = `<span class="drawer-amiibo-hex">${escapeHtml(formatAmiiboHex(head, tail))}</span>`;
  if (!info) return hex;
  const seriesLine = info.amiiboSeries && info.amiiboSeries !== info.gameSeries
    ? `${escapeHtml(info.gameSeries)} · ${escapeHtml(info.amiiboSeries)}`
    : escapeHtml(info.gameSeries);
  return `<div class="drawer-amiibo-info">` +
    `<span class="drawer-amiibo-name">${escapeHtml(info.name)}</span>` +
    `<span class="drawer-amiibo-series">${seriesLine}</span>` +
    hex +
    `</div>` +
    `<img src="${escapeHtml(info.image)}" alt="${escapeHtml(info.name)}" loading="lazy">`;
}

function applyAmiiboDisplay(entry, head, tail) {
  const key = `${head >>> 0}:${tail >>> 0}`;
  if (_amiiboCache.has(key)) {
    el.panelAmiiboContent.innerHTML = renderAmiiboField(head, tail, _amiiboCache.get(key));
    return;
  }
  el.panelAmiiboContent.innerHTML =
    `<div class="drawer-amiibo-info">` +
    `<span class="drawer-amiibo-hex">${escapeHtml(formatAmiiboHex(head, tail))}</span>` +
    `</div>` +
    `<div class="drawer-amiibo-loading"><md-circular-progress indeterminate style="--md-circular-progress-size:28px"></md-circular-progress></div>`;
  lookupAmiibo(head, tail).then(info => {
    if (state.drawerEntry !== entry) return;
    el.panelAmiiboContent.innerHTML = renderAmiiboField(head, tail, info);
  });
}

function renderFileTable() {
  if (state.entries.length === 0) {
    el.fileTableBody.innerHTML = '<tr><td colspan="4" class="empty-state">This folder is empty.</td></tr>';
    return;
  }

  const rows = [];
  for (const entry of state.entries) {
    const isDir = entry.type === "DIR";
    const checked = state.selectedNames.has(entry.name) ? "checked" : "";
    const size = isDir ? "\u2014" : formatBytes(entry.size);
    const isPanelActive = state.drawerEntry && state.drawerEntry.name === entry.name;

    // Subtitle: amiibo name (if known) → flags abbreviation → empty
    let sub = "";
    if (!isDir && entry.meta) {
      const cachedAmiibo = _amiiboCache.get(`${entry.meta.amiiboHead >>> 0}:${entry.meta.amiiboTail >>> 0}`);
      if (cachedAmiibo) {
        sub = escapeHtml(cachedAmiibo.name);
      } else {
        const flagStr = formatFlagShort(entry.meta.flags);
        if (flagStr !== "\u2014") sub = escapeHtml(flagStr);
      }
    }

    const nameCell = isDir
      ? `<td class="cell-name folder"><span class="ms-sm">folder</span> ${escapeHtml(entry.name)}</td>`
      : `<td class="cell-name"><span class="ms-sm">insert_drive_file</span> ${escapeHtml(entry.name)}${sub ? `<span class="cell-name-sub">${sub}</span>` : ""}</td>`;

    rows.push(
      `<tr data-name="${escapeHtml(entry.name)}"${isPanelActive ? ' class="panel-active"' : ''}>` +
      `<td class="cell-check"><input type="checkbox" ${checked}></td>` +
      nameCell +
      `<td class="cell-size">${size}</td>` +
      `<td class="cell-actions"><button class="ghost" title="Rename"><span class="ms-sm">edit</span></button></td>` +
      `</tr>`
    );
  }
  el.fileTableBody.innerHTML = rows.join("");
}

// === Selection Bar ===

function updateSelectionBar() {
  const count = state.selectedNames.size;
  el.selectionBar.classList.toggle("visible", state.entries.length > 0);
  el.selectionCount.textContent = count > 0 ? `${count} selected` : "";
  el.btnDelete.disabled = count === 0;
  el.btnLowercase.disabled = false;
  el.checkAll.checked = state.entries.length > 0 && count === state.entries.length;
  el.checkAll.indeterminate = count > 0 && count < state.entries.length;
}

// === Helpers ===

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

  // Rename button click
  const renameBtn = e.target.closest(".cell-actions button");
  if (renameBtn) {
    renameTarget = entry.name;
    el.renameInput.value = entry.name;
    openModal(el.renameModal);
    el.renameInput.focus();
    el.renameInput.select();
    return;
  }

  // Folder name click — navigate
  const nameCell = e.target.closest(".cell-name");
  if (nameCell) {
    if (entry.type === "DIR") {
      browseFolder(joinChildPath(state.currentPath, entry.name));
    } else {
      setPanelState("file", entry);
    }
    return;
  }
});

// Check all
el.checkAll.addEventListener("change", () => {
  const checked = el.checkAll.checked;
  state.selectedNames.clear();
  if (checked) {
    for (const entry of state.entries) state.selectedNames.add(entry.name);
  }
  applySelectionToRows(checked);
  updateSelectionBar();
});

// Toolbar buttons
el.btnUp.addEventListener("click", () => {
  if (state.currentPath && state.currentPath !== "E:/") {
    browseFolder(getParentPath(state.currentPath));
  }
});

el.btnRefresh.addEventListener("click", () => {
  if (state.currentPath) {
    state.folderCache.delete(state.currentPath);
    browseFolder(state.currentPath);
  }
});

// New folder modal
el.btnNewFolder.addEventListener("click", () => {
  el.newFolderPath.textContent = state.currentPath || "E:/";
  el.newFolderInput.value = "";
  openModal(el.newFolderModal);
  el.newFolderInput.focus();
});

el.btnNewFolderCancel.addEventListener("click", () => closeModal(el.newFolderModal));

el.btnNewFolderConfirm.addEventListener("click", async () => {
  const name = el.newFolderInput.value.trim();
  if (!name) return;
  closeModal(el.newFolderModal);
  if (!state.client) return;
  try {
    const folderPath = joinChildPath(state.currentPath, name);
    validateRemotePath(folderPath, "folder");
    const res = await state.client.createFolder(folderPath);
    if (res.ok) {
      log(`Created folder: ${folderPath}`);
      state.folderCache.delete(state.currentPath);
      await browseFolder(state.currentPath);
    } else {
      log(`Failed to create folder: ${res.error}`, "err");
    }
  } catch (err) {
    log(`Error creating folder: ${err.message}`, "err");
  }
});

// Selection bar buttons
el.btnSelectAll.addEventListener("click", () => {
  state.selectedNames.clear();
  for (const entry of state.entries) state.selectedNames.add(entry.name);
  applySelectionToRows(true);
  el.checkAll.checked = true;
  updateSelectionBar();
});

el.btnClearSelection.addEventListener("click", () => {
  state.selectedNames.clear();
  for (const row of el.fileTableBody.querySelectorAll("tr[data-name]")) {
    const cb = row.querySelector("input[type=checkbox]");
    if (cb) cb.checked = false;
    row.classList.remove("selected");
  }
  el.checkAll.checked = false;
  updateSelectionBar();
});

// Delete modal (open only — actual delete is wired in a later task)
el.btnDelete.addEventListener("click", () => {
  const count = state.selectedNames.size;
  if (count === 0) return;
  el.deleteCount.textContent = String(count);
  el.deleteModalMsg.textContent = `This will permanently delete ${itemCount(count, "item")}. This action cannot be undone.`;
  openModal(el.deleteModal);
});

el.btnDeleteCancel.addEventListener("click", () => closeModal(el.deleteModal));
el.btnRenameCancel.addEventListener("click", () => closeModal(el.renameModal));

// Lowercase modal
el.btnLowercase.addEventListener("click", () => {
  const count = state.selectedNames.size;
  if (count === 0) {
    el.sanitizeNonePath.textContent = state.currentPath || "E:/";
    openModal(el.sanitizeModalNone);
    return;
  }
  const hasFolders = [...state.selectedNames].some(n => {
    const entry = state.entries.find(e => e.name === n);
    return entry && entry.type === "DIR";
  });
  if (hasFolders) {
    openModal(el.sanitizeModalFolders);
  } else {
    el.sanitizeFilesCount.textContent = itemCount(count, "selected file");
    const names = [...state.selectedNames].slice(0, 10).join(", ");
    el.sanitizeFilesList.textContent = count > 10 ? `${names}, \u2026` : names;
    openModal(el.sanitizeModalFiles);
  }
});

el.btnSanitizeFilesCancel.addEventListener("click", () => closeModal(el.sanitizeModalFiles));
el.btnSanitizeFoldersCancel.addEventListener("click", () => closeModal(el.sanitizeModalFolders));
el.btnSanitizeNoneCancel.addEventListener("click", () => closeModal(el.sanitizeModalNone));

// === Context Panel ===

function setPanelState(mode, entry) {
  // Hide all states
  el.panelFolder.hidden = true;
  el.panelFile.hidden = true;
  el.panelUpload.hidden = true;

  if (mode === "upload") {
    state.panelPrevMode = state.panelMode === "upload" ? state.panelPrevMode : state.panelMode;
    state.panelMode = "upload";
    el.panelUpload.hidden = false;
    return;
  }

  if (mode === "file" && entry) {
    state.drawerEntry = entry;
    state.panelMode = "file";
    el.panelFile.hidden = false;

    // Populate file fields
    el.panelFileName.textContent = entry.name;
    el.panelFileSize.textContent = formatBytes(entry.size);

    // Flags
    const flagDefs = [
      { bit: 0x02, label: "Hidden" },
      { bit: 0x04, label: "System" },
      { bit: 0x01, label: "Readonly" },
    ];
    const flags = entry.meta ? entry.meta.flags : 0;
    el.panelFileFlags.innerHTML = flagDefs.map(f => {
      const active = (flags & f.bit) !== 0;
      const color = active ? "#3a8" : "#ccc";
      return `<div style="font-size:0.78rem"><span class="ms-sm" style="color:${color}">check</span> ${escapeHtml(f.label)}</div>`;
    }).join("");

    // Notes
    el.panelFileNotes.textContent = (entry.meta && entry.meta.notes) ? entry.meta.notes : "\u2014";

    // Amiibo section — only for .bin files
    const isBin = entry.type === "FILE" && entry.name.toLowerCase().endsWith(".bin");
    el.panelAmiibo.hidden = !isBin;
    if (isBin) {
      const metaHead = entry.meta ? entry.meta.amiiboHead : null;
      const metaTail = entry.meta ? entry.meta.amiiboTail : null;
      if (metaHead != null) {
        applyAmiiboDisplay(entry, metaHead, metaTail);
      } else if (state.client) {
        el.panelAmiiboContent.innerHTML = `<span class="drawer-amiibo-hex">\u2026</span>`;
        const filePath = joinChildPath(state.currentPath, entry.name);
        state.client.readFileData(filePath).then(res => {
          if (state.drawerEntry !== entry) return;
          if (res.ok && res.data.length >= 92) {
            const dv = new DataView(res.data.buffer, res.data.byteOffset);
            const head = dv.getUint32(84, false);
            const tail = dv.getUint32(88, false);
            applyAmiiboDisplay(entry, head, tail);
          } else {
            el.panelAmiiboContent.innerHTML = `<span class="drawer-amiibo-hex">\u2014</span>`;
          }
        }).catch(() => {
          if (state.drawerEntry === entry) el.panelAmiiboContent.innerHTML = `<span class="drawer-amiibo-hex">\u2014</span>`;
        });
      } else {
        el.panelAmiiboContent.innerHTML = `<span class="drawer-amiibo-hex">\u2014</span>`;
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
  el.panelFolder.hidden = false;

  // Clear row highlight
  for (const row of el.fileTableBody.querySelectorAll("tr[data-name]")) {
    row.classList.remove("panel-active");
  }

  // Populate folder info
  if (state.currentPath) {
    const name = getBaseName(state.currentPath) || state.currentPath;
    el.panelFolderName.textContent = name;
    el.panelFolderPath.textContent = state.currentPath;
    el.panelFolderCount.textContent = `${state.entries.length} item${state.entries.length !== 1 ? "s" : ""}`;
  } else {
    el.panelFolderName.textContent = "";
    el.panelFolderPath.textContent = "";
    el.panelFolderCount.textContent = "";
  }
  // Drive bar updated by renderDrive
}

// Panel rename button — renames the currently displayed file
el.panelBtnRename.addEventListener("click", () => {
  if (!state.drawerEntry) return;
  renameTarget = state.drawerEntry.name;
  el.renameInput.value = state.drawerEntry.name;
  openModal(el.renameModal);
  el.renameInput.focus();
  el.renameInput.select();
});

// Panel delete button — deletes the currently displayed file
el.panelBtnDelete.addEventListener("click", () => {
  if (!state.drawerEntry) return;
  el.deleteCount.textContent = "1";
  el.deleteModalMsg.textContent = `This will permanently delete "${state.drawerEntry.name}". This action cannot be undone.`;
  // Pre-select the entry so the existing delete confirm handler works
  state.selectedNames.clear();
  state.selectedNames.add(state.drawerEntry.name);
  openModal(el.deleteModal);
});

// === Connect button ===

el.btnConnect.addEventListener("click", connectOrDisconnect);

// === Keyboard: Enter in new-folder input ===

el.newFolderInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    el.btnNewFolderConfirm.click();
  }
});

el.renameInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    el.btnRenameConfirm.click();
  }
});

// === Task 6: File Manager Operations ===

let renameTarget = "";

// --- Rename confirm ---

el.btnRenameConfirm.addEventListener("click", async () => {
  const newName = el.renameInput.value.trim();
  closeModal(el.renameModal);
  if (!newName || newName === renameTarget) return;
  if (newName.includes("/")) {
    log("Rename failed: name cannot contain /", "err");
    return;
  }
  if (!state.client) return;
  try {
    const oldPath = joinChildPath(state.currentPath, renameTarget);
    const newPath = joinChildPath(state.currentPath, newName);
    const entry = state.entries.find(e => e.name === renameTarget);
    const kind = entry && entry.type === "DIR" ? "folder" : "file";
    validateRemotePath(newPath, kind);
    const res = await state.client.renamePath(oldPath, newPath);
    if (res.ok) {
      log(`Renamed: ${renameTarget} \u2192 ${newName}`);
    } else {
      log(`Rename failed: ${res.error}`, "err");
    }
  } catch (err) {
    log(`Rename error: ${err.message}`, "err");
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
  el.browserLockTitle.textContent = "Delete in progress";
  updateControls();
  let deleted = 0;
  const total = paths.length;
  try {
    for (const item of paths) {
      try {
        const res = await state.client.removePath(item.path);
        if (res.ok) {
          deleted++;
        } else {
          log(`Delete failed: ${item.name} \u2014 ${res.error}`, "err");
        }
      } catch (err) {
        log(`Delete error: ${item.name} \u2014 ${err.message}`, "err");
      }
    }
    log(`Deleted ${deleted} of ${total} ${total === 1 ? "item" : "items"}.`);
  } finally {
    el.browserLockOverlay.classList.remove("active");
    updateControls();
    invalidateCache();
    await browseFolder(state.currentPath);
  }
});

// --- Sanitize helpers ---

function buildSanitizeOps(entries, parentPath) {
  const ops = [];
  const skipped = [];
  const existing = new Set(entries.map(e => e.name));
  const groups = new Map();
  for (const e of entries) {
    const lower = e.name.toLowerCase();
    if (lower === e.name) continue;
    if (!groups.has(lower)) groups.set(lower, []);
    groups.get(lower).push(e);
  }
  for (const [lower, group] of groups) {
    if (group.length > 1) {
      for (const e of group) skipped.push({ name: e.name, reason: `collision: multiple \u2192 ${lower}` });
      continue;
    }
    const [e] = group;
    if (existing.has(lower)) {
      skipped.push({ name: e.name, reason: `${lower} already exists` });
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
    if (!res.ok) { log(`Scan failed: ${folder} \u2014 ${res.error}`, "err"); continue; }
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
        log(`Lowercase failed: ${op.name} \u2014 ${res.error}`, "err");
      }
    } catch (err) {
      log(`Lowercase error: ${op.name} \u2014 ${err.message}`, "err");
    }
  }

  const parts = [`${renamed} renamed`];
  if (allSkipped.length > 0) {
    parts.push(`${allSkipped.length} skipped`);
    for (const s of allSkipped) {
      log(`Skipped: ${s.name} \u2014 ${s.reason}`, "err");
    }
  }
  log(`Lowercase: ${parts.join(", ")}.`);
}

async function withBrowserLock(title, fn) {
  el.browserLockOverlay.classList.add("active");
  el.browserLockTitle.textContent = title;
  updateControls();
  try {
    await fn();
  } catch (err) {
    log(err.message, "err");
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
  await withBrowserLock("Lowercase rename in progress", async () => {
    const selected = state.entries.filter(e => state.selectedNames.has(e.name) && e.type === "FILE");
    const { ops, skipped } = buildSanitizeOps(selected, state.currentPath);
    await executeSanitize(ops, skipped);
  });
});

// --- Sanitize: folders confirm ---

el.btnSanitizeFoldersConfirm.addEventListener("click", async () => {
  closeModal(el.sanitizeModalFolders);
  if (!state.client) return;

  const scope = document.querySelector('input[name="sanitizeFolderScope"]:checked').value;

  await withBrowserLock("Lowercase rename in progress", async () => {
    const allOps = [];
    const allSkipped = [];

    if (scope === "selected") {
      const selected = state.entries.filter(e => state.selectedNames.has(e.name));
      const { ops, skipped } = buildSanitizeOps(selected, state.currentPath);
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
      const { ops, skipped } = buildSanitizeOps(selectedEntries, state.currentPath);
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

  const scope = document.querySelector('input[name="sanitizeNoneScope"]:checked').value;

  await withBrowserLock("Lowercase rename in progress", async () => {
    const allOps = [];
    const allSkipped = [];

    if (scope === "files") {
      const files = state.entries.filter(e => e.type === "FILE");
      const { ops, skipped } = buildSanitizeOps(files, state.currentPath);
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

// === Task 7: Tree Upload ===

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
    case "done": return '<span class="ms-sm" style="color:#3a8">check_circle</span>';
    case "active": return '<span class="ms-sm spin" style="color:#7878cc">sync</span>';
    case "pending": return '<span class="ms-sm" style="color:#888">schedule</span>';
    case "error": return '<span class="ms-sm" style="color:#c33">error</span>';
    case "aborted": return '<span class="ms-sm" style="color:#b80">block</span>';
    default: return '';
  }
}

function renderUploadQueue() {
  if (state.uploadPlan.length === 0) {
    el.uploadQueue.innerHTML = '<div class="queue-empty">No uploads queued</div>';
    return;
  }

  const items = [];
  let totalBytes = 0;
  let doneBytes = 0;
  let doneCount = 0;

  for (const item of state.uploadPlan) {
    totalBytes += item.size;
    if (item.status === "done") { doneBytes += item.size; doneCount++; }
    else { doneBytes += item.transferred; }

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

  const totalPct = totalBytes > 0 ? Math.round((doneBytes / totalBytes) * 100) : (doneCount === state.uploadPlan.length ? 100 : 0);
  const speedStr = state.transferSpeed
    ? ` \u00b7 <span class="ms-sm">upload</span> <span style="color:#7878cc;font-weight:700">${state.transferSpeed}</span>`
    : "";
  items.push(
    `<div class="queue-summary">${doneCount} / ${state.uploadPlan.length} items \u2014 ${totalPct}% (${formatBytes(doneBytes)} / ${formatBytes(totalBytes)})${speedStr}</div>`
  );

  el.uploadQueue.innerHTML = items.join("");
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
  for (const rel of sortedFolders) {
    const remote = joinChildPath(base, rel);
    try {
      validateRemotePath(remote, "folder");
    } catch (err) {
      log(`Skipping folder ${rel}: ${err.message}`, "err");
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
      continue;
    }
    plan.push({ id: ++planSeed, kind: "file", localPath: entry.relativePath, remotePath: remote, size: entry.file.size, file: entry.file, transferred: 0, status: "pending" });
  }
  state.uploadPlan = plan;
  renderUploadQueue();
  updateControls();
}

// --- Upload execution ---

async function runUpload() {
  if (!state.client || state.connState !== "connected" || state.uploadActive || state.uploadPlan.length === 0) return;
  state.uploadActive = true;
  state.abortController = new AbortController();
  el.browserLockOverlay.classList.add("active");
  el.browserLockTitle.textContent = "Upload in progress";

  updateControls();

  // Reset statuses
  for (const item of state.uploadPlan) { item.transferred = 0; item.status = "pending"; }
  renderUploadQueue();

  try {
    // Create folders (shallow-first)
    for (const item of state.uploadPlan.filter(i => i.kind === "folder")) {
      if (state.abortController.signal.aborted) throw new Error("Aborted.");
      item.status = "active";
      renderUploadQueue();
      await state.client.ensureFolder(item.remotePath);
      item.status = "done";
      renderUploadQueue();
    }

    // Upload files
    for (const item of state.uploadPlan.filter(i => i.kind === "file")) {
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
      item.status = "done";
      renderUploadQueue();
    }
    log("Upload complete.");
  } catch (err) {
    log(`Upload error: ${err.message}`, "err");
    const active = state.uploadPlan.find(i => i.status === "active");
    if (active) { active.status = state.abortController.signal.aborted ? "aborted" : "error"; }
    for (const item of state.uploadPlan) { if (item.status === "pending") item.status = "aborted"; }
    renderUploadQueue();
  } finally {
    state.uploadActive = false;
    state.abortController = null;
    state.transferSpeed = "";
    el.browserLockOverlay.classList.remove("active");
    updateControls();
    invalidateCache();
    if (state.currentPath) await browseFolder(state.currentPath);
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
  e.target.value = "";
});

el.btnUploadStart.addEventListener("click", runUpload);

el.btnUploadAbort.addEventListener("click", () => {
  if (state.abortController) {
    state.abortController.abort();
    log("Upload abort requested.");
  }
});

el.btnUploadClear.addEventListener("click", () => {
  state.uploadPlan = [];
  renderUploadQueue();
  updateControls();
});

// === Initial state ===

setConnState("disconnected");
updateControls();
