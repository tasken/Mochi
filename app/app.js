import { PixlToolsClient, DevMockClient, validateRemotePath, getBaseName, getParentPath, sortEntries, utf8Length, MAX_FILE_NAME_BYTES } from './client.js';

// === Constants ===

const LARGE_DIR_THRESHOLD = 80;
const LARGE_BATCH_THRESHOLD = 200;
const SYNC_EXCLUDE_PATHS = ["e:/amiibo/fav", "e:/amiibo/data"]; // device paths excluded from sync on both sides
const PIXL_RELEASES_URL = "https://github.com/solosky/pixl.js/releases";
const PIXL_LATEST_API = "https://api.github.com/repos/solosky/pixl.js/releases/latest";

const FAVICON_PATH = `<path d="M225.5-82.5Q120-125 120-200q0-32 20-57.5t56-45.5l65 58q-24 8-42.5 20.5T200-200q0 26 81 53t199 27q118 0 199-27t81-53q0-12-18.5-24.5T699-245l65-58q36 20 56 45.5t20 57.5q0 75-105.5 117.5T480-40q-149 0-254.5-42.5Zm212-125Q417-215 400-230L148-453q-13-11-20.5-27t-7.5-33v-80q0-17 6.5-33t19.5-27l252-235q17-16 38-24t44-8q23 0 44 8t38 24l252 235q13 11 19.5 27t6.5 33v80q0 17-7.5 33T812-453L560-230q-17 15-37.5 22.5T480-200q-22 0-42.5-7.5Zm-42-357Q410-579 410-600t-14.5-35.5Q381-650 360-650t-35.5 14.5Q310-621 310-600t14.5 35.5Q339-550 360-550t35.5-14.5ZM410-496q43 21 90.5 13.5T584-522q34-29 44.5-73T618-678L410-496Zm105.5-188.5Q530-699 530-720t-14.5-35.5Q501-770 480-770t-35.5 14.5Q430-741 430-720t14.5 35.5Q459-670 480-670t35.5-14.5Z"/>`;
const FAVICON_COLORS = {
  disconnected: "#9ca3af",
  connecting:   "#f59e0b",
  connected:    "#10b981",
  reconnecting: "#fb923c",
  mock:         "#7878cc",
};

const BRAND_GRADIENTS = {
  disconnected: ["#9ca3af", "#cbd5e1"],
  connecting:   ["#f59e0b", "#fde68a"],
  connected:    ["#059669", "#34d399"],
  reconnecting: ["#f97316", "#fbbf24"],
  mock:         ["#7c3aed", "#d946ef"],
};

function setStateColors(connState, isMock) {
  const key = isMock ? "mock" : connState;
  const faviconColor = FAVICON_COLORS[key] ?? FAVICON_COLORS.disconnected;
  const [gradFrom, gradTo] = BRAND_GRADIENTS[key] ?? BRAND_GRADIENTS.disconnected;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -960 960 960" width="32" height="32" fill="${faviconColor}">${FAVICON_PATH}</svg>`;
  const link = document.querySelector('link[rel="icon"]');
  if (link) link.href = "data:image/svg+xml," + encodeURIComponent(svg);
  document.documentElement.style.setProperty("--brand-grad-from", gradFrom);
  document.documentElement.style.setProperty("--brand-grad-to", gradTo);
}

// === Utilities ===

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function escapeHtml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function isSyncExcluded(remotePath) {
  const lower = remotePath.toLowerCase();
  return SYNC_EXCLUDE_PATHS.some(p => lower === p || lower.startsWith(p + "/"));
}

function joinChildPath(parent, child) {
  const c = String(child || "").replace(/^\/+|\/+$/g, "");
  if (!c) return parent;
  return parent.endsWith("/") ? `${parent}${c}` : `${parent}/${c}`;
}

function triggerDownload(data, filename) {
  const url = URL.createObjectURL(new Blob([data]));
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 200);
}

function pluralize(n, word) {
  return `${n} ${word}${n !== 1 ? "s" : ""}`;
}

function formatNfcUid(head, tail) {
  return `${(head >>> 0).toString(16).toUpperCase().padStart(8, "0")}:${(tail >>> 0).toString(16).toUpperCase().padStart(8, "0")}`;
}

function nfcDetailRow(label, value, { mono = false } = {}) {
  const cls = mono ? " details-nfc-mono js-copy-id" : "";
  const attr = mono ? ' title="Copy ID"' : "";
  return `<div class="details-nfc-row"><span class="details-nfc-label">${escapeHtml(label)}</span><span class="details-nfc-value${cls}"${attr}>${escapeHtml(value)}</span></div>`;
}

function isAriaDisabled(el) {
  return el.getAttribute("aria-disabled") === "true";
}

function firstPlusMore(items) {
  if (items.length === 0) return "";
  return items.length > 1 ? `${items[0]} (+${items.length - 1} more)` : String(items[0]);
}

