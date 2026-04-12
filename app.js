const NUS_SERVICE_UUID = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";
const NUS_CHAR_TX_UUID = "6e400002-b5a3-f393-e0a9-e50e24dcca9e";
const NUS_CHAR_RX_UUID = "6e400003-b5a3-f393-e0a9-e50e24dcca9e";

const FRAME_HEADER_SIZE = 4;
const MAX_ATT_BYTES = 247;
const MAX_WRITE_CHUNK = MAX_ATT_BYTES - FRAME_HEADER_SIZE - 1;
const MAX_FILE_NAME_BYTES = 47;
const MAX_FILE_PATH_BYTES = 65;
const MAX_FOLDER_PATH_BYTES = 57;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const elements = {
  modeUploaderButton: document.getElementById("modeUploaderButton"),
  modeManagerButton: document.getElementById("modeManagerButton"),
  modeDescription: document.getElementById("modeDescription"),

  connectButton: document.getElementById("connectButton"),
  refreshButton: document.getElementById("refreshButton"),
  driveSelect: document.getElementById("driveSelect"),
  remoteBaseInput: document.getElementById("remoteBaseInput"),
  createPathButton: document.getElementById("createPathButton"),
  uploaderBaseField: document.getElementById("uploaderBaseField"),
  uploaderBaseActions: document.getElementById("uploaderBaseActions"),
  connectionState: document.getElementById("connectionState"),
  firmwareVersion: document.getElementById("firmwareVersion"),
  bleAddress: document.getElementById("bleAddress"),

  treeUploaderPanel: document.getElementById("treeUploaderPanel"),
  uploadPlanPanel: document.getElementById("uploadPlanPanel"),
  fileManagerPanel: document.getElementById("fileManagerPanel"),

  pickFolderButton: document.getElementById("pickFolderButton"),
  pickFilesButton: document.getElementById("pickFilesButton"),
  preserveRootToggle: document.getElementById("preserveRootToggle"),
  folderInput: document.getElementById("folderInput"),
  filesInput: document.getElementById("filesInput"),
  selectionSummary: document.getElementById("selectionSummary"),
  folderCount: document.getElementById("folderCount"),
  fileCount: document.getElementById("fileCount"),
  totalBytes: document.getElementById("totalBytes"),
  startUploadButton: document.getElementById("startUploadButton"),
  abortButton: document.getElementById("abortButton"),
  clearPlanButton: document.getElementById("clearPlanButton"),
  overallProgressLabel: document.getElementById("overallProgressLabel"),
  overallProgressPercent: document.getElementById("overallProgressPercent"),
  overallProgressBar: document.getElementById("overallProgressBar"),
  queueStats: document.getElementById("queueStats"),
  planTableBody: document.getElementById("planTableBody"),

  managerStatusLabel: document.getElementById("managerStatusLabel"),
  managerPathInput: document.getElementById("managerPathInput"),
  managerOpenButton: document.getElementById("managerOpenButton"),
  managerUpButton: document.getElementById("managerUpButton"),
  managerRefreshButton: document.getElementById("managerRefreshButton"),
  managerUsePathButton: document.getElementById("managerUsePathButton"),
  managerFolderNameInput: document.getElementById("managerFolderNameInput"),
  managerCreateFolderButton: document.getElementById("managerCreateFolderButton"),
  managerSanitizeButton: document.getElementById("managerSanitizeButton"),
  managerSelectAllButton: document.getElementById("managerSelectAllButton"),
  managerClearSelectionButton: document.getElementById("managerClearSelectionButton"),
  managerDeleteButton: document.getElementById("managerDeleteButton"),
  managerCurrentPath: document.getElementById("managerCurrentPath"),
  managerEntryCount: document.getElementById("managerEntryCount"),
  managerSelectionInfo: document.getElementById("managerSelectionInfo"),
  managerOutcomeBanner: document.getElementById("managerOutcomeBanner"),
  managerOutcomeTitle: document.getElementById("managerOutcomeTitle"),
  managerOutcomeText: document.getElementById("managerOutcomeText"),
  managerBusyState: document.getElementById("managerBusyState"),
  managerBusyEyebrow: document.getElementById("managerBusyEyebrow"),
  managerBusyBadge: document.getElementById("managerBusyBadge"),
  managerBusyTitle: document.getElementById("managerBusyTitle"),
  managerBusyCount: document.getElementById("managerBusyCount"),
  managerBusyPhase: document.getElementById("managerBusyPhase"),
  managerBusyLabel: document.getElementById("managerBusyLabel"),
  managerBusyPercent: document.getElementById("managerBusyPercent"),
  managerBusyBar: document.getElementById("managerBusyBar"),
  managerBrowserShell: document.getElementById("managerBrowserShell"),
  managerTableBody: document.getElementById("managerTableBody"),

  activityStatusCard: document.getElementById("activityStatusCard"),
  activityPhaseLabel: document.getElementById("activityPhaseLabel"),
  activityOperationTitle: document.getElementById("activityOperationTitle"),
  activityStatusBadge: document.getElementById("activityStatusBadge"),
  activityProgressCount: document.getElementById("activityProgressCount"),
  activityProgressDetail: document.getElementById("activityProgressDetail"),
  activityProgressLabel: document.getElementById("activityProgressLabel"),
  activityProgressPercent: document.getElementById("activityProgressPercent"),
  activityProgressBar: document.getElementById("activityProgressBar"),
  activityOutcomeBanner: document.getElementById("activityOutcomeBanner"),
  activityOutcomeTitle: document.getElementById("activityOutcomeTitle"),
  activityOutcomeText: document.getElementById("activityOutcomeText"),
  clearLogButton: document.getElementById("clearLogButton"),
  logOutput: document.getElementById("logOutput")
};

function createDefaultActivityState() {
  return {
    status: "idle",
    phaseLabel: "Ready",
    title: "Waiting for the next device task",
    detail: "Connect to a device, choose a drive, then start an upload or open the file manager.",
    progressLabel: "No active task",
    current: 0,
    total: 0,
    percent: 0,
    outcome: {
      visible: false,
      title: "No recent activity",
      text: "Completed work, partial results, skipped items, and path-limit warnings will appear here."
    }
  };
}

function createDefaultManagerBusyState() {
  return {
    eyebrow: "Updating device storage",
    badgeTone: "active",
    badgeLabel: "Working",
    title: "Working in the current folder",
    phase: "Waiting for the next device step",
    label: "Preparing device change",
    current: 0,
    total: 0,
    percent: 0
  };
}

function createDefaultManagerOutcome() {
  return {
    visible: false,
    title: "No recent device action",
    text: "Bulk results, skipped items, and path-limit warnings will appear here."
  };
}

const state = {
  client: null,
  connected: false,
  mode: "uploader",
  drives: [],
  plan: [],
  queuedFolders: [],
  queuedFiles: [],
  uploadActive: false,
  abortRequested: false,
  itemSeed: 0,
  activity: createDefaultActivityState(),
  manager: {
    currentPath: "",
    entries: [],
    selectedPaths: [],
    loaded: false,
    busy: false,
    busyState: createDefaultManagerBusyState(),
    outcome: createDefaultManagerOutcome()
  }
};

class Cursor {
  constructor(bytes) {
    this.bytes = bytes;
    this.offset = 0;
  }

  remaining() {
    return this.bytes.length - this.offset;
  }

  u8() {
    const value = this.bytes[this.offset];
    this.offset += 1;
    return value;
  }

  u16() {
    const value = this.bytes[this.offset] | (this.bytes[this.offset + 1] << 8);
    this.offset += 2;
    return value;
  }

  u32() {
    const view = new DataView(this.bytes.buffer, this.bytes.byteOffset + this.offset, 4);
    const value = view.getUint32(0, true);
    this.offset += 4;
    return value;
  }

  take(length) {
    const value = this.bytes.slice(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }

  skip(length) {
    this.offset += length;
  }

  string() {
    return decoder.decode(this.take(this.u16()));
  }
}

class PixlBleClient {
  constructor(logFn) {
    this.log = logFn;
    this.device = null;
    this.txCharacteristic = null;
    this.rxCharacteristic = null;
    this.commandQueue = Promise.resolve();
    this.pending = null;
    this.chunking = false;
    this.rxParts = [];
    this.createdFolders = new Set();

    this.handleNotification = this.handleNotification.bind(this);
    this.handleDisconnect = this.handleDisconnect.bind(this);
  }

