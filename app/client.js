// === Protocol constants ===

const NUS_SERVICE_UUID = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";
const NUS_CHAR_TX_UUID = "6e400002-b5a3-f393-e0a9-e50e24dcca9e";
const NUS_CHAR_RX_UUID = "6e400003-b5a3-f393-e0a9-e50e24dcca9e";

const FRAME_HEADER_SIZE = 4;

export const NUS_SERVICE = NUS_SERVICE_UUID;
export const MAX_FILE_NAME_BYTES = 47;
const MAX_FILE_PATH_BYTES = 63;
const MAX_FOLDER_PATH_BYTES = 55;

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
    0x02: "ENTER_DFU",
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

// === Wire encoding ===

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
    for (const c of chunks) {
        out.set(c, offset);
        offset += c.length;
    }
    return out;
}

export function utf8Length(value) {
    return encoder.encode(value).length;
}

// === Path utilities ===

export function getBaseName(path) {
    const parts = path.split("/").filter(Boolean);
    return parts.length === 0 ? "" : parts[parts.length - 1];
}

export function getParentPath(path) {
    const i = path.lastIndexOf("/");
    return i <= 2 ? path.slice(0, 3) : path.slice(0, i);
}

export function validateRemotePath(path, kind) {
    if (!path || path.length < 3)
        throw new Error(`Invalid ${kind} path: "${path}"`);
    const limit =
        kind === "folder" ? MAX_FOLDER_PATH_BYTES : MAX_FILE_PATH_BYTES;
    const len = utf8Length(path);
    if (len > limit)
        throw new Error(
            `${kind === "folder" ? "Folder" : "File"} path is ${len} bytes (max ${limit}): ${path}`,
        );
    const base = getBaseName(path);
    if (base && utf8Length(base) > MAX_FILE_NAME_BYTES)
        throw new Error(`Name exceeds ${MAX_FILE_NAME_BYTES} bytes: ${base}`);
}

export function sortEntries(entries) {
    return [...entries].sort((a, b) => {
        const aDir = a.type === "DIR" ? 0 : 1;
        const bDir = b.type === "DIR" ? 0 : 1;
        if (aDir !== bDir) return aDir - bDir;
        return a.name.localeCompare(b.name, undefined, {
            numeric: true,
            sensitivity: "base",
        });
    });
}

// === Binary cursor ===

class Cursor {
    constructor(bytes) {
        this.bytes = bytes;
        this.offset = 0;
        this._view = new DataView(bytes.buffer, bytes.byteOffset);
    }
    remaining() {
        return this.bytes.length - this.offset;
    }
    u8() {
        return this.bytes[this.offset++];
    }
    u16() {
        const v = this.bytes[this.offset] | (this.bytes[this.offset + 1] << 8);
        this.offset += 2;
        return v;
    }
    u32() {
        const v = this._view.getUint32(this.offset, true);
        this.offset += 4;
        return v;
    }
    take(n) {
        const v = this.bytes.slice(this.offset, this.offset + n);
        this.offset += n;
        return v;
    }
    string() {
        return decoder.decode(this.take(this.u16()));
    }
}

// === BLE Client ===