function setHiddenAll(hidden, ...elements) {
  for (const e of elements) e.hidden = hidden;
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
  navCommitOverlay: document.getElementById("navCommitOverlay"),
  navCommitMobile: document.getElementById("navCommitMobile"),
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
  panelNfcTag: document.getElementById("panelNfcTag"),
  panelNfcTagContent: document.getElementById("panelNfcTagContent"),

  // Context panel — upload state
  panelUpload: document.getElementById("panelUpload"),
  btnPickFolder: document.getElementById("btnPickFolder"),
  btnPickFiles: document.getElementById("btnPickFiles"),
  uploadProgressTotal: document.getElementById("uploadProgressTotal"),
  uploadWarningBanner: document.getElementById("uploadWarningBanner"),
  uploadQueue: document.getElementById("uploadQueue"),
  btnUploadStart: document.getElementById("btnUploadStart"),
  btnUploadAbort: document.getElementById("btnUploadAbort"),
  btnUploadClear: document.getElementById("btnUploadClear"),
  uploadExecuteZone: document.getElementById("uploadExecuteZone"),
  folderInput: document.getElementById("folderInput"),
  filesInput: document.getElementById("filesInput"),
  btnUploadClose: document.getElementById("btnUploadClose"),
  btnSync: document.getElementById("btnSync"),

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
  selectionBar: document.getElementById("selectionBar"),
  selectionCount: document.getElementById("selectionCount"),
  btnClearSelection: document.getElementById("btnClearSelection"),
  btnDownloadSelected: document.getElementById("btnDownloadSelected"),
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
  disconnectToast: null,
  uploadBase: "E:/",         // path where the upload plan was built — anchors runSync
  syncState: "idle",         // "idle" | "scanning" | "done" | "error"
  syncSkippedFiles: [],      // [{ remotePath, size }]
  syncOrphans: [],           // [{ remotePath, size, kind, deletable, status }]
  syncOrphanChecked: new Set(),   // Set<remotePath>
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

function isMobileViewport() { return window.innerWidth < 992; }

function _lockScroll()   { document.body.classList.add("no-scroll"); }
function _unlockScroll() { document.body.classList.remove("no-scroll"); }

function openSheet() {
  el.sheetContainer.classList.add("open");
  _lockScroll();
}
function closeSheet() {
  el.sheetContainer.classList.remove("open");
  el.sheetContainer.classList.remove("is-upload");
  if (!document.body.classList.contains("log-open")) _unlockScroll();
}
function openDetailsSheet() {
  el.detailsSheetContainer.classList.add("open");
  _lockScroll();
}
function closeDetailsSheet() {
  el.detailsSheetContainer.classList.remove("open");
  if (!document.body.classList.contains("log-open")) _unlockScroll();
}

el.sheetBackdrop.addEventListener("click", closeSheet);
document.getElementById("btnFolderSheetClose").addEventListener("click", closeSheet);

el.btnSheetInfo.addEventListener("click", () => { setPanelState("folder"); el.sheetContainer.classList.remove("is-upload"); openSheet(); });
el.btnSheetUpload.addEventListener("click", () => { setPanelState("upload"); el.sheetContainer.classList.add("is-upload"); openSheet(); });

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
  el.mainOverlaySub.textContent = (connecting || reconnecting) ? "" : "Connect to browse and manage files on your Pixl.js over Bluetooth.";
  el.btnConnectCta.hidden = connecting || reconnecting;
  el.btnConnectCta.disabled = connecting || reconnecting;

  // Disconnect button — visible when connected or reconnecting
  el.btnConnect.hidden = !(connected || reconnecting);
  el.btnDev.hidden = !shouldShowDevButton();

  // Topbar connected elements — keep visible during reconnecting
  setHiddenAll(!(connected || reconnecting),
    el.topbarBadge, el.topbarDrive, el.topbarActionSep, el.btnFormat,
    el.btnRefresh, el.btnNewFolder, el.btnNormalize, el.btnLogToggle,
    el.btnSheetInfo, el.btnSheetUpload);
  if (!(connected || reconnecting)) el.btnMobileUp.hidden = true;

  // Error cleared on state change
  el.connError.hidden = true;
  el.connError.textContent = "";

  if (disconnected) {
    clearToasts({ keepErrors: true });
    closeSheet();
    closeDetailsSheet();
    closeLogSheet();
    _unlockScroll();
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

  setStateColors(newState, connected && state.client instanceof DevMockClient);
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
  if (state.connState === "connecting") return;
  if (state.connState === "connected" || state.connState === "reconnecting") {
    if (state.disconnectToast) { removeToast(state.disconnectToast); state.disconnectToast = null; }
    if (state.client) state.client.disconnect();
    invalidateCache();
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
    if (wasReconnecting) showErrorToast("Reconnection timed out", "Try disconnecting and reconnecting.");
    invalidateCache();
  };
  state.client.onReconnecting = () => {
    if (state.abortController) state.abortController.abort();
    setConnState("reconnecting");
    state.disconnectToast = showErrorToast("Connection lost", "Reconnecting…");
  };
  state.client.onReconnect = async () => {
    if (state.disconnectToast) { removeToast(state.disconnectToast); state.disconnectToast = null; }
    setConnState("connected");
    showSuccessToast("Back online");
    if (state.currentPath) {
      invalidateCache();
      await browseFolder(state.currentPath);
    }
  };

  try {
    await state.client.connect();
    setConnState("connected");
    showSuccessToast("Connected");

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

    const dr = await state.client.listDrives();
    if (dr.ok && dr.data.length > 0) {
      state.drive = dr.data[0];
      renderDrive(state.drive);
    }

    await browseFolder("E:/");

  } catch (err) {
    log(`Connection failed: ${err.message}`);
    showConnError(err.message);
    showErrorToast("Connection failed", err.message);
    setConnState("disconnected");
  }
}

async function devConnect() {
  if (state.connState === "connected") return;
  setConnState("connecting");
  state.client = new DevMockClient();
  state.client.onDisconnect = () => setConnState("disconnected");
  setConnState("connected");
  showSuccessToast("Connected");

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
  if (modalEl === el.formatModal) {
    clearInterval(_formatCountdown);
    _formatCountdown = null;
    el.btnFormatConfirm.textContent = "Format drive";
    el.btnFormatConfirm.disabled = false;
  }
  modalEl.classList.remove("open");
  modalEl.dispatchEvent(new Event("modal:close"));
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

// Escape key — close surfaces from most to least prominent
document.addEventListener("keydown", e => {
  if (e.key !== "Escape") return;
  // 1. Image lightbox
  if (!el.imgLightbox.hidden) { e.preventDefault(); closeLightbox(); return; }
  // 2. Open modals
  const openModalEl = document.querySelector(".modal-overlay.open");
  if (openModalEl) { e.preventDefault(); closeModal(openModalEl); return; }
  // 3. Log sheet
  if (el.logOverlay.classList.contains("open")) { e.preventDefault(); closeLogSheet(); return; }
  // 4. Details sheet (mobile) or details panel (desktop)
  if (el.detailsSheetContainer.classList.contains("open")) { e.preventDefault(); setPanelState("folder"); closeDetailsSheet(); return; }
  if (!el.detailsPanel.hidden) { e.preventDefault(); setPanelState("folder"); return; }
  // 5. Upload panel (desktop — simulate close button if not disabled)
  if (!isMobileViewport() && state.panelMode === "upload" && !isAriaDisabled(el.btnUploadClose)) { e.preventDefault(); el.btnUploadClose.click(); return; }
  // 6. Context sheet (mobile)
  if (el.sheetContainer.classList.contains("open")) { e.preventDefault(); closeSheet(); }
});

el.btnFormatCancel.addEventListener("click", () => closeModal(el.formatModal));

el.btnFormatConfirm.addEventListener("click", async () => {
  closeModal(el.formatModal);
  if (!state.client) return;
  try {
    el.btnFormatConfirm.disabled = true;
    const res = await state.client.formatDrive("E");
    if (res.ok) {
      log("Drive E: formatted successfully.");
      showSuccessToast("Drive formatted");
      invalidateCache();
      const dr = await state.client.listDrives();
      if (dr.ok && dr.data.length > 0) {
        state.drive = dr.data[0];
        renderDrive(state.drive);
      }
      await browseFolder("E:/");
    } else {
      log(`Format failed: ${res.error}`, "err");
      showErrorToast("Format failed", res.error);
    }
  } catch (err) {
    log(`Format error: ${err.message}`, "err");
    showErrorToast("Format failed", err.message);
  } finally {
    el.btnFormatConfirm.disabled = false;
  }
});

// Close modals on backdrop click
for (const modal of [el.formatModal, el.newFolderModal, el.renameModal, el.deleteModal,
    el.sanitizeModalNone]) {
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
  const syncing = state.syncState === "scanning";
  const queueHasItems = hasQueuedUploadState();
  el.btnRefresh.disabled = !connected || uploading;
  el.btnNewFolder.disabled = !connected || uploading;
  el.sidebarDropZone.setAttribute("aria-disabled", String(!connected || uploading || syncing));
  el.btnNormalize.disabled = !connected || uploading;
  el.btnFormat.disabled = !connected || uploading;
  el.btnPickFolder.disabled = !connected || uploading || syncing;
  el.btnPickFiles.disabled = !connected || uploading || syncing;
  el.btnSync.disabled = !connected || uploading || syncing || !queueHasItems;
  el.btnSync.innerHTML = state.syncState === "done"
    ? `<span class="ms-sm">sync</span> Rescan`
    : `<span class="ms-sm">sync</span> Sync with device`;

  // Execute zone: show when queue has items or upload is active
  el.uploadExecuteZone.style.display = (queueHasItems || uploading) ? "flex" : "none";

  // Start ↔ Stop swap
  el.btnUploadStart.hidden = uploading;
  el.btnUploadAbort.hidden = !uploading;
  el.btnUploadAbort.disabled = !uploading;

  if (state.syncState === "done") {
    el.btnUploadStart.innerHTML = `<span class="ms">upload</span> Upload`;
    el.btnUploadStart.disabled = !connected || uploading ||
      (state.uploadPlan.filter(i => i.kind === "file").length === 0 && state.syncOrphanChecked.size === 0);
  } else {
    el.btnUploadStart.innerHTML = `<span class="ms">play_arrow</span> Start`;
    el.btnUploadStart.disabled = !connected || uploading || syncing || state.uploadPlan.length === 0;
  }

  setButtonDisabledState(el.btnUploadClear, {
    disabled: !uploading && !syncing && !queueHasItems,
    pseudoDisabled: uploading || syncing,
    reason: uploading
      ? "Cannot clear while uploading."
      : "Cannot clear while scanning.",
  });
  setButtonDisabledState(el.btnUploadClose, {
    disabled: false,
    pseudoDisabled: uploading,
    reason: "This panel cannot be closed while an upload is in progress.",
  });
}

// === Cache ===

function invalidateCache() {
  if (state.client) {
    state.client.folderCache.clear();
    state.client.createdFolders.clear();
  }
}

// === File Browser ===

async function browseFolder(path) {
  if (!state.client || state.connState !== "connected") return;

  // Check cache first
  let entries, truncated = false;
  const cached = state.client.folderCache.get(path);
  if (cached) {
    entries = sortEntries(cached.entries);
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
      state.client.folderCache.set(path, { entries, truncated });
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
    el.folderWarningText.textContent = "Listing may be incomplete — some entries couldn't load over Bluetooth.";
  } else if (entries.length >= LARGE_DIR_THRESHOLD) {
    el.folderWarningBanner.hidden = false;
    el.folderWarningText.textContent = `This folder has ${entries.length} items. Large folders can be slow over Bluetooth.`;
  } else {
    el.folderWarningBanner.hidden = true;
    el.folderWarningText.textContent = "";
  }

  state.currentPath = path;
  state.entries = entries;
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
    const _ep = "https://am\u0069iboapi.org/api/am\u0069ibo/";
    const res = await fetch(`${_ep}?head=${headHex}&tail=${tailHex}`);
    if (res.ok) {
      const _body = await res.json();
      const _key = "am\u0069ibo";
      const raw = (_body[_key])?.[0] ?? null;
      if (raw) raw.tagSeries = raw["am\u0069iboSeries"];
      info = raw;
    }
  } catch { /* network unavailable — leave null */ }
  _nfcTagCache.set(key, info);
  return info;
}

function nfcSeriesGradient(series) {
  if (!series) return "linear-gradient(135deg, #8b5cf6, #d946ef)";
  // More specific entries appear before their general counterpart to prevent partial clashes.
  // Keys are lowercase substrings of tagSeries / gameSeries as returned by amiiboapi.org.
  const map = [
    ["kirby air rider",         "linear-gradient(135deg, #ec4899, #3b82f6)"],   // Kirby Air Riders
    ["monster hunter rise",     "linear-gradient(135deg, #ef4444, #f97316)"],   // Monster Hunter Rise
    ["mario sports superstars", "linear-gradient(135deg, #ef4444, #22c55e)"],   // Mario Sports Superstars
    ["my mario wooden blocks",  "linear-gradient(135deg, #ef4444, #d97706)"],   // My Mario Wooden Blocks
    ["super smash bros.",       "linear-gradient(135deg, #1e1b4b, #312e81)"],   // Super Smash Bros.
    ["super mario bros.",       "linear-gradient(135deg, #ef4444, #dc2626)"],   // Super Mario Bros.
    ["super nintendo world",    "linear-gradient(135deg, #ef4444, #f59e0b)"],   // Super Nintendo World
    ["yoshi's woolly world",    "linear-gradient(135deg, #22c55e, #16a34a)"],   // Yoshi's Woolly World
    ["xenoblade chronicles",    "linear-gradient(135deg, #0284c7, #7c3aed)"],   // Xenoblade Chronicles 3
    ["legend of zelda",         "linear-gradient(135deg, #16a34a, #ca8a04)"],   // Legend Of Zelda
    ["street fighter",          "linear-gradient(135deg, #dc2626, #111827)"],   // Street Fighter 6
    ["animal crossing",         "linear-gradient(135deg, #84cc16, #65a30d)"],   // Animal Crossing
    ["monster hunter",          "linear-gradient(135deg, #92400e, #78350f)"],   // Monster Hunter
    ["shovel knight",           "linear-gradient(135deg, #1d4ed8, #1e40af)"],   // Shovel Knight
    ["donkey kong",             "linear-gradient(135deg, #f59e0b, #dc2626)"],   // Donkey Kong
    ["fire emblem",             "linear-gradient(135deg, #3b82f6, #2563eb)"],   // Fire Emblem
    ["mario kart",              "linear-gradient(135deg, #ef4444, #f59e0b)"],   // Mario Kart (gameSeries)
    ["skylanders",              "linear-gradient(135deg, #7c3aed, #1d4ed8)"],   // Skylanders
    ["chibi-robo",              "linear-gradient(135deg, #f59e0b, #d97706)"],   // Chibi-Robo!
    ["yu-gi-oh",                "linear-gradient(135deg, #7c3aed, #d97706)"],   // Yu-Gi-Oh!
    ["power pros",              "linear-gradient(135deg, #1d4ed8, #15803d)"],   // Power Pros
    ["star fox",                "linear-gradient(135deg, #8b5cf6, #7c3aed)"],   // Star Fox (gameSeries)
    ["splatoon",                "linear-gradient(135deg, #f97316, #84cc16)"],   // Splatoon
    ["mega man",                "linear-gradient(135deg, #0ea5e9, #0284c7)"],   // Mega Man
    ["metroid",                 "linear-gradient(135deg, #f97316, #dc2626)"],   // Metroid
    ["pokemon",                 "linear-gradient(135deg, #f59e0b, #ef4444)"],   // Pokemon
    ["boxboy",                  "linear-gradient(135deg, #374151, #111827)"],   // BoxBoy!
    ["pikmin",                  "linear-gradient(135deg, #84cc16, #10b981)"],   // Pikmin
    ["8-bit mario",             "linear-gradient(135deg, #dc2626, #7f1d1d)"],   // 8-bit Mario
    ["kirby",                   "linear-gradient(135deg, #ec4899, #db2777)"],   // Kirby
    ["diablo",                  "linear-gradient(135deg, #991b1b, #450a0a)"],   // Diablo
    ["pragmata",                "linear-gradient(135deg, #06b6d4, #1e1b4b)"],   // Pragmata
    ["yoshi",                   "linear-gradient(135deg, #22c55e, #16a34a)"],   // Yoshi (gameSeries fallback)
  ];
  const lower = series.toLowerCase();
  for (const [key, grad] of map) {
    if (lower.includes(key)) return grad;
  }
  let h = 0;
  for (const c of lower) h = (Math.imul(h, 31) + c.charCodeAt(0)) >>> 0;
  const hue = h % 360;
  return `linear-gradient(135deg, hsl(${hue},60%,45%), hsl(${(hue+40)%360},65%,40%))`;
}

function renderNfcTagField(head, tail, info) {
  const uid = formatNfcUid(head, tail);
  if (!info) return nfcDetailRow("Figure ID", uid, { mono: true });
  const rows = [];
  if (info.name) rows.push(nfcDetailRow("Character", info.name));
  if (info.tagSeries) rows.push(nfcDetailRow("Series", info.tagSeries));
  if (info.gameSeries) rows.push(nfcDetailRow("Game", info.gameSeries));
  if (info.type) rows.push(nfcDetailRow("Type", info.type));
  if (info.release?.na) rows.push(nfcDetailRow("Released", info.release.na));
  rows.push(nfcDetailRow("Figure ID", uid, { mono: true }));
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
  el.panelNfcTagContent.innerHTML = nfcDetailRow("Figure ID", formatNfcUid(head, tail));
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
  const grad = nfcSeriesGradient(info.gameSeries || info.tagSeries);
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
  const series = escapeHtml(info.tagSeries || info.gameSeries || "");
  const name = escapeHtml(info.name || entry.name);
  const game = info.gameSeries && info.gameSeries !== (info.tagSeries || "") ? escapeHtml(info.gameSeries) : "";
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
      title: "Device is empty",
      sub: "No files yet — drop some in to get started.",
    };
  }

  return {
    icon: "folder_open",
    title: "Folder is empty",
    sub: "Nothing here yet.",
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

    const nameWarn = utf8Length(entry.name) > MAX_FILE_NAME_BYTES;
    const iconHtml = isDir
      ? `<span class="cell-name-icon folder"><span class="ms-sm">folder</span></span>`
      : `<span class="cell-name-icon file"><span class="ms-sm">insert_drive_file</span></span>`;
    const warnIcon = nameWarn ? `<span class="ms-sm warn-icon cell-warn-icon" title="Filename is ${utf8Length(entry.name)} bytes, exceeding the ${MAX_FILE_NAME_BYTES}-byte firmware limit. Rename it to avoid issues.">warning</span>` : "";
    const nameCell = isDir
      ? `<td class="cell-name folder"><span class="cell-name-inner">${iconHtml}${escapeHtml(entry.name)}${warnIcon}</span></td>`
      : `<td class="cell-name"><span class="cell-name-inner">${iconHtml}${escapeHtml(entry.name)}${warnIcon}</span></td>`;

    const classes = [isPanelActive ? "panel-active" : "", isSelected ? "selected" : "", nameWarn ? "row-warn" : ""].filter(Boolean).join(" ");
    rows.push(
      `<tr data-name="${escapeHtml(entry.name)}"${classes ? ` class="${classes}"` : ''}>` +
      `<td class="cell-check"><input type="checkbox"${isSelected ? " checked" : ""}></td>` +
      nameCell +
      `<td class="cell-size">${size}</td>` +
      `<td class="cell-actions">` +
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
    const cls = i === 0
      ? `nav-crumb nav-crumb-home${isActive ? " active" : ""}`
      : `nav-crumb${isActive ? " active" : ""}`;
    return (i > 0 ? '<span class="nav-sep">›</span>' : "") +
      `<button class="${cls}" data-path="${escapeHtml(c.path)}">${label}</button>`;
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
  el.selectionBar.classList.toggle("has-selection", hasSelection);
  el.selectionCount.textContent = `${count} selected`;
  el.checkAll.checked = state.entries.length > 0 && count === state.entries.length;
  el.checkAll.indeterminate = hasSelection && count < state.entries.length;
  const fileCount = state.entries.filter(e => state.selectedNames.has(e.name) && e.type === "FILE").length;
  el.btnDownloadSelected.hidden = fileCount === 0;
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
  el.deleteModalMsg.textContent = `Permanently delete ${pluralize(count, "item")}? This action cannot be undone.`;
  openModal(el.deleteModal);
});