  async connect() {
    if (!navigator.bluetooth) {
      throw new Error("Web Bluetooth is not available in this browser.");
    }

    this.log("Requesting BLE device...");
    const device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [NUS_SERVICE_UUID] }],
      optionalServices: [NUS_SERVICE_UUID]
    });

    device.addEventListener("gattserverdisconnected", this.handleDisconnect);

    const server = await device.gatt.connect();
    const service = await server.getPrimaryService(NUS_SERVICE_UUID);
    const characteristics = await service.getCharacteristics();

    characteristics.forEach((characteristic) => {
      if (characteristic.uuid === NUS_CHAR_TX_UUID) {
        this.txCharacteristic = characteristic;
      } else if (characteristic.uuid === NUS_CHAR_RX_UUID) {
        this.rxCharacteristic = characteristic;
      }
    });

    if (!this.txCharacteristic || !this.rxCharacteristic) {
      throw new Error("The Nordic UART characteristics are missing on this device.");
    }

    this.device = device;
    await this.rxCharacteristic.startNotifications();
    this.rxCharacteristic.addEventListener("characteristicvaluechanged", this.handleNotification);
    this.createdFolders.clear();
    this.log(`Connected to ${device.name || "BLE device"}.`);
  }

  disconnect() {
    if (this.device && this.device.gatt.connected) {
      this.device.gatt.disconnect();
      return;
    }

    this.resetTransport("Device disconnected.");
  }

  resetTransport(reason) {
    if (this.rxCharacteristic) {
      this.rxCharacteristic.removeEventListener("characteristicvaluechanged", this.handleNotification);
    }

    if (this.device) {
      this.device.removeEventListener("gattserverdisconnected", this.handleDisconnect);
    }

    if (this.pending) {
      this.pending.reject(new Error(reason));
      this.pending = null;
    }

    this.device = null;
    this.txCharacteristic = null;
    this.rxCharacteristic = null;
    this.commandQueue = Promise.resolve();
    this.chunking = false;
    this.rxParts = [];
    this.createdFolders.clear();
  }

  handleDisconnect() {
    this.log("Device disconnected.");
    this.resetTransport("Device disconnected.");
    setConnected(false);
    setActivityStatus({
      status: "error",
      phaseLabel: "Connection lost",
      title: "The device disconnected",
      detail: "Reconnect, refresh the drive list, then continue browsing or uploading.",
      current: 0,
      total: 1,
      progressLabel: "Connection closed"
    });
    showActivityOutcome("Device disconnected", "The Bluetooth connection closed. Reconnect and refresh the drive list to continue.", "error");
  }

  async getVersion() {
    const response = await this.sendCommand(0x01);
    if (response.status !== 0) {
      throw new Error(`Version request failed with status ${response.status}.`);
    }

    const cursor = new Cursor(response.payload);
    return {
      version: cursor.string(),
      bleAddress: cursor.remaining() > 0 ? cursor.string() : ""
    };
  }

  async listDrives() {
    const response = await this.sendCommand(0x10);
    if (response.status !== 0) {
      throw new Error(`Drive listing failed with status ${response.status}.`);
    }

    const cursor = new Cursor(response.payload);
    const count = cursor.u8();
    const drives = [];

    for (let index = 0; index < count; index += 1) {
      drives.push({
        status: cursor.u8(),
        label: String.fromCharCode(cursor.u8()),
        name: cursor.string(),
        totalBytes: cursor.u32(),
        usedBytes: cursor.u32()
      });
    }

    return drives;
  }

  async readFolder(path) {
    const response = await this.sendCommand(0x16, encodeString(path));
    if (response.status !== 0) {
      throw new Error(`Read folder failed for ${path} with status ${response.status}.`);
    }

    const cursor = new Cursor(response.payload);
    const entries = [];
    while (cursor.remaining() > 0) {
      const name = cursor.string();
      const size = cursor.u32();
      const type = cursor.u8();
      const metaSize = cursor.u8();
      cursor.skip(metaSize);
      entries.push({
        name,
        size,
        type: type === 1 ? "DIR" : "FILE"
      });
    }

    return entries;
  }

  async createFolder(path) {
    const response = await this.sendCommand(0x17, encodeString(path));
    if (response.status !== 0) {
      throw new Error(`Create folder failed for ${path} with status ${response.status}.`);
    }
  }

  async removePath(path) {
    const response = await this.sendCommand(0x18, encodeString(path));
    if (response.status !== 0) {
      throw new Error(`Delete failed for ${path} with status ${response.status}.`);
    }
  }

  async renamePath(oldPath, newPath) {
    const response = await this.sendCommand(0x19, concatUint8Arrays(encodeString(oldPath), encodeString(newPath)));
    if (response.status !== 0) {
      throw new Error(`Rename failed for ${oldPath} -> ${newPath} with status ${response.status}.`);
    }
  }

  async openFile(path, mode) {
    const payload = concatUint8Arrays(
      encodeString(path),
      Uint8Array.of(mode === "r" ? 0x08 : 0x16)
    );

    const response = await this.sendCommand(0x12, payload);
    if (response.status !== 0) {
      throw new Error(`Open file failed for ${path} with status ${response.status}.`);
    }

    const cursor = new Cursor(response.payload);
    return cursor.u8();
  }

  async writeFileChunk(fileId, chunk) {
    const response = await this.sendCommand(0x15, concatUint8Arrays(Uint8Array.of(fileId), chunk));
    if (response.status !== 0) {
      throw new Error(`Write chunk failed with status ${response.status}.`);
    }
  }

  async closeFile(fileId) {
    const response = await this.sendCommand(0x13, Uint8Array.of(fileId));
    if (response.status !== 0) {
      throw new Error(`Close file failed with status ${response.status}.`);
    }
  }

  async ensureFolder(remotePath) {
    const root = remotePath.slice(0, 3);
    if (remotePath === root) {
      return;
    }

    const segments = remotePath.slice(3).split("/").filter(Boolean);
    let current = root;

    for (const segment of segments) {
      current = current === root ? `${root}${segment}` : `${current}/${segment}`;
      validateRemotePath(current, "folder");

      if (this.createdFolders.has(current)) {
        continue;
      }

      try {
        await this.createFolder(current);
        this.log(`Created ${current}`);
      } catch (error) {
        const parent = getParentRemotePath(current);
        const entries = await this.readFolder(parent);
        const exists = entries.some((entry) => entry.type === "DIR" && entry.name === getBaseName(current));
        if (!exists) {
          throw error;
        }
        this.log(`Using existing ${current}`);
      }

      this.createdFolders.add(current);
    }
  }

  async uploadFile(remotePath, file, onProgress) {
    validateRemotePath(remotePath, "file");
    const fileId = await this.openFile(remotePath, "w");
    const bytes = new Uint8Array(await file.arrayBuffer());

    try {
      if (bytes.length === 0) {
        onProgress(0, 0);
        return;
      }

      let offset = 0;
      while (offset < bytes.length) {
        if (state.abortRequested) {
          throw new Error("Upload aborted by user.");
        }

        const end = Math.min(offset + MAX_WRITE_CHUNK, bytes.length);
        await this.writeFileChunk(fileId, bytes.slice(offset, end));
        offset = end;
        onProgress(offset, bytes.length);
      }
    } finally {
      await this.closeFile(fileId);
    }
  }

  sendCommand(cmd, payload = new Uint8Array()) {
    const run = () => this.performCommand(cmd, payload);
    this.commandQueue = this.commandQueue.catch(() => undefined).then(run);
    return this.commandQueue;
  }

  async performCommand(cmd, payload) {
    if (!this.txCharacteristic) {
      throw new Error("Not connected to a BLE device.");
    }

    return new Promise(async (resolve, reject) => {
      this.pending = { resolve, reject, cmd };

      try {
        await this.writeFrame(cmd, payload);
      } catch (error) {
        this.pending = null;
        reject(error);
      }
    });
  }

  async writeFrame(cmd, payload) {
    const frame = new Uint8Array(FRAME_HEADER_SIZE + payload.length);
    frame[0] = cmd;
    frame[1] = 0;
    frame[2] = 0;
    frame[3] = 0;
    frame.set(payload, FRAME_HEADER_SIZE);

    if (typeof this.txCharacteristic.writeValueWithResponse === "function") {
      await this.txCharacteristic.writeValueWithResponse(frame);
      return;
    }

    await this.txCharacteristic.writeValue(frame);
  }

  handleNotification(event) {
    if (!this.pending) {
      return;
    }

    const incoming = new Uint8Array(
      event.target.value.buffer.slice(
        event.target.value.byteOffset,
        event.target.value.byteOffset + event.target.value.byteLength
      )
    );

    const chunk = incoming[2] | (incoming[3] << 8);
    const hasMore = (chunk & 0x8000) !== 0;

    if (hasMore) {
      if (!this.chunking) {
        this.rxParts = [incoming];
        this.chunking = true;
      } else {
        this.rxParts.push(incoming.slice(FRAME_HEADER_SIZE));
      }
      return;
    }

    let frame = incoming;
    if (this.chunking) {
      this.rxParts.push(incoming.slice(FRAME_HEADER_SIZE));
      frame = concatUint8Arrays(...this.rxParts);
      this.rxParts = [];
      this.chunking = false;
    }

    const response = {
      cmd: frame[0],
      status: frame[1],
      chunk: frame[2] | (frame[3] << 8),
      payload: frame.slice(FRAME_HEADER_SIZE)
    };

    const pending = this.pending;
    this.pending = null;

    if (response.cmd !== pending.cmd) {
      pending.reject(new Error(`Unexpected response 0x${response.cmd.toString(16)} for command 0x${pending.cmd.toString(16)}.`));
      return;
    }

    pending.resolve(response);
  }
}

function encodeString(value) {
  const bytes = encoder.encode(value);
  const output = new Uint8Array(2 + bytes.length);
  output[0] = bytes.length & 0xff;
  output[1] = (bytes.length >> 8) & 0xff;
  output.set(bytes, 2);
  return output;
}

function concatUint8Arrays(...chunks) {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const output = new Uint8Array(totalLength);
  let offset = 0;
  chunks.forEach((chunk) => {
    output.set(chunk, offset);
    offset += chunk.length;
  });
  return output;
}

function percentFromProgress(current, total) {
  if (!Number.isFinite(total) || total <= 0) {
    return 0;
  }
  const safeCurrent = Math.max(0, Math.min(current, total));
  return Math.round((safeCurrent / total) * 100);
}

function formatProgressCount(current, total) {
  const safeCurrent = Number.isFinite(current) ? Math.max(0, current) : 0;
  const safeTotal = Number.isFinite(total) ? Math.max(0, total) : 0;
  return `${safeCurrent} of ${safeTotal}`;
}

