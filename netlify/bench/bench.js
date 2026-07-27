import { PixlToolsClient } from "./client.js";

const el = {
    btnConnect: document.getElementById("btnConnect"),
    btnDisconnect: document.getElementById("btnDisconnect"),
    connState: document.getElementById("connState"),
    regularFileSize: document.getElementById("regularFileSize"),
    regularFilesCount: document.getElementById("regularFilesCount"),
    regularFilesPerFolder: document.getElementById("regularFilesPerFolder"),
    regularChunks: document.getElementById("regularChunks"),
    regularRepeats: document.getElementById("regularRepeats"),
    btnRunRegular: document.getElementById("btnRunRegular"),
    btnStopRegular: document.getElementById("btnStopRegular"),
    regularSummary: document.getElementById("regularSummary"),
    regularTable: document.getElementById("regularTable"),
    regularTableBody: document.querySelector("#regularTable tbody"),

    expTotalBytes: document.getElementById("expTotalBytes"),
    expChunkSize: document.getElementById("expChunkSize"),
    expPipelineDepth: document.getElementById("expPipelineDepth"),
    expFileSize: document.getElementById("expFileSize"),
    expFileCount: document.getElementById("expFileCount"),
    btnRunBatch: document.getElementById("btnRunBatch"),
    btnRunPipeline: document.getElementById("btnRunPipeline"),
    btnRunMultiPipe: document.getElementById("btnRunMultiPipe"),
    btnStopExp: document.getElementById("btnStopExp"),
    expSummary: document.getElementById("expSummary"),
    expTable: document.getElementById("expTable"),
    expTableBody: document.querySelector("#expTable tbody"),

    dfuFile: document.getElementById("dfuFile"),
    dfuPacketSize: document.getElementById("dfuPacketSize"),
    dfuDelay: document.getElementById("dfuDelay"),
    dfuPrn: document.getElementById("dfuPrn"),
    dfuObjectDelay: document.getElementById("dfuObjectDelay"),
    dfuAlreadyInMode: document.getElementById("dfuAlreadyInMode"),
    btnRunDfu: document.getElementById("btnRunDfu"),
    btnStopDfu: document.getElementById("btnStopDfu"),
    btnClearDfu: document.getElementById("btnClearDfu"),
    dfuLiveStats: document.getElementById("dfuLiveStats"),
    dfuSummary: document.getElementById("dfuSummary"),
    dfuTable: document.getElementById("dfuTable"),
    dfuTableBody: document.querySelector("#dfuTable tbody"),

    log: document.getElementById("log"),
};

const state = {
    client: null,
    connected: false,
    runningRegular: false,
    runningDfu: false,
    runningExp: false,
    regularAbortController: null,
    dfuAbortController: null,
    expAbortController: null,
    lastDfuDeviceId: "",
    dfuDevice: null,
    dfuRows: [],
};

const DFU_FIXED_OPTIONS = Object.freeze({
    maxDfuAttempts: 2,
    reconnectDelayMs: 1000,
    notificationTimeoutMs: 20000,
    operationTimeoutMs: 20000,
    rebootTimeMs: 3000,
});

// ── Helpers ───────────────────────────────────────────────────────

function getDfuParams() {
    const packetSize = Number.parseInt(el.dfuPacketSize.value, 10) || 20;
    const delayMs = Math.max(0, Number.parseInt(el.dfuDelay.value, 10) || 0);
    const prn = (() => {
        const v = Number.parseInt(el.dfuPrn.value, 10);
        return Number.isFinite(v) ? v : 12;
    })();
    const objectDelayMs = Math.max(
        0,
        Number.parseInt(el.dfuObjectDelay.value, 10) || 0,
    );
    return { packetSize, delayMs, prn, objectDelayMs };
}

function createSecureDfu({ packetSize, delayMs, prn, objectDelayMs }) {
    return new window.SecureDfu(null, undefined, delayMs, prn, {
        ...DFU_FIXED_OPTIONS,
        packetSize,
        dataObjectDelayMs: objectDelayMs,
    });
}

function log(message, cls = "") {
    const line = document.createElement("div");
    if (cls) line.className = cls;
    line.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
    el.log.appendChild(line);
    setTimeout(() => line.scrollIntoView(false), 0);
}

function setConnectionState(connected, label = "") {
    state.connected = connected;
    el.connState.textContent = connected
        ? `connected${label ? `: ${label}` : ""}`
        : "disconnected";
    setButtons();
}

function parseNumberList(raw, kind, min = 1) {
    const values = raw
        .split(",")
        .map((s) => Number.parseInt(s.trim(), 10))
        .filter((n) => Number.isFinite(n));
    if (!values.length) throw new Error(`Provide at least one ${kind} value.`);
    if (values.some((v) => v < min))
        throw new Error(`${kind} values must be >= ${min}.`);
    return [...new Set(values)];
}

function bytesToKbPerSec(bytes, seconds) {
    if (seconds <= 0) return 0;
    return bytes / 1024 / seconds;
}

function sleep(ms) {
    return new Promise((resolve) => {
        const start = performance.now();
        const check = () => {
            if (performance.now() - start >= ms) resolve();
            else if (typeof requestIdleCallback !== "undefined")
                requestIdleCallback(check, { timeout: 100 });
            else
                setTimeout(
                    check,
                    Math.min(100, ms - (performance.now() - start)),
                );
        };
        check();
    });
}

function setDfuLiveStats(text) {
    el.dfuLiveStats.textContent = text;
}

function setButtons() {
    const busy = state.runningRegular || state.runningDfu || state.runningExp;
    const hasDfuFile = !!el.dfuFile.files?.length;
    el.btnConnect.disabled = busy;
    el.btnDisconnect.disabled = busy;
    el.btnRunRegular.disabled = busy;
    el.btnStopRegular.disabled = !state.runningRegular;
    el.btnRunDfu.disabled = busy || !hasDfuFile;
    el.btnStopDfu.disabled = !state.runningDfu;
    el.btnRunBatch.disabled = busy;
    el.btnRunPipeline.disabled = busy;
    el.btnRunMultiPipe.disabled = busy;
    el.btnStopExp.disabled = !state.runningExp;
}

// ── Connection ────────────────────────────────────────────────────

// Polls while client.js's own backoff reconnect (_attemptReconnect, started
// from onReconnecting) is in flight, instead of racing it with a second
// gatt.connect() call — concurrent connect() calls on the same device throw
// "GATT operation already in progress".
function waitWhileReconnecting(timeoutMs = 16000) {
    return new Promise((resolve) => {
        const start = performance.now();
        const check = () => {
            if (!state.client?._reconnecting) return resolve(state.connected);
            if (performance.now() - start > timeoutMs) return resolve(false);
            setTimeout(check, 250);
        };
        check();
    });
}

