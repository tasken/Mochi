/*
 * Nordic Secure DFU — Web Bluetooth
 * Based on thegecko/web-bluetooth-dfu, rewritten for modern browsers.
 * MIT License — Copyright (c) 2018 Rob Moran, 2026 Augusto Daniele
 */
(function () {
"use strict";

// ── CRC32 ─────────────────────────────────────────────────────────

const CRC32_TABLE = new Int32Array(256);
for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    CRC32_TABLE[n] = c;
}

function crc32(buf) {
    let crc = -1;
    for (let i = 0; i < buf.length; i++) crc = CRC32_TABLE[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
    return crc ^ -1;
}

// ── Protocol constants ────────────────────────────────────────────

const CONTROL_UUID  = "8ec90001-f315-4f60-9fb8-838830daea50";
const PACKET_UUID   = "8ec90002-f315-4f60-9fb8-838830daea50";
const BUTTON_UUID   = "8ec90003-f315-4f60-9fb8-838830daea50";
const BUTTON_BOND   = "8ec90004-f315-4f60-9fb8-838830daea50";

const OP_CREATE   = 0x01;
const OP_SET_PRN  = 0x02;
const OP_CHECKSUM = 0x03;
const OP_EXECUTE  = 0x04;
const OP_SELECT   = 0x06;
const OP_RESPONSE = 0x60;

const OBJ_COMMAND = 0x01;
const OBJ_DATA    = 0x02;

const LE = true;
const MAX_PACKET  = 244;
const DEFAULT_PRN = 12;

const RESULT_OK       = 0x01;
const RESULT_EXTENDED = 0x0B;

const RESPONSE_MSG = {
    0x00: "Invalid opcode",
    0x02: "Opcode not supported",
    0x03: "Missing or invalid parameter value",
    0x04: "Not enough memory for the data object",
    0x05: "Data object does not match firmware/hardware requirements or signature is wrong",
    0x07: "Not a valid object type for a Create request",
    0x08: "The DFU state does not allow this operation",
    0x0A: "Operation failed",
    0x0B: "Extended error",
};

const EXTENDED_MSG = {
    0x00: "No extended error code has been set",
    0x01: "Invalid error code",
    0x02: "Wrong command format",
    0x03: "Command not supported or unknown",
    0x04: "Invalid init command",
    0x05: "Firmware version too low",
    0x06: "Hardware version mismatch",
    0x07: "SoftDevice version mismatch",
    0x08: "Signature missing",
    0x09: "Hash type not supported",
    0x0A: "Hash calculation failed",
    0x0B: "Signature type unknown",
    0x0C: "Firmware hash mismatch",
    0x0D: "Insufficient space",
};

// ── SecureDfu ─────────────────────────────────────────────────────

class SecureDfu {

    static SERVICE_UUID    = 0xFE59;
    static EVENT_LOG       = "log";
    static EVENT_PROGRESS  = "progress";

    #listeners      = new Map();
    #waiters        = new Map();
    #waiterTimers   = new Map();
    #prnWaiter      = null;
    #prnTimer       = null;
    #packetsSent    = 0;
    #controlChar    = null;
    #packetChar     = null;
    #progressFn     = null;
    #onNotification;
    #onDisconnect;

    constructor(crc32Fn, bluetooth, delay = 0, prn = DEFAULT_PRN, options = {}) {
        if (prn && typeof prn === "object") {
            options = prn;
            prn = typeof options.receiptNotificationPackets === "number"
                ? options.receiptNotificationPackets : DEFAULT_PRN;
        }

        this.crc32Fn            = typeof crc32Fn === "function" ? crc32Fn : crc32;
        this.bluetooth          = bluetooth || navigator?.bluetooth || null;
        this.delay              = delay;
        this.prn                = typeof prn === "number" ? prn : DEFAULT_PRN;
        this.maxAttempts        = Math.max(1, Math.floor(options.maxDfuAttempts ?? 1));
        this.reconnectDelay     = Math.max(0, options.reconnectDelayMs ?? 750);
        this.notificationTimeout = Math.max(1000, options.notificationTimeoutMs ?? 15000);
        this.operationTimeout   = Math.max(1000, options.operationTimeoutMs ?? 20000);
        this.objectDelay        = Math.max(0, options.dataObjectDelayMs ?? 0);
        this.rebootTime         = Math.max(0, options.rebootTimeMs ?? 3000);

        const reqSize = options.packetSize ?? options.dataPacketSize ?? 20;
        this.packetSize = Math.max(1, Math.min(MAX_PACKET, Math.floor(reqSize)));

        this.#onNotification = this.#handleNotification.bind(this);
        this.#onDisconnect = () => {
            const err = new Error("Device disconnected");
            for (const [op] of this.#waiters) this.#clearWaiter(op, err);
            this.#clearPRN(err);
            this.#controlChar = null;
            this.#packetChar = null;
        };
    }

    // ── Events ────────────────────────────────────────────────────

    addEventListener(type, fn) {
        if (!this.#listeners.has(type)) this.#listeners.set(type, new Set());
        this.#listeners.get(type).add(fn);
    }

    removeEventListener(type, fn) {
        this.#listeners.get(type)?.delete(fn);
    }

    #emit(type, data) {
        for (const fn of this.#listeners.get(type) || []) fn(data);
    }

    #log(msg) {
        this.#emit(SecureDfu.EVENT_LOG, { message: msg });
    }

    // ── Public API ────────────────────────────────────────────────

    async requestDevice(buttonLess, filters, uuids) {
        uuids = this.#mergeUuids(uuids);
        if (!this.bluetooth?.requestDevice) throw new Error("Web Bluetooth is not available");
        if (!buttonLess && !filters) filters = [{ services: [uuids.service] }];

        const opts = { optionalServices: [uuids.service] };
        if (filters) opts.filters = filters;
        else opts.acceptAllDevices = true;

        const device = await this.bluetooth.requestDevice(opts);
        return buttonLess ? this.setDfuMode(device, uuids) : device;
    }

    async setDfuMode(device, uuids) {
        uuids = this.#mergeUuids(uuids);
        const chars = await this.#gattConnect(device, uuids.service);
        this.#log(`found ${chars.length} characteristic(s)`);

        if (chars.find(c => c.uuid === uuids.control) && chars.find(c => c.uuid === uuids.packet)) {
            return device;
        }

        const btnUuids = [uuids.button, uuids.buttonBond].filter(Boolean).map(u => u.toLowerCase());
        const btn = chars.find(c => btnUuids.includes((c.uuid || "").toLowerCase()));
        if (!btn) throw new Error("Unsupported device");
        this.#log("found buttonless characteristic");

        if (!btn.properties.notify && !btn.properties.indicate) {
            throw new Error("Buttonless characteristic does not allow notifications");
        }

        return new Promise(resolve => {
            let done = false;
            const finish = () => {
                if (done) return;
                done = true;
                btn.removeEventListener("characteristicvaluechanged", this.#onNotification);
                this.#waiters.clear();
                resolve(null);
            };
            btn.startNotifications().then(() => {
                this.#log("enabled buttonless notifications");
                device.addEventListener("gattserverdisconnected", finish, { once: true });
                btn.addEventListener("characteristicvaluechanged", this.#onNotification);
                return this.#sendOperation(btn, [OP_CREATE], null);
            }).then(() => {
                this.#log("sent DFU mode");
                return this.#sleep(this.rebootTime);
            }).then(finish);
        });
    }

    async update(device, init, firmware) {
        if (!device)   throw new Error("Device not specified");
        if (!init)     throw new Error("Init not specified");
        if (!firmware) throw new Error("Firmware not specified");

        const baseMax = Math.max(1, this.maxAttempts);
        const maxAttempts = this.delay === 0 ? Math.max(2, baseMax) : baseMax;
        let attempt = 0;

        const run = async () => {
            attempt++;
            this.#log(`DFU attempt ${attempt}/${maxAttempts}`);

            await this.#connect(device);

            this.#log("transferring init");
            await this.#transferInit(init);

            this.#log("transferring firmware");
            await this.#transferFirmware(firmware);

            this.#log("complete, disconnecting...");
            await new Promise(resolve => {
                const onDc = () => { this.#log("disconnected"); resolve(); };
                device.addEventListener("gattserverdisconnected", onDc, { once: true });
                if (device.gatt?.connected) {
                    try { device.gatt.disconnect(); } catch { resolve(); }
                } else {
                    resolve();
                }
            });
            return device;
        };

        const savedDelay = this.delay;
        while (true) {
            try {
                const result = await run();
                this.delay = savedDelay;
                return result;
            } catch (err) {
                const e = this.#asError(err);
                if (attempt < maxAttempts && this.#isRetryable(e)) {
                    console.warn("[DFU]", `Attempt ${attempt} failed (${e.message}), retrying...`);
                    this.#log(`Retrying after disconnect (attempt ${attempt + 1}/${maxAttempts})...`);
                    await this.#sleep(this.reconnectDelay);
                    continue;
                }
                console.error("[DFU]", `Transfer failed after ${attempt} attempt(s):`, e.message);
                this.delay = savedDelay;
                throw e;
            }
        }
    }

    // ── Connection ────────────────────────────────────────────────

    async #connect(device) {
        if (!device?.gatt) throw new Error("Device not specified");

        for (const [op] of this.#waiters) this.#clearWaiter(op, new Error("Starting new DFU session"));
        this.#clearPRN();

        device.removeEventListener("gattserverdisconnected", this.#onDisconnect);
        device.addEventListener("gattserverdisconnected", this.#onDisconnect);

        const chars = await this.#gattConnect(device);
        this.#log(`found ${chars.length} characteristic(s)`);

        this.#packetChar = chars.find(c => c.uuid === PACKET_UUID);
        if (!this.#packetChar) throw new Error("Unable to find packet characteristic");
        this.#log("found packet characteristic");

        this.#controlChar = chars.find(c => c.uuid === CONTROL_UUID);
        if (!this.#controlChar) throw new Error("Unable to find control characteristic");
        this.#log("found control characteristic");

        if (!this.#controlChar.properties.notify && !this.#controlChar.properties.indicate) {
            throw new Error("Control characteristic does not allow notifications");
        }

        await this.#controlChar.startNotifications();
        this.#controlChar.removeEventListener("characteristicvaluechanged", this.#onNotification);
        this.#controlChar.addEventListener("characteristicvaluechanged", this.#onNotification);
        this.#log("enabled control notifications");
        return device;
    }

    async #gattConnect(device, serviceUUID = SecureDfu.SERVICE_UUID) {
        if (!device?.gatt) throw new Error("Device GATT is unavailable");
        const server = device.gatt.connected ? device.gatt : await device.gatt.connect();
        this.#log("connected to gatt server");
        let service;
        try { service = await server.getPrimaryService(serviceUUID); }
        catch { throw new Error("Unable to find DFU service"); }
        this.#log("found DFU service");
        return service.getCharacteristics();
    }

    // ── Transfer ──────────────────────────────────────────────────

    async #transferInit(buffer) {
        const savedPrn = this.prn;
        this.prn = 0;
        this.#packetsSent = 0;
        try {
            await this.#transfer(buffer, "init", OBJ_COMMAND);
        } finally {
            this.prn = savedPrn;
            this.#packetsSent = 0;
        }
    }

    async #transferFirmware(buffer) {
        this.#packetsSent = 0;
        if (this.prn > 0) await this.#setPRN(this.prn);
        await this.#transfer(buffer, "firmware", OBJ_DATA);
    }

    async #transfer(buffer, type, objType) {
        const resp = await this.#sendControl([OP_SELECT, objType]);
        const maxSize = resp.getUint32(0, LE);
        const offset  = resp.getUint32(4, LE);
        const crc     = resp.getInt32(8, LE);
        this.#log(`${type}: maxObjSize=${maxSize}, resumeOffset=${offset}, totalSize=${buffer.byteLength}`);

        this.#progressFn = bytes => this.#emit(SecureDfu.EVENT_PROGRESS, {
            object: type,
            totalBytes: buffer.byteLength,
            currentBytes: bytes,
        });

        if (offset === buffer.byteLength && this.#checkCrc(buffer, crc)) {
            this.#log(`${type} already available, skipping transfer`);
            this.#progressFn(buffer.byteLength);
            return;
        }

        this.#progressFn(0);
        await this.#transferObjects(buffer, [OP_CREATE, objType], maxSize, offset);
    }

    async #transferObjects(buffer, createOp, maxSize, offset) {
        if (maxSize <= 0) throw new Error("DFU target returned invalid object size");

        while (offset < buffer.byteLength) {
            const start = offset - (offset % maxSize);
            const end   = Math.min(start + maxSize, buffer.byteLength);

            const sizeBuf = new DataView(new ArrayBuffer(4));
            sizeBuf.setUint32(0, end - start, LE);
            await this.#sendControl(createOp, sizeBuf.buffer);

            if (createOp[1] === OBJ_DATA && this.objectDelay > 0) {
                await this.#sleep(this.objectDelay);
            }

            this.#packetsSent = 0;
            await this.#writePackets(buffer.slice(start, end), start);

            const ck = await this.#sendControl([OP_CHECKSUM]);
            const transferred = ck.getUint32(0, LE);
            const ckCrc       = ck.getInt32(4, LE);

            if (transferred > buffer.byteLength) {
                const err = `Invalid transferred offset ${transferred} (total ${buffer.byteLength})`;
                console.error("[DFU]", err);
                throw new Error(err);
            }

            if (this.#checkCrc(buffer.slice(0, transferred), ckCrc)) {
                const lost = end - transferred;
                if (lost > 0) {
                    console.warn("[DFU]", `${lost} bytes lost, retrying from offset ${transferred}`);
                    this.#log(`${lost} bytes lost, retrying from offset ${transferred}`);
                    offset = transferred;
                    continue;
                }
                this.#log(`written ${transferred} bytes`);
                offset = transferred;
                await this.#sendControl([OP_EXECUTE]);
            } else {
                const err = `Object checksum mismatch at offset ${transferred}`;
                console.error("[DFU]", err);
                throw new Error(err);
            }
        }
        this.#log("transfer complete");
    }

    async #writePackets(data, baseOffset) {
        let pos = 0;
        while (pos < data.byteLength) {
            const end = Math.min(pos + this.packetSize, data.byteLength);
            await this.#writePacket(data.slice(pos, end));

            if (this.prn > 0) {
                this.#packetsSent++;
                if (this.#packetsSent >= this.prn) {
                    await this.#waitForPRN();
                }
            }

            if (this.delay > 0) await this.#sleep(this.delay);
            this.#progressFn?.(baseOffset + end);
            pos = end;
        }
    }

    async #writePacket(packet) {
        const ch = this.#packetChar;
        if (!ch) throw new Error("Packet characteristic not ready");
        if (ch.properties?.writeWithoutResponse && ch.writeValueWithoutResponse) {
            return ch.writeValueWithoutResponse(packet);
        }
        return ch.writeValueWithResponse ? ch.writeValueWithResponse(packet) : ch.writeValue(packet);
    }

    // ── PRN (Packet Receipt Notification) ─────────────────────────

    async #setPRN(count) {
        const buf = new ArrayBuffer(2);
        new DataView(buf).setUint16(0, count, LE);
        this.#log(`Setting PRN to ${count}`);
        await this.#sendControl([OP_SET_PRN], buf);
    }

    #waitForPRN() {
        return new Promise((resolve, reject) => {
            this.#prnWaiter = { resolve, reject };
            this.#prnTimer = setTimeout(() => {
                this.#prnTimer = null;
                if (!this.#prnWaiter) return;
                this.#prnWaiter = null;
                const err = new Error(`PRN timeout (${Math.floor(this.notificationTimeout / 1000)}s)`);
                console.error("[DFU]", err.message);
                reject(err);
            }, this.notificationTimeout);
        });
    }

    #clearPRN(err = null) {
        if (this.#prnTimer) { clearTimeout(this.#prnTimer); this.#prnTimer = null; }
        const w = this.#prnWaiter;
        this.#prnWaiter = null;
        if (w && err) w.reject(this.#asError(err));
    }

    // ── Notifications ─────────────────────────────────────────────

    #handleNotification(event) {
        const view = event.target.value;
        const code = view.getUint8(0);
        const op   = view.getUint8(1);

        // PRN: bootloader sends [0x60, 0x03 (CHECKSUM), 0x01, offset(4), crc(4)]
        if (code === OP_RESPONSE && op === OP_CHECKSUM && this.#prnWaiter) {
            const result = view.getUint8(2);
            if (result === RESULT_OK) {
                const prnOffset = view.getUint32(3, LE);
                const prnCrc = view.getInt32(7, LE);
                this.#log(`PRN: offset=${prnOffset}, CRC=0x${(prnCrc >>> 0).toString(16)}`);
                const w = this.#prnWaiter;
                this.#clearPRN();
                this.#packetsSent = 0;
                w.resolve();
                return;
            }
        }

        if (code !== OP_RESPONSE) {
            const err = new Error("Unrecognised control characteristic response");
            console.error("[DFU]", err.message, { code, op });
            this.#log(err.message);
            for (const [key] of this.#waiters) this.#clearWaiter(key, err);
            this.#clearPRN(err);
            return;
        }

        const waiter = this.#waiters.get(op);
        if (!waiter) return;

        const result = view.getUint8(2);
        if (result === RESULT_OK) {
            const data = new DataView(view.buffer, view.byteOffset + 3);
            waiter.resolve(data);
            this.#clearWaiter(op);
        } else {
            const msg = result === RESULT_EXTENDED
                ? `Error: ${EXTENDED_MSG[view.getUint8(3)] || `Extended error ${view.getUint8(3)}`}`
                : `Error: ${RESPONSE_MSG[result] || `Status ${result}`}`;
            console.error("[DFU]", `Bootloader error for op 0x${op.toString(16)}: ${msg}`);
            this.#log(`notify: ${msg}`);
            this.#clearWaiter(op, new Error(msg));
        }
    }

    // ── Control point ─────────────────────────────────────────────

    async #sendControl(operation, buffer) {
        if (!this.#controlChar) throw new Error("Control characteristic not ready");
        const resp = await this.#sendOperation(this.#controlChar, operation, buffer);
        if (this.delay > 0) await this.#sleep(this.delay);
        return resp;
    }

    #sendOperation(char, operation, buffer) {
        return new Promise((resolve, reject) => {
            if (!char) return reject(new Error("DFU characteristic not ready"));

            const opBytes = Array.isArray(operation) ? operation : [operation];
            const bufData = buffer ? new Uint8Array(buffer) : null;
            const value = new Uint8Array(opBytes.length + (bufData ? bufData.length : 0));
            value.set(opBytes);
            if (bufData) value.set(bufData, opBytes.length);

            const opKey = opBytes[0];
            this.#clearWaiter(opKey, new Error(`Operation 0x${opKey.toString(16)} replaced`));

            this.#waiters.set(opKey, { resolve, reject });
            this.#waiterTimers.set(opKey, setTimeout(() => {
                console.error("[DFU]", `Operation 0x${opKey.toString(16)} timed out (${this.operationTimeout}ms)`);
                this.#clearWaiter(opKey, new Error(`Operation 0x${opKey.toString(16)} timed out`));
            }, this.operationTimeout));

            const write = char.writeValueWithResponse
                ? char.writeValueWithResponse(value)
                : char.writeValue(value);

            write.catch(async (e) => {
                console.warn("[DFU]", `Write failed for op 0x${opKey.toString(16)}, retrying:`, this.#asError(e).message);
                this.#log(this.#asError(e).message);
                await this.#sleep(500);
                try {
                    await (char.writeValueWithResponse
                        ? char.writeValueWithResponse(value)
                        : char.writeValue(value));
                } catch (retryErr) {
                    console.error("[DFU]", `Write retry failed for op 0x${opKey.toString(16)}:`, this.#asError(retryErr).message);
                    this.#clearWaiter(opKey, this.#asError(retryErr));
                }
            });
        });
    }

    #clearWaiter(op, err = null) {
        const t = this.#waiterTimers.get(op);
        if (t) { clearTimeout(t); this.#waiterTimers.delete(op); }
        const w = this.#waiters.get(op);
        this.#waiters.delete(op);
        if (w && err) w.reject(this.#asError(err));
    }

    // ── Helpers ───────────────────────────────────────────────────

    #mergeUuids(uuids) {
        return {
            service: SecureDfu.SERVICE_UUID,
            control: CONTROL_UUID,
            packet: PACKET_UUID,
            button: BUTTON_UUID,
            buttonBond: BUTTON_BOND,
            ...uuids,
        };
    }

    #checkCrc(buffer, expected) {
        return expected === this.crc32Fn(new Uint8Array(buffer));
    }

    #isRetryable(err) {
        const m = (err?.message || "").toLowerCase();
        return m.includes("disconnected") || m.includes("connection")
            || m.includes("gatt") || m.includes("networkerror");
    }

    #asError(e) {
        if (e instanceof Error) return e;
        if (typeof e === "string") return new Error(e);
        if (e?.message) return new Error(e.message);
        return new Error("Unknown DFU error");
    }

    #sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
}

window.SecureDfu = SecureDfu;
})();