el.btnClearSelection.addEventListener("click", () => {
  state.selectedNames.clear();
  applySelectionToRows(false);
  updateSelectionBar();
});

el.btnDownloadSelected.addEventListener("click", async () => {
  const files = state.entries.filter(e => state.selectedNames.has(e.name) && e.type === "FILE");
  if (files.length === 0) return;
  const toast = showSuccessToast(`Downloading ${pluralize(files.length, "file")}…`);
  let failed = 0;
  for (const entry of files) {
    try {
      const res = await state.client.readFileData(joinChildPath(state.currentPath, entry.name));
      if (res.ok) {
        triggerDownload(res.data, entry.name);
        await new Promise(r => setTimeout(r, 150));
      } else {
        log(`Download failed: ${entry.name}: ${res.error}`, "err");
        failed++;
      }
    } catch (err) {
      log(`Download failed: ${entry.name}: ${err.message}`, "err");
      failed++;
    }
  }
  if (toast) removeToast(toast);
  if (failed > 0) {
    showErrorToast(`${pluralize(failed, "file")} failed to download`);
  } else {
    showSuccessToast(`Downloaded ${pluralize(files.length, "file")}`);
  }
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
    state.client.folderCache.delete(state.currentPath);
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
    if (h >= PTR_THRESHOLD * 0.45 && state.currentPath && state.connState === "connected") {
      el.ptrIndicator.classList.add("ptr-loading");
      el.ptrIndicator.classList.remove("ptr-ready");
      el.ptrIndicator.querySelector(".ptr-icon").style.transform = "";
      state.client.folderCache.delete(state.currentPath);
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
      showSuccessToast("Folder created");
      state.client.folderCache.delete(state.currentPath);
      await browseFolder(state.currentPath);
    } else {
      log(`Failed to create folder: ${res.error}`, "err");
      showErrorToast("Folder creation failed", res.error);
    }
  } catch (err) {
    log(`Failed to create folder: ${err.message}`, "err");
    showErrorToast("Folder creation failed", err.message);
  }
});