async function ensureRegularClientConnected() {
    if (state.client && state.connected) return state.client;
    if (!state.client) {
        state.client = new PixlToolsClient((msg) => log(`[regular] ${msg}`));
        state.client.onDisconnect = () => setConnectionState(false);
        state.client.onReconnecting = () => {
            setConnectionState(false);
            log("[regular] Connection lost, reconnecting...", "warn");
        };
        state.client.onReconnect = () => {
            setConnectionState(true, state.client.device?.name || "");
            log("[regular] GATT reconnected (no picker needed).", "ok");
        };
    }
    if (state.client.device) {
        if (state.client._reconnecting) {
            const recovered = await waitWhileReconnecting();
            if (recovered) return state.client;
            throw new Error(
                "Automatic reconnect failed. Click Connect to re-select the device.",
            );
        }
        // A known device exists — reconnect via gatt.connect(), never via
        // requestDevice(). requestDevice() needs a live user gesture, which
        // callers deep inside an automated sweep don't have; let the caller
        // decide how to handle the failure instead of silently opening a
        // picker that Chrome will reject with a SecurityError.
        await state.client._setupGatt(state.client.device);
        setConnectionState(true, state.client.device.name || "");
        return state.client;
    }
    await state.client.connect();
    setConnectionState(true, state.client.device?.name || "");
    return state.client;
}

async function getGrantedDfuDevice() {
    if (!navigator.bluetooth?.getDevices) return null;
    const devices = await navigator.bluetooth.getDevices();
    if (!devices.length) return null;
    if (state.lastDfuDeviceId) {
        const known = devices.find(
            (device) => device.id === state.lastDfuDeviceId,
        );
        if (known) return known;
    }
    const named = devices.find((device) => /dfu/i.test(device.name || ""));
    if (named) return named;
    return devices.length === 1 ? devices[0] : null;
}

// ── Path helpers ──────────────────────────────────────────────────

function joinRemote(base, name) {
    return base.endsWith("/") ? `${base}${name}` : `${base}/${name}`;
}

function parentRemote(path) {
    const i = path.lastIndexOf("/");
    return i <= 2 ? `${path.slice(0, 3)}` : path.slice(0, i);
}

function baseRemote(path) {
    const i = path.lastIndexOf("/");
    return i === -1 ? path : path.slice(i + 1);
}

function isNotFoundError(message) {
    return String(message || "")
        .toLowerCase()
        .includes("not found");
}

function isAlreadyExistsError(message) {
    return String(message || "")
        .toLowerCase()
        .includes("already exists");
}

function isCommandFailedError(message) {
    return String(message || "")
        .toLowerCase()
        .includes("command failed");
}

// ── Filesystem helpers ────────────────────────────────────────────

async function getRemoteEntryType(client, path) {
    const parent = parentRemote(path);
    const base = baseRemote(path);
    const listRes = await client.readFolder(parent);
    if (!listRes.ok) {
        if (isNotFoundError(listRes.error)) return null;
        throw new Error(`Read folder failed (${parent}): ${listRes.error}`);
    }
    const entry = listRes.data.find((e) => e.name === base);
    return entry ? entry.type : null;
}

async function ensureFolderPath(client, path) {
    const type = await getRemoteEntryType(client, path);
    if (type === "DIR") return;
    if (type === "FILE") {
        const rmRes = await client.removePath(path);
        if (!rmRes.ok && !isNotFoundError(rmRes.error))
            throw new Error(
                `Remove conflicting file failed (${path}): ${rmRes.error}`,
            );
    }
    const res = await client.createFolder(path);
    if (!res.ok && !isAlreadyExistsError(res.error))
        throw new Error(`Create folder failed (${path}): ${res.error}`);
}

async function removePathTree(client, path) {
    const listRes = await client.readFolder(path);
    if (!listRes.ok) {
        if (isNotFoundError(listRes.error)) return;
        throw new Error(`Read folder failed (${path}): ${listRes.error}`);
    }
    for (const entry of listRes.data) {
        const childPath = joinRemote(path, entry.name);
        if (entry.type === "DIR") await removePathTree(client, childPath);
        else {
            const rmRes = await client.removePath(childPath);
            if (!rmRes.ok && !isNotFoundError(rmRes.error))
                throw new Error(
                    `Remove file failed (${childPath}): ${rmRes.error}`,
                );
        }
    }
    const rmRes = await client.removePath(path);
    if (!rmRes.ok && !isNotFoundError(rmRes.error)) {
        if (isCommandFailedError(rmRes.error)) return;
        throw new Error(`Remove folder failed (${path}): ${rmRes.error}`);
    }
}

async function cleanupBenchRoot(client, benchRoot) {
    const type = await getRemoteEntryType(client, benchRoot);
    if (!type) return;
    if (type === "FILE") {
        const rmRes = await client.removePath(benchRoot);
        if (!rmRes.ok && !isNotFoundError(rmRes.error))
            throw new Error(
                `Remove stale file failed (${benchRoot}): ${rmRes.error}`,
            );
        return;
    }
    await removePathTree(client, benchRoot);
}

// ── Regular file transfer bench ───────────────────────────────────