export class PixlToolsClient {
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
        this.folderCache = new Map();
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
        if (!navigator.bluetooth)
            throw new Error("Web Bluetooth is not available.");
        this._log("Requesting BLE device...");
        const device = await navigator.bluetooth.requestDevice({
            filters: [{ services: [NUS_SERVICE_UUID] }],
            optionalServices: [NUS_SERVICE_UUID],
        });
        await this._setupGatt(device);
    }

    async connectTo(device) {
        await this._setupGatt(device);
    }

    async _setupGatt(device) {
        device.removeEventListener(
            "gattserverdisconnected",
            this._onDisconnect,
        );
        device.addEventListener("gattserverdisconnected", this._onDisconnect);
        if (this.rxChar)
            this.rxChar.removeEventListener(
                "characteristicvaluechanged",
                this._onNotification,
            );
        const server = await device.gatt.connect();
        try {
            const service = await server.getPrimaryService(NUS_SERVICE_UUID);
            this.txChar = await service.getCharacteristic(NUS_CHAR_TX_UUID);
            this.rxChar = await service.getCharacteristic(NUS_CHAR_RX_UUID);
            this.device = device;
            await this.rxChar.startNotifications();
            this.rxChar.addEventListener(
                "characteristicvaluechanged",
                this._onNotification,
            );
        } catch (err) {
            device.removeEventListener(
                "gattserverdisconnected",
                this._onDisconnect,
            );
            this.txChar = null;
            this.rxChar = null;
            this.device = null;
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
        if (this.rxChar)
            this.rxChar.removeEventListener(
                "characteristicvaluechanged",
                this._onNotification,
            );
        if (this.device)
            this.device.removeEventListener(
                "gattserverdisconnected",
                this._onDisconnect,
            );
        clearTimeout(this._pendingTimer);
        this._pendingTimer = null;
        if (this.pending) {
            this.pending.reject(new Error(reason));
            this.pending = null;
        }
        this.device = null;
        this.txChar = null;
        this.rxChar = null;
        this.queue = Promise.resolve();
        this.chunking = false;
        this.rxParts = [];
        this.createdFolders.clear();
        this.folderCache.clear();
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
            await new Promise((r) => setTimeout(r, delay));
            if (this._abortReconnect) {
                this._reconnecting = false;
                this._abortReconnect = false;
                if (this.onDisconnect) this.onDisconnect();
                return;
            }
            try {
                this._log("Reconnecting...");
                await this._setupGatt(device);
                if (this._abortReconnect) {
                    this._reconnecting = false;
                    this._abortReconnect = false;
                    if (this.device && this.device.gatt.connected) {
                        this._intentionalDisconnect = true;
                        this.device.gatt.disconnect();
                    } else {
                        if (this.onDisconnect) this.onDisconnect();
                    }
                    return;
                }
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
        if (r.status !== 0)
            return { ok: false, error: this._vfsError(r.status), data: null };
        const c = new Cursor(r.payload);
        const version = c.string();
        const bleAddress = c.remaining() > 0 ? c.string() : "";
        return { ok: true, error: null, data: { version, bleAddress } };
    }

    async listDrives() {
        const r = await this._sendCommand(0x10);
        if (r.status !== 0)
            return { ok: false, error: this._vfsError(r.status), data: null };
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
        if (r.status !== 0)
            return { ok: false, error: this._vfsError(r.status), data: null };
        return { ok: true, error: null, data: null };
    }

    async readFolder(path) {
        const r = await this._sendCommand(0x16, encodeString(path));
        if (r.status !== 0)
            return { ok: false, error: this._vfsError(r.status), data: null };
        const c = new Cursor(r.payload);
        const entries = [];
        let truncated = false;
        while (c.remaining() >= 8) {
            // 8 = 2 (name_len u16) + 4 (size u32) + 1 (type) + 1 (meta_size)
            const nameLen = c.bytes[c.offset] | (c.bytes[c.offset + 1] << 8);
            if (c.remaining() < 2 + nameLen + 4 + 1 + 1) break;
            const name = c.string();
            const size = c.u32();
            const type = c.u8() === 1 ? "DIR" : "FILE";
            const metaSize = c.u8();
            if (c.remaining() < metaSize) {
                truncated = true;
                break;
            }
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
                        const len = c.bytes[pos];
                        pos += 1;
                        pos += len;
                    } else if (tlvType === 2) {
                        // Flags: [flags_byte] — no length prefix
                        if (pos >= metaEnd || pos >= c.bytes.length) break;
                        meta.flags = c.bytes[pos];
                        pos += 1;
                    } else if (tlvType === 3) {
                        // NFC Tag ID: [head u32 LE][tail u32 LE] — no length prefix
                        if (pos + 8 > metaEnd || pos + 8 > c.bytes.length)
                            break;
                        const mv = new DataView(
                            c.bytes.buffer,
                            c.bytes.byteOffset + pos,
                            8,
                        );
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
        if (r.status !== 0)
            return { ok: false, error: this._vfsError(r.status), data: null };
        return { ok: true, error: null, data: null };
    }

    async removePath(path) {
        const r = await this._sendCommand(0x18, encodeString(path));
        if (r.status !== 0)
            return { ok: false, error: this._vfsError(r.status), data: null };
        return { ok: true, error: null, data: null };
    }

    async renamePath(oldPath, newPath) {
        const r = await this._sendCommand(
            0x19,
            concatBytes(encodeString(oldPath), encodeString(newPath)),
        );
        if (r.status !== 0)
            return { ok: false, error: this._vfsError(r.status), data: null };
        return { ok: true, error: null, data: null };
    }

    async openFile(path, mode) {
        const modeMap = { r: 0x08, w: 0x16 };
        if (!(mode in modeMap))
            throw new Error(`openFile: unknown mode "${mode}"`);
        const payload = concatBytes(
            encodeString(path),
            Uint8Array.of(modeMap[mode]),
        );
        const r = await this._sendCommand(0x12, payload);
        if (r.status !== 0)
            return { ok: false, error: this._vfsError(r.status), data: null };
        const c = new Cursor(r.payload);
        return { ok: true, error: null, data: c.u8() };
    }

    async writeFileChunk(fileId, chunk) {
        const r = await this._sendCommand(
            0x15,
            concatBytes(Uint8Array.of(fileId), chunk),
        );
        if (r.status !== 0)
            return { ok: false, error: this._vfsError(r.status), data: null };
        return { ok: true, error: null, data: null };
    }

    async closeFile(fileId) {
        const r = await this._sendCommand(0x13, Uint8Array.of(fileId));
        if (r.status !== 0)
            return { ok: false, error: this._vfsError(r.status), data: null };
        return { ok: true, error: null, data: null };
    }

    async enterDfu() {
        // Set flag before sending: device reboots immediately on ENTER_DFU and
        // disconnects before (or without) sending a notification response, so
        // _onDisconnect fires while _sendCommand is still pending. Marking as
        // intentional here prevents the reconnect timer from starting.
        this._intentionalDisconnect = true;
        try {
            await this._sendCommand(0x02);
            return { ok: true, error: null };
        } catch (err) {
            // Expected: "Device disconnected." due to reboot. Any other error is real.
            const msg = err.message || "";
            if (
                msg.includes("disconnected") ||
                msg.includes("timed out") ||
                msg.includes("Not connected")
            ) {
                return { ok: true, error: null };
            }
            this._intentionalDisconnect = false;
            return { ok: false, error: msg };
        }
    }

    async readFileData(path) {
        const openRes = await this.openFile(path, "r");
        if (!openRes.ok) return { ok: false, error: openRes.error, data: null };
        const fileId = openRes.data;
        try {
            const r = await this._sendCommand(0x14, Uint8Array.of(fileId));
            if (r.status !== 0)
                return {
                    ok: false,
                    error: this._vfsError(r.status),
                    data: null,
                };
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
                const exists = listing.data.some(
                    (e) => e.type === "DIR" && e.name === getBaseName(current),
                );
                if (!exists) throw new Error(res.error);
                this._log(`Using existing ${current}`);
            } else {
                this._log(`Created ${current}`);
            }
            this.createdFolders.add(current);
        }
    }

    async uploadFile(
        remotePath,
        file,
        onProgress,
        abortSignal,
        chunkSize = 242,
    ) {
        validateRemotePath(remotePath, "file");
        const openRes = await this.openFile(remotePath, "w");
        if (!openRes.ok) throw new Error(openRes.error);
        const fileId = openRes.data;
        try {
            if (file.size === 0) {
                onProgress(0, 0);
                return;
            }
            let offset = 0;
            while (offset < file.size) {
                if (abortSignal && abortSignal.aborted)
                    throw new Error("Upload aborted by user.");
                const end = Math.min(offset + chunkSize, file.size);
                const chunk = new Uint8Array(
                    await file.slice(offset, end).arrayBuffer(),
                );
                const res = await this.writeFileChunk(fileId, chunk);
                if (!res.ok) throw new Error(res.error);
                offset = end;
                onProgress(offset, file.size);
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
        this.queue = this.queue
            .catch((err) => {
                if (!this.txChar) return;
                throw err;
            })
            .then(run);
        return this.queue;
    }

    _performCommand(cmd, payload, cmdName) {
        if (!this.txChar) return Promise.reject(new Error("Not connected."));
        this._log(
            `→ ${cmdName}${payload.length > 0 ? ` (${payload.length}B)` : ""}`,
        );
        return new Promise((resolve, reject) => {
            this.pending = { resolve, reject, cmd };
            const frame = new Uint8Array(FRAME_HEADER_SIZE + payload.length);
            frame[0] = cmd;
            frame[1] = 0;
            frame[2] = 0;
            frame[3] = 0;
            frame.set(payload, FRAME_HEADER_SIZE);
            const write =
                typeof this.txChar.writeValueWithResponse === "function"
                    ? this.txChar.writeValueWithResponse(frame)
                    : this.txChar.writeValue(frame);
            write
                .then(() => {
                    if (!this.pending) return;
                    const pendingRef = this.pending;
                    this._pendingTimer = setTimeout(() => {
                        if (this.pending === pendingRef) {
                            this.pending = null;
                            this._pendingTimer = null;
                            // Reset the queue so subsequent commands are not poisoned by this
                            // rejection propagating through the chain. We intentionally do NOT
                            // call _resetTransport here — the GATT connection may still be live.
                            this.queue = Promise.resolve();
                            const err = new Error(
                                `Command timed out: ${cmdName}`,
                            );
                            console.error("[BLE]", err.message);
                            reject(err);
                        }
                    }, 15000);
                })
                .catch((err) => {
                    this.pending = null;
                    console.error(
                        "[BLE]",
                        `Write failed (${cmdName}):`,
                        err.message,
                    );
                    reject(err);
                });
        });
    }

    _onNotification(event) {
        if (!this.pending) return;
        try {
            const dv = event.target.value;
            const incoming = new Uint8Array(
                dv.buffer.slice(dv.byteOffset, dv.byteOffset + dv.byteLength),
            );
            const chunk = incoming[2] | (incoming[3] << 8);
            const hasMore = (chunk & 0x8000) !== 0;
            if (hasMore) {
                if (!this.chunking) {
                    this.rxParts = [incoming];
                    this.chunking = true;
                } else {
                    if (this.rxParts.length > 64) {
                        // Guard against runaway reassembly from duplicate/out-of-order packets.
                        this.chunking = false;
                        this.rxParts = [];
                        clearTimeout(this._pendingTimer);
                        this._pendingTimer = null;
                        if (this.pending) {
                            const err = new Error(
                                "RX overflow: too many chunks for a single response",
                            );
                            console.error("[BLE]", err.message);
                            // Reset the queue chain before rejecting, for the same reason
                            // as the timeout handler: without this, the rejection cascades
                            // through every subsequently queued command.
                            this.queue = Promise.resolve();
                            this.pending.reject(err);
                            this.pending = null;
                        }
                        return;
                    }
                    this.rxParts.push(incoming.slice(FRAME_HEADER_SIZE));
                }
                return;
            }
            let frame = incoming;
            if (this.chunking) {
                this.rxParts.push(incoming.slice(FRAME_HEADER_SIZE));
                frame = concatBytes(...this.rxParts);
                this.rxParts = [];
                this.chunking = false;
            }
            const response = {
                cmd: frame[0],
                status: frame[1],
                payload: frame.slice(FRAME_HEADER_SIZE),
            };
            const p = this.pending;
            clearTimeout(this._pendingTimer);
            this._pendingTimer = null;
            this.pending = null;
            const cmdName =
                CMD_NAMES[response.cmd] || `0x${response.cmd.toString(16)}`;
            if (response.status === 0) {
                this._log(
                    `← ${cmdName} OK${response.payload.length > 0 ? ` (${response.payload.length}B)` : ""}`,
                );
            } else {
                const errMsg = this._vfsError(response.status);
                this._log(`← ${cmdName} ERR: ${errMsg}`);
                console.error(
                    "[BLE]",
                    `${cmdName} returned error: ${errMsg} (status ${response.status})`,
                );
            }
            if (response.cmd !== p.cmd) {
                const err = new Error(
                    `Unexpected response 0x${response.cmd.toString(16)} for 0x${p.cmd.toString(16)}`,
                );
                console.error("[BLE]", err.message);
                p.reject(err);
                return;
            }
            p.resolve(response);
        } catch (err) {
            console.error("[BLE]", "Notification parse error:", err.message);
            clearTimeout(this._pendingTimer);
            this._pendingTimer = null;
            if (this.pending) {
                this.pending.reject(err);
                this.pending = null;
            }
            this.chunking = false;
            this.rxParts = [];
        }
    }
}

// === Dev Mock Client ===

export class DevMockClient {
    constructor() {
        this.device = { name: "Pixl.js (mock)" };
        this.onDisconnect = null;
        this.onReconnecting = null;
        this.onReconnect = null;
        this.createdFolders = new Set();
        this.folderCache = new Map();
        this.isDriveFormatted = false;
    }

    async connect() {}

    disconnect() {
        this.folderCache.clear();
        this.createdFolders.clear();
        this.onDisconnect?.();
    }

    async getVersion() {
        return {
            ok: true,
            data: { version: "2.14.0", bleAddress: "DE:V0:00:00:00:00" },
        };
    }

    async listDrives() {
        return {
            ok: true,
            data: [
                {
                    label: "E",
                    name: "E:",
                    totalBytes: 8 * 1024 * 1024,
                    freeBytes: this.isDriveFormatted
                        ? 8 * 1024 * 1024
                        : 6 * 1024 * 1024,
                },
            ],
        };
    }

    async readFolder(path) {
        if (this.isDriveFormatted) return { ok: true, data: [] };

        const fs = {
            "E:/": [
                { name: "amiibo", type: "DIR" },
                { name: "save", type: "DIR" },
                {
                    name: "README.txt",
                    type: "FILE",
                    size: 312,
                    meta: { nfcTagHead: null, nfcTagTail: null },
                },
            ],
            // loose files in amiibo root + the 3 system folders
            "E:/amiibo": [
                { name: "data", type: "DIR" },
                { name: "fav", type: "DIR" },
                { name: "large-set", type: "DIR" },
                {
                    name: "tag_001.bin",
                    type: "FILE",
                    size: 540,
                    meta: { nfcTagHead: 0x05c00000, nfcTagTail: 0x04121302 },
                }, // Samus (Metroid)
                {
                    name: "tag_002.bin",
                    type: "FILE",
                    size: 540,
                    meta: { nfcTagHead: 0x1f000000, nfcTagTail: 0x02540c02 },
                }, // Kirby
                {
                    name: "tag_003.bin",
                    type: "FILE",
                    size: 540,
                    meta: { nfcTagHead: 0x08000100, nfcTagTail: 0x04150402 },
                }, // Inkling (Splatoon)
                {
                    name: "tag_004.bin",
                    type: "FILE",
                    size: 540,
                    meta: { nfcTagHead: 0x19070000, nfcTagTail: 0x03840002 },
                }, // Squirtle
            ],
            // data: slot-named files required by AmiiDB (00.bin, 01.bin, …)
            "E:/amiibo/data": [
                {
                    name: "00.bin",
                    type: "FILE",
                    size: 540,
                    meta: { nfcTagHead: 0x00000000, nfcTagTail: 0x00000002 },
                }, // Mario (SSB)
                {
                    name: "01.bin",
                    type: "FILE",
                    size: 540,
                    meta: { nfcTagHead: 0x21070000, nfcTagTail: 0x03611202 },
                }, // Celica (Fire Emblem)
                {
                    name: "02.bin",
                    type: "FILE",
                    size: 540,
                    meta: { nfcTagHead: 0x01010300, nfcTagTail: 0x04140902 },
                }, // Zelda & Loftwing
            ],
            // fav: favorites managed by AmiiDB
            "E:/amiibo/fav": [
                {
                    name: "tag_001.bin",
                    type: "FILE",
                    size: 540,
                    meta: { nfcTagHead: 0x00c00000, nfcTagTail: 0x037b0002 },
                }, // King K. Rool
                {
                    name: "tag_002.bin",
                    type: "FILE",
                    size: 540,
                    meta: { nfcTagHead: 0x22420000, nfcTagTail: 0x041f0002 },
                }, // Mythra (Xenoblade)
                {
                    name: "tag_003.bin",
                    type: "FILE",
                    size: 540,
                    meta: { nfcTagHead: 0x08070000, nfcTagTail: 0x04330402 },
                }, // Shiver (Splatoon)
            ],
            // large-set: 95 files for scroll/bulk-operation testing
            "E:/amiibo/large-set": [
                ...Array.from({ length: 95 }, (_, i) => ({
                    name: `tag_${String(i + 1).padStart(3, "0")}.bin`,
                    type: "FILE",
                    size: 540,
                    meta: {
                        nfcTagHead: 0x01000000 + i,
                        nfcTagTail: 0x03530902,
                    },
                })),
            ],
            "E:/save": [
                {
                    name: "backup.bin",
                    type: "FILE",
                    size: 1229,
                    meta: { nfcTagHead: null, nfcTagTail: null },
                },
            ],
        };
        return { ok: true, data: sortEntries(fs[path] ?? []) };
    }

    async enterDfu() {
        return { ok: true, error: null };
    }

    // Mutations always succeed but are not reflected in readFolder (static mock).
    async createFolder() {
        return { ok: true, data: null };
    }
    async removePath(path) {
        if (path && path.toLowerCase().endsWith("readme.txt")) {
            return { ok: false, error: "Permission denied (mock)" };
        }
        return { ok: true, data: null };
    }
    async renamePath() {
        return { ok: true, data: null };
    }
    async formatDrive() {
        this.isDriveFormatted = true;
        this.createdFolders.clear();
        return { ok: true, data: null };
    }
    async openFile() {
        return { ok: true, data: 0 };
    }
    async writeFileChunk() {
        return { ok: true, data: null };
    }
    async closeFile() {
        return { ok: true, data: null };
    }
    async readFileData(path) {
        const mockFiles = {
            "E:/README.txt": { size: 312, nfcTagHead: null, nfcTagTail: null },
            // loose files in amiibo root (all distinct heads, all API-validated)
            "E:/amiibo/tag_001.bin": {
                size: 540,
                nfcTagHead: 0x05c00000,
                nfcTagTail: 0x04121302,
            }, // Samus - Metroid Dread
            "E:/amiibo/tag_002.bin": {
                size: 540,
                nfcTagHead: 0x1f000000,
                nfcTagTail: 0x02540c02,
            }, // Kirby
            "E:/amiibo/tag_003.bin": {
                size: 540,
                nfcTagHead: 0x08000100,
                nfcTagTail: 0x04150402,
            }, // Inkling - Yellow (Splatoon)
            "E:/amiibo/tag_004.bin": {
                size: 540,
                nfcTagHead: 0x19070000,
                nfcTagTail: 0x03840002,
            }, // Squirtle
            // data: slot-named, distinct characters
            "E:/amiibo/data/00.bin": {
                size: 540,
                nfcTagHead: 0x00000000,
                nfcTagTail: 0x00000002,
            }, // Mario (SSB)
            "E:/amiibo/data/01.bin": {
                size: 540,
                nfcTagHead: 0x21070000,
                nfcTagTail: 0x03611202,
            }, // Celica (Fire Emblem)
            "E:/amiibo/data/02.bin": {
                size: 540,
                nfcTagHead: 0x01010300,
                nfcTagTail: 0x04140902,
            }, // Zelda & Loftwing
            // fav: favorites managed by AmiiDB
            "E:/amiibo/fav/tag_001.bin": {
                size: 540,
                nfcTagHead: 0x00c00000,
                nfcTagTail: 0x037b0002,
            }, // King K. Rool
            "E:/amiibo/fav/tag_002.bin": {
                size: 540,
                nfcTagHead: 0x22420000,
                nfcTagTail: 0x041f0002,
            }, // Mythra (Xenoblade)
            "E:/amiibo/fav/tag_003.bin": {
                size: 540,
                nfcTagHead: 0x08070000,
                nfcTagTail: 0x04330402,
            }, // Shiver (Splatoon)
            "E:/save/backup.bin": {
                size: 1229,
                nfcTagHead: null,
                nfcTagTail: null,
            },
        };
        // Generate mock entries for large-set files
        const largeMatch = path.match(
            /^E:\/amiibo\/large-set\/tag_(\d+)\.bin$/,
        );
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
    async ensureFolder() {}

    waitForMockUploadDelay(ms, abortSignal) {
        return new Promise((resolve, reject) => {
            if (abortSignal?.aborted) {
                reject(new Error("Upload aborted by user."));
                return;
            }
            const timer = setTimeout(resolve, ms);
            abortSignal?.addEventListener(
                "abort",
                () => {
                    clearTimeout(timer);
                    reject(new Error("Upload aborted by user."));
                },
                { once: true },
            );
        });
    }

    async uploadFile(path, file, onProgress, abortSignal) {
        const totalBytes = file.size || 0;
        if (totalBytes === 0) {
            onProgress(0, 0);
            return;
        }

        const simulatedDurationMs = Math.max(
            DEV_MOCK_UPLOAD_MIN_DURATION_MS,
            Math.min(
                DEV_MOCK_UPLOAD_MAX_DURATION_MS,
                Math.round(
                    (totalBytes / DEV_MOCK_UPLOAD_BYTES_PER_SECOND) * 1000,
                ),
            ),
        );
        const progressUpdates = Math.max(
            2,
            Math.min(
                DEV_MOCK_UPLOAD_MAX_PROGRESS_UPDATES,
                Math.ceil(simulatedDurationMs / 140),
            ),
        );
        const updateIntervalMs = Math.max(
            70,
            Math.round(simulatedDurationMs / progressUpdates),
        );

        if (abortSignal?.aborted) throw new Error("Upload aborted by user.");
        for (let step = 1; step <= progressUpdates; step++) {
            await this.waitForMockUploadDelay(updateIntervalMs, abortSignal);
            const written =
                step === progressUpdates
                    ? totalBytes
                    : Math.max(
                          1,
                          Math.round(totalBytes * (step / progressUpdates)),
                      );
            onProgress(written, totalBytes);
        }
    }
}