function formatItemCount(count, noun) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function nextFrame() {
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

async function yieldToBrowser(index, interval = 24) {
  if (index > 0 && index % interval === 0) {
    await nextFrame();
  }
}

function normalizeRemoteBasePath(input) {
  let value = (input || "/").trim().replace(/\\/g, "/");
  if (!value.startsWith("/")) {
    value = `/${value}`;
  }
  value = value.replace(/\/+/g, "/");
  if (value.length > 1 && value.endsWith("/")) {
    value = value.slice(0, -1);
  }
  return value || "/";
}

function joinRemotePath(drive, basePath, relativePath) {
  const normalizedBase = normalizeRemoteBasePath(basePath);
  const cleanedDrive = drive.endsWith(":") ? drive.slice(0, -1) : drive;
  const root = `${cleanedDrive}:${normalizedBase}`;
  const cleanedRelative = (relativePath || "").replace(/\\/g, "/").split("/").filter(Boolean).join("/");
  if (!cleanedRelative) {
    return root;
  }
  return root.endsWith("/") ? `${root}${cleanedRelative}` : `${root}/${cleanedRelative}`;
}

function getBaseName(path) {
  const parts = path.split("/").filter(Boolean);
  return parts.length === 0 ? "" : parts[parts.length - 1];
}

function getParentRemotePath(path) {
  const index = path.lastIndexOf("/");
  return index <= 2 ? path.slice(0, 3) : path.slice(0, index);
}

function getDriveRoot(drive) {
  return drive ? `${drive}:/` : "";
}

function joinRemoteChildPath(parentPath, childName) {
  const normalizedChild = String(childName || "").replace(/^\/+|\/+$/g, "");
  if (!normalizedChild) {
    return parentPath;
  }
  return parentPath.endsWith("/") ? `${parentPath}${normalizedChild}` : `${parentPath}/${normalizedChild}`;
}

function normalizeAbsoluteRemoteFolderPath(input, drive = getSelectedDrive()) {
  const root = getDriveRoot(drive);
  if (!root) {
    return "";
  }

  let value = (input || root).trim().replace(/\\/g, "/");
  if (!value) {
    return root;
  }

  const absoluteMatch = value.match(/^([A-Za-z]):(.*)$/);
  if (absoluteMatch) {
    const requestedDrive = absoluteMatch[1].toUpperCase();
    if (drive && requestedDrive !== drive.toUpperCase()) {
      throw new Error(`Selected drive is ${drive}:/, but requested path is ${requestedDrive}:/.`);
    }

    let rest = absoluteMatch[2] || "/";
    if (!rest.startsWith("/")) {
      rest = `/${rest}`;
    }
    rest = rest.replace(/\/+/g, "/");
    if (rest.length > 1 && rest.endsWith("/")) {
      rest = rest.slice(0, -1);
    }
    return `${requestedDrive}:${rest || "/"}`;
  }

  return joinRemotePath(drive, value.startsWith("/") ? value : `/${value}`, "");
}

function sortRemoteEntries(entries) {
  return [...entries].sort((left, right) => {
    if (left.type !== right.type) {
      return left.type === "DIR" ? -1 : 1;
    }
    return left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" });
  });
}

function utf8Length(value) {
  return encoder.encode(value).length;
}

function validateRemotePath(path, kind) {
  const fullLimit = kind === "folder" ? MAX_FOLDER_PATH_BYTES : MAX_FILE_PATH_BYTES;
  const length = utf8Length(path);
  if (length > fullLimit) {
    throw new Error(`${kind === "folder" ? "Folder" : "File"} path is ${length} bytes. The current firmware allows at most ${fullLimit} UTF-8 bytes for this type: ${path}`);
  }

  const baseName = getBaseName(path);
  if (baseName && utf8Length(baseName) > MAX_FILE_NAME_BYTES) {
    throw new Error(`Path segment exceeds ${MAX_FILE_NAME_BYTES} UTF-8 bytes: ${baseName}`);
  }
}

function formatBytes(bytes) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(2)} KB`;
  }
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function invalidateClientFolderCache() {
  if (state.client) {
    state.client.createdFolders.clear();
  }
}

function getActivityBadgeTone(status) {
  switch (status) {
    case "running":
      return "active";
    case "success":
      return "done";
    case "warning":
      return "aborted";
    case "error":
      return "error";
    default:
      return "pending";
  }
}

function getActivityBadgeLabel(status) {
  switch (status) {
    case "running":
      return "Working";
    case "success":
      return "Complete";
    case "warning":
      return "Needs review";
    case "error":
      return "Error";
    default:
      return "Ready";
  }
}

function applyStatusPill(element, tone, label) {
  element.className = `status-pill ${tone}`;
  element.textContent = label;
}

function renderActivityStatus() {
  elements.activityStatusCard.dataset.state = state.activity.status;
  elements.activityPhaseLabel.textContent = state.activity.phaseLabel;
  elements.activityOperationTitle.textContent = state.activity.title;
  elements.activityProgressCount.textContent = formatProgressCount(state.activity.current, state.activity.total);
  elements.activityProgressDetail.textContent = state.activity.detail;
  elements.activityProgressLabel.textContent = state.activity.progressLabel;
  elements.activityProgressPercent.textContent = `${state.activity.percent}%`;
  elements.activityProgressBar.style.width = `${state.activity.percent}%`;
  applyStatusPill(elements.activityStatusBadge, getActivityBadgeTone(state.activity.status), getActivityBadgeLabel(state.activity.status));

  elements.activityOutcomeBanner.hidden = !state.activity.outcome.visible;
  elements.activityOutcomeTitle.textContent = state.activity.outcome.title;
  elements.activityOutcomeText.textContent = state.activity.outcome.text;
}

function setActivityStatus(patch) {
  const outcome = state.activity.outcome;
  const nextState = {
    ...state.activity,
    ...patch,
    outcome
  };
  nextState.percent = Object.prototype.hasOwnProperty.call(patch, "percent")
    ? patch.percent
    : percentFromProgress(nextState.current, nextState.total);
  state.activity = nextState;
  renderActivityStatus();
}

function resetActivityStatus() {
  const outcome = state.activity.outcome;
  state.activity = {
    ...createDefaultActivityState(),
    outcome
  };
  renderActivityStatus();
}

function clearActivityOutcome() {
  state.activity.outcome = createDefaultActivityState().outcome;
  renderActivityStatus();
}

function showActivityOutcome(title, text, status = null) {
  state.activity.outcome = {
    visible: true,
    title,
    text
  };
  if (status) {
    state.activity.status = status;
  }
  renderActivityStatus();
}

function renderManagerOutcome() {
  elements.managerOutcomeBanner.hidden = !state.manager.outcome.visible;
  elements.managerOutcomeTitle.textContent = state.manager.outcome.title;
  elements.managerOutcomeText.textContent = state.manager.outcome.text;
}

function clearManagerOutcome() {
  state.manager.outcome = createDefaultManagerOutcome();
  renderManagerOutcome();
}

function showManagerOutcome(title, text) {
  state.manager.outcome = {
    visible: true,
    title,
    text
  };
  renderManagerOutcome();
}

function renderManagerBusyState() {
  elements.managerBusyState.hidden = !state.manager.busy;
  elements.managerBrowserShell.hidden = state.manager.busy;
  elements.managerBusyEyebrow.textContent = state.manager.busyState.eyebrow;
  elements.managerBusyTitle.textContent = state.manager.busyState.title;
  elements.managerBusyCount.textContent = formatProgressCount(state.manager.busyState.current, state.manager.busyState.total);
  elements.managerBusyPhase.textContent = state.manager.busyState.phase;
  elements.managerBusyLabel.textContent = state.manager.busyState.label;
  elements.managerBusyPercent.textContent = `${state.manager.busyState.percent}%`;
  elements.managerBusyBar.style.width = `${state.manager.busyState.percent}%`;
  applyStatusPill(elements.managerBusyBadge, state.manager.busyState.badgeTone, state.manager.busyState.badgeLabel);
}

function syncActivityFromManagerBusy() {
  setActivityStatus({
    status: "running",
    phaseLabel: state.manager.busyState.eyebrow,
    title: state.manager.busyState.title,
    detail: state.manager.busyState.label,
    progressLabel: state.manager.busyState.phase,
    current: state.manager.busyState.current,
    total: state.manager.busyState.total,
    percent: state.manager.busyState.percent
  });
}

function beginManagerBusy(patch) {
  clearManagerOutcome();
  clearActivityOutcome();
  state.manager.busy = true;
  state.manager.busyState = {
    ...createDefaultManagerBusyState(),
    ...patch
  };
  state.manager.busyState.percent = Object.prototype.hasOwnProperty.call(patch, "percent")
    ? patch.percent
    : percentFromProgress(state.manager.busyState.current, state.manager.busyState.total);
  syncActivityFromManagerBusy();
  renderManager();
  updateControls();
}

function updateManagerBusy(patch) {
  state.manager.busyState = {
    ...state.manager.busyState,
    ...patch
  };
  state.manager.busyState.percent = Object.prototype.hasOwnProperty.call(patch, "percent")
    ? patch.percent
    : percentFromProgress(state.manager.busyState.current, state.manager.busyState.total);
  syncActivityFromManagerBusy();
  renderManager();
}

function endManagerBusy() {
  state.manager.busy = false;
  state.manager.busyState = createDefaultManagerBusyState();
  renderManager();
  updateControls();
}

function log(message) {
  const now = new Date();
  const stamp = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  elements.logOutput.textContent += `${elements.logOutput.textContent ? "\n" : ""}[${stamp}] ${message}`;
  elements.logOutput.scrollTop = elements.logOutput.scrollHeight;
}

function clearLog() {
  elements.logOutput.textContent = "Ready.";
}

function getSelectedManagerEntries() {
  if (state.manager.selectedPaths.length === 0) {
    return [];
  }

  const selectedSet = new Set(state.manager.selectedPaths);
  return state.manager.entries.filter((entry) => selectedSet.has(entry.fullPath));
}

function setManagerSelection(paths) {
  const allowedPaths = new Set(state.manager.entries.map((entry) => entry.fullPath));
  const nextPaths = new Set(paths.filter((path) => allowedPaths.has(path)));
  state.manager.selectedPaths = state.manager.entries
    .filter((entry) => nextPaths.has(entry.fullPath))
    .map((entry) => entry.fullPath);
}

function isManagerEntrySelected(path) {
  return state.manager.selectedPaths.includes(path);
}

function toggleManagerSelection(path, forceSelected = !isManagerEntrySelected(path)) {
  const nextPaths = new Set(state.manager.selectedPaths);
  if (forceSelected) {
    nextPaths.add(path);
  } else {
    nextPaths.delete(path);
  }
  setManagerSelection([...nextPaths]);
}

function selectAllManagerEntries() {
  if (!state.manager.loaded || state.manager.entries.length === 0 || state.manager.busy) {
    return;
  }

  setManagerSelection(state.manager.entries.map((entry) => entry.fullPath));
  renderManager();
  updateControls();
}

function clearManagerSelection() {
  if (state.manager.selectedPaths.length === 0) {
    return;
  }

  state.manager.selectedPaths = [];
  renderManager();
  updateControls();
}

function formatManagerSelectionInfo(selectedEntries) {
  if (selectedEntries.length === 0) {
    return "Nothing selected";
  }

  if (selectedEntries.length === 1) {
    const [entry] = selectedEntries;
    return `${entry.type === "DIR" ? "Folder" : "File"}: ${entry.name}`;
  }

  const folderCount = selectedEntries.filter((entry) => entry.type === "DIR").length;
  const fileCount = selectedEntries.length - folderCount;
  const detailParts = [];

  if (folderCount > 0) {
    detailParts.push(formatItemCount(folderCount, "folder"));
  }
  if (fileCount > 0) {
    detailParts.push(formatItemCount(fileCount, "file"));
  }

  return `${formatItemCount(selectedEntries.length, "item")} selected, ${detailParts.join(", ")}`;
}

function sanitizeRemoteEntryName(name) {
  return String(name || "").toLowerCase();
}

function buildSanitizeOperations(entries, parentPath) {
  const operations = [];
  const skipped = [];
  const existingNames = new Set(entries.map((entry) => entry.name));
  const candidateGroups = new Map();

  entries.forEach((entry) => {
    const sanitizedName = sanitizeRemoteEntryName(entry.name);
    if (!sanitizedName || sanitizedName === entry.name) {
      return;
    }

    if (!candidateGroups.has(sanitizedName)) {
      candidateGroups.set(sanitizedName, []);
    }

    candidateGroups.get(sanitizedName).push(entry);
  });

  candidateGroups.forEach((group, sanitizedName) => {
    if (group.length > 1) {
      group.forEach((entry) => {
        skipped.push({
          path: joinRemoteChildPath(parentPath, entry.name),
          reason: `multiple names would become ${sanitizedName}`
        });
      });
      return;
    }

    const [entry] = group;
    if (existingNames.has(sanitizedName)) {
      skipped.push({
        path: joinRemoteChildPath(parentPath, entry.name),
        reason: `target name ${sanitizedName} already exists`
      });
      return;
    }

    const currentPath = joinRemoteChildPath(parentPath, entry.name);
    const nextPath = joinRemoteChildPath(parentPath, sanitizedName);
    const kind = entry.type === "DIR" ? "folder" : "file";

    try {
      validateRemotePath(nextPath, kind);
    } catch (error) {
      skipped.push({
        path: currentPath,
        reason: error.message
      });
      return;
    }

    operations.push({
      from: currentPath,
      to: nextPath,
      type: entry.type
    });
  });

  return {
    operations,
    skipped
  };
}

function summarizeSanitizeSkips(skipped) {
  const summary = {
    collisionCount: 0,
    pathLimitCount: 0,
    otherCount: 0
  };

  skipped.forEach((item) => {
    if (item.reason.includes("already exists") || item.reason.includes("would become")) {
      summary.collisionCount += 1;
    } else if (item.reason.includes("bytes") || item.reason.includes("at most") || item.reason.includes("exceeds")) {
      summary.pathLimitCount += 1;
    } else {
      summary.otherCount += 1;
    }
  });

  return summary;
}

function buildSanitizeOutcomeText(renamedCount, skipped) {
  const parts = [`Updated ${formatItemCount(renamedCount, "name")}.`];
  if (skipped.length === 0) {
    return parts.join(" ");
  }

  const summary = summarizeSanitizeSkips(skipped);
  const reasonParts = [];
  if (summary.collisionCount > 0) {
    reasonParts.push(`${formatItemCount(summary.collisionCount, "collision")}`);
  }
  if (summary.pathLimitCount > 0) {
    reasonParts.push(`${formatItemCount(summary.pathLimitCount, "path-limit issue")}`);
  }
  if (summary.otherCount > 0) {
    reasonParts.push(`${formatItemCount(summary.otherCount, "other issue")}`);
  }

  parts.push(`Skipped ${formatItemCount(skipped.length, "item")}${reasonParts.length > 0 ? `, ${reasonParts.join(", ")}` : ""}.`);
  return parts.join(" ");
}

function logSanitizeSkips(skipped) {
  if (skipped.length === 0) {
    return;
  }

  const previewCount = Math.min(skipped.length, 6);
  for (const item of skipped.slice(0, previewCount)) {
    log(`Skipped ${item.path}, ${item.reason}.`);
  }

  if (skipped.length > previewCount) {
    log(`Skipped ${skipped.length - previewCount} more item${skipped.length - previewCount === 1 ? "" : "s"} during name cleanup.`);
  }
}

function sortManagerEntriesForDelete(entries) {
  return [...entries].sort((left, right) => {
    const depthDifference = right.fullPath.split("/").length - left.fullPath.split("/").length;
    if (depthDifference !== 0) {
      return depthDifference;
    }

    if (left.type !== right.type) {
      return left.type === "FILE" ? -1 : 1;
    }

    return left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" });
  });
}

function canManagerGoUp() {
  const drive = getSelectedDrive();
  if (!drive || !state.manager.currentPath) {
    return false;
  }
  return state.manager.currentPath !== getDriveRoot(drive);
}

function resetManagerState() {
  state.manager.currentPath = "";
  state.manager.entries = [];
  state.manager.selectedPaths = [];
  state.manager.loaded = false;
  state.manager.busy = false;
  state.manager.busyState = createDefaultManagerBusyState();
  state.manager.outcome = createDefaultManagerOutcome();
}

function syncManagerPathWithDrive(forceRoot = false) {
  const drive = getSelectedDrive();
  if (!drive) {
    resetManagerState();
    elements.managerPathInput.value = "";
    return;
  }

  const root = getDriveRoot(drive);
  if (forceRoot || !state.manager.currentPath || !state.manager.currentPath.startsWith(`${drive}:`)) {
    state.manager.currentPath = root;
    state.manager.entries = [];
    state.manager.selectedPaths = [];
    state.manager.loaded = false;
  }

  elements.managerPathInput.value = state.manager.currentPath;
}

function setConnected(connected) {
  state.connected = connected;
  elements.connectionState.textContent = connected ? "Connected" : "Not connected";
  elements.connectButton.textContent = connected ? "Disconnect device" : "Connect device";
  updateControls();

  if (!connected) {
    state.drives = [];
    elements.firmwareVersion.textContent = "-";
    elements.bleAddress.textContent = "-";
    resetManagerState();
    renderDriveOptions();
    renderManager();
  }
}

function updateControls() {
  const hasPlan = state.plan.length > 0;
  const hasDrive = Boolean(getSelectedDrive());
  const repoBusy = state.uploadActive || state.manager.busy;
  const managerReady = state.connected && hasDrive && !state.uploadActive;
  const selectedCount = state.manager.selectedPaths.length;
  const allSelected = state.manager.loaded && state.manager.entries.length > 0 && selectedCount === state.manager.entries.length;

  elements.modeUploaderButton.disabled = repoBusy;
  elements.modeManagerButton.disabled = repoBusy;

  elements.refreshButton.disabled = !state.connected || repoBusy;
  elements.driveSelect.disabled = !state.connected || repoBusy;
  elements.remoteBaseInput.disabled = !state.connected || repoBusy;
  elements.createPathButton.disabled = !state.connected || repoBusy;

  elements.pickFolderButton.disabled = !state.connected || repoBusy;
  elements.pickFilesButton.disabled = !state.connected || repoBusy;
  elements.startUploadButton.disabled = !state.connected || !hasPlan || repoBusy;
  elements.abortButton.disabled = !state.uploadActive;
  elements.clearPlanButton.disabled = repoBusy || !hasPlan;

  elements.managerPathInput.disabled = !managerReady || state.manager.busy;
  elements.managerOpenButton.disabled = !managerReady || state.manager.busy;
  elements.managerRefreshButton.disabled = !managerReady || state.manager.busy;
  elements.managerUpButton.disabled = !managerReady || state.manager.busy || !canManagerGoUp();
  elements.managerUsePathButton.disabled = !managerReady || !state.manager.currentPath;
  elements.managerFolderNameInput.disabled = !managerReady || state.manager.busy;
  elements.managerCreateFolderButton.disabled = !managerReady || state.manager.busy || !elements.managerFolderNameInput.value.trim();
  elements.managerSanitizeButton.disabled = !managerReady || state.manager.busy || !state.manager.loaded || state.manager.entries.length === 0;
  elements.managerSelectAllButton.disabled = !managerReady || state.manager.busy || !state.manager.loaded || state.manager.entries.length === 0 || allSelected;
  elements.managerClearSelectionButton.disabled = !managerReady || state.manager.busy || selectedCount === 0;
  elements.managerDeleteButton.disabled = !managerReady || state.manager.busy || selectedCount === 0;
  elements.managerDeleteButton.textContent = selectedCount > 0 ? `Delete ${selectedCount} selected` : "Delete selected";
}

function renderDriveOptions() {
  elements.driveSelect.innerHTML = "";
  if (!state.drives.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = state.connected ? "No writable drives found" : "Connect first";
    elements.driveSelect.appendChild(option);
    syncManagerPathWithDrive();
    return;
  }

  state.drives.forEach((drive, index) => {
    const option = document.createElement("option");
    option.value = drive.label;
    option.textContent = `${drive.label}:/ ${drive.name} ${drive.status === 0 ? `(${formatBytes(drive.usedBytes)}/${formatBytes(drive.totalBytes)})` : `(status ${drive.status})`}`;
    option.disabled = drive.status !== 0;
    if (index === 0) {
      option.selected = true;
    }
    elements.driveSelect.appendChild(option);
  });

  syncManagerPathWithDrive();
}

function getSelectedDrive() {
  return elements.driveSelect.value;
}

function resetPlan() {
  state.plan = [];
  state.queuedFolders = [];
  state.queuedFiles = [];
  state.itemSeed = 0;
  renderPlan();
  renderSummary();
  updateControls();
}

function buildUploadPlanSummaryText() {
  return `Plan ready: ${formatItemCount(state.queuedFolders.length, "folder")} and ${formatItemCount(state.queuedFiles.length, "file")} for ${getSelectedDrive() || "?"}:${normalizeRemoteBasePath(elements.remoteBaseInput.value)}.`;
}

function renderSummary() {
  const totalBytes = state.queuedFiles.reduce((sum, file) => sum + file.file.size, 0);
  elements.folderCount.textContent = `${state.queuedFolders.length}`;
  elements.fileCount.textContent = `${state.queuedFiles.length}`;
  elements.totalBytes.textContent = formatBytes(totalBytes);
  elements.queueStats.textContent = `${state.plan.length} queued item${state.plan.length === 1 ? "" : "s"}`;

  if (state.plan.length === 0) {
    elements.selectionSummary.textContent = "Choose a folder or files to build an upload plan.";
  } else {
    elements.selectionSummary.textContent = buildUploadPlanSummaryText();
  }

  updateOverallProgress();
}

function setMode(mode) {
  state.mode = mode;
  const uploaderActive = mode === "uploader";

  elements.modeUploaderButton.classList.toggle("active", uploaderActive);
  elements.modeUploaderButton.classList.toggle("secondary", !uploaderActive);
  elements.modeManagerButton.classList.toggle("active", !uploaderActive);
  elements.modeManagerButton.classList.toggle("secondary", uploaderActive);
  elements.modeUploaderButton.setAttribute("aria-selected", uploaderActive ? "true" : "false");
  elements.modeManagerButton.setAttribute("aria-selected", uploaderActive ? "false" : "true");
  elements.modeDescription.textContent = uploaderActive ? "Tree uploader selected" : "File manager selected";

  elements.uploaderBaseField.hidden = !uploaderActive;
  elements.uploaderBaseActions.hidden = !uploaderActive;
  elements.treeUploaderPanel.hidden = !uploaderActive;
  elements.uploadPlanPanel.hidden = !uploaderActive;
  elements.fileManagerPanel.hidden = uploaderActive;

  if (!uploaderActive && state.connected && getSelectedDrive() && !state.manager.loaded) {
    refreshManagerFolder(state.manager.currentPath || getDriveRoot(getSelectedDrive()));
  }

  updateControls();
}

function updateOverallProgress() {
  const totalBytes = state.plan
    .filter((item) => item.kind === "file")
    .reduce((sum, item) => sum + item.size, 0);
  const uploadedBytes = state.plan
    .filter((item) => item.kind === "file")
    .reduce((sum, item) => sum + Math.min(item.transferred || 0, item.size), 0);

  const percent = totalBytes === 0 ? 0 : Math.round((uploadedBytes / totalBytes) * 100);
  elements.overallProgressLabel.textContent = `${formatBytes(uploadedBytes)} of ${formatBytes(totalBytes)}`;
  elements.overallProgressPercent.textContent = `${percent}%`;
  elements.overallProgressBar.style.width = `${percent}%`;
}

function renderPlan() {
  if (state.plan.length === 0) {
    elements.planTableBody.innerHTML = '<tr><td colspan="6" class="empty-state">Choose a folder or files after connecting to build an upload plan.</td></tr>';
    return;
  }

  elements.planTableBody.innerHTML = state.plan.map((item) => `
    <tr data-item-id="${item.id}">
      <td><span class="kind-pill ${item.kind}">${item.kind === "folder" ? "Folder" : "File"}</span></td>
      <td class="path-cell">${escapeHtml(item.localPath || "-")}</td>
      <td class="path-cell">${escapeHtml(item.remotePath)}</td>
      <td>${item.kind === "file" ? escapeHtml(formatBytes(item.size)) : '<span class="muted">-</span>'}</td>
      <td class="status-cell">${renderStatusPill(item.status, item.message)}</td>
      <td>
        ${item.kind === "file" ? `
          <div class="row-progress-track"><div class="row-progress-bar" style="width: ${item.size === 0 ? (item.status === "done" ? 100 : 0) : Math.round(((item.transferred || 0) / item.size) * 100)}%"></div></div>
        ` : '<span class="muted">-</span>'}
      </td>
    </tr>
  `).join("");
}

function renderManager() {
  const drive = getSelectedDrive();
  const currentPath = state.manager.currentPath || (drive ? getDriveRoot(drive) : "-");
  const selectedEntries = getSelectedManagerEntries();

  elements.managerCurrentPath.textContent = currentPath;
  elements.managerEntryCount.textContent = `${state.manager.entries.length}`;
  elements.managerSelectionInfo.textContent = formatManagerSelectionInfo(selectedEntries);

  renderManagerBusyState();
  renderManagerOutcome();

  if (!state.connected) {
    elements.managerStatusLabel.textContent = "Connect to a device and choose a drive to browse.";
    elements.managerBrowserShell.hidden = false;
    elements.managerTableBody.innerHTML = '<tr><td colspan="5" class="empty-state">Connect to get started.</td></tr>';
    return;
  }

  if (!drive) {
    elements.managerStatusLabel.textContent = "Choose a writable drive to browse.";
    elements.managerBrowserShell.hidden = false;
    elements.managerTableBody.innerHTML = '<tr><td colspan="5" class="empty-state">No writable drive found.</td></tr>';
    return;
  }

  if (state.manager.busy) {
    elements.managerStatusLabel.textContent = state.manager.busyState.title;
    return;
  }

  elements.managerStatusLabel.textContent = currentPath;
  elements.managerBrowserShell.hidden = false;

  if (!state.manager.loaded) {
    elements.managerTableBody.innerHTML = '<tr><td colspan="5" class="empty-state">Open a folder to load its contents.</td></tr>';
    return;
  }

  if (state.manager.entries.length === 0) {
    elements.managerTableBody.innerHTML = '<tr><td colspan="5" class="empty-state">This folder is empty.</td></tr>';
    return;
  }

  elements.managerTableBody.innerHTML = state.manager.entries.map((entry) => `
    <tr class="row-selectable ${isManagerEntrySelected(entry.fullPath) ? "is-selected" : ""}" data-path="${escapeHtml(entry.fullPath)}">
      <td class="selection-cell"><input type="checkbox" class="selection-toggle" data-action="toggle-selection" data-path="${escapeHtml(entry.fullPath)}" aria-label="Select ${escapeHtml(entry.name)}" ${isManagerEntrySelected(entry.fullPath) ? "checked" : ""}></td>
      <td class="path-cell">${entry.type === "DIR" ? `<button type="button" class="table-link" data-action="open" data-path="${escapeHtml(entry.fullPath)}">${escapeHtml(entry.name)}</button>` : escapeHtml(entry.name)}</td>
      <td><span class="kind-pill ${entry.type === "DIR" ? "folder" : "file"}">${entry.type === "DIR" ? "Folder" : "File"}</span></td>
      <td>${entry.type === "DIR" ? '<span class="muted">-</span>' : escapeHtml(formatBytes(entry.size))}</td>
      <td>${entry.type === "DIR" ? `<button type="button" class="secondary table-action" data-action="open" data-path="${escapeHtml(entry.fullPath)}">Open</button>` : '<span class="muted">-</span>'}</td>
    </tr>
  `).join("");
}

function renderStatusPill(status, message) {
  const labelMap = {
    pending: "Pending",
    active: "Running",
    done: "Done",
    error: "Error",
    aborted: "Aborted"
  };
  const label = labelMap[status] || status;
  const title = message ? ` title="${escapeHtml(message)}"` : "";
  return `<span class="status-pill ${status}"${title}>${label}</span>`;
}

function updatePlanItem(item) {
  const row = elements.planTableBody.querySelector(`[data-item-id="${item.id}"]`);
  if (!row) {
    return;
  }

  const statusCell = row.querySelector(".status-cell");
  statusCell.innerHTML = renderStatusPill(item.status, item.message);

  if (item.kind === "file") {
    const bar = row.querySelector(".row-progress-bar");
    const percent = item.size === 0 ? (item.status === "done" ? 100 : 0) : Math.round(((item.transferred || 0) / item.size) * 100);
    bar.style.width = `${percent}%`;
  }

  updateOverallProgress();
}

function sortByDepth(paths) {
  return paths.sort((left, right) => {
    const depthDifference = left.split("/").length - right.split("/").length;
    return depthDifference !== 0 ? depthDifference : left.localeCompare(right);
  });
}

function makePlanItem(kind, localPath, remotePath, size, file) {
  state.itemSeed += 1;
  return {
    id: state.itemSeed,
    kind,
    localPath,
    remotePath,
    size,
    file,
    transferred: 0,
    status: "pending",
    message: ""
  };
}

function queuePlan(folders, files) {
  const drive = getSelectedDrive();
  if (!drive) {
    throw new Error("Select a writable remote drive before preparing an upload plan.");
  }

  const basePath = normalizeRemoteBasePath(elements.remoteBaseInput.value);
  const folderItems = sortByDepth(Array.from(folders)).map((relativePath) => {
    const remotePath = joinRemotePath(drive, basePath, relativePath);
    validateRemotePath(remotePath, "folder");
    return makePlanItem("folder", relativePath, remotePath, 0, null);
  });

  const fileItems = files.map((entry) => {
    const remotePath = joinRemotePath(drive, basePath, entry.relativePath);
    validateRemotePath(remotePath, "file");
    return makePlanItem("file", entry.relativePath, remotePath, entry.file.size, entry.file);
  });

  state.queuedFolders = folderItems;
  state.queuedFiles = fileItems;
  state.plan = [...folderItems, ...fileItems];
  renderPlan();
  renderSummary();
  updateControls();
}

function collectFoldersFromRelativePath(relativePath, set) {
  const parts = relativePath.split("/").filter(Boolean);
  for (let index = 1; index < parts.length; index += 1) {
    set.add(parts.slice(0, index).join("/"));
  }
}

async function countDirectoryEntries(handle) {
  let total = 0;
  for await (const [, child] of handle.entries()) {
    total += 1;
    if (child.kind === "directory") {
      total += await countDirectoryEntries(child);
    }
  }
  return total;
}

async function collectFromDirectoryHandle(handle, preserveRoot, onProgress) {
  const folders = new Set();
  const files = [];
  const totalEntries = await countDirectoryEntries(handle);
  const basePrefix = preserveRoot ? handle.name : "";
  let processed = 0;

  async function walk(dirHandle, prefix) {
    if (prefix) {
      folders.add(prefix);
    }

    for await (const [name, child] of dirHandle.entries()) {
      const relativePath = prefix ? `${prefix}/${name}` : name;
      processed += 1;
      onProgress(processed, totalEntries, relativePath);
      await yieldToBrowser(processed, 12);

      if (child.kind === "directory") {
        folders.add(relativePath);
        await walk(child, relativePath);
      } else {
        const file = await child.getFile();
        files.push({ relativePath, file });
        collectFoldersFromRelativePath(relativePath, folders);
      }
    }
  }

  await walk(handle, basePrefix);
  return { folders, files, totalEntries };
}

async function collectFromWebkitDirectory(fileList, preserveRoot, onProgress) {
  const folders = new Set();
  const collectedFiles = [];
  const files = Array.from(fileList);

  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    const rawPath = file.webkitRelativePath || file.name;
    const segments = rawPath.split("/").filter(Boolean);
    const relativeSegments = preserveRoot ? segments : segments.slice(1);
    const relativePath = relativeSegments.length > 0 ? relativeSegments.join("/") : file.name;
    collectedFiles.push({ relativePath, file });
    collectFoldersFromRelativePath(relativePath, folders);
    onProgress(index + 1, files.length, relativePath);
    await yieldToBrowser(index + 1, 48);
  }

  return {
    folders,
    files: collectedFiles,
    totalEntries: files.length
  };
}

async function collectFromFileList(fileList, onProgress) {
  const files = Array.from(fileList);
  const collectedFiles = [];

  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    collectedFiles.push({ relativePath: file.name, file });
    onProgress(index + 1, files.length, file.name);
    await yieldToBrowser(index + 1, 48);
  }

  return {
    folders: new Set(),
    files: collectedFiles,
    totalEntries: files.length
  };
}

async function finalizeCollectedSelection(collected, sourceLabel) {
  try {
    queuePlan(collected.folders, collected.files);
    const totalItems = state.plan.length;
    const detail = `${buildUploadPlanSummaryText()} Review the plan, then start the upload.`;
    log(sourceLabel);
    setActivityStatus({
      status: "success",
      phaseLabel: "Plan ready",
      title: "Upload plan ready",
      detail,
      progressLabel: "Ready to upload",
      current: totalItems,
      total: totalItems
    });
    showActivityOutcome("Upload plan ready", detail, "success");
  } catch (error) {
    log(error.message);
    setActivityStatus({
      status: "error",
      phaseLabel: "Plan blocked",
      title: "Cannot build the upload plan",
      detail: error.message,
      progressLabel: "Validation failed",
      current: 0,
      total: 1
    });
    showActivityOutcome("Upload plan blocked", error.message, "error");
  }
}

function handleDriveChange() {
  invalidateClientFolderCache();
  clearManagerOutcome();
  renderSummary();
  syncManagerPathWithDrive(true);
  renderManager();

  if (state.mode === "manager" && state.connected && getSelectedDrive()) {
    refreshManagerFolder(state.manager.currentPath);
  }
}

async function loadManagerFolderData(normalizedPath) {
  const entries = await state.client.readFolder(normalizedPath);
  state.manager.currentPath = normalizedPath;
  state.manager.entries = sortRemoteEntries(entries).map((entry) => ({
    ...entry,
    fullPath: joinRemoteChildPath(normalizedPath, entry.name)
  }));
  state.manager.selectedPaths = [];
  state.manager.loaded = true;
  elements.managerPathInput.value = normalizedPath;
  return entries;
}

async function loadManagerEntriesForPath(folderPath) {
  if (state.manager.loaded && state.manager.currentPath === folderPath) {
    return state.manager.entries;
  }

  const entries = await state.client.readFolder(folderPath);
  return sortRemoteEntries(entries).map((entry) => ({
    ...entry,
    fullPath: joinRemoteChildPath(folderPath, entry.name)
  }));
}

async function collectRemoteFolderSnapshots(rootPath, recursive, onProgress) {
  const snapshots = [];
  const queue = [rootPath];
  let processed = 0;

  while (queue.length > 0) {
    const folderPath = queue.shift();
    const entries = await loadManagerEntriesForPath(folderPath);
    snapshots.push({ path: folderPath, entries });
    processed += 1;

    if (recursive) {
      entries
        .filter((entry) => entry.type === "DIR")
        .forEach((entry) => {
          queue.push(entry.fullPath);
        });
    }

    onProgress(processed, Math.max(processed, processed + queue.length), folderPath);
    await yieldToBrowser(processed, 6);
  }

  return snapshots;
}

function buildSanitizePlanFromSnapshots(snapshots) {
  const fileOperations = [];
  const directoryOperations = [];
  const skipped = [];

  snapshots.forEach((snapshot) => {
    const result = buildSanitizeOperations(snapshot.entries, snapshot.path);
    skipped.push(...result.skipped);
    result.operations.forEach((operation) => {
      if (operation.type === "FILE") {
        fileOperations.push(operation);
      } else {
        directoryOperations.push(operation);
      }
    });
  });

  directoryOperations.sort((left, right) => {
    const depthDifference = right.from.split("/").length - left.from.split("/").length;
    if (depthDifference !== 0) {
      return depthDifference;
    }
    return left.from.localeCompare(right.from, undefined, { numeric: true, sensitivity: "base" });
  });

  return {
    operations: [...fileOperations, ...directoryOperations],
    skipped
  };
}

async function refreshManagerFolder(targetPath = state.manager.currentPath || getDriveRoot(getSelectedDrive())) {
  if (!state.client || !state.connected) {
    return;
  }

  const drive = getSelectedDrive();
  if (!drive) {
    const message = "Choose a drive before browsing device storage.";
    log(message);
    setActivityStatus({
      status: "error",
      phaseLabel: "Browse unavailable",
      title: "No drive selected",
      detail: message,
      progressLabel: "Cannot browse",
      current: 0,
      total: 1
    });
    showActivityOutcome("Browse unavailable", message, "error");
    return;
  }

  let normalizedPath;
  try {
    normalizedPath = normalizeAbsoluteRemoteFolderPath(targetPath, drive);
    if (normalizedPath !== getDriveRoot(drive)) {
      validateRemotePath(normalizedPath, "folder");
    }
  } catch (error) {
    log(error.message);
    showManagerOutcome("Cannot open folder", error.message);
    setActivityStatus({
      status: "error",
      phaseLabel: "Browse failed",
      title: "That device folder cannot be opened",
      detail: `${error.message} Check the selected drive and folder path, then try again.`,
      progressLabel: "Path validation failed",
      current: 0,
      total: 1
    });
    showActivityOutcome("Browse failed", error.message, "error");
    return;
  }

  beginManagerBusy({
    eyebrow: "Loading device folder",
    title: `Loading ${normalizedPath}`,
    phase: "Reading folder contents",
    label: normalizedPath,
    current: 0,
    total: 1
  });

  try {
    const entries = await loadManagerFolderData(normalizedPath);
    updateManagerBusy({
      title: `Loaded ${normalizedPath}`,
      phase: "Folder loaded",
      label: `${formatItemCount(entries.length, "entry")} available`,
      current: 1,
      total: 1
    });
    log(`Loaded ${normalizedPath} (${entries.length} entries).`);
    endManagerBusy();
    setActivityStatus({
      status: "success",
      phaseLabel: "Folder loaded",
      title: `Loaded ${normalizedPath}`,
      detail: `${formatItemCount(entries.length, "entry")} loaded for the current folder.`,
      progressLabel: "Device folder ready",
      current: 1,
      total: 1
    });
  } catch (error) {
    endManagerBusy();
    log(error.message);
    showManagerOutcome("Cannot open folder", error.message);
    setActivityStatus({
      status: "error",
      phaseLabel: "Browse failed",
      title: `Could not load ${normalizedPath}`,
      detail: error.message,
      progressLabel: "Browse failed",
      current: 0,
      total: 1
    });
    showActivityOutcome("Browse failed", error.message, "error");
  }
}

async function openManagerFolder(targetPath) {
  await refreshManagerFolder(targetPath);
}

async function goManagerUp() {
  if (!canManagerGoUp()) {
    return;
  }

  await refreshManagerFolder(getParentRemotePath(state.manager.currentPath));
}

async function createManagerFolder() {
  if (!state.client || !state.connected) {
    return;
  }

  const folderName = elements.managerFolderNameInput.value.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (!folderName) {
    const message = "Enter a folder name.";
    log(message);
    showManagerOutcome("Cannot create folder", message);
    setActivityStatus({
      status: "warning",
      phaseLabel: "Folder name required",
      title: "Cannot create a folder yet",
      detail: message,
      progressLabel: "Waiting for folder name",
      current: 0,
      total: 1
    });
    showActivityOutcome("Folder name required", message, "warning");
    return;
  }

  if (folderName.includes("/")) {
    const message = "Folder name must be a single path segment.";
    log(message);
    showManagerOutcome("Cannot create folder", message);
    setActivityStatus({
      status: "error",
      phaseLabel: "Folder name invalid",
      title: "Cannot create that folder",
      detail: message,
      progressLabel: "Validation failed",
      current: 0,
      total: 1
    });
    showActivityOutcome("Folder creation failed", message, "error");
    return;
  }

  const currentPath = state.manager.currentPath || getDriveRoot(getSelectedDrive());
  const remotePath = joinRemoteChildPath(currentPath, folderName);

  try {
    validateRemotePath(remotePath, "folder");
  } catch (error) {
    log(error.message);
    showManagerOutcome("Cannot create folder", error.message);
    setActivityStatus({
      status: "error",
      phaseLabel: "Folder creation blocked",
      title: "This folder path is too long",
      detail: `${error.message} Shorten the folder name or create it higher in the drive.`,
      progressLabel: "Validation failed",
      current: 0,
      total: 1
    });
    showActivityOutcome("Folder creation blocked", error.message, "error");
    return;
  }

  beginManagerBusy({
    eyebrow: "Creating folder",
    title: `Creating ${remotePath}`,
    phase: "Sending create request",
    label: remotePath,
    current: 0,
    total: 2
  });

  try {
    await state.client.createFolder(remotePath);
    invalidateClientFolderCache();
    elements.managerFolderNameInput.value = "";
    log(`Created ${remotePath}`);

    updateManagerBusy({
      title: `Refreshing ${currentPath}`,
      phase: "Refreshing folder contents",
      label: currentPath,
      current: 1,
      total: 2
    });

    const entries = await loadManagerFolderData(currentPath);
    updateManagerBusy({
      title: `Created ${remotePath}`,
      phase: "Folder ready",
      label: `${formatItemCount(entries.length, "entry")} available`,
      current: 2,
      total: 2
    });

    endManagerBusy();
    const summaryText = `Created ${remotePath}. Refreshed ${currentPath}.`;
    showManagerOutcome("Folder created", summaryText);
    setActivityStatus({
      status: "success",
      phaseLabel: "Folder created",
      title: `Created ${remotePath}`,
      detail: summaryText,
      progressLabel: "Folder ready",
      current: 2,
      total: 2
    });
    showActivityOutcome("Folder created", summaryText, "success");
  } catch (error) {
    endManagerBusy();
    log(error.message);
    showManagerOutcome("Folder creation failed", error.message);
    setActivityStatus({
      status: "error",
      phaseLabel: "Folder creation failed",
      title: `Could not create ${remotePath}`,
      detail: error.message,
      progressLabel: "Folder creation failed",
      current: 0,
      total: 2
    });
    showActivityOutcome("Folder creation failed", error.message, "error");
  }
}

async function sanitizeManagerNames() {
  if (!state.client || !state.connected || !state.manager.loaded) {
    return;
  }

  const currentPath = state.manager.currentPath || getDriveRoot(getSelectedDrive());
  const recursive = window.confirm("Also scan subfolders?\n\nPress OK to include the current folder and all subfolders.\nPress Cancel to scan only the current folder.");

  beginManagerBusy({
    eyebrow: recursive ? "Planning name cleanup" : "Scanning current folder",
    title: `Scanning ${currentPath}`,
    phase: recursive ? "Scanning folders" : "Checking names",
    label: currentPath,
    current: 0,
    total: 1
  });

  let plan;
  try {
    const snapshots = await collectRemoteFolderSnapshots(currentPath, recursive, (current, total, folderPath) => {
      updateManagerBusy({
        eyebrow: recursive ? "Planning name cleanup" : "Scanning current folder",
        title: `Scanning ${currentPath}`,
        phase: recursive ? "Scanning folders" : "Checking names",
        label: folderPath,
        current,
        total
      });
    });
    plan = buildSanitizePlanFromSnapshots(snapshots);
  } catch (error) {
    endManagerBusy();
    log(error.message);
    showManagerOutcome("Name cleanup planning failed", error.message);
    setActivityStatus({
      status: "error",
      phaseLabel: "Name cleanup failed",
      title: `Could not scan ${currentPath}`,
      detail: error.message,
      progressLabel: "Planning failed",
      current: 0,
      total: 1
    });
    showActivityOutcome("Name cleanup failed", error.message, "error");
    return;
  }

  if (plan.operations.length === 0) {
    endManagerBusy();
    if (plan.skipped.length > 0) {
      logSanitizeSkips(plan.skipped);
    }
    const summaryText = plan.skipped.length > 0
      ? `No safe name changes were found in ${currentPath}. ${buildSanitizeOutcomeText(0, plan.skipped)}`
      : `No uppercase names were found in ${currentPath}.`;
    log(summaryText);
    showManagerOutcome("Name cleanup complete", summaryText);
    setActivityStatus({
      status: plan.skipped.length > 0 ? "warning" : "success",
      phaseLabel: "Name cleanup complete",
      title: `Finished checking ${currentPath}`,
      detail: summaryText,
      progressLabel: "Nothing to change",
      current: 0,
      total: 0
    });
    showActivityOutcome("Name cleanup complete", summaryText, plan.skipped.length > 0 ? "warning" : "success");
    return;
  }

  const confirmed = window.confirm(`Lowercase names for ${formatItemCount(plan.operations.length, "item")} ${recursive ? `across ${currentPath} and its subfolders` : `in ${currentPath}`}?`);
  if (!confirmed) {
    endManagerBusy();
    const summaryText = `Name cleanup was cancelled before any changes were made in ${currentPath}.`;
    log("Name cleanup cancelled.");
    showManagerOutcome("Name cleanup cancelled", summaryText);
    setActivityStatus({
      status: "warning",
      phaseLabel: "Name cleanup cancelled",
      title: "Rename pass cancelled",
      detail: summaryText,
      progressLabel: "Cancelled before execution",
      current: 0,
      total: plan.operations.length
    });
    showActivityOutcome("Name cleanup cancelled", summaryText, "warning");
    return;
  }

  const totalSteps = plan.operations.length + 1;
  updateManagerBusy({
    eyebrow: "Applying name cleanup",
    title: `Updating names under ${currentPath}`,
    phase: "Renaming remote entries",
    label: `${formatItemCount(plan.operations.length, "rename")} queued`,
    current: 0,
    total: totalSteps
  });

  let renamedCount = 0;
  let renameError = null;

  for (let index = 0; index < plan.operations.length; index += 1) {
    const operation = plan.operations[index];

    updateManagerBusy({
      eyebrow: "Applying name cleanup",
      title: `Updating names under ${currentPath}`,
      phase: "Renaming remote entries",
      label: `${getBaseName(operation.from)} -> ${getBaseName(operation.to)}`,
      current: index + 1,
      total: totalSteps
    });

    try {
      await state.client.renamePath(operation.from, operation.to);
      renamedCount += 1;
      log(`Renamed ${operation.from} -> ${operation.to}`);
      await yieldToBrowser(index + 1, 8);
    } catch (error) {
      renameError = error;
      break;
    }
  }

  invalidateClientFolderCache();

  let refreshError = null;
  try {
    updateManagerBusy({
      eyebrow: "Refreshing manager",
      title: `Refreshing ${currentPath}`,
      phase: "Reloading current folder",
      label: currentPath,
      current: totalSteps,
      total: totalSteps
    });
    await loadManagerFolderData(currentPath);
  } catch (error) {
    refreshError = error;
  }

  endManagerBusy();
  if (plan.skipped.length > 0) {
    logSanitizeSkips(plan.skipped);
  }

  const summaryText = buildSanitizeOutcomeText(renamedCount, plan.skipped);
  const finalText = renameError
    ? `${summaryText} The device stopped during the rename pass: ${renameError.message}`
    : refreshError
      ? `${summaryText} The rename pass finished, but the final folder refresh failed: ${refreshError.message}`
      : summaryText;

  if (renameError || refreshError) {
    log(finalText);
    showManagerOutcome("Name cleanup finished with issues", finalText);
    setActivityStatus({
      status: renamedCount > 0 || plan.skipped.length > 0 ? "warning" : "error",
      phaseLabel: "Name cleanup finished with issues",
      title: `Name cleanup incomplete for ${currentPath}`,
      detail: finalText,
      progressLabel: "Review the summary",
      current: renamedCount,
      total: plan.operations.length
    });
    showActivityOutcome("Name cleanup finished with issues", finalText, renamedCount > 0 || plan.skipped.length > 0 ? "warning" : "error");
    return;
  }

  log(`Updated ${formatItemCount(renamedCount, "name")} ${recursive ? `across ${currentPath} and its subfolders` : `in ${currentPath}`}.`);
  showManagerOutcome("Name cleanup complete", finalText);
  setActivityStatus({
    status: plan.skipped.length > 0 ? "warning" : "success",
    phaseLabel: "Name cleanup complete",
    title: `Finished updating names in ${currentPath}`,
    detail: finalText,
    progressLabel: "Rename pass finished",
    current: totalSteps,
    total: totalSteps
  });
  showActivityOutcome("Name cleanup complete", finalText, plan.skipped.length > 0 ? "warning" : "success");
}

async function deleteManagerSelection() {
  const selectedEntries = getSelectedManagerEntries();
  if (selectedEntries.length === 0 || !state.client || !state.connected) {
    return;
  }

  const confirmed = window.confirm(
    selectedEntries.length === 1
      ? `Delete ${selectedEntries[0].type === "DIR" ? "folder" : "file"} ${selectedEntries[0].fullPath}?\n\nThis changes the device immediately and cannot be undone in MochiNest.`
      : `Delete ${formatItemCount(selectedEntries.length, "selected item")} from ${state.manager.currentPath}?\n\nThis changes the device immediately and cannot be undone in MochiNest.`
  );
  if (!confirmed) {
    return;
  }

  const currentPath = state.manager.currentPath;
  const sortedEntries = sortManagerEntriesForDelete(selectedEntries);
  const totalSteps = sortedEntries.length + 1;

  beginManagerBusy({
    eyebrow: "Deleting selected items",
    title: `Deleting from ${currentPath}`,
    phase: "Removing selected entries",
    label: `${formatItemCount(sortedEntries.length, "delete")} queued`,
    current: 0,
    total: totalSteps
  });

  let deletedCount = 0;
  let deleteError = null;

  for (let index = 0; index < sortedEntries.length; index += 1) {
    const entry = sortedEntries[index];
    updateManagerBusy({
      eyebrow: "Deleting selected items",
      title: `Deleting from ${currentPath}`,
      phase: "Removing selected entries",
      label: entry.fullPath,
      current: index + 1,
      total: totalSteps
    });

    try {
      await state.client.removePath(entry.fullPath);
      deletedCount += 1;
      log(`Deleted ${entry.fullPath}`);
      await yieldToBrowser(index + 1, 8);
    } catch (error) {
      deleteError = error;
      break;
    }
  }

  invalidateClientFolderCache();

  let refreshError = null;
  try {
    updateManagerBusy({
      eyebrow: "Refreshing manager",
      title: `Refreshing ${currentPath}`,
      phase: "Reloading current folder",
      label: currentPath,
      current: totalSteps,
      total: totalSteps
    });
    await loadManagerFolderData(currentPath);
  } catch (error) {
    refreshError = error;
  }

  endManagerBusy();

  const summaryText = deleteError
    ? `Deleted ${deletedCount} of ${selectedEntries.length} selected items before the device returned an error. ${deleteError.message}`
    : refreshError
      ? `Deleted ${deletedCount} selected items, but the folder refresh failed. ${refreshError.message}`
      : `Deleted ${deletedCount} selected items from ${currentPath}.`;

  if (deleteError || refreshError) {
    log(summaryText);
    showManagerOutcome("Delete finished with issues", summaryText);
    setActivityStatus({
      status: deletedCount > 0 ? "warning" : "error",
      phaseLabel: "Delete finished with issues",
      title: `Delete incomplete for ${currentPath}`,
      detail: summaryText,
      progressLabel: "Review the summary",
      current: deletedCount,
      total: selectedEntries.length
    });
    showActivityOutcome("Delete finished with issues", summaryText, deletedCount > 0 ? "warning" : "error");
    return;
  }

  showManagerOutcome("Delete complete", summaryText);
  setActivityStatus({
    status: "success",
    phaseLabel: "Delete complete",
    title: `Finished deleting from ${currentPath}`,
    detail: summaryText,
    progressLabel: "Delete batch finished",
    current: totalSteps,
    total: totalSteps
  });
  showActivityOutcome("Delete complete", summaryText, "success");
}

function useManagerPathForUploader() {
  const drive = getSelectedDrive();
  if (!drive || !state.manager.currentPath) {
    return;
  }

  const basePath = state.manager.currentPath.slice(2) || "/";
  elements.remoteBaseInput.value = basePath;
  renderSummary();
  log(`Uploader target set to ${state.manager.currentPath}`);
  setActivityStatus({
    status: "success",
    phaseLabel: "Uploader target updated",
    title: "Uploader target updated",
    detail: `New uploads will go to ${state.manager.currentPath}.`,
    progressLabel: "Ready to switch workspaces",
    current: 1,
    total: 1
  });
  showActivityOutcome("Uploader target updated", `New uploads will go to ${state.manager.currentPath}.`, "success");
  setMode("uploader");
}

function handleManagerTableClick(event) {
  const openButton = event.target.closest("[data-action='open']");
  if (openButton) {
    openManagerFolder(openButton.dataset.path);
    return;
  }

  const selectionToggle = event.target.closest("[data-action='toggle-selection']");
  if (selectionToggle) {
    toggleManagerSelection(selectionToggle.dataset.path, selectionToggle.checked);
    renderManager();
    updateControls();
    return;
  }

  const row = event.target.closest("tr[data-path]");
  if (!row) {
    return;
  }

  toggleManagerSelection(row.dataset.path);
  renderManager();
  updateControls();
}

async function connectOrDisconnect() {
  if (!state.client) {
    state.client = new PixlBleClient(log);
  }

  if (state.connected) {
    state.client.disconnect();
    return;
  }

  clearActivityOutcome();
  setActivityStatus({
    status: "running",
    phaseLabel: "Connecting",
    title: "Waiting for Bluetooth permission",
    detail: "Choose your Pixl.js device in the browser prompt. If it does not appear, check BLE File Transfer mode.",
    progressLabel: "Opening Web Bluetooth",
    current: 0,
    total: 1
  });

  try {
    elements.connectButton.disabled = true;
    await state.client.connect();
    setConnected(true);

    const version = await state.client.getVersion();
    elements.firmwareVersion.textContent = version.version || "-";
    elements.bleAddress.textContent = version.bleAddress || "-";
    log(`Firmware ${version.version || "unknown"}${version.bleAddress ? `, ${version.bleAddress}` : ""}`);

    setActivityStatus({
      status: "success",
      phaseLabel: "Connected",
      title: "Device connected",
      detail: version.bleAddress ? `Connected to ${version.version}, ${version.bleAddress}.` : `Connected to firmware ${version.version || "unknown"}.`,
      progressLabel: "Refreshing drive list",
      current: 1,
      total: 1
    });

    await refreshDrives();
  } catch (error) {
    log(error.message);
    setConnected(false);
    setActivityStatus({
      status: "error",
      phaseLabel: "Connection failed",
      title: "Could not connect to the device",
      detail: `${error.message} Make sure the device is in BLE File Transfer mode, then try again.`,
      progressLabel: "Connection failed",
      current: 0,
      total: 1
    });
    showActivityOutcome("Connection failed", `${error.message} Make sure the device is in BLE File Transfer mode, then try again.`, "error");
  } finally {
    elements.connectButton.disabled = false;
  }
}

async function refreshDrives() {
  if (!state.client || !state.connected) {
    return;
  }

  clearActivityOutcome();
  setActivityStatus({
    status: "running",
    phaseLabel: "Refreshing drives",
    title: "Reading drive list",
    detail: "Checking which writable drives are available on the device.",
    progressLabel: "Drive list",
    current: 0,
    total: 1
  });

  try {
    const drives = await state.client.listDrives();
    state.drives = drives.filter((drive) => drive.status === 0);
    invalidateClientFolderCache();
    renderDriveOptions();
    renderSummary();
    renderManager();
    log(`Found ${state.drives.length} writable drive${state.drives.length === 1 ? "" : "s"}.`);

    setActivityStatus({
      status: "success",
      phaseLabel: "Drives ready",
      title: "Drive list ready",
      detail: `${formatItemCount(state.drives.length, "writable drive")} available.`,
      progressLabel: "Drive list ready",
      current: 1,
      total: 1
    });

    if (state.mode === "manager" && state.drives.length > 0) {
      await refreshManagerFolder(state.manager.currentPath || getDriveRoot(getSelectedDrive()));
      return;
    }

    showActivityOutcome("Drive list ready", `${formatItemCount(state.drives.length, "writable drive")} available.`, "success");
  } catch (error) {
    log(error.message);
    setActivityStatus({
      status: "error",
      phaseLabel: "Drive refresh failed",
      title: "Could not read the drive list",
      detail: `${error.message} Reconnect the device or try refreshing again.`,
      progressLabel: "Drive list failed",
      current: 0,
      total: 1
    });
    showActivityOutcome("Drive list failed", `${error.message} Reconnect the device or try refreshing again.`, "error");
  }
}

async function createRemotePath() {
  if (!state.client || !state.connected) {
    return;
  }

  const drive = getSelectedDrive();
  if (!drive) {
    const message = "Choose a drive before creating the base path.";
    log(message);
    setActivityStatus({
      status: "warning",
      phaseLabel: "Base path blocked",
      title: "No drive selected",
      detail: message,
      progressLabel: "Select a drive first",
      current: 0,
      total: 1
    });
    showActivityOutcome("Destination folder blocked", message, "warning");
    return;
  }

  const remoteBase = normalizeRemoteBasePath(elements.remoteBaseInput.value);
  const fullPath = joinRemotePath(drive, remoteBase, "");
  if (fullPath === `${drive}:/`) {
    const message = "The drive root already exists.";
    log(message);
    setActivityStatus({
      status: "success",
      phaseLabel: "Base path ready",
      title: "Nothing to create",
      detail: message,
      progressLabel: "Root path already exists",
      current: 1,
      total: 1
    });
    showActivityOutcome("Destination folder ready", message, "success");
    return;
  }

  clearActivityOutcome();
  setActivityStatus({
    status: "running",
    phaseLabel: "Preparing destination folder",
    title: `Preparing ${fullPath}`,
    detail: "Creating any missing folders under the chosen destination folder.",
    progressLabel: "Creating missing folders",
    current: 0,
    total: 1
  });

  try {
    await state.client.ensureFolder(fullPath);
    invalidateClientFolderCache();
    log(`Destination folder ready: ${fullPath}`);
    setActivityStatus({
      status: "success",
      phaseLabel: "Destination folder ready",
      title: "Destination folder ready",
      detail: `All required folders now exist under ${fullPath}.`,
      progressLabel: "Destination folder prepared",
      current: 1,
      total: 1
    });
    showActivityOutcome("Destination folder ready", `All required folders now exist under ${fullPath}.`, "success");
  } catch (error) {
    log(error.message);
    setActivityStatus({
      status: "error",
      phaseLabel: "Destination folder failed",
      title: `Could not prepare ${fullPath}`,
      detail: `${error.message} Check the drive, shorten the path if needed, then try again.`,
      progressLabel: "Path preparation failed",
      current: 0,
      total: 1
    });
    showActivityOutcome("Destination folder failed", `${error.message} Check the drive, shorten the path if needed, then try again.`, "error");
  }
}

async function prepareFolderSelection() {
  if (!state.connected) {
    return;
  }

  const preserveRoot = elements.preserveRootToggle.checked;
  try {
    if (typeof window.showDirectoryPicker !== "function") {
      elements.folderInput.click();
      return;
    }

    const handle = await window.showDirectoryPicker({ mode: "read" });
    clearActivityOutcome();
    setActivityStatus({
      status: "running",
      phaseLabel: "Scanning local folder",
      title: `Scanning ${handle.name}`,
      detail: "Building the upload plan from your local folder.",
      progressLabel: "Scanning local files",
      current: 0,
      total: 1
    });

    const collected = await collectFromDirectoryHandle(handle, preserveRoot, (current, total, relativePath) => {
      setActivityStatus({
        status: "running",
        phaseLabel: "Scanning local folder",
        title: `Scanning ${handle.name}`,
        detail: relativePath,
        progressLabel: "Scanning local entries",
        current,
        total
      });
    });

    await finalizeCollectedSelection(collected, `Built an upload plan from folder ${handle.name}.`);
  } catch (error) {
    if (error && error.name !== "AbortError") {
      log(error.message);
      setActivityStatus({
        status: "error",
        phaseLabel: "Folder scan failed",
        title: "Could not scan the selected folder",
        detail: error.message,
        progressLabel: "Folder scan failed",
        current: 0,
        total: 1
      });
      showActivityOutcome("Folder scan failed", error.message, "error");
    }
  }
}

async function handleDirectoryFallbackSelection(event) {
  const preserveRoot = elements.preserveRootToggle.checked;
  if (!event.target.files || event.target.files.length === 0) {
    return;
  }

  clearActivityOutcome();
  setActivityStatus({
    status: "running",
    phaseLabel: "Scanning selected files",
    title: "Scanning selected folder",
    detail: "Building the upload plan from the chosen folder.",
    progressLabel: "Scanning selected entries",
    current: 0,
    total: event.target.files.length
  });

  const collected = await collectFromWebkitDirectory(event.target.files, preserveRoot, (current, total, relativePath) => {
    setActivityStatus({
      status: "running",
      phaseLabel: "Scanning selected files",
      title: "Scanning selected folder",
      detail: relativePath,
      progressLabel: "Scanning selected entries",
      current,
      total
    });
  });

  await finalizeCollectedSelection(collected, `Built an upload plan from ${formatItemCount(collected.files.length, "file")} in the chosen folder.`);
  event.target.value = "";
}

async function handleFileSelection(event) {
  if (!event.target.files || event.target.files.length === 0) {
    return;
  }

  clearActivityOutcome();
  setActivityStatus({
    status: "running",
    phaseLabel: "Scanning selected files",
    title: "Scanning file selection",
    detail: "Building the upload plan from the selected files.",
    progressLabel: "Scanning selected files",
    current: 0,
    total: event.target.files.length
  });

  const collected = await collectFromFileList(event.target.files, (current, total, relativePath) => {
    setActivityStatus({
      status: "running",
      phaseLabel: "Scanning selected files",
      title: "Scanning file selection",
      detail: relativePath,
      progressLabel: "Scanning selected files",
      current,
      total
    });
  });

  await finalizeCollectedSelection(collected, `Built an upload plan from ${formatItemCount(collected.files.length, "file")}.`);
  event.target.value = "";
}

function updateUploadActivity(item, currentIndex, totalItems, detail, progressLabel) {
  setActivityStatus({
    status: "running",
    phaseLabel: "Uploading",
    title: `Uploading to ${getSelectedDrive() || "?"}:${normalizeRemoteBasePath(elements.remoteBaseInput.value)}`,
    detail,
    progressLabel,
    current: currentIndex,
    total: totalItems
  });
}

async function runUpload() {
  if (!state.client || !state.connected || state.uploadActive || state.plan.length === 0) {
    return;
  }

  state.uploadActive = true;
  state.abortRequested = false;
  updateControls();

  const drive = getSelectedDrive();
  const basePath = normalizeRemoteBasePath(elements.remoteBaseInput.value);
  const remoteBase = joinRemotePath(drive, basePath, "");
  const totalItems = state.queuedFolders.length + state.queuedFiles.length;
  let completedItems = 0;

  clearActivityOutcome();
  setActivityStatus({
    status: "running",
    phaseLabel: "Uploading",
    title: `Uploading to ${remoteBase}`,
    detail: `Preparing ${formatItemCount(totalItems, "queued item")} for transfer to the destination folder.`,
    progressLabel: "Preparing upload queue",
    current: 0,
    total: totalItems
  });

  state.plan.forEach((item) => {
    item.transferred = 0;
    item.status = "pending";
    item.message = "";
  });
  renderPlan();
  updateOverallProgress();

  try {
    if (remoteBase !== `${drive}:/`) {
      await state.client.ensureFolder(remoteBase);
    }

    for (const item of state.queuedFolders) {
      if (state.abortRequested) {
        markPendingItemsAsAborted();
        throw new Error("Upload aborted by user.");
      }

      item.status = "active";
      item.message = "Preparing folder";
      updatePlanItem(item);
      updateUploadActivity(item, Math.min(completedItems + 1, totalItems), totalItems, item.remotePath, "Preparing folders");

      await state.client.ensureFolder(item.remotePath);

      item.status = "done";
      item.message = "Folder ready";
      updatePlanItem(item);
      completedItems += 1;
    }

    for (const item of state.queuedFiles) {
      if (state.abortRequested) {
        markPendingItemsAsAborted();
        throw new Error("Upload aborted by user.");
      }

      item.status = "active";
      item.message = "Uploading";
      updatePlanItem(item);
      updateUploadActivity(item, Math.min(completedItems + 1, totalItems), totalItems, item.remotePath, "Uploading file");

      const parent = getParentRemotePath(item.remotePath);
      await state.client.ensureFolder(parent);
      await state.client.uploadFile(item.remotePath, item.file, (writtenBytes, totalBytes) => {
        item.transferred = writtenBytes;
        updatePlanItem(item);
        setActivityStatus({
          status: "running",
          phaseLabel: "Uploading",
          title: `Uploading to ${remoteBase}`,
          detail: `${item.remotePath} • ${formatBytes(writtenBytes)} of ${formatBytes(totalBytes)}`,
          progressLabel: "Uploading file",
          current: Math.min(completedItems + 1, totalItems),
          total: totalItems
        });
      });

      item.transferred = item.size;
      item.status = "done";
      item.message = "Uploaded";
      updatePlanItem(item);
      completedItems += 1;
      log(`Uploaded ${item.remotePath}`);
    }

    const summaryText = `Uploaded ${formatItemCount(state.queuedFiles.length, "file")} and prepared ${formatItemCount(state.queuedFolders.length, "folder")} under ${remoteBase}.`;
    log("Upload finished.");
    setActivityStatus({
      status: "success",
      phaseLabel: "Upload complete",
      title: "Upload complete",
      detail: summaryText,
      progressLabel: "Transfer complete",
      current: totalItems,
      total: totalItems
    });
    showActivityOutcome("Upload complete", summaryText, "success");
  } catch (error) {
    log(error.message);
    const activeItem = state.plan.find((item) => item.status === "active");
    if (activeItem) {
      activeItem.status = state.abortRequested ? "aborted" : "error";
      activeItem.message = error.message;
      updatePlanItem(activeItem);
    }

    const status = state.abortRequested ? "warning" : "error";
    const title = state.abortRequested ? "Upload stopped" : "Upload failed";
    const summaryText = state.abortRequested
      ? `Upload stopped after completing ${completedItems} of ${totalItems} queued items.`
      : `Upload failed after completing ${completedItems} of ${totalItems} queued items. ${error.message} Check the destination folder and connection, then try again.`;
    setActivityStatus({
      status,
      phaseLabel: title,
      title,
      detail: summaryText,
      progressLabel: state.abortRequested ? "Upload cancelled" : "Upload failed",
      current: completedItems,
      total: totalItems
    });
    showActivityOutcome(title, summaryText, status);
  } finally {
    state.uploadActive = false;
    updateControls();
  }
}

function markPendingItemsAsAborted() {
  state.plan.forEach((item) => {
    if (item.status === "pending") {
      item.status = "aborted";
      item.message = "Skipped after abort";
      updatePlanItem(item);
    }
  });
}

function abortUpload() {
  if (!state.uploadActive) {
    return;
  }

  state.abortRequested = true;
  log("Stop requested. The current BLE write will finish before the queue stops.");
  setActivityStatus({
    status: "warning",
    phaseLabel: "Stop requested",
    title: "Upload stop requested",
    detail: "The current BLE write will finish before the queue stops.",
    progressLabel: "Waiting for the current step to finish",
    current: state.plan.filter((item) => item.status === "done").length,
    total: state.plan.length
  });
  showActivityOutcome("Stop requested", "The current BLE write will finish before the queue stops.", "warning");
}

elements.connectButton.addEventListener("click", connectOrDisconnect);
elements.modeUploaderButton.addEventListener("click", () => setMode("uploader"));
elements.modeManagerButton.addEventListener("click", () => setMode("manager"));
elements.refreshButton.addEventListener("click", refreshDrives);
elements.createPathButton.addEventListener("click", createRemotePath);
elements.pickFolderButton.addEventListener("click", prepareFolderSelection);
elements.pickFilesButton.addEventListener("click", () => elements.filesInput.click());
elements.folderInput.addEventListener("change", handleDirectoryFallbackSelection);
elements.filesInput.addEventListener("change", handleFileSelection);
elements.startUploadButton.addEventListener("click", runUpload);
elements.abortButton.addEventListener("click", abortUpload);
elements.clearPlanButton.addEventListener("click", resetPlan);

elements.managerOpenButton.addEventListener("click", () => refreshManagerFolder(elements.managerPathInput.value));
elements.managerUpButton.addEventListener("click", goManagerUp);
elements.managerRefreshButton.addEventListener("click", () => refreshManagerFolder(elements.managerPathInput.value));
elements.managerUsePathButton.addEventListener("click", useManagerPathForUploader);
elements.managerCreateFolderButton.addEventListener("click", createManagerFolder);
elements.managerSanitizeButton.addEventListener("click", sanitizeManagerNames);
elements.managerSelectAllButton.addEventListener("click", selectAllManagerEntries);
elements.managerClearSelectionButton.addEventListener("click", clearManagerSelection);
elements.managerDeleteButton.addEventListener("click", deleteManagerSelection);
elements.managerTableBody.addEventListener("click", handleManagerTableClick);

elements.clearLogButton.addEventListener("click", clearLog);
elements.driveSelect.addEventListener("change", handleDriveChange);
elements.remoteBaseInput.addEventListener("change", renderSummary);
elements.remoteBaseInput.addEventListener("blur", () => {
  elements.remoteBaseInput.value = normalizeRemoteBasePath(elements.remoteBaseInput.value);
  renderSummary();
});
elements.managerPathInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    refreshManagerFolder(elements.managerPathInput.value);
  }
});
elements.managerPathInput.addEventListener("blur", () => {
  if (!getSelectedDrive()) {
    return;
  }

  try {
    elements.managerPathInput.value = normalizeAbsoluteRemoteFolderPath(elements.managerPathInput.value, getSelectedDrive());
  } catch (error) {
    log(error.message);
    const detail = `${error.message} Use the selected drive and a valid device folder path.`;
    showManagerOutcome("Invalid device folder", detail);
    showActivityOutcome("Invalid device folder", detail, "error");
  }
});
elements.managerFolderNameInput.addEventListener("input", updateControls);
elements.managerFolderNameInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    createManagerFolder();
  }
});

setConnected(false);
renderPlan();
renderSummary();
renderManager();
renderActivityStatus();