async function runRegularSweep() {
    state.runningRegular = true;
    state.regularAbortController = new AbortController();
    setButtons();
    try {
        const fileSizeBytes = Number.parseInt(el.regularFileSize.value, 10);
        const filesCount = Number.parseInt(el.regularFilesCount.value, 10);
        const filesPerFolder = Number.parseInt(
            el.regularFilesPerFolder.value,
            10,
        );
        if (!Number.isFinite(fileSizeBytes) || fileSizeBytes < 1)
            throw new Error("File size must be >= 1 byte.");
        if (!Number.isFinite(filesCount) || filesCount < 1)
            throw new Error("Total files must be >= 1.");
        if (!Number.isFinite(filesPerFolder) || filesPerFolder < 1)
            throw new Error("Files per folder must be >= 1.");

        const requestedChunkSizes = parseNumberList(
            el.regularChunks.value,
            "chunk size",
        );
        const repeats = Number.parseInt(el.regularRepeats.value, 10);
        if (!Number.isFinite(repeats) || repeats < 1 || repeats > 100)
            throw new Error("Repeats must be 1-100.");

        let client = await ensureRegularClientConnected();

        // Writing above the negotiated MTU is what wedges the GATT connection
        // in the first place (Chrome throws "GATT operation already in
        // progress" on every subsequent call, and reconnecting can't clear it
        // since the device never actually disconnects) — so sizes above
        // client.maxChunkSize never get tried.
        const oversizedChunks = requestedChunkSizes.filter(
            (cs) => cs > client.maxChunkSize,
        );
        const chunkSizes = requestedChunkSizes.filter(
            (cs) => cs <= client.maxChunkSize,
        );
        if (oversizedChunks.length) {
            log(
                `[regular] Skipping chunk size(s) above negotiated MTU (${client.maxChunkSize}B): [${oversizedChunks}]`,
                "warn",
            );
        }
        if (!chunkSizes.length) {
            throw new Error(
                `All requested chunk sizes exceed the negotiated MTU (${client.maxChunkSize}B).`,
            );
        }

        const drivesRes = await client.listDrives();
        if (!drivesRes.ok || !drivesRes.data.length)
            throw new Error(drivesRes.error || "No drive available.");
        const drive =
            drivesRes.data.find((d) => d.status === 0) || drivesRes.data[0];

        const benchRoot = `${drive.label}:/_mochi`;
        log(`[regular] Cleaning stale benchmark workspace: ${benchRoot}`);
        try {
            await cleanupBenchRoot(client, benchRoot);
        } catch (err) {
            log(
                `[regular] Cleanup warning: ${err.message || String(err)}`,
                "err",
            );
        }
        await ensureFolderPath(client, benchRoot);

        const testBlob = new Blob([new Uint8Array(fileSizeBytes)], {
            type: "application/octet-stream",
        });
        const bytesPerRun = fileSizeBytes * filesCount;
        const chunksPerFile = chunkSizes.map((cs) =>
            Math.ceil(fileSizeBytes / cs),
        );
        log(
            `[regular] Sweep: ${fileSizeBytes}B x ${filesCount} files, ${filesPerFolder}/folder, chunks=[${chunkSizes}], repeats=${repeats}`,
        );
        log(
            `[regular] Chunks per file: [${chunksPerFile.map((c, i) => `${chunkSizes[i]}B=${c}`).join(", ")}]`,
        );

        const rows = [];
        el.regularTableBody.innerHTML = "";
        el.regularTable.hidden = false;
        el.regularSummary.textContent = "";

        let needsReconnect = false;
        for (const chunkSize of chunkSizes) {
            let okRuns = 0;
            let totalSeconds = 0;
            let lastErr = "";

            if (needsReconnect) {
                log(
                    "[regular] Reconnecting GATT after previous failure...",
                    "warn",
                );
                try {
                    // ensureRegularClientConnected() now waits for client.js's
                    // own backoff reconnect if one is already in flight (started
                    // by the earlier failure's disconnect event), or does a
                    // single gatt.connect() itself otherwise. Either way it
                    // never opens the requestDevice() picker for a known device.
                    client = await ensureRegularClientConnected();
                    needsReconnect = false;
                    log("[regular] GATT reconnected.", "ok");
                } catch (reconErr) {
                    log(
                        `[regular] GATT reconnect failed: ${reconErr.message}`,
                        "err",
                    );
                    if (reconErr?.stack)
                        log(`[regular] stack: ${reconErr.stack}`, "err");
                    rows.push({
                        chunkSize,
                        okRuns: 0,
                        repeats,
                        avgSec: 0,
                        kbps: 0,
                        perFile: 0,
                        status: "failed",
                        detail: `reconnect failed: ${reconErr.message}`,
                    });
                    continue;
                }
            }

            for (let i = 0; i < repeats; i++) {
                const runRoot = joinRemote(benchRoot, `c${chunkSize}r${i + 1}`);
                const t0 = performance.now();
                let lastFileIndex = -1;
                let lastFilePath = "";
                try {
                    await ensureFolderPath(client, runRoot);
                    const createdFolders = new Set();
                    for (
                        let fileIndex = 0;
                        fileIndex < filesCount;
                        fileIndex++
                    ) {
                        lastFileIndex = fileIndex;
                        const folderNumber =
                            Math.floor(fileIndex / filesPerFolder) + 1;
                        const folderPath = joinRemote(
                            runRoot,
                            `t${folderNumber}`,
                        );
                        if (!createdFolders.has(folderPath)) {
                            await ensureFolderPath(client, folderPath);
                            createdFolders.add(folderPath);
                        }
                        lastFilePath = joinRemote(
                            folderPath,
                            `f${String(fileIndex + 1).padStart(4, "0")}.bin`,
                        );
                        log(
                            `[regular] chunk=${chunkSize} repeat=${i + 1}/${repeats} file=${fileIndex + 1}/${filesCount} ${lastFilePath}`,
                        );
                        await client.uploadFile(
                            lastFilePath,
                            testBlob,
                            () => {},
                            state.regularAbortController.signal,
                            chunkSize,
                        );
                    }
                    const dt = (performance.now() - t0) / 1000;
                    okRuns++;
                    totalSeconds += dt;
                    log(
                        `[regular] chunk=${chunkSize} run=${i + 1}/${repeats} ${dt.toFixed(2)}s`,
                        "ok",
                    );
                } catch (err) {
                    lastErr = err.message || String(err);
                    log(
                        `[regular] chunk=${chunkSize} failed at file ${lastFileIndex + 1}/${filesCount} (${lastFilePath}): ${lastErr}`,
                        "err",
                    );
                    if (err?.stack) log(`[regular] stack: ${err.stack}`, "err");
                    needsReconnect =
                        lastErr.toLowerCase().includes("gatt") ||
                        lastErr.toLowerCase().includes("disconnect");
                } finally {
                    try {
                        await removePathTree(client, runRoot);
                    } catch (cleanupErr) {
                        log(
                            `[regular] cleanup failed (${runRoot}): ${cleanupErr.message}`,
                            "warn",
                        );
                        needsReconnect = true;
                    }
                }
            }
            const avgSec = okRuns ? totalSeconds / okRuns : 0;
            const kbps = okRuns ? bytesToKbPerSec(bytesPerRun, avgSec) : 0;
            const perFile = okRuns ? (avgSec / filesCount) * 1000 : 0;
            rows.push({
                chunkSize,
                okRuns,
                repeats,
                avgSec,
                kbps,
                perFile,
                status: okRuns ? "ok" : "failed",
                detail: lastErr,
            });
        }

        for (const row of rows) {
            const tr = document.createElement("tr");
            tr.innerHTML = `
        <td class="mono">${row.chunkSize}</td>
        <td class="mono">${row.okRuns}/${row.repeats}</td>
        <td class="mono">${row.okRuns ? row.avgSec.toFixed(2) : "-"}</td>
        <td class="mono">${row.okRuns ? row.kbps.toFixed(1) : "-"}</td>
        <td class="mono">${row.okRuns ? row.perFile.toFixed(0) : "-"}</td>
        <td class="${row.status === "ok" ? "ok" : "err"}">${row.status}${row.detail ? ` (${row.detail})` : ""}</td>
      `;
            el.regularTableBody.appendChild(tr);
        }

        const best = rows
            .filter((r) => r.okRuns > 0)
            .sort((a, b) => b.kbps - a.kbps)[0];
        el.regularSummary.textContent = best
            ? `Best: chunk ${best.chunkSize}B (${best.kbps.toFixed(1)} KB/s, ${best.perFile.toFixed(0)}ms/file, ${filesCount} x ${fileSizeBytes}B)`
            : "No successful run. See log.";
        log(`[regular] Final cleanup: ${benchRoot}`);
        await cleanupBenchRoot(client, benchRoot).catch((e) =>
            log(`[regular] Final cleanup failed: ${e.message}`, "warn"),
        );
    } catch (err) {
        log(`[regular] ${err.message || String(err)}`, "err");
        if (err?.stack) log(`[regular] stack: ${err.stack}`, "err");
    } finally {
        state.runningRegular = false;
        setButtons();
    }
}