el.btnDeleteCancel.addEventListener("click", () => closeModal(el.deleteModal));
el.btnRenameCancel.addEventListener("click", () => closeModal(el.renameModal));

// Normalize modal
el.btnNormalize.addEventListener("click", () => {
  el.sanitizeNonePath.textContent = state.currentPath || "E:/";
  openModal(el.sanitizeModalNone);
});

el.btnSanitizeNoneCancel.addEventListener("click", () => closeModal(el.sanitizeModalNone));

// === Context Panel ===

function setPanelState(mode, entry) {
  // When upload panel is active, file selection only opens the right details panel —
  // it does not replace the left upload panel.
  if (mode === "file" && state.panelMode === "upload") {
    state.drawerEntry = entry;
    el.detailsPanel.hidden = false;
    if (entry) {
      el.panelFileName.textContent = entry.name;
      el.panelFileSize.textContent = formatBytes(entry.size);
      el.detailsKind.textContent = entry.type === "FILE" ? "File" : "Folder";
      const fullPath = joinChildPath(state.currentPath, entry.name);
      el.detailsFilePath.textContent = fullPath;
      if (el.detailsPathInRow) el.detailsPathInRow.textContent = fullPath;
      el.detailsHeroImgArea.innerHTML = `<span class="ms details-hero-file-icon" id="detailsHeroIcon">insert_drive_file</span>`;
      el.detailsHeroBand.hidden = true;
      el.detailsHeroBand.style.background = "";
      el.detailsHeroBand.innerHTML = "";
      el.panelNfcTag.hidden = true;
      el.panelNfcTagContent.innerHTML = "";
    }
    return;
  }

  // Left panel toggles between folder info and upload
  el.panelFolder.hidden = (mode === "upload");
  el.panelUpload.hidden = (mode !== "upload");

  // Right details panel: on desktop the two columns are independent, so only
  // touch it when not entering upload mode (mobile dismisses via closeDetailsSheet).
  if (mode !== "upload" || isMobileViewport()) {
    el.detailsPanel.hidden = (mode !== "file");
  }

  if (mode === "upload") {
    state.panelPrevMode = state.panelMode === "upload" ? state.panelPrevMode : state.panelMode;
    state.panelMode = "upload";
    if (isMobileViewport()) closeDetailsSheet();
    return;
  }

  if (mode === "file" && entry) {
    state.drawerEntry = entry;
    state.panelMode = "file";

    el.panelFileName.textContent = entry.name;
    el.panelFileSize.textContent = formatBytes(entry.size);
    el.detailsKind.textContent = entry.type === "FILE" ? "File" : "Folder";
    const fullPath = joinChildPath(state.currentPath, entry.name);
    el.detailsFilePath.textContent = fullPath;
    if (el.detailsPathInRow) el.detailsPathInRow.textContent = fullPath;

    el.detailsHeroImgArea.innerHTML = `<span class="ms details-hero-file-icon" id="detailsHeroIcon">insert_drive_file</span>`;
    el.detailsHeroBand.hidden = true;
    el.detailsHeroBand.style.background = "";
    el.detailsHeroBand.innerHTML = "";

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

  for (const row of el.fileTableBody.querySelectorAll("tr[data-name]")) {
    row.classList.remove("panel-active");
  }

  if (state.currentPath) {
    el.panelFolderName.textContent = "Pixl.js";
    el.panelFolderPath.textContent = state.drive ? state.drive.name : "E:/";
    const folderBaseName = state.currentPath === "E:/" ? "Root" : (getBaseName(state.currentPath) || state.currentPath);
    el.panelCurrentFolderName.textContent = folderBaseName;
    const fileCount = state.entries.filter(e => e.type === "FILE").length;
    const dirCount = state.entries.filter(e => e.type === "DIR").length;
    const parts = [];
    if (fileCount) parts.push(pluralize(fileCount, "file"));
    if (dirCount) parts.push(pluralize(dirCount, "folder"));
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
  if (state.panelMode === "upload") {
    el.detailsPanel.hidden = true;
    state.drawerEntry = null;
  } else {
    setPanelState("folder");
  }
  if (isMobileViewport()) closeDetailsSheet();
});

// Details sheet backdrop click
el.detailsSheetBackdrop.addEventListener("click", () => {
  if (state.panelMode === "upload") {
    el.detailsPanel.hidden = true;
    state.drawerEntry = null;
  } else {
    setPanelState("folder");
  }
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

function openLogSheet() {
  el.logOverlay.classList.add("open");
  document.body.classList.add("log-open");
  _lockScroll();
}
function closeLogSheet() {
  el.logOverlay.classList.remove("open");
  document.body.classList.remove("log-open");
  if (!el.sheetContainer.classList.contains("open") && !el.detailsSheetContainer.classList.contains("open")) _unlockScroll();
}

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
    const grad = nfcSeriesGradient(info.gameSeries || info.tagSeries);
    const tc = _gradientTextColor(grad);
    const uid = (head != null && tail != null) ? formatNfcUid(head, tail) : null;
    const rows = [];
    if (info.name) rows.push(["Character", info.name, false]);
    if (info.tagSeries) rows.push(["Series", info.tagSeries, false]);
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

    const lbSeries = info.tagSeries || info.gameSeries || "";
    const lbGame = info.gameSeries && info.gameSeries !== (info.tagSeries || "") ? info.gameSeries : "";
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
  if (e.target === el.imgLightbox || e.target.classList.contains("img-lightbox-inner") || window.innerWidth <= 767) closeLightbox();
});

// === Upload panel toggle ===

el.sidebarDropZone.addEventListener("click", () => {
  if (isAriaDisabled(el.sidebarDropZone)) return;
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
el.sidebarDropZone.addEventListener("drop", async (e) => {
  e.preventDefault();
  _dropZoneCounter = 0;
  el.sidebarDropZone.classList.remove("drag-over");
  if (isAriaDisabled(el.sidebarDropZone)) return;
  const { items, files } = e.dataTransfer;
  const hasEntryApi = items && items.length > 0 && typeof items[0].webkitGetAsEntry === "function";
  if (!hasEntryApi && (!files || files.length === 0)) return;
  try {
    const collected = hasEntryApi
      ? await collectFromDataTransfer(e.dataTransfer)
      : collectFromFiles(files);
    if (collected.files.length === 0 && collected.folders.size === 0) return;
    if (!await checkSystemFolderWarning(collected)) return;
    buildUploadPlan(collected.folders, collected.files);
    setPanelState("upload");
  } catch (err) {
    log(`Drop error: ${err.message}`, "err");
  }
});

el.btnUploadClose.addEventListener("click", () => {
  if (isAriaDisabled(el.btnUploadClose)) return;
  resetUploadSessionState();
  renderUploadQueue();
  updateControls();
  state.panelMode = "folder";
  if (isMobileViewport()) {
    // Mobile: panels are unified — restore to file or folder as appropriate.
    if (state.panelPrevMode === "file" && state.drawerEntry) {
      setPanelState("file", state.drawerEntry);
    } else {
      setPanelState("folder");
      closeSheet();
    }
  } else {
    // Desktop: left and right panels are independent. Only swap the left panel;
    // leave the right details panel exactly as it is.
    el.panelFolder.hidden = false;
    el.panelUpload.hidden = true;
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
      showSuccessToast("Renamed");
    } else {
      log(`Rename failed: ${res.error}`, "err");
      showErrorToast("Rename failed", res.error);
    }
  } catch (err) {
    log(`Failed to rename: ${err.message}`, "err");
    showErrorToast("Rename failed", err.message);
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
  const depthOf = new Map(paths.map(p => [p, (p.path.match(/\//g) || []).length]));
  paths.sort((a, b) => {
    const d = depthOf.get(b) - depthOf.get(a);
    if (d !== 0) return d;
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
          log(`Deleted ${item.path}`, "ok");
        } else {
          failedPaths.push(item.path);
          log(`Delete failed: ${item.path} — ${res.error}`, "err");
        }
      } catch (err) {
        failedPaths.push(item.path);
        log(`Delete failed: ${item.path} — ${err.message}`, "err");
      }
    }
    if (deleted === total) {
      showSuccessToast(`Deleted ${pluralize(deleted, "item")}`);
    } else if (deleted > 0) {
      showErrorToast(`Deleted ${deleted} of ${total} — some failed`, firstPlusMore(failedPaths));
    } else {
      showErrorToast("Delete failed", firstPlusMore(failedPaths) || "Nothing was deleted");
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
        log(`Renamed: ${op.from} → ${op.to}`, "ok");
      } else {
        log(`Rename failed: ${op.from} — ${res.error}`, "err");
      }
    } catch (err) {
      log(`Rename failed: ${op.from} — ${err.message}`, "err");
    }
  }

  if (allSkipped.length > 0) {
    for (const s of allSkipped) {
      log(`Skipped: ${s.name} — ${s.reason}`);
    }
  }
  const renamedText = pluralize(renamed, "item");
  const totalText = pluralize(allOps.length, "item");
  const skippedText = allSkipped.length > 0 ? `Skipped ${pluralize(allSkipped.length, "item")}` : "";
  if (renamed === allOps.length && renamed > 0) {
    showSuccessToast(`Renamed ${renamedText}`, skippedText);
  } else if (renamed > 0) {
    showErrorToast(`Renamed ${renamedText} of ${totalText}`, skippedText);
  } else if (allOps.length > 0) {
    showErrorToast("Rename failed");
  } else {
    showSuccessToast("Already lowercase", skippedText);
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
    showErrorToast("Rename failed", err.message);
  } finally {
    el.browserLockOverlay.classList.remove("active");
    updateControls();
    invalidateCache();
    await browseFolder(state.currentPath);
  }
}

// --- Sanitize: none confirm ---

el.btnSanitizeNoneConfirm.addEventListener("click", async () => {
  closeModal(el.sanitizeModalNone);
  if (!state.client) return;

  let scope;
  try {
    scope = readCheckedRadioValue("sanitizeNoneScope", "Normalize scope");
  } catch (err) {
    showErrorToast("Rename failed", err.message);
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
  await walk(handle, handle.name);
  return { folders, files };
}

async function collectFromWebkitDir(fileList) {
  const folders = new Set();
  const files = [];
  for (const f of Array.from(fileList)) {
    const rel = f.webkitRelativePath || f.name;
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

async function collectFromDataTransfer(dataTransfer) {
  const folders = new Set();
  const files = [];

  // Capture entries synchronously before any await (items list clears after event)
  const entries = Array.from(dataTransfer.items)
    .filter(item => item.kind === "file")
    .map(item => item.webkitGetAsEntry?.())
    .filter(Boolean);

  function readAllEntries(reader) {
    return new Promise((resolve, reject) => {
      const all = [];
      function next() {
        reader.readEntries(batch => {
          if (batch.length === 0) resolve(all);
          else { all.push(...batch); next(); }
        }, reject);
      }
      next();
    });
  }

  function fileFromEntry(entry) {
    return new Promise((resolve, reject) => entry.file(resolve, reject));
  }

  async function walk(entry, pfx) {
    if (entry.isDirectory) {
      if (pfx) folders.add(pfx);
      const children = await readAllEntries(entry.createReader());
      for (const child of children) {
        await walk(child, pfx ? `${pfx}/${child.name}` : child.name);
      }
    } else {
      const f = await fileFromEntry(entry);
      files.push({ relativePath: pfx, file: f });
      collectFoldersFromPath(pfx, folders);
    }
  }

  for (const entry of entries) {
    await walk(entry, entry.name);
  }

  return { folders, files };
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

function hasQueuedUploadState() {
  return state.uploadPlan.length > 0 ||
    state.syncState === "scanning" ||
    state.syncSkippedFiles.length > 0 ||
    state.syncOrphans.length > 0;
}

function resetUploadSessionState() {
  state.uploadPlan = [];
  state.uploadWarnings = [];
  state.uploadBase = "E:/";
  state.syncState = "idle";
  state.syncSkippedFiles = [];
  state.syncOrphans = [];
  state.syncOrphanChecked = new Set();
  state.transferSpeed = "";
  resetUploadProgress([]);
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
  if (!hasQueuedUploadState()) {
    el.uploadProgressTotal.textContent = "Nothing queued";
    return;
  }

  if (state.syncState === "done") {
    const uploadCount = state.uploadPlan.filter(i => i.kind === "file").length;
    const deleteCount = state.syncOrphanChecked.size;
    if (uploadCount === 0 && deleteCount === 0) {
      el.uploadProgressTotal.textContent = "Everything is in sync";
    } else {
      const parts = [];
      if (uploadCount > 0) parts.push(`${pluralize(uploadCount, "file")} to upload`);
      if (deleteCount > 0) parts.push(`${deleteCount} to delete`);
      el.uploadProgressTotal.textContent = parts.join(" · ");
    }
    return;
  }

  if (state.uploadTotalCount === 0) {
    el.uploadProgressTotal.textContent = "Nothing queued";
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

function renderSyncQueue() {
  const uploadFiles = state.uploadPlan.filter(i => i.kind === "file");
  const unchangedCount = state.syncSkippedFiles.length;
  const orphanCount = state.syncOrphans.length;
  let html = "";

  // Summary chips
  const chipParts = [];
  if (uploadFiles.length > 0) chipParts.push(`<span class="sync-chip sync-chip-upload">↑ ${uploadFiles.length} new</span>`);
  if (unchangedCount > 0) chipParts.push(`<span class="sync-chip sync-chip-unchanged">${unchangedCount} up to date</span>`);
  if (orphanCount > 0) chipParts.push(`<span class="sync-chip sync-chip-orphan">\u{1F5D1} ${orphanCount} orphaned</span>`);
  html += `<div class="sync-chips">${chipParts.join("")}</div>`;

  // Upload section — only render header when there are files
  if (uploadFiles.length === 0) {
    html += `<div class="queue-empty"><span class="ms queue-empty-icon done">check_circle</span><span class="queue-empty-title">Everything is in sync</span></div>`;
  } else {
    html += `<div class="sync-section-header sync-header-upload">TO UPLOAD · ${uploadFiles.length}</div>`;
    for (const item of uploadFiles) {
      const icon = getQueueStatusIcon(item.status);
      const baseName = escapeHtml(getBaseName(item.remotePath));
      const title = escapeHtml(item.remotePath);
      html += `<div class="queue-item">` +
        `${icon}` +
        `<span class="queue-name" title="${title}">${baseName}</span>` +
        `<span class="queue-status">${escapeHtml(formatBytes(item.size))}</span>` +
        `</div>`;
    }
  }

  // Orphan section
  if (orphanCount > 0) {
    html += `<div class="sync-section-header sync-header-orphan">` +
      `ON DEVICE ONLY · ${orphanCount}` +
      `<button class="sync-delete-all-btn" type="button">Delete all</button>` +
      `</div>`;
    for (const orphan of state.syncOrphans) {
      const baseName = escapeHtml(getBaseName(orphan.remotePath));
      const title = escapeHtml(orphan.remotePath);
      const suffix = orphan.kind === "folder" ? "/" : "";
      if (!orphan.deletable) {
        html += `<div class="queue-item queue-orphan-item">` +
          `<span class="queue-name" title="${title}">${baseName}${suffix}</span>` +
          `<em class="queue-orphan-nondeletable">folder has contents</em>` +
          `</div>`;
      } else if (orphan.status === "deleting") {
        html += `<div class="queue-item queue-orphan-item">` +
          `<span class="ms-sm spin queue-icon active">sync</span>` +
          `<span class="queue-name" title="${title}">${baseName}${suffix}</span>` +
          `<span class="queue-status active">deleting…</span>` +
          `</div>`;
      } else if (orphan.status === "deleted") {
        html += `<div class="queue-item queue-orphan-item">` +
          `<span class="ms-sm queue-icon done">check_circle</span>` +
          `<span class="queue-name" title="${title}">${baseName}${suffix}</span>` +
          `<span class="queue-status done">deleted</span>` +
          `</div>`;
      } else if (orphan.status === "error") {
        html += `<div class="queue-item queue-orphan-item">` +
          `<span class="ms-sm queue-icon error">error</span>` +
          `<span class="queue-name" title="${title}">${baseName}${suffix}</span>` +
          `<span class="queue-status error">error</span>` +
          `</div>`;
      } else {
        // pending — checkbox
        const checked = state.syncOrphanChecked.has(orphan.remotePath) ? " checked" : "";
        html += `<div class="queue-item queue-orphan-item">` +
          `<input type="checkbox" class="orphan-checkbox" data-path="${escapeHtml(orphan.remotePath)}"${checked}>` +
          `<span class="queue-name" title="${title}">${baseName}${suffix}</span>` +
          `<span class="queue-status">${escapeHtml(formatBytes(orphan.size))}</span>` +
          `</div>`;
      }
    }
  }

  el.uploadQueue.innerHTML = html;
}

function renderUploadQueue() {
  renderUploadSummary();

  if (state.syncState === "scanning") {
    el.uploadQueue.innerHTML =
      `<div class="sync-scanning"><span class="ms spin">sync</span><span class="sync-scanning-text"> Scanning device…</span></div>`;
    el.uploadWarningBanner.hidden = true;
    el.uploadWarningBanner.innerHTML = "";
    return;
  }

  if (state.syncState === "done") {
    renderSyncQueue();
    el.uploadWarningBanner.hidden = true;
    el.uploadWarningBanner.innerHTML = "";
    return;
  }

  if (state.uploadPlan.length === 0) {
    const [icon, title, sub] = state.uploadTotalCount > 0
      ? ["task_alt", "Upload complete", ""]
      : ["inbox", "Queue is empty", `<span class="queue-empty-sub">Pick files or a folder above</span>`];
    el.uploadQueue.innerHTML = `<div class="queue-empty"><span class="ms queue-empty-icon${state.uploadTotalCount > 0 ? " done" : ""}">${icon}</span><span class="queue-empty-title">${title}</span>${sub}</div>`;
    el.uploadWarningBanner.hidden = true;
    el.uploadWarningBanner.innerHTML = "";
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
  if (state.uploadWarnings.length > 0 && !state.uploadActive) {
    const wasOpen = !!el.uploadWarningBanner.querySelector("details")?.open;
    // Summary line (collapsed state)
    const summaryParts = [];
    for (const w of state.uploadWarnings) {
      if (w.type === "large-dirs") summaryParts.push(pluralize(w.dirs.length, "crowded folder"));
      else if (w.type === "large-batch") summaryParts.push(`~${w.mins} min upload`);
    }
    // Detail body (expanded state) — one block per problem, paths listed once
    let bodyHtml = "";
    for (const w of state.uploadWarnings) {
      if (w.type === "large-dirs") {
        const pathList = w.dirs.map(({ dir }) => `<li>${escapeHtml(dir)}</li>`).join("");
        bodyHtml += `<p>${pluralize(w.dirs.length, "folder")} with many files — these may transfer slowly or stall:</p><ul>${pathList}</ul>`;
      } else if (w.type === "large-batch") {
        bodyHtml += `<p>${w.count} files total. Expect ${w.mins}+ minutes — keep the device nearby and the screen on to avoid drops.</p>`;
      }
    }
    el.uploadWarningBanner.className = "queue-warning";
    el.uploadWarningBanner.innerHTML =
      `<details${wasOpen ? " open" : ""}>` +
      `<summary class="queue-warning-header">` +
      `<span class="ms-sm">warning</span> ${escapeHtml(summaryParts.join(" · "))}` +
      `<span class="ms-sm queue-warning-toggle">keyboard_arrow_down</span>` +
      `</summary>` +
      `<div class="queue-warning-body">${bodyHtml}</div>` +
      `</details>`;
    el.uploadWarningBanner.hidden = false;
  } else {
    el.uploadWarningBanner.hidden = true;
    el.uploadWarningBanner.innerHTML = "";
  }
}

// --- Upload plan building ---

let planSeed = 0;

function buildUploadPlan(folders, files) {
  state.syncState = "idle";
  state.syncSkippedFiles = [];
  state.syncOrphans = [];
  state.syncOrphanChecked = new Set();

  const base = state.currentPath || "E:/";
  state.uploadBase = base;
  const sortedFolders = [...folders].sort((a, b) => {
    const d = a.split("/").length - b.split("/").length;
    return d !== 0 ? d : a.localeCompare(b);
  });
  const plan = [];
  const skipped = [];

  for (const rel of sortedFolders) {
    const remote = joinChildPath(base, rel.toLowerCase());
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
    const remote = joinChildPath(base, entry.relativePath.toLowerCase());
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
      showErrorToast("No files added to queue", formatUploadInputFeedback(skipped));
    } else {
      showWarningToast("No files added to queue", "The selected folder appears to be empty.");
    }
    return;
  }

  if (skipped.length > 0) {
    showWarningToast(`Skipped ${pluralize(skipped.length, "invalid upload item")}`, formatUploadInputFeedback(skipped));
  }
}

function checkUploadPlanWarnings(plan) {
  const warnings = [];
  // Per-directory density check
  const largeDirs = [];
  const perDir = new Map();
  for (const item of plan) {
    const parent = getParentPath(item.remotePath);
    perDir.set(parent, (perDir.get(parent) || 0) + 1);
  }
  for (const [dir, planned] of perDir) {
    const cached = state.client.folderCache.get(dir);
    const existing = cached ? cached.entries.length : 0;
    const total = planned + existing;
    if (total >= LARGE_DIR_THRESHOLD) largeDirs.push({ dir, total });
  }
  if (largeDirs.length > 0) warnings.push({ type: "large-dirs", dirs: largeDirs });
  // Total batch size check
  if (plan.length >= LARGE_BATCH_THRESHOLD) {
    const mins = Math.ceil(plan.length * 0.75 / 60);
    warnings.push({ type: "large-batch", count: plan.length, mins });
  }
  return warnings;
}

function warningsToStrings(warnings) {
  const lines = [];
  for (const w of warnings) {
    if (w.type === "large-dirs") {
      for (const { dir } of w.dirs) {
        lines.push(`${dir} has many files and may transfer slowly or stall`);
      }
    } else if (w.type === "large-batch") {
      lines.push(`${w.count} files total — expect ${w.mins}+ minutes. Keep the device nearby and screen on to avoid drops`);
    }
  }
  return lines;
}

function detectSystemFolderWarnings(folders, files) {
  const base = (state.currentPath || "E:/").toLowerCase();
  const affected = new Set();
  const check = rel => {
    const remote = joinChildPath(base, rel.toLowerCase());
    if (remote === "e:/amiibo/data" || remote.startsWith("e:/amiibo/data/")) affected.add("data");
    if (remote === "e:/amiibo/fav"  || remote.startsWith("e:/amiibo/fav/"))  affected.add("fav");
  };
  for (const rel of folders) check(rel);
  for (const entry of files) check(entry.relativePath);
  return affected;
}

// Shared confirm modal: sets innerHTML, opens uploadWarnModal, returns Promise<boolean>.
// AbortController + modal:close event ensure listeners always clean up (Cancel, X, Escape).
function showUploadWarnModal(htmlContent) {
  return new Promise(resolve => {
    el.uploadWarnMsg.innerHTML = htmlContent;
    openModal(el.uploadWarnModal);
    const ac = new AbortController();
    const { signal } = ac;
    const done = (result) => { ac.abort(); closeModal(el.uploadWarnModal); resolve(result); };
    el.btnUploadWarnConfirm.addEventListener("click", () => done(true), { signal });
    el.btnUploadWarnCancel.addEventListener("click", () => done(false), { signal });
    el.uploadWarnModal.addEventListener("modal:close", () => { ac.abort(); resolve(false); }, { signal, once: true });
  });
}

function buildSystemFolderWarnHtml(affected) {
  const parts = [];
  if (affected.has("data")) parts.push(
    `<p><strong>My Tags (amiibo/data)</strong> — files here must be named ` +
    `<strong>00.bin, 01.bin</strong>… to appear as slots in the AmiiDB app.</p>`
  );
  if (affected.has("fav")) parts.push(
    `<p><strong>My Favorites (amiibo/fav)</strong> — this folder uses an internal ` +
    `format managed by AmiiDB. Uploaded files won't be visible in the app.</p>`
  );
  return parts.join("") + `<p class="modal-note">You can still upload, but files may not appear as expected.</p>`;
}

async function checkSystemFolderWarning(collected) {
  const affected = detectSystemFolderWarnings(collected.folders, collected.files);
  if (affected.size === 0) return true;
  return showUploadWarnModal(buildSystemFolderWarnHtml(affected));
}

// --- Sync ---

async function runSync() {
  if (!state.client || state.connState !== "connected") return;
  if (state.syncState === "scanning") return;

  state.syncState = "scanning";
  state.syncSkippedFiles = [];
  state.syncOrphans = [];
  state.syncOrphanChecked = new Set();
  updateControls();
  renderUploadQueue();

  const deviceTree = new Map(); // remotePath → { size, kind }
  let scanCount = 0;

  function setScanText(msg) {
    const span = el.uploadQueue.querySelector(".sync-scanning-text");
    if (span) span.textContent = " " + msg;
  }

  async function walk(path) {
    const res = await state.client.readFolder(path);
    if (!res.ok) throw new Error(`readFolder(${path}): ${res.error}`);
    if (res.truncated) throw new Error(`Directory listing truncated at ${path}`);
    state.client.folderCache.set(path, { entries: sortEntries(res.data), truncated: false });
    scanCount++;
    setScanText(`Scanning device… · ${pluralize(scanCount, "folder")}`);
    for (const entry of res.data) {
      const entryPath = joinChildPath(path, entry.name);
      if (isSyncExcluded(entryPath)) continue;
      const kind = entry.type === "DIR" ? "folder" : "file";
      deviceTree.set(entryPath, { size: entry.size, kind });
      if (kind === "folder") await walk(entryPath);
    }
  }

  el.browserLockOverlay.classList.add("active");
  el.browserLockTitle.textContent = "Scanning device…";

  try {
    const base = state.uploadBase || "E:/";
    const normBase = base.endsWith("/") ? base : base + "/";

    // Compute scan roots from the upload plan
    const scanRoots = new Set();
    for (const item of state.uploadPlan) {
      if (!item.remotePath.startsWith(normBase)) continue;
      const topSeg = item.remotePath.slice(normBase.length).split("/")[0];
      if (!topSeg) continue;
      const rootPath = normBase + topSeg;
      const isFolder = state.uploadPlan.some(i => i.remotePath === rootPath && i.kind === "folder");
      const hasNested = item.remotePath.slice(normBase.length).includes("/");
      if (isFolder || hasNested) scanRoots.add(rootPath);
    }
    for (const root of scanRoots) {
      try { await walk(root); }
      catch (err) { if (!err.message.includes("Not found")) throw err; }
    }
  } catch (err) {
    el.browserLockOverlay.classList.remove("active");
    log(`Sync scan failed: ${err.message}`, "err");
    showErrorToast("Scan failed", err.message);
    state.syncState = "error";
    updateControls();
    renderUploadQueue();
    return;
  }

  el.browserLockOverlay.classList.remove("active");

  // Snapshot original plan paths (pre-filter) to detect orphans
  const localPaths = new Set(state.uploadPlan.map(i => i.remotePath));

  // Filter plan: remove items already on device at same size
  const skippedFiles = [];
  const filteredPlan = [];
  for (const item of state.uploadPlan) {
    if (item.kind === "file") {
      const remote = deviceTree.get(item.remotePath);
      if (remote && remote.kind === "file" && remote.size === item.size) {
        skippedFiles.push({ remotePath: item.remotePath, size: item.size });
        continue;
      }
    } else if (item.kind === "folder" && deviceTree.has(item.remotePath)) {
      continue;
    }
    filteredPlan.push(item);
  }

  // Find orphans: device entries absent from the original local plan
  const orphans = [];
  for (const [remotePath, { size, kind }] of deviceTree) {
    if (localPaths.has(remotePath)) continue;
    let deletable = kind === "file";
    if (kind === "folder") {
      const prefix = remotePath.endsWith("/") ? remotePath : remotePath + "/";
      deletable = ![...deviceTree.keys()].some(p => p.startsWith(prefix));
    }
    orphans.push({ remotePath, size, kind, deletable, status: "pending" });
  }

  state.syncSkippedFiles = skippedFiles;
  state.syncOrphans = orphans;
  state.uploadPlan = filteredPlan;
  state.uploadWarnings = checkUploadPlanWarnings(filteredPlan);
  state.syncState = "done";
  resetUploadProgress(filteredPlan);
  renderUploadQueue();
  updateControls();
}

async function runOrphanDeletion() {
  const toDelete = state.syncOrphans.filter(
    o => o.deletable && o.status === "pending" && state.syncOrphanChecked.has(o.remotePath)
  );
  let deletedCount = 0;
  let errorCount = 0;
  for (const orphan of toDelete) {
    orphan.status = "deleting";
    renderUploadQueue();
    try {
      const res = await state.client.removePath(orphan.remotePath);
      if (!res.ok) throw new Error(res.error);
      orphan.status = "deleted";
      deletedCount++;
      log(`Removed ${orphan.remotePath}`, "ok");
      state.client.folderCache.delete(getParentPath(orphan.remotePath));
    } catch (err) {
      log(`Remove failed: ${orphan.remotePath} — ${err.message}`, "err");
      orphan.status = "error";
      errorCount++;
    }
    renderUploadQueue();
  }
  if (errorCount > 0) {
    showWarningToast(`Removed ${deletedCount} of ${deletedCount + errorCount} from device (${errorCount} failed)`);
  } else if (deletedCount > 0) {
    showSuccessToast(`Removed ${pluralize(deletedCount, "file")} from device`);
  }
}

// --- Upload execution ---

async function runUpload() {
  const hasUploads = state.uploadPlan.filter(i => i.kind === "file").length > 0;
  const hasOrphanDeletions = state.syncOrphanChecked.size > 0;
  if (!state.client || state.connState !== "connected" || state.uploadActive) return;
  if (!hasUploads && !hasOrphanDeletions) return;

  if (state.uploadWarnings.length > 0) {
    const lines = warningsToStrings(state.uploadWarnings).map(w => `<li>${escapeHtml(w)}</li>`).join("");
    const html = `<ul class="modal-list">${lines}</ul>` +
      `<p class="modal-note">You can still proceed, but the upload may be slow or fail partway through.</p>`;
    if (!await showUploadWarnModal(html)) return;
  }

  state.uploadActive = true;
  state.abortController = new AbortController();
  el.browserLockOverlay.classList.add("active");
  el.browserLockTitle.textContent = "Uploading…";

  updateControls();

  resetUploadProgress(state.uploadPlan);

  for (const item of state.uploadPlan) { item.transferred = 0; item.status = "pending"; }
  renderUploadQueue();

  const folderItems = state.uploadPlan.filter(i => i.kind === "folder");
  const fileItems = state.uploadPlan.filter(i => i.kind === "file");

  try {
    for (const item of folderItems) {
      if (state.abortController.signal.aborted) throw new Error("Aborted.");
      item.status = "active";
      renderUploadQueue();
      await state.client.ensureFolder(item.remotePath);
      item.transferred = item.size;
      consumeCompletedUploadItem(item);
      renderUploadQueue();
    }

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
      log(`Uploaded ${item.remotePath} (${formatBytes(item.size)})`, "ok");
      consumeCompletedUploadItem(item);
      renderUploadQueue();
    }
    // Phase 2: Orphan deletion
    if (!state.abortController.signal.aborted && state.syncOrphanChecked.size > 0) {
      await runOrphanDeletion();
    }

    if (fileItems.length > 0) {
      showSuccessToast(`Uploaded ${pluralize(fileItems.length, "file")}`);
    }
  } catch (err) {
    log(`Upload error: ${err.message}`, "err");
    const isReconnecting = state.connState === "reconnecting";
    const isConnectionLoss = !isReconnecting && /GATT|NetworkError|disconnected/i.test(err.message);
    const isUserAbort = !isReconnecting && !isConnectionLoss && state.abortController && state.abortController.signal.aborted;
    if (isUserAbort) {
      showErrorToast("Upload cancelled");
    } else if (!isReconnecting && !isConnectionLoss) {
      showErrorToast("Upload failed", err.message);
    }
    const active = state.uploadPlan.find(i => i.status === "active");
    if (active) active.status = isUserAbort ? "aborted" : "error";
    if (!isReconnecting && !isConnectionLoss) {
      for (const item of state.uploadPlan) { if (item.status === "pending") item.status = "aborted"; }
    }
    renderUploadQueue();
  } finally {
    state.syncState = "idle";
    state.syncSkippedFiles = [];
    state.syncOrphans = [];
    state.syncOrphanChecked = new Set();
    state.uploadActive = false;
    state.abortController = null;
    state.transferSpeed = "";
    el.browserLockOverlay.classList.remove("active");
    renderUploadQueue();
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
      if (!await checkSystemFolderWarning(collected)) return;
      buildUploadPlan(collected.folders, collected.files);
      setPanelState("upload");
    } else {
      el.folderInput.click();
    }
  } catch (err) {
    if (err.name !== "AbortError") log(`Picker error: ${err.message}`, "err");
  }
});

el.folderInput.addEventListener("change", async (e) => {
  if (!e.target.files || e.target.files.length === 0) return;
  const snapshot = Array.from(e.target.files);
  e.target.value = "";
  try {
    const collected = await collectFromWebkitDir(snapshot);
    if (!await checkSystemFolderWarning(collected)) return;
    buildUploadPlan(collected.folders, collected.files);
    setPanelState("upload");
  } catch (err) {
    showErrorToast("Upload failed", err.message);
  }
});

el.btnPickFiles.addEventListener("click", () => el.filesInput.click());

el.filesInput.addEventListener("change", async (e) => {
  if (!e.target.files || e.target.files.length === 0) return;
  const snapshot = Array.from(e.target.files);
  e.target.value = "";
  try {
    const collected = collectFromFiles(snapshot);
    if (!await checkSystemFolderWarning(collected)) return;
    buildUploadPlan(collected.folders, collected.files);
    setPanelState("upload");
  } catch (err) {
    showErrorToast("Upload failed", err.message);
  }
});

el.btnUploadStart.addEventListener("click", runUpload);

el.btnSync.addEventListener("click", runSync);

// Orphan checkbox toggle (event delegation — survives innerHTML re-renders)
el.uploadQueue.addEventListener("change", (e) => {
  if (!e.target.classList.contains("orphan-checkbox")) return;
  const path = e.target.dataset.path;
  if (e.target.checked) {
    state.syncOrphanChecked.add(path);
  } else {
    state.syncOrphanChecked.delete(path);
  }
  renderUploadSummary();
  updateControls();
});

// "Delete all" button in orphan section header (event delegation)
el.uploadQueue.addEventListener("click", (e) => {
  const btn = e.target.closest(".sync-delete-all-btn");
  if (!btn) return;
  for (const orphan of state.syncOrphans) {
    if (orphan.deletable && orphan.status === "pending") {
      state.syncOrphanChecked.add(orphan.remotePath);
    }
  }
  renderSyncQueue();
  renderUploadSummary();
  updateControls();
});

el.btnUploadAbort.addEventListener("click", () => {
  if (state.abortController) {
    state.abortController.abort();
    log("Upload cancelled.");
  }
});

el.btnUploadClear.addEventListener("click", () => {
  if (isAriaDisabled(el.btnUploadClear)) return;
  resetUploadSessionState();
  renderUploadQueue();
  updateControls();
});

// === Initial state ===

const _buildCommit = document.querySelector('meta[name="build-commit"]')?.content;
const _buildBranch = document.querySelector('meta[name="build-branch"]')?.content;

if (_buildCommit && _buildCommit !== "dev") {
  el.navCommit.textContent = _buildCommit;
  el.navCommitOverlay.textContent = _buildCommit;
  el.navCommitMobile.textContent = _buildCommit;
}

const isDevMode = _buildCommit === "dev" || (_buildBranch && _buildBranch !== "main") || (!_buildCommit && !_buildBranch);
if (isDevMode) {
  el.btnDev.addEventListener("click", devConnect);
  if (_buildCommit === "dev") {
    el.navCommit.textContent = "dev";
    el.navCommitOverlay.textContent = "dev";
    el.navCommitMobile.textContent = "dev";
  }
}

setConnState("disconnected");
updateControls();

if (!navigator.bluetooth) {
  const [summary, detail, overlaySub] = window.isSecureContext
    ? [
        "Chrome or Edge required",
        "Your browser doesn't support device connections. Switch to Chrome or Edge to use Mochi.",
        "Open Mochi in Chrome or Edge to connect to your Pixl.js.",
      ]
    : [
        "Secure connection required",
        "Mochi needs to be opened over HTTPS to connect to your device.",
        "Open this page over HTTPS to connect to your Pixl.js.",
      ];
  el.mainOverlaySub.textContent = overlaySub;
  el.btnConnectCta.disabled = true;
  showErrorToast(summary, detail);
}