// ── Experiments ──────────────────────────────────────────────────

function addExpRow(row) {
    el.expTable.hidden = false;
    const tr = document.createElement("tr");
    const isOk = row.status === "ok";
    tr.innerHTML = `
    <td class="mono">${row.mode}</td>
    <td class="mono">${row.totalBytes}</td>
    <td class="mono">${row.chunkSize}</td>
    <td class="mono">${isOk ? row.seconds.toFixed(2) : "-"}</td>
    <td class="mono">${isOk ? row.kbps.toFixed(1) : "-"}</td>
    <td class="mono">${isOk ? row.msPerChunk.toFixed(1) : "-"}</td>
    <td class="${isOk ? "ok" : "err"}">${row.status}${row.detail ? ` (${row.detail})` : ""}</td>
  `;
    el.expTableBody.appendChild(tr);
}

async function runBatchWriteTest() {
    state.runningExp = true;
    state.expAbortController = new AbortController();
    setButtons();
    try {
        const totalBytes = Number.parseInt(el.expTotalBytes.value, 10);
        const chunkSize = Number.parseInt(el.expChunkSize.value, 10);
        if (!Number.isFinite(totalBytes) || totalBytes < 1)
            throw new Error("Total bytes must be >= 1.");
        if (!Number.isFinite(chunkSize) || chunkSize < 1)
            throw new Error("Chunk size must be >= 1.");

        const client = await ensureRegularClientConnected();
        const drivesRes = await client.listDrives();
        if (!drivesRes.ok || !drivesRes.data.length)
            throw new Error(drivesRes.error || "No drive available.");
        const drive =
            drivesRes.data.find((d) => d.status === 0) || drivesRes.data[0];

        const benchRoot = `${drive.label}:/_mochi`;
        try {
            await cleanupBenchRoot(client, benchRoot);
        } catch {}
        await ensureFolderPath(client, benchRoot);

        const filePath = joinRemote(benchRoot, "batch.bin");
        const data = new Uint8Array(totalBytes);
        const totalChunks = Math.ceil(totalBytes / chunkSize);

        log(
            `[batch] Writing single ${totalBytes}B file in ${totalChunks} chunks of ${chunkSize}B`,
        );

        const openRes = await client.openFile(filePath, "w");
        if (!openRes.ok) throw new Error(`Open failed: ${openRes.error}`);
        const fileId = openRes.data;

        const t0 = performance.now();
        try {
            let offset = 0;
            let chunkNum = 0;
            while (offset < totalBytes) {
                if (state.expAbortController.signal.aborted)
                    throw new Error("Aborted.");
                const end = Math.min(offset + chunkSize, totalBytes);
                const res = await client.writeFileChunk(
                    fileId,
                    data.slice(offset, end),
                );
                if (!res.ok)
                    throw new Error(
                        `Write chunk ${chunkNum} failed: ${res.error}`,
                    );
                offset = end;
                chunkNum++;
                if (chunkNum % 20 === 0 || offset >= totalBytes) {
                    log(
                        `[batch] ${offset}/${totalBytes}B (${Math.round((offset / totalBytes) * 100)}%)`,
                    );
                }
            }
        } finally {
            await client.closeFile(fileId).catch(() => {});
        }

        const seconds = (performance.now() - t0) / 1000;
        const kbps = bytesToKbPerSec(totalBytes, seconds);
        const msPerChunk = (seconds / totalChunks) * 1000;
        log(
            `[batch] Done: ${seconds.toFixed(2)}s, ${kbps.toFixed(1)} KB/s, ${msPerChunk.toFixed(1)}ms/chunk`,
            "ok",
        );

        const row = {
            mode: "batch",
            totalBytes,
            chunkSize,
            seconds,
            kbps,
            msPerChunk,
            status: "ok",
            detail: "",
        };
        addExpRow(row);
        el.expSummary.textContent = `Batch: ${kbps.toFixed(1)} KB/s (${totalChunks} chunks, ${msPerChunk.toFixed(1)}ms/chunk)`;

        log("[batch] Cleanup...");
        await cleanupBenchRoot(client, benchRoot).catch((e) =>
            log(`[batch] Cleanup failed: ${e.message}`, "warn"),
        );
    } catch (err) {
        log(`[batch] ${err.message || String(err)}`, "err");
        if (err?.stack) log(`[batch] stack: ${err.stack}`, "err");
        addExpRow({
            mode: "batch",
            totalBytes: 0,
            chunkSize: 0,
            seconds: 0,
            kbps: 0,
            msPerChunk: 0,
            status: "failed",
            detail: err.message,
        });
    } finally {
        state.runningExp = false;
        setButtons();
    }
}

async function runPipelineTest() {
    state.runningExp = true;
    state.expAbortController = new AbortController();
    setButtons();
    try {
        const totalBytes = Number.parseInt(el.expTotalBytes.value, 10);
        const chunkSize = Number.parseInt(el.expChunkSize.value, 10);
        const pipelineDepth = Number.parseInt(el.expPipelineDepth.value, 10);
        if (!Number.isFinite(totalBytes) || totalBytes < 1)
            throw new Error("Total bytes must be >= 1.");
        if (!Number.isFinite(chunkSize) || chunkSize < 1)
            throw new Error("Chunk size must be >= 1.");
        if (!Number.isFinite(pipelineDepth) || pipelineDepth < 1)
            throw new Error("Pipeline depth must be >= 1.");

        const client = await ensureRegularClientConnected();
        const txChar = client.txChar;
        if (!txChar) throw new Error("No TX characteristic — not connected.");
        if (typeof txChar.writeValueWithoutResponse !== "function") {
            throw new Error(
                "writeValueWithoutResponse not available on this browser/device.",
            );
        }

        const drivesRes = await client.listDrives();
        if (!drivesRes.ok || !drivesRes.data.length)
            throw new Error(drivesRes.error || "No drive available.");
        const drive =
            drivesRes.data.find((d) => d.status === 0) || drivesRes.data[0];

        const benchRoot = `${drive.label}:/_mochi`;
        try {
            await cleanupBenchRoot(client, benchRoot);
        } catch {}
        await ensureFolderPath(client, benchRoot);

        const filePath = joinRemote(benchRoot, "pipeline.bin");
        const data = new Uint8Array(totalBytes);
        const totalChunks = Math.ceil(totalBytes / chunkSize);

        log(
            `[pipeline] Writing ${totalBytes}B, chunk=${chunkSize}B, depth=${pipelineDepth}, ${totalChunks} chunks total`,
        );

        const openRes = await client.openFile(filePath, "w");
        if (!openRes.ok) throw new Error(`Open failed: ${openRes.error}`);
        const fileId = openRes.data;

        let responsesReceived = 0;
        let responseErrors = 0;
        const onResponse = (event) => {
            const dv = event.target.value;
            const incoming = new Uint8Array(
                dv.buffer.slice(dv.byteOffset, dv.byteOffset + dv.byteLength),
            );
            if (incoming[1] !== 0) responseErrors++;
            responsesReceived++;
        };

        function waitForResponses(target, timeoutMs = 15000) {
            return new Promise((resolve, reject) => {
                if (responsesReceived >= target) return resolve();
                const t0 = performance.now();
                const check = () => {
                    if (responsesReceived >= target) return resolve();
                    if (performance.now() - t0 > timeoutMs)
                        return reject(
                            new Error(
                                `Pipeline timeout: expected ${target} responses, got ${responsesReceived}`,
                            ),
                        );
                    setTimeout(check, 5);
                };
                check();
            });
        }

        client.rxChar.addEventListener(
            "characteristicvaluechanged",
            onResponse,
        );
        const t0 = performance.now();
        let pipelineOk = true;
        try {
            let chunksSent = 0;
            while (chunksSent < totalChunks) {
                if (state.expAbortController.signal.aborted)
                    throw new Error("Aborted.");
                const batchEnd = Math.min(
                    chunksSent + pipelineDepth,
                    totalChunks,
                );

                for (let i = chunksSent; i < batchEnd; i++) {
                    const offset = i * chunkSize;
                    const end = Math.min(offset + chunkSize, totalBytes);
                    const chunkData = data.slice(offset, end);
                    const frame = new Uint8Array(4 + 1 + chunkData.length);
                    frame[0] = 0x15;
                    frame[1] = 0;
                    frame[2] = 0;
                    frame[3] = 0;
                    frame[4] = fileId;
                    frame.set(chunkData, 5);
                    await txChar.writeValueWithoutResponse(frame);
                }

                await waitForResponses(batchEnd);
                if (responseErrors > 0) {
                    log(
                        `[pipeline] ${responseErrors} error response(s) after ${batchEnd} chunks`,
                        "err",
                    );
                    pipelineOk = false;
                    break;
                }

                chunksSent = batchEnd;
                if (chunksSent % 20 === 0 || chunksSent >= totalChunks) {
                    const bytesSent = Math.min(
                        chunksSent * chunkSize,
                        totalBytes,
                    );
                    log(
                        `[pipeline] ${bytesSent}/${totalBytes}B (${Math.round((bytesSent / totalBytes) * 100)}%)`,
                    );
                }
            }
        } finally {
            client.rxChar.removeEventListener(
                "characteristicvaluechanged",
                onResponse,
            );
            await client.closeFile(fileId).catch(() => {});
        }

        const seconds = (performance.now() - t0) / 1000;
        const kbps = bytesToKbPerSec(totalBytes, seconds);
        const msPerChunk = (seconds / totalChunks) * 1000;

        if (pipelineOk) {
            log(
                `[pipeline] Done: ${seconds.toFixed(2)}s, ${kbps.toFixed(1)} KB/s, ${msPerChunk.toFixed(1)}ms/chunk`,
                "ok",
            );
            addExpRow({
                mode: `pipe(${pipelineDepth})`,
                totalBytes,
                chunkSize,
                seconds,
                kbps,
                msPerChunk,
                status: "ok",
                detail: "",
            });
            el.expSummary.textContent = `Pipeline(${pipelineDepth}): ${kbps.toFixed(1)} KB/s (${totalChunks} chunks, ${msPerChunk.toFixed(1)}ms/chunk)`;
        } else {
            addExpRow({
                mode: `pipe(${pipelineDepth})`,
                totalBytes,
                chunkSize,
                seconds: 0,
                kbps: 0,
                msPerChunk: 0,
                status: "failed",
                detail: `${responseErrors} error(s)`,
            });
        }

        log("[pipeline] Cleanup...");
        await cleanupBenchRoot(client, benchRoot).catch((e) =>
            log(`[pipeline] Cleanup failed: ${e.message}`, "warn"),
        );
    } catch (err) {
        log(`[pipeline] ${err.message || String(err)}`, "err");
        if (err?.stack) log(`[pipeline] stack: ${err.stack}`, "err");
        addExpRow({
            mode: "pipeline",
            totalBytes: 0,
            chunkSize: 0,
            seconds: 0,
            kbps: 0,
            msPerChunk: 0,
            status: "failed",
            detail: err.message,
        });
    } finally {
        state.runningExp = false;
        setButtons();
    }
}

async function runMultiFilePipelineTest() {
    state.runningExp = true;
    state.expAbortController = new AbortController();
    setButtons();
    try {
        const fileSize = Number.parseInt(el.expFileSize.value, 10);
        const fileCount = Number.parseInt(el.expFileCount.value, 10);
        const chunkSize = Number.parseInt(el.expChunkSize.value, 10);
        const pipelineDepth = Number.parseInt(el.expPipelineDepth.value, 10);
        if (!Number.isFinite(fileSize) || fileSize < 1)
            throw new Error("File size must be >= 1.");
        if (!Number.isFinite(fileCount) || fileCount < 1)
            throw new Error("File count must be >= 1.");
        if (!Number.isFinite(chunkSize) || chunkSize < 1)
            throw new Error("Chunk size must be >= 1.");
        if (!Number.isFinite(pipelineDepth) || pipelineDepth < 1)
            throw new Error("Pipeline depth must be >= 1.");

        const client = await ensureRegularClientConnected();
        const txChar = client.txChar;
        if (!txChar) throw new Error("No TX characteristic — not connected.");

        const drivesRes = await client.listDrives();
        if (!drivesRes.ok || !drivesRes.data.length)
            throw new Error(drivesRes.error || "No drive available.");
        const drive =
            drivesRes.data.find((d) => d.status === 0) || drivesRes.data[0];

        const benchRoot = `${drive.label}:/_mochi`;
        try {
            await cleanupBenchRoot(client, benchRoot);
        } catch {}
        await ensureFolderPath(client, benchRoot);

        const totalBytes = fileSize * fileCount;
        const chunksPerFile = Math.ceil(fileSize / chunkSize);
        const data = new Uint8Array(fileSize);
        const testBlob = new Blob([data], { type: "application/octet-stream" });
        const hasPipeline =
            typeof txChar.writeValueWithoutResponse === "function" &&
            pipelineDepth > 1;

        log(
            `[multi] ${fileCount} x ${fileSize}B files, chunk=${chunkSize}B (${chunksPerFile} chunks/file), pipeline=${hasPipeline ? pipelineDepth : "off (serial)"}`,
        );

        // Also run serial baseline for comparison
        const results = [];

        // --- Serial baseline ---
        log("[multi] Running serial baseline...");
        const serialFolder = joinRemote(benchRoot, "serial");
        await ensureFolderPath(client, serialFolder);
        const t0serial = performance.now();
        for (let f = 0; f < fileCount; f++) {
            if (state.expAbortController.signal.aborted)
                throw new Error("Aborted.");
            const path = joinRemote(
                serialFolder,
                `f${String(f + 1).padStart(4, "0")}.bin`,
            );
            await client.uploadFile(
                path,
                testBlob,
                () => {},
                state.expAbortController.signal,
                chunkSize,
            );
            if ((f + 1) % 5 === 0 || f === fileCount - 1)
                log(`[multi/serial] file ${f + 1}/${fileCount}`);
        }
        const serialSec = (performance.now() - t0serial) / 1000;
        const serialKbps = bytesToKbPerSec(totalBytes, serialSec);
        const serialMsFile = (serialSec / fileCount) * 1000;
        log(
            `[multi/serial] Done: ${serialSec.toFixed(2)}s, ${serialKbps.toFixed(1)} KB/s, ${serialMsFile.toFixed(0)}ms/file`,
            "ok",
        );
        results.push({
            mode: `serial(${fileCount}x${fileSize})`,
            totalBytes,
            chunkSize,
            seconds: serialSec,
            kbps: serialKbps,
            msPerChunk: serialMsFile,
            status: "ok",
            detail: `${serialMsFile.toFixed(0)}ms/file`,
        });
        addExpRow(results[results.length - 1]);

        await removePathTree(client, serialFolder).catch(() => {});

        if (!hasPipeline) {
            el.expSummary.textContent = `Serial only: ${serialKbps.toFixed(1)} KB/s (${serialMsFile.toFixed(0)}ms/file)`;
            log("[multi] Cleanup...");
            await cleanupBenchRoot(client, benchRoot).catch(() => {});
            return;
        }

        // --- Pipeline per-file ---
        log(`[multi] Running pipeline (depth ${pipelineDepth})...`);
        const pipeFolder = joinRemote(benchRoot, "pipe");
        await ensureFolderPath(client, pipeFolder);

        let responsesReceived = 0;
        let responseErrors = 0;
        const onResponse = (event) => {
            const dv = event.target.value;
            const incoming = new Uint8Array(
                dv.buffer.slice(dv.byteOffset, dv.byteOffset + dv.byteLength),
            );
            const cmd = incoming[0];
            if (cmd !== 0x15 && cmd !== 0x13) return;
            if (incoming[1] !== 0) responseErrors++;
            responsesReceived++;
        };

        function waitForResponses(target, timeoutMs = 15000) {
            return new Promise((resolve, reject) => {
                if (responsesReceived >= target) return resolve();
                const t0 = performance.now();
                const check = () => {
                    if (responsesReceived >= target) return resolve();
                    if (performance.now() - t0 > timeoutMs)
                        return reject(
                            new Error(
                                `Pipeline timeout: expected ${target} responses, got ${responsesReceived}`,
                            ),
                        );
                    setTimeout(check, 5);
                };
                check();
            });
        }

        const t0pipe = performance.now();
        let pipelineOk = true;
        client.rxChar.addEventListener(
            "characteristicvaluechanged",
            onResponse,
        );
        try {
            for (let f = 0; f < fileCount; f++) {
                if (state.expAbortController.signal.aborted)
                    throw new Error("Aborted.");
                const path = joinRemote(
                    pipeFolder,
                    `f${String(f + 1).padStart(4, "0")}.bin`,
                );

                const openRes = await client.openFile(path, "w");
                if (!openRes.ok)
                    throw new Error(
                        `Open file ${f + 1} failed: ${openRes.error}`,
                    );
                const fileId = openRes.data;

                responsesReceived = 0;
                responseErrors = 0;
                const expectedResponses = chunksPerFile + 1;

                for (let c = 0; c < chunksPerFile; c++) {
                    const offset = c * chunkSize;
                    const end = Math.min(offset + chunkSize, fileSize);
                    const chunkData = data.slice(offset, end);
                    const frame = new Uint8Array(4 + 1 + chunkData.length);
                    frame[0] = 0x15;
                    frame[1] = 0;
                    frame[2] = 0;
                    frame[3] = 0;
                    frame[4] = fileId;
                    frame.set(chunkData, 5);
                    await txChar.writeValueWithoutResponse(frame);
                }

                const closeFrame = new Uint8Array([0x13, 0, 0, 0, fileId]);
                await txChar.writeValueWithoutResponse(closeFrame);

                await waitForResponses(expectedResponses);
                if (responseErrors > 0) {
                    log(`[multi/pipe] Error responses at file ${f + 1}`, "err");
                    pipelineOk = false;
                    break;
                }
                if ((f + 1) % 5 === 0 || f === fileCount - 1)
                    log(`[multi/pipe] file ${f + 1}/${fileCount}`);
            }
        } finally {
            client.rxChar.removeEventListener(
                "characteristicvaluechanged",
                onResponse,
            );
        }

        const pipeSec = (performance.now() - t0pipe) / 1000;
        const pipeKbps = bytesToKbPerSec(totalBytes, pipeSec);
        const pipeMsFile = (pipeSec / fileCount) * 1000;

        if (pipelineOk) {
            log(
                `[multi/pipe] Done: ${pipeSec.toFixed(2)}s, ${pipeKbps.toFixed(1)} KB/s, ${pipeMsFile.toFixed(0)}ms/file`,
                "ok",
            );
            results.push({
                mode: `pipe${pipelineDepth}(${fileCount}x${fileSize})`,
                totalBytes,
                chunkSize,
                seconds: pipeSec,
                kbps: pipeKbps,
                msPerChunk: pipeMsFile,
                status: "ok",
                detail: `${pipeMsFile.toFixed(0)}ms/file`,
            });
        } else {
            results.push({
                mode: `pipe${pipelineDepth}(${fileCount}x${fileSize})`,
                totalBytes,
                chunkSize,
                seconds: 0,
                kbps: 0,
                msPerChunk: 0,
                status: "failed",
                detail: `${responseErrors} error(s)`,
            });
        }
        addExpRow(results[results.length - 1]);

        const okResults = results.filter((r) => r.status === "ok");
        if (okResults.length >= 2) {
            const speedup = (okResults[1].kbps / okResults[0].kbps).toFixed(2);
            el.expSummary.textContent = `Serial: ${okResults[0].kbps.toFixed(1)} KB/s (${okResults[0].msPerChunk.toFixed(0)}ms/file) → Pipeline(${pipelineDepth}): ${okResults[1].kbps.toFixed(1)} KB/s (${okResults[1].msPerChunk.toFixed(0)}ms/file) — ${speedup}x`;
        }

        log("[multi] Cleanup...");
        await cleanupBenchRoot(client, benchRoot).catch((e) =>
            log(`[multi] Cleanup failed: ${e.message}`, "warn"),
        );
    } catch (err) {
        log(`[multi] ${err.message || String(err)}`, "err");
        if (err?.stack) log(`[multi] stack: ${err.stack}`, "err");
        addExpRow({
            mode: "multi",
            totalBytes: 0,
            chunkSize: 0,
            seconds: 0,
            kbps: 0,
            msPerChunk: 0,
            status: "failed",
            detail: err.message,
        });
    } finally {
        state.runningExp = false;
        setButtons();
    }
}

// ── DFU bench ─────────────────────────────────────────────────────

async function resolveOtaZip(fileBlob) {
    const zip = await window.JSZip.loadAsync(fileBlob);
    if (zip.file("manifest.json")) return fileBlob;
    const nested = Object.values(zip.files).find(
        (e) => !e.dir && e.name.toLowerCase().endsWith(".zip"),
    );
    if (!nested) throw new Error("No DFU package found inside this zip.");
    return nested.async("blob");
}

async function loadDfuImages(zipBlob) {
    const zip = await window.JSZip.loadAsync(zipBlob);
    const manifestFile = zip.file("manifest.json");
    if (!manifestFile) throw new Error("manifest.json is missing.");
    const root = JSON.parse(await manifestFile.async("string"));
    const manifest = root.manifest || {};

    async function getImage(types) {
        for (const type of types) {
            const entry = manifest[type];
            if (!entry) continue;
            const init = zip.file(entry.dat_file);
            const image = zip.file(entry.bin_file);
            if (!init || !image)
                throw new Error(`Package missing ${type} files.`);
            return {
                type,
                initData: await init.async("arraybuffer"),
                imageData: await image.async("arraybuffer"),
            };
        }
        return null;
    }

    return {
        baseImage: await getImage([
            "softdevice",
            "bootloader",
            "softdevice_bootloader",
        ]),
        appImage: await getImage(["application"]),
    };
}

function dfuTotalBytes(images) {
    return (
        (images.baseImage?.initData?.byteLength || 0) +
        (images.baseImage?.imageData?.byteLength || 0) +
        (images.appImage?.initData?.byteLength || 0) +
        (images.appImage?.imageData?.byteLength || 0)
    );
}

async function runSingleDfu(images, combo, dfuDevice) {
    const { packetSize, delayMs, prn, objectDelayMs } = combo;
    const dfu = createSecureDfu(combo);
    const totalBytes = dfuTotalBytes(images);
    let transferred = 0;
    let t0 = 0;
    let lastProgressAt = 0;
    let lastProgressBytes = 0;

    dfu.addEventListener(window.SecureDfu.EVENT_LOG, ({ message }) => {
        log(`[dfu-lib] ${message}`);
    });

    const progressMarks = new Map();
    dfu.addEventListener(
        window.SecureDfu.EVENT_PROGRESS,
        ({ object, currentBytes, totalBytes: objTotal }) => {
            if (!objTotal) return;
            const now = performance.now();
            const elapsedSec = Math.max((now - t0) / 1000, 0.001);
            const transferredBytes = transferred + currentBytes;
            const deltaBytes = Math.max(
                0,
                transferredBytes - lastProgressBytes,
            );
            const deltaSec = Math.max((now - lastProgressAt) / 1000, 0.001);
            const liveKbps = lastProgressAt
                ? bytesToKbPerSec(deltaBytes, deltaSec)
                : bytesToKbPerSec(transferredBytes, elapsedSec);
            const avgKbps = bytesToKbPerSec(transferredBytes, elapsedSec);
            lastProgressAt = now;
            lastProgressBytes = transferredBytes;

            const pct = Math.round((currentBytes / objTotal) * 100);
            const totalPct =
                totalBytes > 0
                    ? Math.round((transferredBytes / totalBytes) * 100)
                    : 0;
            setDfuLiveStats(
                `${object} ${totalPct}% — live ${liveKbps.toFixed(1)} KB/s, avg ${avgKbps.toFixed(1)} KB/s`,
            );

            const lastLoggedPct = progressMarks.get(object) ?? -10;
            if (
                pct >= lastLoggedPct + 10 ||
                pct === 100 ||
                currentBytes === objTotal
            ) {
                progressMarks.set(object, pct);
                log(`[dfu] ${object}: ${currentBytes}/${objTotal} (${pct}%)`);
            }
        },
    );

    log(
        `[dfu] Transfer: pkt=${packetSize}B delay=${delayMs}ms prn=${prn} objDelay=${objectDelayMs}ms`,
    );
    t0 = performance.now();

    if (images.baseImage) {
        await dfu.update(
            dfuDevice,
            images.baseImage.initData,
            images.baseImage.imageData,
        );
        transferred +=
            images.baseImage.initData.byteLength +
            images.baseImage.imageData.byteLength;
    }
    if (images.appImage) {
        await dfu.update(
            dfuDevice,
            images.appImage.initData,
            images.appImage.imageData,
        );
        transferred +=
            images.appImage.initData.byteLength +
            images.appImage.imageData.byteLength;
    }

    const seconds = (performance.now() - t0) / 1000;
    const avgKbps = bytesToKbPerSec(totalBytes, seconds);
    log(
        `[dfu] Done: ${seconds.toFixed(2)}s, avg ${avgKbps.toFixed(1)} KB/s`,
        "ok",
    );
    return seconds;
}

async function acquireDfuDevice(combo) {
    if (el.dfuAlreadyInMode.checked) {
        log("[dfu] Device already in DFU mode — opening picker.");
        setDfuLiveStats("Select DFU device in picker...");
        const picker = createSecureDfu(combo);
        const device = await picker.requestDevice(false, [
            { services: [window.SecureDfu.SERVICE_UUID] },
        ]);
        state.lastDfuDeviceId = device.id || state.lastDfuDeviceId;
        return device;
    }

    const client = await ensureRegularClientConnected();
    log("[dfu] Sending enterDfu...");
    setDfuLiveStats("Entering DFU mode...");
    const enterRes = await client.enterDfu();
    if (!enterRes.ok) throw new Error(enterRes.error || "enterDfu failed");
    setConnectionState(false);
    state.client = null;

    let dfuDevice = await getGrantedDfuDevice();
    if (dfuDevice) {
        log(
            `[dfu] Reusing granted DFU device: ${dfuDevice.name || "DFU device"}`,
        );
        setDfuLiveStats("Waiting for DFU mode...");
        await sleep(3500);
    } else {
        log("[dfu] Select DFU device in picker.");
        setDfuLiveStats("Select DFU device in picker...");
        const picker = createSecureDfu(combo);
        dfuDevice = await picker.requestDevice(false, [
            { services: [window.SecureDfu.SERVICE_UUID] },
        ]);
        state.lastDfuDeviceId = dfuDevice.id || state.lastDfuDeviceId;
    }
    return dfuDevice;
}

function addDfuRow(row) {
    el.dfuTable.hidden = false;
    state.dfuRows.push(row);
    const tr = document.createElement("tr");
    const isOk = row.status === "ok";
    tr.innerHTML = `
    <td class="mono">${state.dfuRows.length}</td>
    <td class="mono">${row.packetSize}</td>
    <td class="mono">${row.delayMs}</td>
    <td class="mono">${row.prn}</td>
    <td class="mono">${row.objectDelayMs}</td>
    <td class="${isOk ? "ok" : "err"}">${row.status}</td>
    <td class="mono">${isOk ? row.seconds.toFixed(2) : "-"}</td>
    <td class="mono">${isOk ? row.kbps.toFixed(1) : "-"}</td>
  `;
    el.dfuTableBody.appendChild(tr);

    const okRows = state.dfuRows.filter((r) => r.status === "ok");
    if (okRows.length) {
        const best = okRows.sort((a, b) => b.kbps - a.kbps)[0];
        el.dfuSummary.textContent = `Best: #${state.dfuRows.indexOf(best) + 1} pkt=${best.packetSize} delay=${best.delayMs} prn=${best.prn} objDelay=${best.objectDelayMs} → ${best.kbps.toFixed(1)} KB/s (${best.seconds.toFixed(1)}s)`;
    }
}

async function runDfuSingle() {
    state.runningDfu = true;
    state.dfuAbortController = new AbortController();
    setButtons();

    try {
        if (!window.JSZip || !window.SecureDfu)
            throw new Error("DFU libs failed to load.");
        const file = el.dfuFile.files?.[0];
        if (!file) throw new Error("Pick a DFU package zip first.");

        const combo = getDfuParams();
        const { baseImage, appImage } = await loadDfuImages(
            await resolveOtaZip(file),
        );
        if (!baseImage && !appImage)
            throw new Error("No firmware image in package.");
        const images = { baseImage, appImage };
        const totalBytes = dfuTotalBytes(images);

        log(
            `[dfu] Package: ${file.name} (${file.size}B zip, ${totalBytes}B DFU payload)`,
        );
        log(
            `[dfu] Params: pkt=${combo.packetSize} delay=${combo.delayMs} prn=${combo.prn} objDelay=${combo.objectDelayMs}`,
        );

        const dfuDevice = await acquireDfuDevice(combo);
        if (!dfuDevice) throw new Error("No DFU device available");
        state.dfuDevice = dfuDevice;
        log(`[dfu] Device: ${dfuDevice.name || "DFU device"}`);

        const seconds = await runSingleDfu(images, combo, dfuDevice);
        const kbps = bytesToKbPerSec(totalBytes, seconds);

        addDfuRow({ ...combo, seconds, kbps, status: "ok", detail: "" });
        setDfuLiveStats(
            `Done: ${kbps.toFixed(1)} KB/s (${seconds.toFixed(1)}s)`,
        );
    } catch (err) {
        const detail = err?.stack
            ? err.stack.split("\n")[0]
            : err.message || String(err);
        log(`[dfu] Failed: ${detail}`, "err");
        try {
            const combo = getDfuParams();
            addDfuRow({
                ...combo,
                seconds: 0,
                kbps: 0,
                status: "failed",
                detail,
            });
        } catch {}
        setDfuLiveStats(`Failed: ${detail}`);
    } finally {
        state.runningDfu = false;
        setButtons();
    }
}

// ── Event wiring ──────────────────────────────────────────────────

el.btnConnect.addEventListener("click", async () => {
    try {
        await ensureRegularClientConnected();
    } catch (err) {
        log(err.message || String(err), "err");
    }
});

el.btnDisconnect.addEventListener("click", () => {
    if (state.client) state.client.disconnect();
    state.client = null;
    setConnectionState(false);
});

el.btnRunRegular.addEventListener("click", runRegularSweep);
el.btnStopRegular.addEventListener("click", () => {
    if (state.regularAbortController) {
        state.regularAbortController.abort();
        log("[regular] Stop requested by user", "warn");
    }
});

el.btnRunBatch.addEventListener("click", runBatchWriteTest);
el.btnRunPipeline.addEventListener("click", runPipelineTest);
el.btnRunMultiPipe.addEventListener("click", runMultiFilePipelineTest);
el.btnStopExp.addEventListener("click", () => {
    if (state.expAbortController) {
        state.expAbortController.abort();
        log("[exp] Stop requested by user", "warn");
    }
});

el.dfuFile.addEventListener("change", setButtons);
el.dfuAlreadyInMode.addEventListener("change", setButtons);
el.btnRunDfu.addEventListener("click", runDfuSingle);
el.btnStopDfu.addEventListener("click", () => {
    if (state.dfuAbortController) {
        state.dfuAbortController.abort();
        log("[dfu] Stop requested by user", "warn");
    }
});
el.btnClearDfu.addEventListener("click", () => {
    state.dfuRows = [];
    el.dfuTableBody.innerHTML = "";
    el.dfuTable.hidden = true;
    el.dfuSummary.textContent = "";
    el.dfuLiveStats.textContent = "";
});

// ── Init ──────────────────────────────────────────────────────────

setButtons();
setConnectionState(false);
log("Ready.");
