import {
    PixlToolsClient,
    DevMockClient,
    validateRemotePath,
    getBaseName,
    getParentPath,
    sortEntries,
    utf8Length,
    MAX_FILE_NAME_BYTES,
    NUS_SERVICE,
} from "./client.js";

// === Constants ===

const LARGE_DIR_THRESHOLD = 80;
const LARGE_BATCH_THRESHOLD = 200;
const SYNC_EXCLUDE_PATHS = ["e:/amiibo/fav", "e:/amiibo/data"]; // device paths excluded from sync on both sides
const PIXL_RELEASES_URL = "https://github.com/solosky/pixl.js/releases";

const FAVICON_PATH = `<path d="M225.5-82.5Q120-125 120-200q0-32 20-57.5t56-45.5l65 58q-24 8-42.5 20.5T200-200q0 26 81 53t199 27q118 0 199-27t81-53q0-12-18.5-24.5T699-245l65-58q36 20 56 45.5t20 57.5q0 75-105.5 117.5T480-40q-149 0-254.5-42.5Zm212-125Q417-215 400-230L148-453q-13-11-20.5-27t-7.5-33v-80q0-17 6.5-33t19.5-27l252-235q17-16 38-24t44-8q23 0 44 8t38 24l252 235q13 11 19.5 27t6.5 33v80q0 17-7.5 33T812-453L560-230q-17 15-37.5 22.5T480-200q-22 0-42.5-7.5Zm-42-357Q410-579 410-600t-14.5-35.5Q381-650 360-650t-35.5 14.5Q310-621 310-600t14.5 35.5Q339-550 360-550t35.5-14.5ZM410-496q43 21 90.5 13.5T584-522q34-29 44.5-73T618-678L410-496Zm105.5-188.5Q530-699 530-720t-14.5-35.5Q501-770 480-770t-35.5 14.5Q430-741 430-720t14.5 35.5Q459-670 480-670t35.5-14.5Z"/>`;
const VISUAL_STATE_COLORS = {
    disconnected: {
        favicon: "#9ca3af",
        theme: "#9ca3af",
        brandFrom: "#9ca3af",
        brandTo: "#cbd5e1",
    },
    connecting: {
        favicon: "#f59e0b",
        theme: "#f59e0b",
        brandFrom: "#f59e0b",
        brandTo: "#fde68a",
    },
    connected: {
        favicon: "#10b981",
        theme: "#059669",
        brandFrom: "#059669",
        brandTo: "#34d399",
    },
    reconnecting: {
        favicon: "#fb923c",
        theme: "#f97316",
        brandFrom: "#f97316",
        brandTo: "#fbbf24",
    },
    mock: {
        favicon: "#7878cc",
        theme: "#7c3aed",
        brandFrom: "#7c3aed",
        brandTo: "#d946ef",
    },
    dfu: {
        favicon: "#f97316",
        theme: "#ea580c",
        brandFrom: "#ea580c",
        brandTo: "#fb923c",
    },
};

function resolveVisualState(connState, isMock) {
    const key = isMock ? "mock" : connState;
    return VISUAL_STATE_COLORS[key] ?? VISUAL_STATE_COLORS.disconnected;
}

function hexToRgba(hex, alpha) {
    const value = String(hex || "").replace("#", "");
    if (value.length !== 6) return `rgba(124, 58, 237, ${alpha})`;
    const r = Number.parseInt(value.slice(0, 2), 16);
    const g = Number.parseInt(value.slice(2, 4), 16);
    const b = Number.parseInt(value.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function setStateColors(connState, isMock) {
    const { favicon, theme, brandFrom, brandTo } = resolveVisualState(
        connState,
        isMock,
    );
    const mockVisuals = resolveVisualState("connected", true);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -960 960 960" width="32" height="32" fill="${favicon}">${FAVICON_PATH}</svg>`;
    const link = document.querySelector('link[rel="icon"]');
    const themeMeta = document.querySelector('meta[name="theme-color"]');
    if (link) link.href = "data:image/svg+xml," + encodeURIComponent(svg);
    if (themeMeta) themeMeta.setAttribute("content", theme);
    document.documentElement.style.setProperty("--brand-grad-from", brandFrom);
    document.documentElement.style.setProperty("--brand-grad-to", brandTo);
    document.documentElement.style.setProperty(
        "--topbar-badge-dev-color",
        mockVisuals.theme,
    );
    document.documentElement.style.setProperty(
        "--topbar-badge-dev-dot",
        mockVisuals.theme,
    );
    document.documentElement.style.setProperty(
        "--topbar-badge-dev-glow",
        hexToRgba(mockVisuals.theme, 0.18),
    );
}

// === Utilities ===

function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function escapeHtml(value) {
    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function isSyncExcluded(remotePath) {
    const lower = remotePath.toLowerCase();
    return SYNC_EXCLUDE_PATHS.some(
        (p) => lower === p || lower.startsWith(p + "/"),
    );
}

function joinChildPath(parent, child) {
    const c = String(child || "").replace(/^\/+|\/+$/g, "");
    if (!c) return parent;
    return parent.endsWith("/") ? `${parent}${c}` : `${parent}/${c}`;
}

function formatPathForUi(path) {
    const raw = String(path || "")
        .trim()
        .replace(/\\/g, "/");
    if (!raw) return "Root";
    if (/^e:\/?$/i.test(raw)) return "Root";
    if (/^e:\//i.test(raw)) return `/${raw.slice(3)}`;
    return raw;
}

function triggerDownload(data, filename) {
    const url = URL.createObjectURL(new Blob([data]));
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    // 60 s gives the browser sufficient time to open the file handle before
    // the object URL is revoked. 200 ms was insufficient for large files.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
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
    return items.length > 1
        ? `${items[0]} (+${items.length - 1} more)`
        : String(items[0]);
}

function setHiddenAll(hidden, ...elements) {
    for (const e of elements) e.hidden = hidden;
}

function trackAnalyticsEvent(name, params = {}) {
    if (typeof window.gtag !== "function") return;
    window.gtag("event", name, params);
}

// === DOM References ===

const el = {
    // Top bar
    btnConnect: document.getElementById("btnConnect"),
    btnDev: document.getElementById("btnDev"),
    topbarSep: document.getElementById("topbarSep"),
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
    footers: document.querySelectorAll(".panel-footer"),
    btnNormalize: document.getElementById("btnNormalize"),
    btnLogToggle: document.getElementById("btnLogToggle"),
    connError: document.getElementById("connError"),

    // iOS banner
    iosBanner: document.getElementById("iosBanner"),
    iosBannerClose: document.getElementById("iosBannerClose"),
    btnFolderSheetClose: document.getElementById("btnFolderSheetClose"),

    // Main overlay
    mainOverlay: document.getElementById("mainOverlay"),
    mainOverlayIcon: document.getElementById("mainOverlayIcon"),
    mainOverlaySpinner: document.getElementById("mainOverlaySpinner"),
    mainOverlayTitle: document.getElementById("mainOverlayTitle"),
    mainOverlaySub: document.getElementById("mainOverlaySub"),
    btnConnectCta: document.getElementById("btnConnectCta"),
    btnDfuFromDfu: document.getElementById("btnDfuFromDfu"),

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
    confirmModal: document.getElementById("confirmModal"),
    confirmTitle: document.getElementById("confirmTitle"),
    confirmBadge: document.getElementById("confirmBadge"),
    confirmIcon: document.getElementById("confirmIcon"),
    confirmBodyTitle: document.getElementById("confirmBodyTitle"),
    confirmMessage: document.getElementById("confirmMessage"),
    btnConfirmOk: document.getElementById("btnConfirmOk"),

    inputModal: document.getElementById("inputModal"),
    inputTitle: document.getElementById("inputTitle"),
    inputLabel: document.getElementById("inputLabel"),
    inputField: document.getElementById("inputField"),
    inputError: document.getElementById("inputError"),
    inputHelper: document.getElementById("inputHelper"),
    btnInputOk: document.getElementById("btnInputOk"),

    uploadWarnModal: document.getElementById("uploadWarnModal"),
    uploadWarnMsg: document.getElementById("uploadWarnMsg"),
    btnUploadWarnConfirm: document.getElementById("btnUploadWarnConfirm"),

    sanitizeModalNone: document.getElementById("sanitizeModalNone"),
    sanitizeNonePath: document.getElementById("sanitizeNonePath"),
    btnSanitizeNoneConfirm: document.getElementById("btnSanitizeNoneConfirm"),

    // DFU
    btnUpdateFirmware: document.getElementById("btnUpdateFirmware"),
    dfuUpdateDot: document.getElementById("dfuUpdateDot"),
    dfuFileInput: document.getElementById("dfuFileInput"),
    dfuModal: document.getElementById("dfuModal"),
    btnDfuClose: document.getElementById("btnDfuClose"),
    dfuConfirmSection: document.getElementById("dfuConfirmSection"),
    dfuNativePanel: document.getElementById("dfuNativePanel"),
    dfuCustomPanel: document.getElementById("dfuCustomPanel"),
    dfuCustomDevicesDetails: document.getElementById("dfuCustomDevicesDetails"),
    dfuReleaseContainer: document.getElementById("dfuReleaseContainer"),
    dfuFileDividerLabel: document.getElementById("dfuFileDividerLabel"),
    dfuFileDivider: document.querySelector(".dfu-file-divider"),
    btnDfuPickFile: document.getElementById("btnDfuPickFile"),
    dfuPickedFile: document.getElementById("dfuPickedFile"),
    dfuPickedName: document.getElementById("dfuPickedName"),
    btnDfuChangeFile: document.getElementById("btnDfuChangeFile"),
    dfuVariantSection: document.getElementById("dfuVariantSection"),
    btnDfuVariantLCD: document.getElementById("btnDfuVariantLCD"),
    btnDfuVariantOLED: document.getElementById("btnDfuVariantOLED"),
    btnDfuVariantCustom: document.getElementById("btnDfuVariantCustom"),
    dfuDevPanel: document.getElementById("dfuDevPanel"),
    dfuDevFailMode: document.getElementById("dfuDevFailMode"),
    dfuProgressSection: document.getElementById("dfuProgressSection"),
    dfuWarnTitle: document.getElementById("dfuWarnTitle"),
    dfuWarnBodyPrimary: document.getElementById("dfuWarnBodyPrimary"),
    dfuWarnBodySecondary: document.getElementById("dfuWarnBodySecondary"),
    dfuMobileNote: document.getElementById("dfuMobileNote"),
    dfuStatusSubhead: document.getElementById("dfuStatusSubhead"),
    dfuActiveIcon: document.getElementById("dfuActiveIcon"),
    dfuActiveLabel: document.getElementById("dfuActiveLabel"),
    dfuProgressBarWrap: document.getElementById("dfuProgressBarWrap"),
    dfuProgressFill: document.getElementById("dfuProgressFill"),
    dfuProgressFile: document.getElementById("dfuProgressFile"),
    dfuProgressSpeed: document.getElementById("dfuProgressSpeed"),
    dfuProgressPct: document.getElementById("dfuProgressPct"),
    dfuSelectingHint: document.getElementById("dfuSelectingHint"),
    dfuReconnectHint: document.getElementById("dfuReconnectHint"),
    dfuMobileTransferNote: document.getElementById("dfuMobileTransferNote"),
    dfuStageList: document.getElementById("dfuStageList"),
    dfuErrorBox: document.getElementById("dfuErrorBox"),
    dfuTroubleshootLinks: document.getElementById("dfuTroubleshootLinks"),
    dfuSuccessBox: document.getElementById("dfuSuccessBox"),
    dfuWarnSection: document.getElementById("dfuWarnSection"),
    dfuFooterConfirm: document.getElementById("dfuFooterConfirm"),
    btnDfuCancelConfirm: document.getElementById("btnDfuCancelConfirm"),
    btnDfuStart: document.getElementById("btnDfuStart"),
    dfuFooterWarn: document.getElementById("dfuFooterWarn"),
    btnDfuBackToConfirm: document.getElementById("btnDfuBackToConfirm"),
    btnDfuProceed: document.getElementById("btnDfuProceed"),
    dfuFooterProgress: document.getElementById("dfuFooterProgress"),
    dfuFooterCancelConfirm: document.getElementById("dfuFooterCancelConfirm"),
    btnDfuCancelKeep: document.getElementById("btnDfuCancelKeep"),
    btnDfuCancelConfirmYes: document.getElementById("btnDfuCancelConfirmYes"),
    btnDfuCancelTransfer: document.getElementById("btnDfuCancelTransfer"),
    dfuFooterFailed: document.getElementById("dfuFooterFailed"),
    btnDfuReconnect: document.getElementById("btnDfuReconnect"),
    btnDfuReboot: document.getElementById("btnDfuReboot"),
    btnDfuRetryConnect: document.getElementById("btnDfuRetryConnect"),
    btnDfuRetry: document.getElementById("btnDfuRetry"),
    dfuFooterSuccess: document.getElementById("dfuFooterSuccess"),
    btnDfuCloseSuccess: document.getElementById("btnDfuCloseSuccess"),
};

function validateElementBindings(bindings) {
    const missing = Object.entries(bindings)
        .filter(([, node]) => {
            if (node instanceof NodeList) return node.length === 0;
            return !node;
        })
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
    dirLoadingPath: null,
    drawerEntry: null, // currently displayed file entry in panel
    panelMode: "folder", // "folder" | "file" | "upload"
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
    uploadBase: "E:/", // path where the upload plan was built — anchors runSync
    syncState: "idle", // "idle" | "scanning" | "done" | "error"
    syncSkippedFiles: [], // [{ remotePath, size }]
    syncOrphans: [], // [{ remotePath, size, kind, deletable, status }]
    syncOrphanChecked: new Set(), // Set<remotePath>
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
    if (
        state.entries.some(
            (entry) => entry.name === name && entry.name !== currentName,
        )
    ) {
        throw new Error(`"${name}" already exists in this folder`);
    }
}

function readCheckedRadioValue(name, label) {
    const selected = document.querySelector(`input[name="${name}"]:checked`);
    if (!selected) throw new Error(`${label} is required`);
    return selected.value;
}

// === Protocol Log ===

function log(msg, role) {
    if (!role) {
        if (msg.startsWith("\u2192")) role = "cmd";
        else if (msg.includes("ERR")) role = "err";
        else if (msg.startsWith("\u2190")) role = "ok";
    }
    if (role === "err") console.error("[mochi]", msg);
    const now = new Date();
    const ts = [now.getHours(), now.getMinutes(), now.getSeconds()]
        .map((n) => String(n).padStart(2, "0"))
        .join(":");
    const line = document.createElement("span");
    line.innerHTML =
        `<span class="ts">[${ts}]</span> ` +
        (role
            ? `<span class="${role}">${escapeHtml(msg)}</span>`
            : escapeHtml(msg)) +
        "\n";
    el.protocolLog.appendChild(line);
    el.protocolLog.scrollTop = el.protocolLog.scrollHeight;
}

// === Bottom Sheet (mobile) ===

function isMobileViewport() {
    return window.innerWidth < 992;
}

function _lockScroll() {
    document.body.classList.add("no-scroll");
}
function _unlockScroll() {
    document.body.classList.remove("no-scroll");
}

// Sheets toggle role="dialog" on open/close. The same DOM is the desktop
// sidebar (where dialog semantics would be wrong) and the mobile bottom-sheet
// (where they're correct), so we apply the role only while the sheet is in
// its "open" overlay state.
function openSheet() {
    el.sheetContainer.classList.add("open");
    el.sheetContainer.setAttribute("role", "dialog");
    el.sheetContainer.setAttribute("aria-modal", "true");
    _lockScroll();
}
function closeSheet() {
    el.sheetContainer.classList.remove("open");
    el.sheetContainer.classList.remove("is-upload");
    el.sheetContainer.removeAttribute("role");
    el.sheetContainer.removeAttribute("aria-modal");
    if (
        !document.body.classList.contains("log-open") &&
        _openModalStack.length === 0
    )
        _unlockScroll();
}
function openDetailsSheet() {
    el.detailsSheetContainer.classList.add("open");
    el.detailsSheetContainer.setAttribute("role", "dialog");
    el.detailsSheetContainer.setAttribute("aria-modal", "true");
    _lockScroll();
}
function closeDetailsSheet() {
    el.detailsSheetContainer.classList.remove("open");
    el.detailsSheetContainer.removeAttribute("role");
    el.detailsSheetContainer.removeAttribute("aria-modal");
    if (
        !document.body.classList.contains("log-open") &&
        _openModalStack.length === 0
    )
        _unlockScroll();
}

el.sheetBackdrop.addEventListener("click", closeSheet);
el.btnFolderSheetClose.addEventListener("click", closeSheet);

el.btnSheetInfo.addEventListener("click", () => {
    setPanelState("folder");
    el.sheetContainer.classList.remove("is-upload");
    openSheet();
});
el.btnSheetUpload.addEventListener("click", () => {
    setPanelState("upload");
    el.sheetContainer.classList.add("is-upload");
    openSheet();
});

// Swipe-down on panel handle dismisses the sheet
let _sheetTouchY = 0;
el.contextPanel.addEventListener(
    "touchstart",
    (e) => {
        _sheetTouchY = e.touches[0].clientY;
    },
    { passive: true },
);
el.contextPanel.addEventListener(
    "touchend",
    (e) => {
        if (e.changedTouches[0].clientY - _sheetTouchY > 60) closeSheet();
    },
    { passive: true },
);

// === Connection State Machine ===

function setConnState(newState) {
    state.connState = newState;

    const connected = newState === "connected";
    const connecting = newState === "connecting";
    const reconnecting = newState === "reconnecting";
    const disconnected = newState === "disconnected";

    // iOS banner — dismiss once the user connects
    if (!disconnected) el.iosBanner.hidden = true;

    // Main overlay
    el.mainOverlay.classList.toggle("active", !connected);
    el.mainOverlayIcon.hidden = connecting || reconnecting;
    el.mainOverlaySpinner.hidden = !(connecting || reconnecting);
    el.mainOverlayTitle.textContent = reconnecting
        ? "Reconnecting\u2026"
        : connecting
          ? "Connecting\u2026"
          : "Connect your device to get started";
    el.mainOverlaySub.textContent =
        connecting || reconnecting
            ? ""
            : "Connect your device to browse and manage files.";
    el.btnConnectCta.hidden = connecting || reconnecting;
    el.btnConnectCta.disabled = connecting || reconnecting;
    el.btnDfuFromDfu.hidden = !disconnected;

    // Disconnect button — visible when connected or reconnecting
    el.btnConnect.hidden = !(connected || reconnecting);
    el.btnDev.hidden = !shouldShowDevButton();
    el.topbarSep.hidden = el.btnConnect.hidden && el.btnDev.hidden;

    // Topbar connected elements — keep visible during reconnecting
    setHiddenAll(
        !(connected || reconnecting),
        el.topbarBadge,
        el.topbarDrive,
        el.topbarActionSep,
        el.btnFormat,
        el.btnRefresh,
        el.btnNewFolder,
        el.btnNormalize,
        el.btnUpdateFirmware,
        el.btnLogToggle,
        el.btnSheetInfo,
        el.btnSheetUpload,
    );
    if (!(connected || reconnecting)) el.btnMobileUp.hidden = true;

    // Error cleared on state change
    el.connError.hidden = true;
    el.connError.textContent = "";

    if (disconnected) {
        el.dfuUpdateDot.hidden = true;
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
        state.client = null;
    }

    updateControls();

    setStateColors(
        newState,
        connected && state.client instanceof DevMockClient,
    );
}

function showConnError(msg) {
    el.connError.textContent = msg;
    // The visual element is truncated to ~200px with ellipsis. Mirror the full
    // message into title= so hovering (or assistive tech reading the tooltip)
    // surfaces the rest.
    el.connError.title = msg;
    el.connError.hidden = false;
}

const MAX_TOASTS = 3;

// Toast copy contract:
// - Use a short summary plus optional detail.
// - Builders normalize copy to "Summary. Detail." sentence structure.
// - Success toasts auto-dismiss, warnings and errors stay sticky.
function normalizeToastPart(value) {
    const text = String(value || "")
        .trim()
        .replace(/\s+/g, " ");
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
        // Auto-dismiss timeout in ms (ignored when sticky=true). Defaults to 2.5s
        // for transient confirmations; undoable toasts can ask for longer.
        duration = 2500,
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

    const iconMap = {
        success: "check",
        error: "error",
        warning: "warning",
        info: "info",
    };

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
        setTimeout(() => removeToast(toast), duration);
    }

    return toast;
}

function showSuccessToast(summary, detail = "") {
    return createToast({
        tone: "success",
        summary: normalizeToastPart(summary),
        detail: normalizeToastPart(detail),
        sticky: false,
    });
}

// Show a success toast with an Undo affordance. The toast lingers a little
// longer than a regular success toast so the user has time to react.
function showUndoToast(summary, onUndo) {
    return createToast({
        tone: "success",
        summary: normalizeToastPart(summary),
        actionLabel: "Undo",
        onAction: onUndo,
        sticky: false,
        duration: 5000,
    });
}

function showErrorToast(summary, detail = "") {
    return createToast({
        tone: "error",
        summary: normalizeToastPart(summary),
        detail: normalizeToastPart(detail),
    });
}

function showWarningToast(summary, detail = "") {
    return createToast({
        tone: "warning",
        summary: normalizeToastPart(summary),
        detail: normalizeToastPart(detail),
    });
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
    if (state.client.device?.name !== "Pixl.js") return;
    if (!/^\d+\.\d+\.\d+$/.test(deviceVersion)) return;
    try {
        const resp = await fetch(
            "https://api.github.com/repos/solosky/pixl.js/releases/latest",
        );
        if (!resp.ok) return;
        const data = await resp.json();
        const latest = data.tag_name;
        if (!latest) return;
        if (compareSemver(deviceVersion, latest) < 0) {
            el.dfuUpdateDot.hidden = false;
            trackAnalyticsEvent("firmware_update_available", {
                current: deviceVersion,
                latest,
            });
            createToast({
                tone: "info",
                summary: `Update available: ${latest}`,
                detail: `Current version: ${deviceVersion}. You can update now or later from Firmware.`,
                actionLabel: "Update",
                onAction: () => el.btnUpdateFirmware.click(),
            });
        }
    } catch (_) {
        /* network error, skip silently */
    }
}

async function connectOrDisconnect() {
    if (state.connState === "connecting") return;
    if (state.connState === "connected" || state.connState === "reconnecting") {
        if (state.disconnectToast) {
            removeToast(state.disconnectToast);
            state.disconnectToast = null;
        }
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
        if (state.disconnectToast) {
            removeToast(state.disconnectToast);
            state.disconnectToast = null;
        }
        invalidateCache();
        if (state.connState !== "disconnected") setConnState("disconnected");
        if (wasReconnecting)
            showErrorToast(
                "Couldn't reconnect",
                "Tap Connect to try again. If this keeps happening, move the device closer.",
            );
    };
    state.client.onReconnecting = () => {
        if (state.abortController) state.abortController.abort();
        if (state.disconnectToast) {
            removeToast(state.disconnectToast);
            state.disconnectToast = null;
        }
        setConnState("reconnecting");
        state.disconnectToast = showErrorToast(
            "Connection lost",
            "Trying to reconnect automatically. Keep the device nearby.",
        );
    };
    state.client.onReconnect = async () => {
        if (state.disconnectToast) {
            removeToast(state.disconnectToast);
            state.disconnectToast = null;
        }
        setConnState("connected");
        showSuccessToast("Reconnected");
        try {
            if (state.currentPath) {
                invalidateCache();
                await browseFolder(state.currentPath);
            }
        } catch (err) {
            showErrorToast("Couldn't refresh after reconnect", err.message);
        }
    };

    const clientRef = state.client;
    try {
        await state.client.connect();
        setConnState("connected");
        showSuccessToast("Connected to device");
        trackAnalyticsEvent("device_connect");

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
        showErrorToast("Couldn't connect", err.message);
        trackAnalyticsEvent("device_connect_fail", { error: err.message });
        clientRef?.disconnect();
        setConnState("disconnected");
    }
}

async function devConnect() {
    if (state.connState === "connected") return;
    setConnState("connecting");
    state.client = new DevMockClient();
    state.client.onDisconnect = () => {
        invalidateCache();
        setConnState("disconnected");
    };
    setConnState("connected");
    showSuccessToast("Connected to mock device");

    try {
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
    } catch (err) {
        showErrorToast("Mock device error", err.message);
        setConnState("disconnected");
    }
}

// === Drive Panel ===

function renderDrive(driveData) {
    if (!driveData) {
        el.panelDriveBarFill.style.width = "0%";
        el.panelDriveBarFill.classList.remove("high");
        el.panelDriveUsage.innerHTML = "";
        el.topbarDriveInfo.textContent = "";
        return;
    }
    const freeBytes =
        driveData.freeBytes ??
        driveData.totalBytes - (driveData.usedBytes ?? 0);
    const usedBytes = driveData.totalBytes - freeBytes;
    const pct =
        driveData.totalBytes > 0
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

// Track which modals are currently open to scope scroll-lock and focus
// restoration. Multiple modals can be open in unusual cases (toast actions
// firing during a confirm prompt) — keep a stack.
const _openModalStack = [];

const _focusableSelector =
    'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function _firstFocusable(modalEl) {
    return modalEl.querySelector(_focusableSelector);
}

function _modalKeydown(e) {
    if (e.key !== "Tab") return;
    const top = _openModalStack[_openModalStack.length - 1];
    if (!top) return;
    if (!top.modalEl.contains(document.activeElement)) {
        // Focus escaped the modal (e.g. landed on document.body after a blur).
        // Re-trap it instead of letting Tab leave the modal entirely.
        e.preventDefault();
        const trapped = Array.from(
            top.modalEl.querySelectorAll(_focusableSelector),
        ).filter((n) => !n.hasAttribute("hidden") && n.offsetParent !== null);
        if (trapped.length > 0)
            (e.shiftKey ? trapped[trapped.length - 1] : trapped[0]).focus();
        return;
    }
    const items = Array.from(
        top.modalEl.querySelectorAll(_focusableSelector),
    ).filter(
        (node) => !node.hasAttribute("hidden") && node.offsetParent !== null,
    );
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
    }
}

function openModal(modalEl) {
    if (modalEl.classList.contains("open")) return;
    const previouslyFocused =
        document.activeElement instanceof HTMLElement
            ? document.activeElement
            : null;
    _openModalStack.push({ modalEl, previouslyFocused });
    if (_openModalStack.length === 1) {
        _lockScroll();
        document.addEventListener("keydown", _modalKeydown, true);
    }
    modalEl.classList.add("open");
    // Focus the first focusable control (skip the X-close where possible so the
    // primary affordance is what receives focus).
    requestAnimationFrame(() => {
        if (!modalEl.classList.contains("open")) return;
        const focusables = modalEl.querySelectorAll(_focusableSelector);
        const target =
            Array.from(focusables).find(
                (node) => !node.classList.contains("modal-close"),
            ) || _firstFocusable(modalEl);
        target?.focus({ preventScroll: true });
    });
}

function closeModal(modalEl) {
    if (modalEl === el.confirmModal) {
        clearInterval(_confirmCountdown);
        _confirmCountdown = null;
    }
    modalEl.classList.remove("open");
    const idx = _openModalStack.findIndex((entry) => entry.modalEl === modalEl);
    let restoreTarget = null;
    if (idx >= 0) {
        restoreTarget = _openModalStack[idx].previouslyFocused;
        _openModalStack.splice(idx, 1);
    }
    if (_openModalStack.length === 0) {
        const sheetsOpen =
            el.sheetContainer.classList.contains("open") ||
            el.detailsSheetContainer.classList.contains("open");
        if (!document.body.classList.contains("log-open") && !sheetsOpen)
            _unlockScroll();
        document.removeEventListener("keydown", _modalKeydown, true);
    }
    modalEl.dispatchEvent(new Event("modal:close"));
    // Return focus to whatever opened the modal so keyboard users don't lose
    // their place. Skip if the previous element no longer exists or has been
    // hidden.
    if (
        restoreTarget &&
        document.body.contains(restoreTarget) &&
        restoreTarget.offsetParent !== null
    ) {
        restoreTarget.focus({ preventScroll: true });
    }
}

// Generic close button delegate for all modals
document.querySelectorAll("[data-modal-close]").forEach((btn) => {
    btn.addEventListener("click", () =>
        closeModal(btn.closest(".modal-overlay")),
    );
});

// === Shared confirm modal ===

let _confirmResolve = null;
let _confirmCountdown = null;

function showConfirmModal({
    title,
    badge = "danger",
    icon,
    heading = "",
    message = "",
    okLabel = "Confirm",
    okClass = "danger",
    okDelay = 0,
}) {
    if (el.confirmModal.classList.contains("open"))
        return Promise.resolve(false);
    el.confirmTitle.textContent = title;
    el.confirmBadge.className = `modal-icon-badge ${badge}`;
    el.confirmBadge.hidden = !icon;
    if (icon) el.confirmIcon.textContent = icon;
    el.confirmBodyTitle.textContent = heading;
    el.confirmBodyTitle.hidden = !heading;
    el.confirmMessage.textContent = message;
    el.confirmMessage.hidden = !message;
    el.btnConfirmOk.className = `btn-labeled ${okClass}`;
    clearInterval(_confirmCountdown);
    if (okDelay > 0) {
        el.btnConfirmOk.disabled = true;
        el.btnConfirmOk.textContent = `Wait (${okDelay}s)`;
        let sec = okDelay;
        _confirmCountdown = setInterval(() => {
            sec--;
            if (sec > 0) {
                el.btnConfirmOk.textContent = `Wait (${sec}s)`;
            } else {
                clearInterval(_confirmCountdown);
                _confirmCountdown = null;
                el.btnConfirmOk.textContent = okLabel;
                el.btnConfirmOk.disabled = false;
            }
        }, 1000);
    } else {
        el.btnConfirmOk.disabled = false;
        el.btnConfirmOk.textContent = okLabel;
    }
    openModal(el.confirmModal);
    return new Promise((resolve) => {
        _confirmResolve = resolve;
    });
}

el.confirmModal.addEventListener("modal:close", () => {
    _confirmResolve?.(false);
    _confirmResolve = null;
});

el.btnConfirmOk.addEventListener("click", () => {
    if (el.btnConfirmOk.disabled) return;
    const r = _confirmResolve;
    _confirmResolve = null;
    closeModal(el.confirmModal);
    r?.(true);
});

// === Shared input modal ===

let _inputResolve = null;
let _inputValidate = null;

function showInputModal({
    title,
    label,
    placeholder = "",
    value = "",
    helper = "",
    okLabel = "OK",
}) {
    if (el.inputModal.classList.contains("open")) return Promise.resolve(null);
    el.inputTitle.textContent = title;
    el.inputLabel.textContent = label;
    el.inputField.placeholder = placeholder;
    el.inputField.value = value;
    el.inputHelper.hidden = !helper;
    el.inputHelper.textContent = helper;
    el.btnInputOk.textContent = okLabel;
    clearInputError(el.inputField, el.inputError);
    openModal(el.inputModal);
    requestAnimationFrame(() => {
        el.inputField.focus();
        el.inputField.select();
    });
    return new Promise((resolve) => {
        _inputResolve = resolve;
    });
}

el.inputModal.addEventListener("modal:close", () => {
    clearInputError(el.inputField, el.inputError);
    _inputResolve?.(null);
    _inputResolve = null;
    _inputValidate = null;
});

el.inputField.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
        e.preventDefault();
        el.btnInputOk.click();
    }
});

el.inputField.addEventListener("input", () => {
    clearInputError(el.inputField, el.inputError);
});

el.btnInputOk.addEventListener("click", () => {
    const raw = el.inputField.value;
    if (_inputValidate) {
        const err = _inputValidate(raw);
        if (err) {
            showInputError(el.inputField, el.inputError, err);
            el.inputField.focus();
            return;
        }
    }
    const r = _inputResolve;
    _inputResolve = null;
    closeModal(el.inputModal);
    r?.(raw.trim());
});

// === Format drive ===

el.btnFormat.addEventListener("click", async () => {
    const confirmed = await showConfirmModal({
        title: "Format drive",
        badge: "warning",
        icon: "warning",
        heading: "Erase all files from device storage?",
        message:
            "This removes every file and folder on storage. Firmware is not changed. This action can't be undone.",
        okLabel: "Format drive",
        okClass: "danger",
        okDelay: 5,
    });
    if (!confirmed || !state.client) return;
    try {
        const res = await state.client.formatDrive("E");
        if (res.ok) {
            log("Drive E: formatted successfully.");
            showSuccessToast(
                "Drive erased",
                "Storage is now empty and ready for new files.",
            );
            trackAnalyticsEvent("format_drive");
            invalidateCache();
            const dr = await state.client.listDrives();
            if (dr.ok && dr.data.length > 0) {
                state.drive = dr.data[0];
                renderDrive(state.drive);
            }
            await browseFolder("E:/");
        } else {
            log(`Format failed: ${res.error}`, "err");
            showErrorToast("Couldn't format drive", res.error);
        }
    } catch (err) {
        log(`Format error: ${err.message}`, "err");
        showErrorToast("Couldn't format drive", err.message);
    }
});

// Escape key — close surfaces from most to least prominent
document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    // 1. Image lightbox
    if (!el.imgLightbox.hidden) {
        e.preventDefault();
        closeLightbox();
        return;
    }
    // 2. Open modals — use the stack so the topmost is closed, not the first in DOM order.
    const openModalEl =
        _openModalStack.length > 0
            ? _openModalStack[_openModalStack.length - 1].modalEl
            : null;
    if (openModalEl) {
        e.preventDefault();
        if (openModalEl === el.dfuModal) {
            if (dfuCanCloseFromBackdrop()) closeDfuModal();
            return;
        }
        closeModal(openModalEl);
        return;
    }
    // 3. Log sheet
    if (el.logOverlay.classList.contains("open")) {
        e.preventDefault();
        closeLogSheet();
        return;
    }
    // 4. Details sheet (mobile) or details panel (desktop)
    if (el.detailsSheetContainer.classList.contains("open")) {
        e.preventDefault();
        setPanelState("folder");
        closeDetailsSheet();
        return;
    }
    if (!el.detailsPanel.hidden) {
        e.preventDefault();
        setPanelState("folder");
        return;
    }
    // 5. Upload panel (desktop — simulate close button if not disabled)
    if (
        !isMobileViewport() &&
        state.panelMode === "upload" &&
        !isAriaDisabled(el.btnUploadClose)
    ) {
        e.preventDefault();
        el.btnUploadClose.click();
        return;
    }
    // 6. Context sheet (mobile)
    if (el.sheetContainer.classList.contains("open")) {
        e.preventDefault();
        closeSheet();
    }
});

// Close modals on backdrop click (DFU excluded — handled separately, blocked during transfer)
for (const modal of [
    el.confirmModal,
    el.inputModal,
    el.sanitizeModalNone,
    el.uploadWarnModal,
]) {
    modal.addEventListener("click", (e) => {
        if (e.target === modal) closeModal(modal);
    });
}
el.dfuModal.addEventListener("click", (e) => {
    if (e.target !== el.dfuModal) return;
    if (dfuCanCloseFromBackdrop()) closeDfuModal();
});

// === Update Controls ===

function updateControls() {
    const connected = state.connState === "connected";
    const uploading = state.uploadActive;
    const atRoot = !state.currentPath || state.currentPath === "E:/";
    const syncing = state.syncState === "scanning";
    const queueHasItems = hasQueuedUploadState();
    const dfuActive = dfuState.phase !== "idle";
    el.btnRefresh.disabled = !connected || uploading || dfuActive;
    el.btnNewFolder.disabled = !connected || uploading || dfuActive;
    el.sidebarDropZone.setAttribute(
        "aria-disabled",
        String(!connected || uploading || syncing || dfuActive),
    );
    el.btnNormalize.disabled = !connected || uploading || dfuActive;
    el.btnFormat.disabled = !connected || uploading || dfuActive;
    el.btnUpdateFirmware.disabled = !connected || uploading || dfuActive;
    el.btnPickFolder.disabled = !connected || uploading || syncing;
    el.btnPickFiles.disabled = !connected || uploading || syncing;
    el.btnSync.disabled = !connected || uploading || syncing || !queueHasItems;
    el.btnSync.innerHTML =
        state.syncState === "done"
            ? `<span class="ms-sm">sync</span> Rescan`
            : `<span class="ms-sm">sync</span> Compare with device`;

    // Execute zone: show when queue has items or upload is active
    el.uploadExecuteZone.style.display =
        queueHasItems || uploading ? "flex" : "none";

    // Start ↔ Stop swap
    el.btnUploadStart.hidden = uploading;
    el.btnUploadAbort.hidden = !uploading;
    el.btnUploadAbort.disabled = !uploading;

    if (state.syncState === "done") {
        el.btnUploadStart.innerHTML = `<span class="ms">upload</span> Upload`;
        el.btnUploadStart.disabled =
            !connected ||
            uploading ||
            (state.uploadPlan.filter(
                (i) => i.kind === "file" && i.status !== "skipped",
            ).length === 0 &&
                state.syncOrphanChecked.size === 0);
    } else {
        el.btnUploadStart.innerHTML = `<span class="ms">play_arrow</span> Start`;
        el.btnUploadStart.disabled =
            !connected ||
            uploading ||
            syncing ||
            state.uploadPlan.filter((i) => i.status !== "skipped").length === 0;
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

    // Cancel any in-flight "stale" skeleton/render work from prior navigations.
    // The skeleton loader sets `state.dirLoadingPath = path`; any earlier
    // browseFolder() that resolves later will see a mismatch and return early.
    state.dirLoadingPath = null;

    // Check cache first
    let entries,
        truncated = false;
    const cached = state.client.folderCache.get(path);
    if (cached) {
        entries = sortEntries(cached.entries);
        truncated = cached.truncated;
    } else {
        // Cache miss: show skeleton rows immediately so the user sees that the
        // navigation registered, even on slow BLE reads. Real listing replaces
        // this once the await resolves below.
        renderFileTableLoading(path);
        try {
            let res;
            for (let attempt = 1; attempt <= 3; attempt++) {
                res = await state.client.readFolder(path);
                if (!res.ok || !res.truncated) break;
                log(
                    `Directory listing for ${path} truncated on attempt ${attempt}, retrying…`,
                    "err",
                );
            }

            // If navigation happened again while we were waiting on BLE, drop
            // these results so we don't overwrite the newer folder UI.
            if (state.dirLoadingPath !== path) return;

            if (!res.ok) {
                log(`Failed to read ${path}: ${res.error}`, "err");
                showErrorToast("Couldn't open folder", res.error);
                state.dirLoadingPath = null;
                renderFileTable();
                return;
            }
            entries = sortEntries(res.data);
            truncated = res.truncated || false;
            state.client.folderCache.set(path, { entries, truncated });
            for (const e of entries) {
                if (e.type === "DIR")
                    state.client.createdFolders.add(
                        joinChildPath(path, e.name),
                    );
            }
            if (truncated) {
                log(
                    `Warning: directory listing for ${path} was truncated (${entries.length} entries received)`,
                    "err",
                );
            } else if (entries.length >= LARGE_DIR_THRESHOLD) {
                log(
                    `Warning: ${path} has ${entries.length} entries, above the ${LARGE_DIR_THRESHOLD}-item threshold`,
                    "err",
                );
            }
        } catch (err) {
            log(`Error reading ${path}: ${err.message}`, "err");
            showErrorToast("Couldn't open folder", err.message);
            state.dirLoadingPath = null;
            renderFileTable();
            return;
        }
    }

    // Update warning banner for current folder (always, whether cached or fresh)
    if (truncated) {
        el.folderWarningBanner.hidden = false;
        el.folderWarningText.textContent =
            "This folder list is incomplete. The device returned a partial response, so some items may be missing.";
    } else if (entries.length >= LARGE_DIR_THRESHOLD) {
        el.folderWarningBanner.hidden = false;
        el.folderWarningText.textContent = `This folder has ${entries.length} items. Over Bluetooth, loading can take longer.`;
    } else {
        el.folderWarningBanner.hidden = true;
        el.folderWarningText.textContent = "";
    }

    state.currentPath = path;
    state.entries = entries;
    state.selectedNames.clear();
    state.dirLoadingPath = null;
    renderBreadcrumb(path);
    renderFileTable();
    if (state.panelMode !== "upload") setPanelState("folder");
    if (isMobileViewport()) {
        closeSheet();
        closeDetailsSheet();
    }
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
            const raw = _body[_key]?.[0] ?? null;
            if (raw) raw.tagSeries = raw["am\u0069iboSeries"];
            info = raw;
        }
    } catch {
        /* network unavailable — leave null */
    }
    _nfcTagCache.set(key, info);
    return info;
}

function nfcSeriesGradient(series) {
    if (!series) return "linear-gradient(135deg, #8b5cf6, #d946ef)";
    // More specific entries appear before their general counterpart to prevent partial clashes.
    // Keys are lowercase substrings of tagSeries / gameSeries as returned by amiiboapi.org.
    const map = [
        ["kirby air rider", "linear-gradient(135deg, #ec4899, #3b82f6)"], // Kirby Air Riders
        ["monster hunter rise", "linear-gradient(135deg, #ef4444, #f97316)"], // Monster Hunter Rise
        [
            "mario sports superstars",
            "linear-gradient(135deg, #ef4444, #22c55e)",
        ], // Mario Sports Superstars
        ["my mario wooden blocks", "linear-gradient(135deg, #ef4444, #d97706)"], // My Mario Wooden Blocks
        ["super smash bros.", "linear-gradient(135deg, #1e1b4b, #312e81)"], // Super Smash Bros.
        ["super mario bros.", "linear-gradient(135deg, #ef4444, #dc2626)"], // Super Mario Bros.
        ["super nintendo world", "linear-gradient(135deg, #ef4444, #f59e0b)"], // Super Nintendo World
        ["yoshi's woolly world", "linear-gradient(135deg, #22c55e, #16a34a)"], // Yoshi's Woolly World
        ["xenoblade chronicles", "linear-gradient(135deg, #0284c7, #7c3aed)"], // Xenoblade Chronicles 3
        ["legend of zelda", "linear-gradient(135deg, #16a34a, #ca8a04)"], // Legend Of Zelda
        ["street fighter", "linear-gradient(135deg, #dc2626, #111827)"], // Street Fighter 6
        ["animal crossing", "linear-gradient(135deg, #84cc16, #65a30d)"], // Animal Crossing
        ["monster hunter", "linear-gradient(135deg, #92400e, #78350f)"], // Monster Hunter
        ["shovel knight", "linear-gradient(135deg, #1d4ed8, #1e40af)"], // Shovel Knight
        ["donkey kong", "linear-gradient(135deg, #f59e0b, #dc2626)"], // Donkey Kong
        ["fire emblem", "linear-gradient(135deg, #3b82f6, #2563eb)"], // Fire Emblem
        ["mario kart", "linear-gradient(135deg, #ef4444, #f59e0b)"], // Mario Kart (gameSeries)
        ["skylanders", "linear-gradient(135deg, #7c3aed, #1d4ed8)"], // Skylanders
        ["chibi-robo", "linear-gradient(135deg, #f59e0b, #d97706)"], // Chibi-Robo!
        ["yu-gi-oh", "linear-gradient(135deg, #7c3aed, #d97706)"], // Yu-Gi-Oh!
        ["power pros", "linear-gradient(135deg, #1d4ed8, #15803d)"], // Power Pros
        ["star fox", "linear-gradient(135deg, #8b5cf6, #7c3aed)"], // Star Fox (gameSeries)
        ["splatoon", "linear-gradient(135deg, #f97316, #84cc16)"], // Splatoon
        ["mega man", "linear-gradient(135deg, #0ea5e9, #0284c7)"], // Mega Man
        ["metroid", "linear-gradient(135deg, #f97316, #dc2626)"], // Metroid
        ["pokemon", "linear-gradient(135deg, #f59e0b, #ef4444)"], // Pokemon
        ["boxboy", "linear-gradient(135deg, #374151, #111827)"], // BoxBoy!
        ["pikmin", "linear-gradient(135deg, #84cc16, #10b981)"], // Pikmin
        ["8-bit mario", "linear-gradient(135deg, #dc2626, #7f1d1d)"], // 8-bit Mario
        ["kirby", "linear-gradient(135deg, #ec4899, #db2777)"], // Kirby
        ["diablo", "linear-gradient(135deg, #991b1b, #450a0a)"], // Diablo
        ["pragmata", "linear-gradient(135deg, #06b6d4, #1e1b4b)"], // Pragmata
        ["yoshi", "linear-gradient(135deg, #22c55e, #16a34a)"], // Yoshi (gameSeries fallback)
    ];
    const lower = series.toLowerCase();
    for (const [key, grad] of map) {
        if (lower.includes(key)) return grad;
    }
    let h = 0;
    for (const c of lower) h = (Math.imul(h, 31) + c.charCodeAt(0)) >>> 0;
    const hue = h % 360;
    return `linear-gradient(135deg, hsl(${hue},60%,45%), hsl(${(hue + 40) % 360},65%,40%))`;
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
    el.panelNfcTagContent.querySelectorAll(".js-copy-id").forEach((node) => {
        node.addEventListener("click", () =>
            navigator.clipboard?.writeText(node.textContent || ""),
        );
    });
}

function applyNfcTagDisplay(entry, head, tail) {
    if (head >>> 0 === 0 && tail >>> 0 === 0) {
        el.panelNfcTagContent.innerHTML = `<div class="details-nfc-row"><span class="details-nfc-label">Figure ID</span><span class="details-nfc-value" style="color:#9ca3af">Not an NFC tag file</span></div>`;
        el.detailsHeroImgArea.innerHTML = `<span class="ms details-hero-file-icon">insert_drive_file</span>`;
        return;
    }
    const key = `${head >>> 0}:${tail >>> 0}`;
    if (_nfcTagCache.has(key)) {
        const info = _nfcTagCache.get(key);
        el.panelNfcTagContent.innerHTML = renderNfcTagField(head, tail, info);
        wireNfcTagCopyButtons();
        if (info) {
            _applyNfcHero(entry, info, head, tail);
        } else {
            el.detailsHeroImgArea.innerHTML = `<span class="ms details-hero-file-icon">insert_drive_file</span>`;
        }
        return;
    }
    el.panelNfcTagContent.innerHTML = nfcDetailRow(
        "Figure ID",
        formatNfcUid(head, tail),
    );
    if (!el.detailsHeroImgArea.querySelector(".details-hero-spinner")) {
        el.detailsHeroImgArea.innerHTML = `<div class="details-hero-spinner"></div>`;
    }
    lookupNfcTag(head, tail)
        .then((info) => {
            if (state.drawerEntry !== entry) return;
            el.panelNfcTagContent.innerHTML = renderNfcTagField(head, tail, info);
            wireNfcTagCopyButtons();
            if (info) {
                _applyNfcHero(entry, info, head, tail);
            } else {
                el.detailsHeroImgArea.innerHTML = `<span class="ms details-hero-file-icon">insert_drive_file</span>`;
            }
        })
        .catch(() => {
            if (state.drawerEntry === entry)
                el.panelNfcTagContent.innerHTML = nfcDetailRow("Figure ID", formatNfcUid(head, tail));
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
        try {
            const parsed = new URL(info.image);
            if (parsed.protocol === "https:" || parsed.protocol === "http:") {
                img.src = parsed.href;
            }
        } catch {
            /* malformed URL — leave src empty */
        }
        img.alt = info.name || entry.name;
        img.loading = "lazy";
        img.onerror = () => {
            el.detailsHeroImgArea.innerHTML =
                '<span class="ms details-hero-file-icon">insert_drive_file</span>';
        };
        const zoomIcon = document.createElement("span");
        zoomIcon.className = "details-hero-zoom-icon";
        wrap.appendChild(img);
        wrap.appendChild(zoomIcon);
        el.detailsHeroImgArea.appendChild(wrap);
        wrap.addEventListener("click", () => {
            openLightbox(
                info.image,
                info.name || entry.name,
                info,
                head,
                tail,
                entry,
            );
        });
    }

    // Color band with series + name + game
    const series = escapeHtml(info.tagSeries || info.gameSeries || "");
    const name = escapeHtml(info.name || entry.name);
    const game =
        info.gameSeries && info.gameSeries !== (info.tagSeries || "")
            ? escapeHtml(info.gameSeries)
            : "";
    el.detailsHeroBand.innerHTML =
        (series
            ? `<div class="details-hero-series" style="color:${textColor}">${series}</div>`
            : "") +
        `<div class="details-hero-name" style="color:${textColor}">${name}</div>` +
        (game
            ? `<div class="details-hero-game" style="color:${textColor}">${game}</div>`
            : "");
    el.detailsHeroBand.style.background = grad;
    el.detailsHeroBand.hidden = false;
}

function getBrowserEmptyStateContent() {
    if (state.currentPath === "E:/") {
        return {
            icon: "storage",
            title: "Device is empty",
            sub: "No files yet. Drop some in to get started.",
        };
    }

    return {
        icon: "folder_open",
        title: "Folder is empty",
        sub: "Upload files to get started.",
    };
}

// Show 5 placeholder skeleton rows while a folder is being fetched. The real
// listing will replace this when browseFolder() resolves. Callers must guard
// against this running for already-cached folders (it would flash stale
// content).
function renderFileTableLoading(targetPath) {
    el.tableWrap.classList.remove("is-empty");
    el.browserEmptyState.hidden = true;
    el.fileTable.hidden = false;
    // Stash the target path so a subsequent renderFileTable() for the same
    // path is the only one that overwrites the skeleton.
    state.dirLoadingPath = targetPath;
    const cells =
        `<td class="cell-check"><span class="skeleton skeleton-checkbox"></span></td>` +
        `<td class="cell-name"><span class="cell-name-inner"><span class="skeleton skeleton-icon"></span><span class="skeleton skeleton-text"></span></span></td>` +
        `<td class="cell-size"><span class="skeleton skeleton-size"></span></td>` +
        `<td class="cell-actions"></td>`;
    const row = `<tr class="skeleton-row" aria-hidden="true">${cells}</tr>`;
    el.fileTableBody.innerHTML = row.repeat(5);
}

function renderFileTable() {
    const showEmptyState =
        state.connState === "connected" &&
        !!state.currentPath &&
        state.entries.length === 0;
    const showTable =
        state.connState === "connected" && state.entries.length > 0;

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
        const isPanelActive =
            state.drawerEntry && state.drawerEntry.name === entry.name;
        const isSelected = state.selectedNames.has(entry.name);

        const nameWarn = utf8Length(entry.name) > MAX_FILE_NAME_BYTES;
        const iconHtml = isDir
            ? `<span class="cell-name-icon folder"><span class="ms-sm">folder</span></span>`
            : `<span class="cell-name-icon file"><span class="ms-sm">insert_drive_file</span></span>`;
        const warnIcon = nameWarn
            ? `<span class="ms-sm warn-icon cell-warn-icon" title="Name is ${utf8Length(entry.name)} bytes (max ${MAX_FILE_NAME_BYTES}). Rename to avoid issues.">warning</span>`
            : "";
        const nameCell = isDir
            ? `<td class="cell-name folder"><span class="cell-name-inner">${iconHtml}${escapeHtml(entry.name)}${warnIcon}</span></td>`
            : `<td class="cell-name"><span class="cell-name-inner">${iconHtml}${escapeHtml(entry.name)}${warnIcon}</span></td>`;

        const classes = [
            isPanelActive ? "panel-active" : "",
            isSelected ? "selected" : "",
            nameWarn ? "row-warn" : "",
        ]
            .filter(Boolean)
            .join(" ");
        rows.push(
            `<tr data-name="${escapeHtml(entry.name)}"${classes ? ` class="${classes}"` : ""}>` +
                `<td class="cell-check"><input type="checkbox"${isSelected ? " checked" : ""}></td>` +
                nameCell +
                `<td class="cell-size">${size}</td>` +
                `<td class="cell-actions">` +
                (!isDir
                    ? `<button class="btn-icon ghost" data-action="download" title="Download"><span class="ms-sm">download</span></button>`
                    : "") +
                `<button class="btn-icon ghost" data-action="rename" title="Rename"><span class="ms-sm">edit</span></button>` +
                `<button class="btn-icon ghost" data-action="delete" title="Delete"><span class="ms-sm">delete</span></button>` +
                `</td>` +
                `</tr>`,
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
    el.navBreadcrumb.innerHTML = crumbs
        .map((c, i) => {
            const isActive = i === crumbs.length - 1;
            const label =
                i === 0
                    ? `<span class="ms nav-home-icon">home</span>`
                    : escapeHtml(c.label);
            const cls =
                i === 0
                    ? `nav-crumb nav-crumb-home${isActive ? " active" : ""}`
                    : `nav-crumb${isActive ? " active" : ""}`;
            return (
                (i > 0 ? '<span class="nav-sep">›</span>' : "") +
                `<button class="${cls}" data-path="${escapeHtml(c.path)}">${label}</button>`
            );
        })
        .join("");

    // Mobile: show current folder name; swap icon between home (root) and arrow_back (subfolder)
    const isRoot = path === "E:/";
    el.mobileFolderName.textContent = isRoot
        ? "Pixl.js"
        : getBaseName(trimmed) || "Pixl.js";
    el.btnMobileUp.hidden = false;
    el.btnMobileUp.disabled = isRoot;
    el.btnMobileUp.querySelector(".ms").textContent = isRoot
        ? "home"
        : "arrow_back";
}

// === Selection Bar ===

function updateSelectionBar() {
    const count = state.selectedNames.size;
    const hasSelection = count > 0;
    el.selectionBar.classList.toggle("has-selection", hasSelection);
    el.selectionCount.textContent = `${count} selected`;
    el.checkAll.checked =
        state.entries.length > 0 && count === state.entries.length;
    el.checkAll.indeterminate = hasSelection && count < state.entries.length;
    const fileCount = state.entries.filter(
        (e) => state.selectedNames.has(e.name) && e.type === "FILE",
    ).length;
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

el.fileTableBody.addEventListener("click", async (e) => {
    const row = e.target.closest("tr");
    if (!row || !row.dataset.name) return;
    const name = row.dataset.name;
    const entry = state.entries.find((en) => en.name === name);
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
            state.selectedNames.clear();
            state.selectedNames.add(entry.name);
            const confirmed = await showConfirmModal({
                title: "Delete",
                badge: "danger",
                icon: "delete",
                heading: `Delete "${entry.name}"?`,
                message:
                    "This removes it from device storage permanently. This action can't be undone.",
                okLabel: "Delete",
                okClass: "danger",
            });
            if (confirmed) await doDeleteSelected();
        } else if (actionBtn.dataset.action === "download") {
            if (!state.client) return;
            const filePath = joinChildPath(state.currentPath, entry.name);
            state.client
                .readFileData(filePath)
                .then((res) => {
                    if (!res.ok) {
                        log(`Download failed: ${res.error}`, "err");
                        showErrorToast("Download failed", res.error);
                        return;
                    }
                    triggerDownload(res.data, entry.name);
                })
                .catch((err) => {
                    log(`Download failed: ${err.message}`, "err");
                    showErrorToast("Download failed", err.message);
                });
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

el.btnDeleteSelected.addEventListener("click", async () => {
    const count = state.selectedNames.size;
    if (count === 0) return;
    const confirmed = await showConfirmModal({
        title: "Delete",
        badge: "danger",
        icon: "delete",
        heading: `Delete ${pluralize(count, "item")}?`,
        message:
            "This removes the selected items from device storage permanently. This action can't be undone.",
        okLabel: "Delete",
        okClass: "danger",
    });
    if (confirmed) await doDeleteSelected();
});

el.btnClearSelection.addEventListener("click", () => {
    state.selectedNames.clear();
    applySelectionToRows(false);
    updateSelectionBar();
});

el.btnDownloadSelected.addEventListener("click", async () => {
    const files = state.entries.filter(
        (e) => state.selectedNames.has(e.name) && e.type === "FILE",
    );
    if (files.length === 0) return;
    const toast = showSuccessToast(
        `Preparing ${pluralize(files.length, "file")} for download…`,
    );
    let failed = 0;
    for (const entry of files) {
        if (!state.client) { failed++; continue; }
        try {
            const res = await state.client.readFileData(
                joinChildPath(state.currentPath, entry.name),
            );
            if (res.ok) {
                triggerDownload(res.data, entry.name);
                await new Promise((r) => setTimeout(r, 150));
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
        showErrorToast(
            "Some files couldn't be downloaded",
            `${pluralize(failed, "file")} failed. Check the protocol log for details.`,
        );
    } else {
        showSuccessToast(`Downloaded ${pluralize(files.length, "file")}`);
    }
    const downloaded = files.length - failed;
    if (downloaded > 0)
        trackAnalyticsEvent("file_download", { count: downloaded });
});

// Navigation bar — breadcrumb handles all navigation (including home crumb)
el.navBreadcrumb.addEventListener("click", (e) => {
    const crumb = e.target.closest(".nav-crumb");
    if (!crumb || !crumb.dataset.path) return;
    if (crumb.dataset.path !== state.currentPath)
        browseFolder(crumb.dataset.path);
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
    const PTR_MAX = 96; // max visual pull height
    let _ptrStartY = 0;
    let _ptrActive = false;

    function _ptrReset() {
        _ptrActive = false;
        el.ptrIndicator.style.height = "";
        el.ptrIndicator.classList.remove(
            "ptr-pulling",
            "ptr-ready",
            "ptr-loading",
        );
    }

    el.tableWrap.addEventListener(
        "touchstart",
        (e) => {
            if (el.tableWrap.scrollTop === 0 && e.touches.length === 1) {
                _ptrStartY = e.touches[0].clientY;
                _ptrActive = true;
            }
        },
        { passive: true },
    );

    el.tableWrap.addEventListener(
        "touchmove",
        (e) => {
            if (!_ptrActive) return;
            const dy = e.touches[0].clientY - _ptrStartY;
            if (dy <= 0) {
                _ptrReset();
                return;
            }
            const h = Math.min(dy * 0.45, PTR_MAX);
            el.ptrIndicator.style.height = `${h}px`;
            el.ptrIndicator.classList.add("ptr-pulling");
            el.ptrIndicator.classList.toggle("ptr-ready", dy >= PTR_THRESHOLD);
            const rotation = Math.min((dy / PTR_THRESHOLD) * 180, 360);
            el.ptrIndicator.querySelector(".ptr-icon").style.transform =
                `rotate(${rotation}deg)`;
        },
        { passive: true },
    );

    el.tableWrap.addEventListener(
        "touchend",
        () => {
            if (!_ptrActive) return;
            const h = parseFloat(el.ptrIndicator.style.height) || 0;
            if (
                h >= PTR_THRESHOLD * 0.45 &&
                state.currentPath &&
                state.connState === "connected"
            ) {
                el.ptrIndicator.classList.add("ptr-loading");
                el.ptrIndicator.classList.remove("ptr-ready");
                el.ptrIndicator.querySelector(".ptr-icon").style.transform = "";
                state.client.folderCache.delete(state.currentPath);
                browseFolder(state.currentPath).finally(() => _ptrReset());
            } else {
                _ptrReset();
            }
        },
        { passive: true },
    );
}

// New folder
el.btnNewFolder.addEventListener("click", async () => {
    if (!state.client) return;
    _inputValidate = (raw) => {
        try {
            const v = validateSingleName(raw, "Folder name");
            ensureSiblingNameAvailable(v, "");
            validateRemotePath(
                joinChildPath(state.currentPath || "E:/", v),
                "folder",
            );
            return null;
        } catch (err) {
            return err.message;
        }
    };
    const name = await showInputModal({
        title: "New folder",
        label: "Folder name",
        placeholder: "e.g. collection",
        helper: `Created in ${formatPathForUi(state.currentPath || "E:/")}`,
        okLabel: "Create",
    });
    if (!name) return;
    try {
        const folderPath = joinChildPath(state.currentPath, name);
        const res = await state.client.createFolder(folderPath);
        if (res.ok) {
            log(`Created folder: ${folderPath}`);
            showSuccessToast("Folder created");
            trackAnalyticsEvent("folder_create");
            state.client.folderCache.delete(state.currentPath);
            await browseFolder(state.currentPath);
        } else {
            log(`Failed to create folder: ${res.error}`, "err");
            showErrorToast("Couldn't create folder", res.error);
        }
    } catch (err) {
        log(`Failed to create folder: ${err.message}`, "err");
        showErrorToast("Couldn't create folder", err.message);
    }
});

// Normalize modal
el.btnNormalize.addEventListener("click", () => {
    el.sanitizeNonePath.textContent = formatPathForUi(
        state.currentPath || "E:/",
    );
    openModal(el.sanitizeModalNone);
});

// === Context Panel ===

function populateFileDetails(entry) {
    el.panelFileName.textContent = entry.name;
    el.panelFileSize.textContent = formatBytes(entry.size);
    el.detailsKind.textContent = entry.type === "FILE" ? "File" : "Folder";
    const fullPath = joinChildPath(state.currentPath, entry.name);
    const fullPathUi = formatPathForUi(fullPath);
    el.detailsFilePath.textContent = fullPathUi;
    if (el.detailsPathInRow) el.detailsPathInRow.textContent = fullPathUi;

    el.detailsHeroImgArea.innerHTML = `<span class="ms details-hero-file-icon" id="detailsHeroIcon">insert_drive_file</span>`;
    el.detailsHeroBand.hidden = true;
    el.detailsHeroBand.style.background = "";
    el.detailsHeroBand.innerHTML = "";

    // NFC tag section — only for .bin files
    el.panelFileLabel.textContent = entry.name.toLowerCase().endsWith(".bin")
        ? "NFC Tag"
        : "Details";
    const isBin =
        entry.type === "FILE" && entry.name.toLowerCase().endsWith(".bin");
    el.panelNfcTag.hidden = !isBin;
    if (!isBin) {
        el.panelNfcTagContent.innerHTML = "";
    } else {
        const metaHead = entry.meta ? entry.meta.nfcTagHead : null;
        const metaTail = entry.meta ? entry.meta.nfcTagTail : null;
        if (metaHead != null && metaTail != null) {
            applyNfcTagDisplay(entry, metaHead, metaTail);
        } else if (state.client) {
            el.panelNfcTagContent.innerHTML = `<div class="details-nfc-row"><span class="details-nfc-label">Figure ID</span><span class="details-nfc-value" style="color:#9ca3af">Loading\u2026</span></div>`;
            el.detailsHeroImgArea.innerHTML = `<div class="details-hero-spinner"></div>`;
            const filePath = joinChildPath(state.currentPath, entry.name);
            state.client
                .readFileData(filePath)
                .then((res) => {
                    if (state.drawerEntry !== entry) return;
                    if (res.ok && res.data.length >= 92) {
                        const dv = new DataView(
                            res.data.buffer,
                            res.data.byteOffset,
                        );
                        // Big-endian: matches how the firmware and mock write the UID
                        // into the .bin file. The TLV path (readFolder) stores the same
                        // logical integer as LE, which round-trips to the same value, so
                        // both code paths produce the same _nfcTagCache key.
                        const head = dv.getUint32(84, false);
                        const tail = dv.getUint32(88, false);
                        applyNfcTagDisplay(entry, head, tail);
                    } else {
                        el.panelNfcTagContent.innerHTML = `<div class="details-nfc-row"><span class="details-nfc-label">Figure ID</span><span class="details-nfc-value" style="color:#9ca3af">Not a valid NFC file</span></div>`;
                        el.detailsHeroImgArea.innerHTML = `<span class="ms details-hero-file-icon">insert_drive_file</span>`;
                    }
                })
                .catch(() => {
                    if (state.drawerEntry === entry) {
                        el.panelNfcTagContent.innerHTML = `<div class="details-nfc-row"><span class="details-nfc-label">Error</span><span class="details-nfc-value" style="color:#e11d48">Failed to read file</span></div>`;
                        el.detailsHeroImgArea.innerHTML = `<span class="ms details-hero-file-icon">insert_drive_file</span>`;
                    }
                });
        } else {
            el.panelNfcTagContent.innerHTML = `<div class="details-nfc-row"><span class="details-nfc-label">Figure ID</span><span class="details-nfc-value" style="color:#9ca3af">Not connected</span></div>`;
        }
    }
}

function setPanelState(mode, entry) {
    // Left panel: only toggle between folder info and upload — never on file selection.
    // The upload panel and file details panel are independent on desktop.
    if (mode !== "file") {
        el.panelFolder.hidden = mode === "upload";
        el.panelUpload.hidden = mode !== "upload";
    }

    // Right details panel: on desktop the two columns are independent, so only
    // touch it when not entering upload mode (mobile dismisses via closeDetailsSheet).
    if (mode !== "upload" || isMobileViewport()) {
        el.detailsPanel.hidden = mode !== "file";
    }

    if (mode === "upload") {
        state.panelPrevMode =
            state.panelMode === "upload"
                ? state.panelPrevMode
                : state.panelMode;
        state.panelMode = "upload";
        if (isMobileViewport()) closeDetailsSheet();
        return;
    }

    if (mode === "file" && entry) {
        state.drawerEntry = entry;
        // Keep panelMode as "upload" if upload panel is open — the two panels are independent.
        if (state.panelMode !== "upload") state.panelMode = "file";

        populateFileDetails(entry);

        // Highlight active row
        for (const row of el.fileTableBody.querySelectorAll("tr[data-name]")) {
            row.classList.toggle(
                "panel-active",
                row.dataset.name === entry.name,
            );
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
        const drivePath = state.drive?.name ? `${state.drive.name}/` : "E:/";
        el.panelFolderPath.textContent = formatPathForUi(drivePath);
        const folderBaseName =
            state.currentPath === "E:/"
                ? "Root"
                : getBaseName(state.currentPath) || state.currentPath;
        el.panelCurrentFolderName.textContent = folderBaseName;
        const fileCount = state.entries.filter((e) => e.type === "FILE").length;
        const dirCount = state.entries.filter((e) => e.type === "DIR").length;
        const parts = [];
        if (fileCount) parts.push(pluralize(fileCount, "file"));
        if (dirCount) parts.push(pluralize(dirCount, "folder"));
        el.panelFolderCount.textContent = state.entries.length
            ? parts.join(", ")
            : "Empty";
        const totalBytes = state.entries.reduce(
            (sum, e) => sum + (e.size || 0),
            0,
        );
        el.panelFolderSize.textContent =
            totalBytes > 0 ? formatBytes(totalBytes) + " total" : "";
    } else {
        el.panelFolderName.textContent = "Pixl.js";
        el.panelFolderPath.textContent = "";
        el.panelCurrentFolderName.textContent = "";
        el.panelFolderCount.textContent = "";
        el.panelFolderSize.textContent = "";
    }
    // Drive bar updated by renderDrive
}

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

async function openRenameModal(name) {
    if (!state.client) return;
    const entry = state.entries.find((e) => e.name === name);
    const kind = entry && entry.type === "DIR" ? "folder" : "file";
    // Capture before the first await: an undo toast for a prior rename can fire
    // while the input modal is suspended, running browseFolder() and changing
    // state.currentPath before showInputModal() resolves.
    const capturedPath = state.currentPath;
    _inputValidate = (raw) => {
        try {
            const v = validateSingleName(raw, "Name");
            if (v === name) throw new Error("Name is unchanged");
            ensureSiblingNameAvailable(v, name);
            validateRemotePath(joinChildPath(capturedPath || "E:/", v), kind);
            return null;
        } catch (err) {
            return err.message;
        }
    };
    const newName = await showInputModal({
        title: "Rename",
        label: "New name",
        placeholder: "",
        value: name,
        okLabel: "Rename",
    });
    if (!newName) return;
    const oldPath = joinChildPath(capturedPath, name);
    const newPath = joinChildPath(capturedPath, newName);
    try {
        const res = await state.client.renamePath(oldPath, newPath);
        if (res.ok) {
            log(`Renamed: ${name} → ${newName}`);
            showUndoToast(`Renamed to ${newName}`, () =>
                undoRename(newPath, oldPath, newName, name, kind),
            );
            trackAnalyticsEvent("file_rename");
        } else {
            log(`Rename failed: ${res.error}`, "err");
            showErrorToast("Rename failed", res.error);
        }
    } catch (err) {
        log(`Failed to rename: ${err.message}`, "err");
        showErrorToast("Rename failed", err.message);
    } finally {
        invalidateCache();
        await browseFolder(getParentPath(oldPath));
    }
}

async function undoRename(
    currentPath,
    originalPath,
    currentName,
    originalName,
    kind,
) {
    if (!state.client) return;
    try {
        // Keep the same remote-path contract as all other BLE writes.
        validateRemotePath(currentPath, kind);
        validateRemotePath(originalPath, kind);

        const res = await state.client.renamePath(currentPath, originalPath);
        if (res.ok) {
            log(`Reverted rename: ${currentName} → ${originalName}`);
            showSuccessToast(`Reverted to ${originalName}`);
            trackAnalyticsEvent("file_rename_undo");
        } else {
            showErrorToast("Couldn't undo rename", res.error);
        }
    } catch (err) {
        showErrorToast("Couldn't undo rename", err.message);
    } finally {
        invalidateCache();
        // Refresh the folder that contains the reverted filename. This matters
        // because the user may have navigated away while the undo toast lingers.
        const refreshPath = getParentPath(originalPath);
        await browseFolder(refreshPath);
    }
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
    if (
        !el.sheetContainer.classList.contains("open") &&
        !el.detailsSheetContainer.classList.contains("open") &&
        _openModalStack.length === 0
    )
        _unlockScroll();
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
        const uid =
            head != null && tail != null ? formatNfcUid(head, tail) : null;
        const rows = [];
        if (info.name) rows.push(["Character", info.name, false]);
        if (info.tagSeries) rows.push(["Series", info.tagSeries, false]);
        if (info.gameSeries) rows.push(["Game", info.gameSeries, false]);
        if (info.type) rows.push(["Type", info.type, false]);
        if (info.release?.na) rows.push(["Released", info.release.na, false]);
        if (uid) rows.push(["Figure ID", uid, true]);
        if (entry?.size != null)
            rows.push(["Size", formatBytes(entry.size), false]);
        if (entry?.name) rows.push(["File", entry.name, false]);

        const rowsHtml = rows
            .map(
                ([label, value, mono]) =>
                    `<div class="img-lightbox-row">` +
                    `<span class="img-lightbox-row-label">${escapeHtml(label)}</span>` +
                    `<span class="img-lightbox-row-value${mono ? " img-lightbox-row-mono js-copy-id" : ""}"` +
                    (mono ? ` title="Copy"` : "") +
                    `>${escapeHtml(value)}</span>` +
                    `</div>`,
            )
            .join("");

        const lbSeries = info.tagSeries || info.gameSeries || "";
        const lbGame =
            info.gameSeries && info.gameSeries !== (info.tagSeries || "")
                ? info.gameSeries
                : "";
        el.imgLightboxSide.innerHTML =
            `<div class="img-lightbox-band" style="background:${grad}">` +
            (lbSeries
                ? `<div class="img-lightbox-series" style="color:${tc}">${escapeHtml(lbSeries)}</div>`
                : "") +
            `<div class="img-lightbox-name" style="color:${tc}">${escapeHtml(info.name || alt || "")}</div>` +
            (lbGame
                ? `<div class="img-lightbox-game" style="color:${tc}">${escapeHtml(lbGame)}</div>`
                : "") +
            `</div>` +
            `<div class="img-lightbox-rows">${rowsHtml}</div>`;
    } else {
        el.imgLightboxSide.innerHTML = "";
    }

    el.imgLightboxSide.querySelectorAll(".js-copy-id").forEach((node) => {
        node.addEventListener("click", () =>
            navigator.clipboard?.writeText(node.textContent || ""),
        );
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
    if (
        e.target === el.imgLightbox ||
        e.target.classList.contains("img-lightbox-inner") ||
        window.innerWidth <= 767
    )
        closeLightbox();
});

// === Upload panel toggle ===

el.sidebarDropZone.addEventListener("click", () => {
    if (isAriaDisabled(el.sidebarDropZone)) return;
    el.filesInput.click();
});

// Enter/Space activation is provided natively now that the drop zone is a
// real <button> element (was previously a div with role="button").

let _dropZoneCounter = 0;
el.sidebarDropZone.addEventListener("dragenter", (e) => {
    e.preventDefault();
    _dropZoneCounter++;
    el.sidebarDropZone.classList.add("drag-over");
});
el.sidebarDropZone.addEventListener("dragleave", () => {
    _dropZoneCounter--;
    if (_dropZoneCounter <= 0) {
        _dropZoneCounter = 0;
        el.sidebarDropZone.classList.remove("drag-over");
    }
});
el.sidebarDropZone.addEventListener("dragover", (e) => {
    e.preventDefault();
});
el.sidebarDropZone.addEventListener("drop", async (e) => {
    e.preventDefault();
    _dropZoneCounter = 0;
    el.sidebarDropZone.classList.remove("drag-over");
    if (isAriaDisabled(el.sidebarDropZone)) return;
    const { items, files } = e.dataTransfer;
    const hasEntryApi =
        items &&
        items.length > 0 &&
        typeof items[0].webkitGetAsEntry === "function";
    if (!hasEntryApi && (!files || files.length === 0)) return;
    try {
        const collected = hasEntryApi
            ? await collectFromDataTransfer(e.dataTransfer)
            : collectFromFiles(files);
        if (collected.files.length === 0 && collected.folders.size === 0)
            return;
        if (!(await checkSystemFolderWarning(collected))) return;
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

// --- Delete confirm ---

async function doDeleteSelected() {
    if (!state.client || state.selectedNames.size === 0) return;

    const selected = state.entries.filter((e) =>
        state.selectedNames.has(e.name),
    );
    const paths = selected.map((e) => ({
        path: joinChildPath(state.currentPath, e.name),
        type: e.type,
        name: e.name,
    }));

    // Sort: files before folders so file handles are closed before rmdir
    paths.sort((a, b) => {
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
                    log(`Delete failed: ${item.path}: ${res.error}`, "err");
                }
            } catch (err) {
                failedPaths.push(item.path);
                log(`Delete failed: ${item.path}: ${err.message}`, "err");
            }
        }
        if (deleted === total) {
            showSuccessToast(`Deleted ${pluralize(deleted, "item")}`);
        } else if (deleted > 0) {
            showErrorToast(
                `Deleted ${deleted} of ${total}`,
                `Some items failed: ${firstPlusMore(failedPaths)}`,
            );
        } else {
            showErrorToast(
                "Couldn't delete items",
                firstPlusMore(failedPaths) || "No items were deleted.",
            );
        }
        if (deleted > 0) trackAnalyticsEvent("file_delete", { count: deleted });
    } finally {
        el.browserLockOverlay.classList.remove("active");
        updateControls();
        invalidateCache();
        try {
            await browseFolder(state.currentPath);
        } catch (_) {
            /* stale connection */
        }
    }
}

// --- Sanitize helpers ---

function buildSanitizeOps(entries, parentPath, allSiblings = entries) {
    const ops = [];
    const skipped = [];
    const existing = new Set(allSiblings.map((e) => e.name));
    const groups = new Map();
    for (const e of entries) {
        const lower = e.name.toLowerCase();
        if (lower === e.name) continue;
        if (!groups.has(lower)) groups.set(lower, []);
        groups.get(lower).push(e);
    }
    for (const [lower, group] of groups) {
        if (group.length > 1) {
            for (const e of group)
                skipped.push({
                    name: e.name,
                    reason: `Collision: multiple -> ${lower}`,
                });
            continue;
        }
        const [e] = group;
        if (existing.has(lower)) {
            skipped.push({
                name: e.name,
                reason: `Already exists as ${lower}`,
            });
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
        if (!state.client) throw new Error("Device disconnected during scan.");
        const folder = queue.shift();
        const res = await state.client.readFolder(folder);
        if (!res.ok) throw new Error(`Scan failed: ${folder}: ${res.error}`);
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
                log(`Rename failed: ${op.from}: ${res.error}`, "err");
            }
        } catch (err) {
            log(`Rename failed: ${op.from}: ${err.message}`, "err");
        }
    }

    if (allSkipped.length > 0) {
        for (const s of allSkipped) {
            log(`Skipped: ${s.name} (${s.reason})`);
        }
    }
    const renamedText = pluralize(renamed, "item");
    const totalText = pluralize(allOps.length, "item");
    const skippedText =
        allSkipped.length > 0
            ? `Skipped ${pluralize(allSkipped.length, "item")}`
            : "";
    if (renamed === allOps.length && renamed > 0) {
        showSuccessToast(`Converted ${renamedText} to lowercase`, skippedText);
    } else if (renamed > 0) {
        showWarningToast(
            `Converted ${renamedText} of ${totalText} to lowercase`,
            skippedText,
        );
    } else if (allOps.length > 0) {
        showErrorToast("Couldn't convert names to lowercase");
    } else {
        showSuccessToast("All names are already lowercase", skippedText);
    }
    if (renamed > 0) trackAnalyticsEvent("normalize_run", { count: renamed });
}

async function withBrowserLock(title, fn) {
    el.browserLockOverlay.classList.add("active");
    el.browserLockTitle.textContent = title;
    updateControls();
    try {
        await fn();
    } catch (err) {
        log(err.message, "err");
        showErrorToast("Couldn't convert names to lowercase", err.message);
    } finally {
        el.browserLockOverlay.classList.remove("active");
        updateControls();
        invalidateCache();
        try {
            await browseFolder(state.currentPath);
        } catch (_) {
            /* stale connection */
        }
    }
}

// --- Sanitize: none confirm ---

el.btnSanitizeNoneConfirm.addEventListener("click", async () => {
    closeModal(el.sanitizeModalNone);
    if (!state.client) return;

    let scope;
    try {
        scope = readCheckedRadioValue("sanitizeNoneScope", "Lowercase scope");
    } catch (err) {
        showErrorToast("Couldn't convert names to lowercase", err.message);
        return;
    }

    await withBrowserLock("Converting names…", async () => {
        const allOps = [];
        const allSkipped = [];

        if (scope === "files") {
            const files = state.entries.filter((e) => e.type === "FILE");
            const { ops, skipped } = buildSanitizeOps(
                files,
                state.currentPath,
                state.entries,
            );
            allOps.push(...ops);
            allSkipped.push(...skipped);
        } else if (scope === "filesAndFolders") {
            const { ops, skipped } = buildSanitizeOps(
                state.entries,
                state.currentPath,
            );
            allOps.push(...ops);
            allSkipped.push(...skipped);
        } else {
            const snapshots = await collectEntriesRecursive(state.currentPath);
            for (const snap of snapshots) {
                const { ops, skipped } = buildSanitizeOps(
                    snap.entries,
                    snap.parentPath,
                );
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
        files: Array.from(fileList).map((f) => ({
            relativePath: f.name,
            file: f,
        })),
    };
}

async function collectFromDataTransfer(dataTransfer) {
    const folders = new Set();
    const files = [];

    // Capture entries synchronously before any await (items list clears after event)
    const entries = Array.from(dataTransfer.items)
        .filter((item) => item.kind === "file")
        .map((item) => item.webkitGetAsEntry?.())
        .filter(Boolean);

    function readAllEntries(reader) {
        return new Promise((resolve, reject) => {
            const all = [];
            function next() {
                reader.readEntries((batch) => {
                    if (batch.length === 0) resolve(all);
                    else {
                        all.push(...batch);
                        next();
                    }
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
            await Promise.all(
                children.map((child) =>
                    walk(child, pfx ? `${pfx}/${child.name}` : child.name),
                ),
            );
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
        case "done":
            return '<span class="ms-sm queue-icon done">check_circle</span>';
        case "active":
            return '<span class="ms-sm spin queue-icon active">sync</span>';
        case "pending":
            return '<span class="ms-sm queue-icon pending">schedule</span>';
        case "error":
            return '<span class="ms-sm queue-icon error">error</span>';
        case "aborted":
            return '<span class="ms-sm queue-icon aborted">block</span>';
        case "skipped":
            return '<span class="ms-sm queue-icon skipped">warning</span>';
        default:
            return "";
    }
}

function hasQueuedUploadState() {
    return (
        state.uploadPlan.length > 0 ||
        state.syncState === "scanning" ||
        state.syncSkippedFiles.length > 0 ||
        state.syncOrphans.length > 0
    );
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
    const uploadable = plan.filter((i) => i.status !== "skipped");
    state.uploadTotalCount = uploadable.length;
    state.uploadTotalBytes = uploadable.reduce(
        (sum, item) => sum + item.size,
        0,
    );
    state.uploadCompletedCount = 0;
    state.uploadCompletedBytes = 0;
}

function consumeCompletedUploadItem(item) {
    state.uploadCompletedCount += 1;
    state.uploadCompletedBytes += item.size;
    state.uploadPlan = state.uploadPlan.filter(
        (candidate) => candidate.id !== item.id,
    );
    state.uploadWarnings = checkUploadPlanWarnings(state.uploadPlan);
}

function renderUploadSummary() {
    if (!hasQueuedUploadState()) {
        el.uploadProgressTotal.textContent = "Nothing queued";
        return;
    }

    if (state.syncState === "done") {
        const uploadCount = state.uploadPlan.filter(
            (i) => i.kind === "file",
        ).length;
        const deleteCount = state.syncOrphanChecked.size;
        if (uploadCount === 0 && deleteCount === 0) {
            el.uploadProgressTotal.textContent = "Everything is in sync";
        } else {
            const parts = [];
            if (uploadCount > 0)
                parts.push(`${pluralize(uploadCount, "file")} to upload`);
            if (deleteCount > 0) parts.push(`${deleteCount} to delete`);
            el.uploadProgressTotal.textContent = parts.join(" · ");
        }
        return;
    }

    if (state.uploadTotalCount === 0) {
        el.uploadProgressTotal.textContent = "Nothing queued";
        return;
    }

    const transferredBytes = state.uploadPlan.reduce(
        (sum, item) => sum + item.transferred,
        0,
    );
    const visibleBytes = Math.min(
        state.uploadTotalBytes,
        state.uploadCompletedBytes + transferredBytes,
    );
    const totalPct =
        state.uploadTotalBytes > 0
            ? Math.round((visibleBytes / state.uploadTotalBytes) * 100)
            : state.uploadCompletedCount === state.uploadTotalCount
              ? 100
              : 0;
    const remainingCount = state.uploadPlan.length;
    const remainingText =
        remainingCount === 1 ? "1 remaining" : `${remainingCount} remaining`;
    const speedStr = state.transferSpeed
        ? ` \u00b7 <span class="queue-summary-speed">${escapeHtml(state.transferSpeed)}</span>`
        : "";

    el.uploadProgressTotal.innerHTML =
        `<span>${state.uploadCompletedCount} / ${state.uploadTotalCount} items \u00b7 ${remainingText}</span>` +
        `<span>${totalPct}% (${escapeHtml(formatBytes(visibleBytes))} / ${escapeHtml(formatBytes(state.uploadTotalBytes))})${speedStr}</span>`;
}

function renderSyncQueue() {
    const uploadFiles = state.uploadPlan.filter((i) => i.kind === "file");
    const unchangedCount = state.syncSkippedFiles.length;
    const orphanCount = state.syncOrphans.length;
    let html = "";

    // Summary chips
    const chipParts = [];
    if (uploadFiles.length > 0)
        chipParts.push(
            `<span class="sync-chip sync-chip-upload" title="Files on your computer that are missing on the device.">↑ ${uploadFiles.length} new</span>`,
        );
    if (unchangedCount > 0)
        chipParts.push(
            `<span class="sync-chip sync-chip-unchanged" title="Files already on the device that match the source — no action needed.">${unchangedCount} up to date</span>`,
        );
    if (orphanCount > 0)
        chipParts.push(
            `<span class="sync-chip sync-chip-orphan" title="Files on the device that aren't in the source folder. They'll be deleted if you check them.">\u{1F5D1} ${orphanCount} orphaned</span>`,
        );
    html += `<div class="sync-chips">${chipParts.join("")}</div>`;

    // Upload section — only render header when there are files
    if (uploadFiles.length === 0) {
        html += `<div class="queue-empty"><span class="ms queue-empty-icon done">check_circle</span><span class="queue-empty-title">Everything is in sync</span></div>`;
    } else {
        html += `<div class="sync-section-header sync-header-upload">Upload to device · ${uploadFiles.length}</div>`;
        for (const item of uploadFiles) {
            const icon = getQueueStatusIcon(item.status);
            const baseName = escapeHtml(getBaseName(item.remotePath));
            const title = escapeHtml(item.remotePath);
            html +=
                `<div class="queue-item">` +
                `${icon}` +
                `<span class="queue-name" title="${title}">${baseName}</span>` +
                `<span class="queue-status">${escapeHtml(formatBytes(item.size))}</span>` +
                `</div>`;
        }
    }

    // Orphan section
    if (orphanCount > 0) {
        html +=
            `<div class="sync-section-header sync-header-orphan">` +
            `Only on device · ${orphanCount}` +
            `<button class="sync-delete-all-btn" type="button">Delete all</button>` +
            `</div>`;
        for (const orphan of state.syncOrphans) {
            const baseName = escapeHtml(getBaseName(orphan.remotePath));
            const title = escapeHtml(orphan.remotePath);
            const suffix = orphan.kind === "folder" ? "/" : "";
            if (!orphan.deletable) {
                html +=
                    `<div class="queue-item queue-orphan-item">` +
                    `<span class="queue-name" title="${title}">${baseName}${suffix}</span>` +
                    `<em class="queue-orphan-nondeletable">contains files</em>` +
                    `</div>`;
            } else if (orphan.status === "deleting") {
                html +=
                    `<div class="queue-item queue-orphan-item">` +
                    `<span class="ms-sm spin queue-icon active">sync</span>` +
                    `<span class="queue-name" title="${title}">${baseName}${suffix}</span>` +
                    `<span class="queue-status active">deleting…</span>` +
                    `</div>`;
            } else if (orphan.status === "deleted") {
                html +=
                    `<div class="queue-item queue-orphan-item">` +
                    `<span class="ms-sm queue-icon done">check_circle</span>` +
                    `<span class="queue-name" title="${title}">${baseName}${suffix}</span>` +
                    `<span class="queue-status done">deleted</span>` +
                    `</div>`;
            } else if (orphan.status === "error") {
                html +=
                    `<div class="queue-item queue-orphan-item">` +
                    `<span class="ms-sm queue-icon error">error</span>` +
                    `<span class="queue-name" title="${title}">${baseName}${suffix}</span>` +
                    `<span class="queue-status error">error</span>` +
                    `</div>`;
            } else {
                // pending — checkbox
                const checked = state.syncOrphanChecked.has(orphan.remotePath)
                    ? " checked"
                    : "";
                html +=
                    `<div class="queue-item queue-orphan-item">` +
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
        el.uploadQueue.innerHTML = `<div class="sync-scanning"><span class="ms spin">sync</span><span class="sync-scanning-text"> Scanning device…</span></div>`;
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
        const [icon, title, sub] =
            state.uploadTotalCount > 0
                ? ["task_alt", "Upload complete", ""]
                : [
                      "inbox",
                      "Queue is empty",
                      `<span class="queue-empty-sub">Choose Folder or Files above to start</span>`,
                  ];
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
                    `<span class="queue-status ${item.status}">${item.status === "skipped" ? "skipped" : item.status}</span>` +
                    `</div>`,
            );
        } else {
            const pct =
                item.size > 0
                    ? Math.round((item.transferred / item.size) * 100)
                    : item.status === "done"
                      ? 100
                      : 0;
            const pctStr =
                item.status === "done"
                    ? "done"
                    : item.status === "pending"
                      ? "pending"
                      : item.status === "aborted"
                        ? "aborted"
                        : item.status === "error"
                          ? "error"
                          : item.status === "skipped"
                            ? "skipped"
                            : `${pct}%`;
            items.push(
                `<div class="queue-item">` +
                    `${icon}` +
                    `<span class="queue-name" title="${title}">${baseName}</span>` +
                    `<div class="queue-bar"><div class="queue-bar-fill" style="width:${pct}%"></div></div>` +
                    `<span class="queue-status ${item.status}">${pctStr}</span>` +
                    `</div>`,
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
            if (w.type === "large-dirs")
                summaryParts.push(pluralize(w.dirs.length, "large folder"));
            else if (w.type === "large-batch")
                summaryParts.push(`~${w.mins} min upload`);
        }
        // Detail body (expanded state) — one block per problem, paths listed once
        let bodyHtml = "";
        for (const w of state.uploadWarnings) {
            if (w.type === "large-dirs") {
                const pathList = w.dirs
                    .map(
                        ({ dir }) =>
                            `<li>${escapeHtml(formatPathForUi(dir))}</li>`,
                    )
                    .join("");
                bodyHtml += `<p>${pluralize(w.dirs.length, "folder")} with many files. These may transfer slowly or stall:</p><ul>${pathList}</ul>`;
            } else if (w.type === "large-batch") {
                bodyHtml += `<p>${w.count} files total. Estimated time: ${w.mins}+ minutes. Keep the device nearby and the screen awake to avoid interruptions.</p>`;
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

    for (const rel of sortedFolders) {
        const remote = joinChildPath(base, rel.toLowerCase());
        let pathError = null;
        try {
            validateRemotePath(remote, "folder");
        } catch (err) {
            pathError = err.message;
        }
        if (pathError) {
            log(`Path too long: ${rel} (${pathError})`, "err");
            plan.push({
                id: ++planSeed,
                kind: "folder",
                localPath: rel,
                remotePath: remote,
                size: 0,
                file: null,
                transferred: 0,
                status: "skipped",
                skipReason: pathError,
            });
        } else {
            plan.push({
                id: ++planSeed,
                kind: "folder",
                localPath: rel,
                remotePath: remote,
                size: 0,
                file: null,
                transferred: 0,
                status: "pending",
            });
        }
    }

    for (const entry of files) {
        const remote = joinChildPath(base, entry.relativePath.toLowerCase());
        let pathError = null;
        try {
            validateRemotePath(remote, "file");
        } catch (err) {
            pathError = err.message;
        }
        if (pathError) {
            log(`Path too long: ${entry.relativePath} (${pathError})`, "err");
            plan.push({
                id: ++planSeed,
                kind: "file",
                localPath: entry.relativePath,
                remotePath: remote,
                size: entry.file.size,
                file: entry.file,
                transferred: 0,
                status: "skipped",
                skipReason: pathError,
            });
        } else {
            plan.push({
                id: ++planSeed,
                kind: "file",
                localPath: entry.relativePath,
                remotePath: remote,
                size: entry.file.size,
                file: entry.file,
                transferred: 0,
                status: "pending",
            });
        }
    }

    for (const item of plan) {
        if (item.kind !== "folder" || item.status === "skipped") continue;
        const prefix = item.remotePath.endsWith("/")
            ? item.remotePath
            : item.remotePath + "/";
        const hasUploadableChild = plan.some(
            (c) =>
                c.kind === "file" &&
                c.status !== "skipped" &&
                c.remotePath.startsWith(prefix),
        );
        if (!hasUploadableChild) {
            item.status = "skipped";
            item.skipReason = "No uploadable files inside";
        }
    }

    state.uploadPlan = plan;
    state.uploadWarnings = checkUploadPlanWarnings(plan);
    resetUploadProgress(plan);
    renderUploadQueue();
    updateControls();

    const uploadable = plan.filter((i) => i.status !== "skipped");
    const skippedFileCount = plan.filter(
        (i) => i.kind === "file" && i.status === "skipped",
    ).length;
    if (uploadable.length === 0) {
        if (skippedFileCount > 0) {
            showErrorToast(
                "No files can be uploaded",
                "Every selected file exceeds the device path limit. Shorten folder or file names and try again.",
            );
        } else {
            showWarningToast("Nothing to upload", "This selection is empty.");
        }
        return;
    }

    if (skippedFileCount > 0) {
        showWarningToast(
            `${pluralize(skippedFileCount, "file")} exceed device limits`,
            "Path or name exceeds the device limit. Shorten the folder or file names to include them.",
        );
    }
}

function checkUploadPlanWarnings(plan) {
    const warnings = [];
    // Per-directory density check
    const largeDirs = [];
    const perDir = new Map();
    for (const item of plan) {
        if (item.status === "skipped") continue;
        const parent = getParentPath(item.remotePath);
        perDir.set(parent, (perDir.get(parent) || 0) + 1);
    }
    for (const [dir, planned] of perDir) {
        const cached = state.client?.folderCache.get(dir);
        const existing = cached ? cached.entries.length : 0;
        const total = planned + existing;
        if (total >= LARGE_DIR_THRESHOLD) largeDirs.push({ dir, total });
    }
    if (largeDirs.length > 0)
        warnings.push({ type: "large-dirs", dirs: largeDirs });
    // Total batch size check
    const uploadable = plan.filter((i) => i.status !== "skipped");
    if (uploadable.length >= LARGE_BATCH_THRESHOLD) {
        const mins = Math.ceil((uploadable.length * 0.75) / 60);
        warnings.push({ type: "large-batch", count: uploadable.length, mins });
    }
    return warnings;
}

function warningsToStrings(warnings) {
    const lines = [];
    for (const w of warnings) {
        if (w.type === "large-dirs") {
            for (const { dir } of w.dirs) {
                lines.push(
                    `${formatPathForUi(dir)} has many files, transfers over Bluetooth may be slower`,
                );
            }
        } else if (w.type === "large-batch") {
            lines.push(
                `${w.count} files total. Estimated time: ${w.mins}+ minutes. Keep the device nearby and the screen awake`,
            );
        }
    }
    return lines;
}

function detectSystemFolderWarnings(folders, files) {
    const base = (state.currentPath || "E:/").toLowerCase();
    const affected = new Set();
    const check = (rel) => {
        const remote = joinChildPath(base, rel.toLowerCase());
        if (remote === "e:/amiibo/data" || remote.startsWith("e:/amiibo/data/"))
            affected.add("data");
        if (remote === "e:/amiibo/fav" || remote.startsWith("e:/amiibo/fav/"))
            affected.add("fav");
    };
    for (const rel of folders) check(rel);
    for (const entry of files) check(entry.relativePath);
    return affected;
}

// Shared confirm modal: sets innerHTML, opens uploadWarnModal, returns Promise<boolean>.
// AbortController + modal:close event ensure listeners always clean up (Cancel, X, Escape).
function showUploadWarnModal(htmlContent) {
    return new Promise((resolve) => {
        el.uploadWarnMsg.innerHTML = htmlContent;
        openModal(el.uploadWarnModal);
        const ac = new AbortController();
        const { signal } = ac;
        const done = (result) => {
            ac.abort();
            closeModal(el.uploadWarnModal);
            resolve(result);
        };
        el.btnUploadWarnConfirm.addEventListener("click", () => done(true), {
            signal,
        });
        el.uploadWarnModal.addEventListener(
            "modal:close",
            () => {
                ac.abort();
                resolve(false);
            },
            { signal, once: true },
        );
    });
}

function buildSystemFolderWarnHtml(affected) {
    const parts = [];
    if (affected.has("data"))
        parts.push(
            `<p><strong>Tag database folder (/amiibo/data)</strong>: files should use sequential names like ` +
                `<strong>00.bin, 01.bin</strong> to appear as numbered slots. This also helps advanced tools index them correctly.</p>`,
        );
    if (affected.has("fav"))
        parts.push(
            `<p><strong>Favorites folder (/amiibo/fav)</strong>: this folder is managed by your device app. ` +
                `Files uploaded here may not appear.</p>`,
        );
    return (
        parts.join("") +
        `<p class="modal-note">You can still upload, but some files may not appear as expected.</p>`
    );
}

async function checkSystemFolderWarning(collected) {
    const affected = detectSystemFolderWarnings(
        collected.folders,
        collected.files,
    );
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
    trackAnalyticsEvent("file_sync");
    updateControls();
    renderUploadQueue();

    const deviceTree = new Map(); // remotePath → { size, kind }
    let scanCount = 0;

    function setScanText(msg) {
        const span = el.uploadQueue.querySelector(".sync-scanning-text");
        if (span) span.textContent = " " + msg;
    }

    async function walk(path) {
        if (!state.client) throw new Error("Device disconnected.");
        const res = await state.client.readFolder(path);
        if (!res.ok) throw new Error(`readFolder(${path}): ${res.error}`);
        if (res.truncated)
            throw new Error(`Directory listing truncated at ${path}`);
        state.client.folderCache.set(path, {
            entries: sortEntries(res.data),
            truncated: false,
        });
        scanCount++;
        setScanText(`Scanning device… · ${pluralize(scanCount, "folder")}`);
        for (const entry of res.data) {
            // Normalize to lowercase so device paths match the plan paths produced
            // by buildUploadPlan (which also lowercases via rel.toLowerCase()). FAT32
            // can return names in any case ("00.BIN", "Sub"), and Map lookup is
            // case-sensitive, so without this files are re-uploaded and folders show
            // as orphans even when they're already in sync.
            const entryPath = joinChildPath(path, entry.name.toLowerCase());
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
            const isFolder = state.uploadPlan.some(
                (i) => i.remotePath === rootPath && i.kind === "folder",
            );
            const hasNested = item.remotePath
                .slice(normBase.length)
                .includes("/");
            if (isFolder || hasNested) scanRoots.add(rootPath);
        }
        // Always scan the base directory so flat files (e.g. E:/foo.bin) are
        // detected as already present and not re-uploaded every sync.
        const baseRes = await state.client.readFolder(base);
        if (baseRes.ok) {
            for (const entry of baseRes.data) {
                const entryPath = joinChildPath(base, entry.name.toLowerCase());
                if (isSyncExcluded(entryPath)) continue;
                const kind = entry.type === "DIR" ? "folder" : "file";
                deviceTree.set(entryPath, { size: entry.size, kind });
            }
        }
        for (const root of scanRoots) {
            try {
                await walk(root);
            } catch (err) {
                if (!err.message.includes("Not found")) throw err;
            }
        }
    } catch (err) {
        el.browserLockOverlay.classList.remove("active");
        log(`Sync scan failed: ${err.message}`, "err");
        showErrorToast("Couldn't scan device", err.message);
        state.syncState = "error";
        updateControls();
        renderUploadQueue();
        return;
    }

    el.browserLockOverlay.classList.remove("active");

    // Snapshot original plan paths (pre-filter) to detect orphans
    const localPaths = new Set(state.uploadPlan.map((i) => i.remotePath));

    // Filter plan: remove items already on device at same size
    const skippedFiles = [];
    const filteredPlan = [];
    for (const item of state.uploadPlan) {
        if (item.status === "skipped") {
            filteredPlan.push(item);
            continue;
        }
        if (item.kind === "file") {
            const remote = deviceTree.get(item.remotePath);
            if (remote && remote.kind === "file" && remote.size === item.size) {
                skippedFiles.push({
                    remotePath: item.remotePath,
                    size: item.size,
                });
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
            const prefix = remotePath.endsWith("/")
                ? remotePath
                : remotePath + "/";
            deletable = true;
            for (const p of deviceTree.keys()) {
                if (p.startsWith(prefix)) {
                    deletable = false;
                    break;
                }
            }
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
        (o) =>
            o.deletable &&
            o.status === "pending" &&
            state.syncOrphanChecked.has(o.remotePath),
    );
    let deletedCount = 0;
    let errorCount = 0;
    for (const orphan of toDelete) {
        if (!state.client) throw new Error("Device disconnected.");
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
            log(`Remove failed: ${orphan.remotePath}: ${err.message}`, "err");
            orphan.status = "error";
            errorCount++;
        }
        renderUploadQueue();
    }
    if (errorCount > 0) {
        showWarningToast(
            `Removed ${deletedCount} of ${deletedCount + errorCount} device-only items`,
            `${errorCount} failed. Check the protocol log for details.`,
        );
    } else if (deletedCount > 0) {
        showSuccessToast(
            `Removed ${pluralize(deletedCount, "item")} from device`,
        );
    }
}

// --- Upload execution ---

async function runUpload() {
    const hasUploads =
        state.uploadPlan.filter((i) => i.kind === "file").length > 0;
    const hasOrphanDeletions = state.syncOrphanChecked.size > 0;
    if (!state.client || state.connState !== "connected" || state.uploadActive)
        return;
    if (!hasUploads && !hasOrphanDeletions) return;

    if (state.uploadWarnings.length > 0) {
        const lines = warningsToStrings(state.uploadWarnings)
            .map((w) => `<li>${escapeHtml(w)}</li>`)
            .join("");
        const html =
            `<ul class="modal-list">${lines}</ul>` +
            `<p class="modal-note">You can continue now, but large transfers may take longer or fail if Bluetooth drops.</p>`;
        if (!(await showUploadWarnModal(html))) return;
        if (!state.client || state.connState !== "connected") return;
    }

    state.uploadActive = true;
    state.abortController = new AbortController();
    el.browserLockOverlay.classList.add("active");
    el.browserLockTitle.textContent = "Uploading…";
    const uploadableFiles = state.uploadPlan.filter(
        (i) => i.kind === "file" && i.status !== "skipped",
    );
    const uploadTotalSize = uploadableFiles.reduce((s, i) => s + i.size, 0);
    trackAnalyticsEvent("file_upload_start", {
        count: uploadableFiles.length,
        size: uploadTotalSize,
    });

    updateControls();

    resetUploadProgress(state.uploadPlan);

    for (const item of state.uploadPlan) {
        if (item.status === "skipped") continue;
        item.transferred = 0;
        item.status = "pending";
    }
    renderUploadQueue();

    const folderItems = state.uploadPlan.filter(
        (i) => i.kind === "folder" && i.status !== "skipped",
    );
    const fileItems = state.uploadPlan.filter(
        (i) => i.kind === "file" && i.status !== "skipped",
    );

    try {
        for (const item of folderItems) {
            if (state.abortController.signal.aborted)
                throw new Error("Aborted.");
            item.status = "active";
            renderUploadQueue();
            await state.client.ensureFolder(item.remotePath);
            item.transferred = item.size;
            consumeCompletedUploadItem(item);
            renderUploadQueue();
        }

        for (const item of fileItems) {
            if (state.abortController.signal.aborted)
                throw new Error("Aborted.");
            item.status = "active";
            renderUploadQueue();
            const parent = getParentPath(item.remotePath);
            await state.client.ensureFolder(parent);
            const fileStartTime = performance.now();
            let lastSpeedUpdate = 0;
            await state.client.uploadFile(
                item.remotePath,
                item.file,
                (written, total) => {
                    item.transferred = written;
                    const now = performance.now();
                    if (now - lastSpeedUpdate >= 150 || written === total) {
                        lastSpeedUpdate = now;
                        const elapsed = (now - fileStartTime) / 1000;
                        if (elapsed > 0 && written > 0) {
                            const bps = written / elapsed;
                            state.transferSpeed =
                                bps < 1000
                                    ? `${Math.round(bps)} B/s`
                                    : `${(bps / 1024).toFixed(1)} KB/s`;
                        }
                    }
                    renderUploadQueue();
                },
                state.abortController.signal,
            );
            item.transferred = item.size;
            log(
                `Uploaded ${item.remotePath} (${formatBytes(item.size)})`,
                "ok",
            );
            consumeCompletedUploadItem(item);
            renderUploadQueue();
        }
        // Phase 2: Orphan deletion
        if (
            !state.abortController.signal.aborted &&
            state.syncOrphanChecked.size > 0
        ) {
            await runOrphanDeletion();
        }

        if (fileItems.length > 0) {
            showSuccessToast(
                `Uploaded ${pluralize(fileItems.length, "file")}`,
                "Transfer finished successfully.",
            );
            trackAnalyticsEvent("file_upload_complete", {
                count: fileItems.length,
                size: uploadTotalSize,
            });
        }
    } catch (err) {
        log(`Upload error: ${err.message}`, "err");
        const isReconnecting = state.connState === "reconnecting";
        const isConnectionLoss =
            !isReconnecting &&
            /GATT|NetworkError|disconnected/i.test(err.message);
        const isUserAbort =
            !isReconnecting &&
            !isConnectionLoss &&
            state.abortController &&
            state.abortController.signal.aborted;
        if (isUserAbort) {
            showWarningToast(
                "Upload canceled",
                "No problem, your queue is still here if you want to retry.",
            );
        } else if (!isReconnecting && !isConnectionLoss) {
            showErrorToast("Couldn't upload files", err.message);
        }
        const active = state.uploadPlan.find((i) => i.status === "active");
        if (active) active.status = isUserAbort ? "aborted" : "error";
        if (!isReconnecting && !isConnectionLoss) {
            for (const item of state.uploadPlan) {
                if (item.status === "pending") item.status = "aborted";
            }
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
        if (
            state.connState === "connected" &&
            state.client &&
            state.client.device
        ) {
            invalidateCache();
            if (state.currentPath) {
                try {
                    await browseFolder(state.currentPath);
                } catch (_) {
                    /* connection may be dropping */
                }
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
            if (!(await checkSystemFolderWarning(collected))) return;
            buildUploadPlan(collected.folders, collected.files);
            setPanelState("upload");
        } else {
            el.folderInput.click();
        }
    } catch (err) {
        if (err.name !== "AbortError")
            log(`Picker error: ${err.message}`, "err");
    }
});

el.folderInput.addEventListener("change", async (e) => {
    if (!e.target.files || e.target.files.length === 0) return;
    const snapshot = Array.from(e.target.files);
    e.target.value = "";
    try {
        const collected = await collectFromWebkitDir(snapshot);
        if (!(await checkSystemFolderWarning(collected))) return;
        buildUploadPlan(collected.folders, collected.files);
        setPanelState("upload");
    } catch (err) {
        showErrorToast("Couldn't add folder", err.message);
    }
});

el.btnPickFiles.addEventListener("click", () => el.filesInput.click());

el.filesInput.addEventListener("change", async (e) => {
    if (!e.target.files || e.target.files.length === 0) return;
    const snapshot = Array.from(e.target.files);
    e.target.value = "";
    try {
        const collected = collectFromFiles(snapshot);
        if (!(await checkSystemFolderWarning(collected))) return;
        buildUploadPlan(collected.folders, collected.files);
        setPanelState("upload");
    } catch (err) {
        showErrorToast("Couldn't add files", err.message);
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

// === DFU ===

const DFU_STAGES = [
    { id: "selecting", label: "Connecting to device" },
    { id: "entering_dfu", label: "Switching to update mode" },
    { id: "waiting", label: "Waiting for device to restart" },
    { id: "reconnecting", label: "Reconnect in update mode" },
    { id: "preparing", label: "Preparing update file" },
    { id: "uploading_init", label: "Preparing transfer" },
    { id: "uploading_firmware", label: "Transferring firmware" },
    { id: "rebooting", label: "Finishing up" },
];

const dfuState = {
    phase: "idle", // idle | confirming | selecting | entering_dfu | waiting | reconnecting | preparing | uploading_init | uploading_firmware | rebooting | success | failed
    source: null, // { type: "url", url, name } | { type: "file", file, name }
    firmwareType: "native", // "native" | "custom"
    variant: null, // "LCD" | "OLED" | null (detected from filename)
    chosenVariant: null, // explicit user pick when variant is null
    cancelFlag: false,
    enterDfuDone: false, // true once the device has been rebooted into DFU mode; retry skips enterDfu()
    dfuDevice: null, // BluetoothDevice once connected to the DFU bootloader; used for forced reboot
    cachedImages: null, // { baseImage, appImage } once prepared; reused on picker-retry without re-download
    pickerDismissed: false, // true when user closed the BT picker; retry jumps straight to scan
    skippedStages: new Set(),
    release: null,
    releaseLoading: false,
};

const DFU_IS_MOBILE = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

const DFU_RUNTIME_OPTIONS = Object.freeze({
    maxDfuAttempts: 2,
    reconnectDelayMs: 1000,
    notificationTimeoutMs: DFU_IS_MOBILE ? 30000 : 20000,
    operationTimeoutMs: DFU_IS_MOBILE ? 30000 : 20000,
    dataObjectDelayMs: DFU_IS_MOBILE ? 100 : 0,
    rebootTimeMs: 3000,
    packetSize: 244,
});

const DFU_TRANSFER_DEFAULTS = Object.freeze({
    delayMs: DFU_IS_MOBILE ? 5 : 0,
    prn: DFU_IS_MOBILE ? 8 : 12,
});

function createSecureDfu({
    delayMs = DFU_TRANSFER_DEFAULTS.delayMs,
    prn = DFU_TRANSFER_DEFAULTS.prn,
} = {}) {
    return new window.SecureDfu(
        null,
        undefined,
        delayMs,
        prn,
        DFU_RUNTIME_OPTIONS,
    );
}

// ── Package utilities ─────────────────────────────────────────────────────────

async function resolveOtaZip(fileBlob, fileName) {
    log(`[DFU] Opening package: ${fileName}`, "cmd");
    const lower = (fileName || "").toLowerCase();
    const inferredVariant = lower.includes("_lcd")
        ? "LCD"
        : lower.includes("_oled")
          ? "OLED"
          : null;

    const zip = await window.JSZip.loadAsync(fileBlob);
    if (zip.file("manifest.json")) {
        log("[DFU] Package is a direct DFU zip.", "ok");
        return { otaBlob: fileBlob, variant: inferredVariant };
    }

    const nested = Object.values(zip.files).find(
        (e) => !e.dir && e.name.toLowerCase().endsWith(".zip"),
    );
    if (!nested)
        throw new Error(
            "No update file found. Use a firmware .zip file or a full Pixl.js release .zip.",
        );

    log(`[DFU] Extracting inner package: ${nested.name}`, "ok");
    const innerLower = nested.name.toLowerCase();
    const innerVariant =
        inferredVariant ??
        (innerLower.includes("_lcd")
            ? "LCD"
            : innerLower.includes("_oled")
              ? "OLED"
              : null);
    const nestedBlob = await nested.async("blob");
    return { otaBlob: nestedBlob, variant: innerVariant };
}

async function loadDfuImages(zipBlob) {
    log("[DFU] Parsing DFU manifest...", "cmd");
    const zip = await window.JSZip.loadAsync(zipBlob);
    const manifestFile = zip.file("manifest.json");
    if (!manifestFile)
        throw new Error("This file doesn't look like a valid update package.");

    const manifestRoot = JSON.parse(await manifestFile.async("string"));
    const manifest = manifestRoot.manifest || {};

    async function getImage(types) {
        for (const type of types) {
            const entry = manifest[type];
            if (!entry) continue;
            const init = zip.file(entry.dat_file);
            const image = zip.file(entry.bin_file);
            if (!init || !image)
                throw new Error(
                    `Package is incomplete: missing files for ${type}.`,
                );
            return {
                type,
                initData: await init.async("arraybuffer"),
                imageData: await image.async("arraybuffer"),
            };
        }
        return null;
    }

    const images = {
        baseImage: await getImage([
            "softdevice",
            "bootloader",
            "softdevice_bootloader",
        ]),
        appImage: await getImage(["application"]),
    };
    const parts = [];
    if (images.baseImage) parts.push(images.baseImage.type);
    if (images.appImage) parts.push("application");
    log(`[DFU] Images loaded: ${parts.join(", ") || "none"}`, "ok");
    return images;
}

// ── Dev mock helpers ──────────────────────────────────────────────────────────

function dfuIsDev() {
    return state.client instanceof DevMockClient;
}

async function validateDfuZip(file) {
    if (!window.JSZip) return; // library not yet loaded, skip silently
    let zip;
    try {
        zip = await window.JSZip.loadAsync(file);
    } catch {
        throw new Error("This file doesn't appear to be a valid .zip archive.");
    }

    if (zip.file("manifest.json")) {
        let manifest;
        try {
            manifest =
                JSON.parse(await zip.file("manifest.json").async("string"))
                    .manifest || {};
        } catch {
            throw new Error("The manifest.json in this package is malformed.");
        }
        const TYPES = [
            "application",
            "softdevice",
            "bootloader",
            "softdevice_bootloader",
        ];
        const found = TYPES.find((t) => manifest[t]);
        if (!found) throw new Error("No firmware image found in this package.");
        const entry = manifest[found];
        if (!zip.file(entry.bin_file) || !zip.file(entry.dat_file))
            throw new Error(
                "This package is incomplete: files listed in manifest.json are missing.",
            );
        return;
    }

    // Release zip: must contain at least one nested .zip
    const nested = Object.values(zip.files).find(
        (e) => !e.dir && e.name.toLowerCase().endsWith(".zip"),
    );
    if (!nested)
        throw new Error(
            "No firmware file found inside this .zip. Use a firmware .zip file or a full Pixl.js release .zip.",
        );
}

const MOCK_RELEASE = {
    tag_name: "v2.16.0-mock",
    assets: [
        { name: "pixljs_2.16.0_LCD.zip" },
        { name: "pixljs_2.16.0_OLED.zip" },
    ],
};

async function mockDfuTransfer(onProgress, failMode = "none") {
    const delay = (ms) => new Promise((r) => setTimeout(r, ms));
    async function sweep(stageId, label, steps, stepMs, cap = 100) {
        for (let i = 0; i <= steps; i++) {
            if (dfuState.cancelFlag) throw new Error("Cancelled");
            onProgress(stageId, {
                progress: Math.min((i / steps) * 100, cap),
                progressFile: label,
            });
            await delay(stepMs);
        }
    }
    await delay(300);
    if (failMode === "init_packet") {
        await sweep("uploading_init", "Init packet", 4, 80, 50);
        throw new Error("Init packet rejected by bootloader.");
    }
    await sweep("uploading_init", "Init packet", 10, 80);
    if (failMode === "mid_transfer") {
        await sweep("uploading_firmware", "Firmware", 8, 100, 40);
        throw new Error(
            "Transfer interrupted: device disconnected mid-transfer.",
        );
    }
    await sweep("uploading_firmware", "Firmware", 20, 100);
}

// ── Modal helpers ─────────────────────────────────────────────────────────────

function dfuInProgress() {
    const active = [
        "preparing",
        "entering_dfu",
        "waiting",
        "selecting",
        "reconnecting",
        "uploading_init",
        "uploading_firmware",
        "rebooting",
    ];
    return active.includes(dfuState.phase);
}

function dfuCanCloseFromBackdrop() {
    return !dfuInProgress() && el.dfuWarnSection.hidden;
}

function closeDfuModal() {
    closeModal(el.dfuModal);
    resetDfuUi();
    setStateColors(state.connState, state.client instanceof DevMockClient);
}

function dfuShowConfirmView() {
    _clearDfuWarnCountdown();
    el.dfuConfirmSection.hidden = false;
    el.dfuWarnSection.hidden = true;
    el.dfuProgressSection.hidden = true;
    el.dfuFooterConfirm.hidden = false;
    el.dfuFooterWarn.hidden = true;
    el.dfuFooterProgress.hidden = true;
    el.dfuFooterCancelConfirm.hidden = true;
    el.dfuFooterFailed.hidden = true;
    el.dfuFooterSuccess.hidden = true;
}

let _dfuWarnTimer = null;

function _clearDfuWarnCountdown() {
    clearInterval(_dfuWarnTimer);
    _dfuWarnTimer = null;
}

function updateDfuWarnCopy() {
    const isCustom = dfuState.firmwareType === "custom";
    const isLocalFile = dfuState.source?.type === "file";

    el.dfuWarnTitle.textContent = "Almost there, one last check";

    if (isCustom || isLocalFile) {
        el.dfuWarnBodyPrimary.textContent =
            "Make sure this file matches your device model (LCD or OLED). Using the wrong one can leave the screen blank until you flash the correct version.";
    } else {
        el.dfuWarnBodyPrimary.textContent =
            "Confirm you picked the right model above. If LCD and OLED are mixed up, the screen can go blank until you install the correct version.";
    }

    el.dfuWarnBodySecondary.textContent =
        "If something goes wrong mid-update, your device may stay in update mode. Don't worry, you can retry with the correct file to fix it.";

    el.dfuMobileNote.hidden = !DFU_IS_MOBILE;
}

function dfuShowWarnView() {
    updateDfuWarnCopy();
    el.dfuConfirmSection.hidden = true;
    el.dfuWarnSection.hidden = false;
    el.dfuProgressSection.hidden = true;
    el.dfuFooterConfirm.hidden = true;
    el.dfuFooterWarn.hidden = false;
    el.dfuFooterProgress.hidden = true;
    el.dfuFooterCancelConfirm.hidden = true;
    el.dfuFooterFailed.hidden = true;
    el.dfuFooterSuccess.hidden = true;

    _clearDfuWarnCountdown();
    let sec = 3;
    el.btnDfuProceed.disabled = true;
    el.btnDfuProceed.textContent = `I understand, update (${sec}s)`;
    _dfuWarnTimer = setInterval(() => {
        sec--;
        if (sec > 0) {
            el.btnDfuProceed.textContent = `I understand, update (${sec}s)`;
        } else {
            _clearDfuWarnCountdown();
            el.btnDfuProceed.textContent = "I understand, update";
            el.btnDfuProceed.disabled = false;
        }
    }, 1000);
}

function dfuShowProgressView() {
    _clearDfuWarnCountdown();
    el.dfuConfirmSection.hidden = true;
    el.dfuWarnSection.hidden = true;
    el.dfuProgressSection.hidden = false;
    el.dfuFooterConfirm.hidden = true;
    el.dfuFooterWarn.hidden = true;
    el.dfuFooterProgress.hidden = false;
    el.dfuFooterCancelConfirm.hidden = true;
    el.dfuFooterFailed.hidden = true;
    el.dfuFooterSuccess.hidden = true;
    el.btnDfuCancelTransfer.disabled = false;
    el.btnDfuCancelTransfer.textContent = "Cancel";
    el.dfuStatusSubhead.textContent = "UPDATING";
    el.dfuErrorBox.hidden = true;
    el.dfuTroubleshootLinks.hidden = true;
    el.dfuSuccessBox.hidden = true;
}

function dfuShowFailedView(
    errorText,
    { title = "Update failed", subhead = "UPDATE FAILED" } = {},
) {
    el.dfuConfirmSection.hidden = true;
    el.dfuWarnSection.hidden = true;
    el.dfuProgressSection.hidden = false;
    el.dfuFooterConfirm.hidden = true;
    el.dfuFooterWarn.hidden = true;
    el.dfuFooterProgress.hidden = true;
    el.dfuFooterCancelConfirm.hidden = true;
    el.dfuFooterFailed.hidden = false;
    el.dfuFooterSuccess.hidden = true;
    el.dfuStatusSubhead.textContent = subhead;
    el.dfuActiveIcon.className = "modal-icon-badge danger";
    el.dfuActiveIcon.querySelector(".ms").textContent = "error";
    el.dfuActiveLabel.textContent = title;
    el.dfuErrorBox.hidden = false;
    el.dfuErrorBox.textContent = errorText;
    el.dfuTroubleshootLinks.hidden = false;
    el.dfuSuccessBox.hidden = true;
    el.btnDfuReboot.disabled = !dfuState.dfuDevice;
    el.btnDfuReboot.setAttribute("aria-disabled", String(!dfuState.dfuDevice));
    el.btnDfuRetryConnect.hidden = !dfuState.pickerDismissed;
    el.btnDfuRetry.hidden = dfuState.pickerDismissed;
    const hadRealSession = !!(
        state.currentPath &&
        state.client &&
        !(state.client instanceof DevMockClient)
    );
    el.btnDfuReconnect.hidden = !hadRealSession;
}

function dfuShowSuccessView() {
    el.dfuConfirmSection.hidden = true;
    el.dfuWarnSection.hidden = true;
    el.dfuProgressSection.hidden = false;
    el.dfuFooterConfirm.hidden = true;
    el.dfuFooterWarn.hidden = true;
    el.dfuFooterProgress.hidden = true;
    el.dfuFooterCancelConfirm.hidden = true;
    el.dfuFooterFailed.hidden = true;
    el.dfuFooterSuccess.hidden = false;
    el.dfuStatusSubhead.textContent = "COMPLETE";
    el.dfuActiveIcon.className = "modal-icon-badge success";
    el.dfuActiveIcon.querySelector(".ms").textContent = "check";
    el.dfuActiveLabel.textContent = "Firmware updated successfully";
    el.dfuErrorBox.hidden = true;
    el.dfuTroubleshootLinks.hidden = true;
    el.dfuSuccessBox.hidden = false;
    renderDfuStageList("__done__");
}

// ── Stage list rendering ──────────────────────────────────────────────────────

function renderDfuStageList(currentStageId) {
    // currentIdx === -1 means all stages complete (e.g. success view)
    const currentIdx = DFU_STAGES.findIndex((s) => s.id === currentStageId);

    // Build skeleton on first render; subsequent calls only patch changed items
    // so the active stage's CSS animation never gets destroyed mid-spin.
    if (el.dfuStageList.children.length !== DFU_STAGES.length) {
        el.dfuStageList.innerHTML = DFU_STAGES.map(
            (s) =>
                `<li class="dfu-stage-item pending">` +
                `<span class="dfu-stage-dot"></span>` +
                `<span class="dfu-stage-item-label">${s.label}</span>` +
                `<button type="button" class="dfu-stage-item-hint" hidden disabled aria-disabled="true">` +
                `<span class="ms-sm">bluetooth_searching</span> Connect to device` +
                `</button>` +
                `</li>`,
        ).join("");
    }

    Array.from(el.dfuStageList.children).forEach((li, i) => {
        const dot = li.querySelector(".dfu-stage-dot");
        const hint = li.querySelector(".dfu-stage-item-hint");
        const stageId = DFU_STAGES[i].id;
        const reconnectActive =
            stageId === "reconnecting" &&
            i === currentIdx &&
            !dfuState.skippedStages.has(stageId);
        if (hint) {
            hint.hidden = !reconnectActive;
            hint.disabled = !reconnectActive;
            hint.setAttribute("aria-disabled", String(!reconnectActive));
        }
        if (dfuState.skippedStages.has(stageId)) {
            if (!li.classList.contains("skipped")) {
                li.className = "dfu-stage-item skipped";
                dot.innerHTML = "";
            }
        } else if (currentIdx === -1 || i < currentIdx) {
            if (!li.classList.contains("done")) {
                li.className = "dfu-stage-item done";
                dot.innerHTML = `<span class="ms">check</span>`;
            }
        } else if (i === currentIdx) {
            if (!li.classList.contains("active")) {
                li.className = "dfu-stage-item active";
                dot.innerHTML = `<span class="ms">sync</span>`;
            }
        } else {
            if (!li.classList.contains("pending")) {
                li.className = "dfu-stage-item pending";
                dot.innerHTML = "";
            }
        }
    });
}

function dfuSetStage(
    stageId,
    { progress = null, progressFile = "", speed = "" } = {},
) {
    const stage = DFU_STAGES.find((s) => s.id === stageId);
    if (!stage) return;
    dfuState.phase = stageId;
    el.dfuActiveLabel.textContent = stage.label;
    el.dfuActiveIcon.className = "modal-icon-badge primary spinning";
    el.dfuActiveIcon.querySelector(".ms").textContent = "sync";
    el.dfuSelectingHint.hidden = stageId !== "selecting";
    const reconnecting = stageId === "reconnecting";
    el.dfuReconnectHint.hidden = !reconnecting;
    const transferring =
        stageId === "uploading_init" || stageId === "uploading_firmware";
    el.dfuMobileTransferNote.hidden = !(DFU_IS_MOBILE && transferring);

    if (progress !== null) {
        el.dfuProgressBarWrap.hidden = false;
        const pct = Math.min(100, Math.max(0, Math.round(progress)));
        el.dfuProgressFill.style.width = `${pct}%`;
        el.dfuProgressPct.textContent = `${pct}%`;
        el.dfuProgressFile.textContent = progressFile;
        el.dfuProgressSpeed.textContent = speed;
    } else {
        el.dfuProgressBarWrap.hidden = true;
        el.dfuProgressSpeed.textContent = "";
    }

    renderDfuStageList(stageId);
}

// ── Release fetching ──────────────────────────────────────────────────────────

async function fetchDfuRelease() {
    if (dfuState.releaseLoading) return;
    dfuState.releaseLoading = true;
    dfuState.release = null;
    renderDfuReleaseList();
    try {
        if (dfuIsDev()) {
            await new Promise((r) => setTimeout(r, 400));
            dfuState.release = MOCK_RELEASE;
        } else {
            log("[DFU] Fetching latest release...", "cmd");
            const resp = await fetch("firmware/release.json");
            if (!resp.ok)
                throw new Error(`Couldn't load release info (${resp.status})`);
            dfuState.release = await resp.json();
            log(`[DFU] Latest release: ${dfuState.release.tag_name}`, "ok");
        }
    } catch (err) {
        log(`[DFU] Couldn't check for updates: ${err.message}`, "err");
        dfuState.release = { error: err.message };
    } finally {
        dfuState.releaseLoading = false;
        renderDfuReleaseList();
        if (dfuState.chosenVariant && dfuState.firmwareType === "native") {
            autoSelectReleaseSource(dfuState.chosenVariant);
        }
    }
}

function renderDfuReleaseList() {
    const c = el.dfuReleaseContainer;
    if (dfuState.releaseLoading) {
        c.innerHTML = `<span class="ms dfu-release-spinner">progress_activity</span><span class="dfu-release-status-text">Checking the latest official update…</span>`;
        return;
    }
    if (!dfuState.release) {
        c.innerHTML = `<span class="dfu-release-status-text">Checking the latest official update…</span>`;
        return;
    }
    if (dfuState.release.error) {
        c.innerHTML = `<span class="dfu-release-status-text error">Couldn't check the latest official update. You can still use your own file below.</span>`;
        return;
    }
    const assets = (dfuState.release.assets || []).filter((a) =>
        a.name.toLowerCase().endsWith(".zip"),
    );
    if (!assets.length) {
        c.innerHTML = `<span class="dfu-release-status-text">The latest official release does not include an update file right now.</span>`;
        return;
    }
    const tagName = dfuState.release.tag_name || "";
    const releaseUrl = dfuState.release.html_url || PIXL_RELEASES_URL;
    c.innerHTML = tagName
        ? `<span class="dfu-release-status-text">Latest official version:</span><span class="dfu-release-tag">${escapeHtml(tagName)}</span><a class="ext-link dfu-release-link" href="${escapeHtml(releaseUrl)}" target="_blank" rel="noopener">View release notes <span class="ms-sm">open_in_new</span></a>`
        : "";
}

function autoSelectReleaseSource(variant) {
    if (!dfuState.release || dfuState.release.error) return;
    const assets = (dfuState.release.assets || []).filter((a) =>
        a.name.toLowerCase().endsWith(".zip"),
    );
    const match = assets.find((a) =>
        a.name.toLowerCase().includes(`_${variant.toLowerCase()}`),
    );
    if (!match) return;
    selectDfuSource({
        type: "url",
        url: `firmware/${match.name}`,
        name: match.name,
    });
}

// ── Package selection ─────────────────────────────────────────────────────────

function detectVariantFromName(name) {
    const lower = (name || "").toLowerCase();
    return lower.includes("_lcd")
        ? "LCD"
        : lower.includes("_oled")
          ? "OLED"
          : null;
}

function selectDfuSource(source) {
    dfuState.source = source;
    dfuState.variant = detectVariantFromName(source.name);
    if (source.type === "file" && !dfuState.variant) {
        setDfuFirmwareType("custom");
    } else if (dfuState.firmwareType === "native" && dfuState.variant) {
        dfuState.chosenVariant = dfuState.variant;
    }

    if (source.type === "file") el.dfuPickedName.textContent = source.name;
    updateDfuVariantUI();
    updateDfuStartButton();
    updateDfuFilePickerUI();
}

function updateDfuVariantUI() {
    const isCustom = dfuState.firmwareType === "custom";
    el.btnDfuVariantLCD.classList.toggle(
        "selected",
        !isCustom && dfuState.chosenVariant === "LCD",
    );
    el.btnDfuVariantOLED.classList.toggle(
        "selected",
        !isCustom && dfuState.chosenVariant === "OLED",
    );
    el.btnDfuVariantCustom.classList.toggle("selected", isCustom);
}

function updateDfuStartButton() {
    const isCustom = dfuState.firmwareType === "custom";
    const ready = !!dfuState.source && (isCustom || !!dfuState.chosenVariant);
    el.btnDfuStart.disabled = !ready;
}

function updateDfuFilePickerUI() {
    const isCustom = dfuState.firmwareType === "custom";
    const hasPickedFile = dfuState.source?.type === "file";

    // Divider + "Pick file" button are only for custom mode *before* selecting
    // a file. Once a file is picked, the picked-file row replaces them.
    if (el.dfuFileDivider)
        el.dfuFileDivider.hidden = !isCustom || hasPickedFile;
    el.btnDfuPickFile.hidden = !isCustom || hasPickedFile;
    el.dfuPickedFile.hidden = !hasPickedFile;
}

function setDfuFirmwareType(type) {
    dfuState.firmwareType = type;
    const isCustom = type === "custom";
    el.dfuNativePanel.hidden = isCustom;
    el.dfuCustomPanel.hidden = !isCustom;
    el.dfuFileDividerLabel.textContent = isCustom
        ? "select your update file"
        : "or use your own .zip file";
    if (isCustom) {
        dfuState.chosenVariant = null;
        if (dfuState.source?.type === "url") {
            dfuState.source = null;
        }
    } else if (dfuState.source?.type === "file") {
        dfuState.chosenVariant =
            detectVariantFromName(dfuState.source.name) ||
            dfuState.chosenVariant;
    }
    updateDfuVariantUI();
    updateDfuStartButton();
    updateDfuFilePickerUI();
}

function resetDfuUi() {
    _clearDfuWarnCountdown();
    dfuState.phase = "idle";
    dfuState.source = null;
    dfuState.variant = null;
    dfuState.chosenVariant = null;
    dfuState.cancelFlag = false;
    dfuState.enterDfuDone = false;
    dfuState.dfuDevice = null;
    dfuState.cachedImages = null;
    dfuState.pickerDismissed = false;
    dfuState.skippedStages = new Set();

    setDfuFirmwareType("native");

    el.dfuWarnSection.hidden = true;
    el.dfuFooterWarn.hidden = true;
    el.dfuFooterCancelConfirm.hidden = true;
    el.btnDfuCancelTransfer.disabled = false;
    el.btnDfuCancelTransfer.textContent = "Cancel";
    el.dfuSelectingHint.hidden = true;
    el.dfuReconnectHint.hidden = true;
    el.dfuMobileTransferNote.hidden = true;
    el.dfuPickedName.textContent = "";
    el.dfuProgressBarWrap.hidden = true;
    el.dfuErrorBox.hidden = true;
    el.dfuTroubleshootLinks.hidden = true;
    el.dfuSuccessBox.hidden = true;
    el.dfuStatusSubhead.textContent = "UPDATING";
    el.dfuActiveLabel.textContent = "";
    el.dfuActiveIcon.className = "modal-icon-badge primary";
    el.dfuActiveIcon.querySelector(".ms").textContent = "sync";
    el.dfuStageList.innerHTML = "";
    el.dfuDevPanel.hidden = !dfuIsDev();
    el.dfuDevPanel.open = false;
    el.btnDfuReboot.disabled = true;
    el.btnDfuReboot.setAttribute("aria-disabled", "true");
    el.dfuDevFailMode.value = "none";
    el.dfuCustomDevicesDetails.open = false;
    el.btnDfuStart.disabled = true;
    updateControls();
}

// ── Transfer ──────────────────────────────────────────────────────────────────

async function runDfuTransfer() {
    const shouldTrackDfuAnalytics = !dfuIsDev();
    dfuState.cancelFlag = false;
    dfuState.skippedStages = new Set();
    dfuShowProgressView();
    updateControls();
    if (shouldTrackDfuAnalytics) {
        trackAnalyticsEvent("dfu_start", {
            source: dfuState.source?.type || "unknown",
            variant: dfuState.chosenVariant || dfuState.variant || "unknown",
        });
    }

    let wakeLock = null;
    try {
        if (navigator.wakeLock) {
            wakeLock = await navigator.wakeLock
                .request("screen")
                .catch(() => null);
        }
        const src = dfuState.source;
        if (!src) throw new Error("Pick an update file first.");

        if (dfuIsDev()) {
            // Simulate the full flow without real BLE or real ZIP. The dev panel
            // selects which failure shape (if any) to inject.
            const failMode = el.dfuDevFailMode.value;
            el.dfuDevFailMode.value = "none";
            if (failMode === "picker_dismissed") {
                const err = new Error("User dismissed the picker.");
                err.name = "NotFoundError";
                throw err;
            }
            dfuSetStage("selecting");
            await new Promise((r) => setTimeout(r, 300));
            dfuSetStage("entering_dfu");
            await new Promise((r) => setTimeout(r, 500));
            // Once we cross entering_dfu the device is in DFU mode; mirror the real
            // flow so simulated failures get the matching retry guidance.
            dfuState.enterDfuDone = true;
            dfuSetStage("waiting");
            await new Promise((r) => setTimeout(r, 700));
            if (dfuState.cancelFlag) throw new Error("Cancelled");
            dfuSetStage("reconnecting");
            await new Promise((r) => setTimeout(r, 600));
            if (dfuState.cancelFlag) throw new Error("Cancelled");
            dfuSetStage("preparing");
            await new Promise((r) => setTimeout(r, 400));
            await mockDfuTransfer(
                (stageId, opts) => dfuSetStage(stageId, opts),
                failMode,
            );
        } else {
            const DFU_UUID = window.SecureDfu.SERVICE_UUID;
            const dfu = createSecureDfu();
            dfu.addEventListener(window.SecureDfu.EVENT_LOG, ({ message }) => {
                console.log("[DFU]", message);
            });
            log(
                `[DFU] Runtime: retries=${DFU_RUNTIME_OPTIONS.maxDfuAttempts}, objectDelay=${DFU_RUNTIME_OPTIONS.dataObjectDelayMs}ms, packet=${DFU_RUNTIME_OPTIONS.packetSize}B, prn=${DFU_TRANSFER_DEFAULTS.prn}, delay=${DFU_TRANSFER_DEFAULTS.delayMs}ms`,
                "cmd",
            );

            let _dfuLastStage = null;
            let _dfuPrevBytes = 0;
            let _dfuPrevTime = 0;
            let _dfuSmoothedKbps = 0;
            const EMA_ALPHA = 0.15;
            dfu.addEventListener(
                window.SecureDfu.EVENT_PROGRESS,
                ({ object, currentBytes, totalBytes }) => {
                    const isInit = object === "init";
                    const stageId = isInit
                        ? "uploading_init"
                        : "uploading_firmware";
                    const pct =
                        totalBytes > 0 ? (currentBytes / totalBytes) * 100 : 0;
                    if (stageId !== _dfuLastStage) {
                        _dfuLastStage = stageId;
                        _dfuPrevBytes = 0;
                        _dfuPrevTime = performance.now();
                        _dfuSmoothedKbps = 0;
                        log(
                            `[DFU] Uploading: ${isInit ? "init packet" : "firmware"}`,
                            "cmd",
                        );
                    }
                    let speed = "";
                    if (!isInit && currentBytes > 0) {
                        const now = performance.now();
                        const dt = (now - _dfuPrevTime) / 1000;
                        if (dt > 0.05) {
                            const instantKbps =
                                (currentBytes - _dfuPrevBytes) / 1024 / dt;
                            _dfuSmoothedKbps =
                                _dfuSmoothedKbps < 0.1
                                    ? instantKbps
                                    : _dfuSmoothedKbps * (1 - EMA_ALPHA) +
                                      instantKbps * EMA_ALPHA;
                            _dfuPrevBytes = currentBytes;
                            _dfuPrevTime = now;
                        }
                        if (_dfuSmoothedKbps > 0.1)
                            speed = `${_dfuSmoothedKbps.toFixed(1)} KB/s`;
                    }
                    dfuSetStage(stageId, {
                        progress: pct,
                        progressFile: isInit ? "Init packet" : "Firmware",
                        speed,
                    });
                },
            );

            // ── Device selection (must happen first — requires user gesture) ──
            let device;

            function waitForReconnectClick() {
                return new Promise((resolve, reject) => {
                    function cleanup() {
                        el.dfuStageList.removeEventListener("click", onClick);
                        el.btnDfuCancelConfirmYes.removeEventListener(
                            "click",
                            onCancel,
                        );
                    }
                    function onClick(e) {
                        const reconnectBtn = e.target.closest(
                            ".dfu-stage-item-hint",
                        );
                        if (
                            !reconnectBtn ||
                            reconnectBtn.hidden ||
                            reconnectBtn.disabled
                        )
                            return;
                        cleanup();
                        dfu.requestDevice(false, [
                            { services: [DFU_UUID] },
                        ]).then(resolve, reject);
                    }
                    // During reconnect, "Cancel" first opens inline confirmation.
                    // Abort only after the user confirms with "Cancel update".
                    function onCancel() {
                        cleanup();
                        reject(new Error("Cancelled"));
                    }
                    el.dfuStageList.addEventListener("click", onClick);
                    el.btnDfuCancelConfirmYes.addEventListener(
                        "click",
                        onCancel,
                    );
                });
            }

            if (dfuState.enterDfuDone) {
                // Retry — device already rebooted into DFU mode
                if (!dfuState.pickerDismissed) {
                    dfuSetStage("waiting");
                    await new Promise((r) => setTimeout(r, 3000));
                }
                dfuState.pickerDismissed = false;
                if (dfuState.cancelFlag) throw new Error("Cancelled");

                dfuSetStage("reconnecting");
                log("[DFU] Tap the button to reconnect...", "cmd");
                device = await waitForReconnectClick();
            } else if (state.client && state.connState === "connected") {
                // Already connected from file browser — reboot into DFU directly
                dfuState.skippedStages = new Set(["selecting"]);
                dfuSetStage("entering_dfu");
                const deviceName = state.client.device?.name || "device";
                log(
                    `[DFU] "${deviceName}" is connected, rebooting into update mode...`,
                    "cmd",
                );
                const enterRes = await state.client.enterDfu();
                if (!enterRes.ok)
                    throw new Error(
                        `Couldn't switch to update mode: ${enterRes.error}`,
                    );
                dfuState.enterDfuDone = true;

                dfuSetStage("waiting");
                await new Promise((r) => setTimeout(r, 3000));
                if (dfuState.cancelFlag) throw new Error("Cancelled");

                dfuSetStage("reconnecting");
                log("[DFU] Tap the button to reconnect...", "cmd");
                device = await waitForReconnectClick();
            } else {
                // Disconnected — unified picker accepts both regular and DFU mode
                dfuSetStage("selecting");
                log("[DFU] Select your device...", "cmd");
                const picked = await navigator.bluetooth.requestDevice({
                    filters: [
                        { services: [NUS_SERVICE] },
                        { services: [DFU_UUID] },
                    ],
                    optionalServices: [NUS_SERVICE, DFU_UUID],
                });
                const server = await picked.gatt.connect();

                let isDfuMode = false;
                try {
                    await server.getPrimaryService(DFU_UUID);
                    isDfuMode = true;
                } catch {
                    /* not in DFU mode */
                }

                if (isDfuMode) {
                    server.disconnect();
                    log(
                        `[DFU] "${picked.name || "device"}" is already in update mode.`,
                        "ok",
                    );
                    dfuState.skippedStages = new Set([
                        "entering_dfu",
                        "waiting",
                        "reconnecting",
                    ]);
                    device = picked;
                } else {
                    dfuSetStage("entering_dfu");
                    log(
                        `[DFU] "${picked.name || "device"}" is in normal mode, rebooting into update mode...`,
                        "cmd",
                    );
                    const nusClient = await (async () => {
                        const c = new PixlToolsClient((msg) =>
                            log(`[DFU] ${msg}`, "cmd"),
                        );
                        await c.connectTo(picked);
                        return c;
                    })();
                    const enterRes = await nusClient.enterDfu();
                    if (!enterRes.ok) {
                        nusClient.disconnect();
                        throw new Error(
                            `Couldn't switch to update mode: ${enterRes.error}`,
                        );
                    }
                    dfuState.enterDfuDone = true;

                    dfuSetStage("waiting");
                    await new Promise((r) => setTimeout(r, 3000));
                    if (dfuState.cancelFlag) throw new Error("Cancelled");

                    dfuSetStage("reconnecting");
                    log("[DFU] Tap the button to reconnect...", "cmd");
                    device = await waitForReconnectClick();
                }
            }

            dfuState.dfuDevice = device;
            const deviceName = device.name || "DFU device";
            log(`[DFU] Connected to "${deviceName}".`, "ok");
            if (dfuState.cancelFlag) throw new Error("Cancelled");

            // ── Firmware preparation (after device selection — no gesture needed) ──
            dfuSetStage("preparing");
            let images;
            if (dfuState.cachedImages) {
                log("[DFU] Using cached firmware images.", "cmd");
                images = dfuState.cachedImages;
            } else {
                let rawBlob;
                if (src.type === "url") {
                    log(`[DFU] Downloading: ${src.name}`, "cmd");
                    const resp = await fetch(src.url);
                    if (!resp.ok)
                        throw new Error(
                            `Couldn't download the update file (${resp.status}). Check your connection and try again.`,
                        );
                    rawBlob = await resp.blob();
                    log(`[DFU] Download complete.`, "ok");
                } else {
                    log(`[DFU] Using local file: ${src.name}`, "cmd");
                    rawBlob = src.file;
                }

                const { otaBlob } = await resolveOtaZip(rawBlob, src.name);
                images = await loadDfuImages(otaBlob);
                if (!images.baseImage && !images.appImage)
                    throw new Error(
                        "This file doesn't contain any firmware to install.",
                    );
                dfuState.cachedImages = images;
            }

            // ── Transfer ──
            dfuSetStage("uploading_init", {
                progress: 0,
                progressFile: "Init packet",
            });

            if (images.baseImage) {
                await dfu.update(
                    device,
                    images.baseImage.initData,
                    images.baseImage.imageData,
                );
                log(`[DFU] ${images.baseImage.type} uploaded.`, "ok");
            }
            if (images.appImage) {
                await dfu.update(
                    device,
                    images.appImage.initData,
                    images.appImage.imageData,
                );
                log("[DFU] Application uploaded.", "ok");
            }
        }

        dfuSetStage("rebooting");
        await new Promise((r) => setTimeout(r, 400));

        log("[DFU] Firmware updated successfully.", "ok");
        dfuState.phase = "success";
        if (shouldTrackDfuAnalytics) {
            trackAnalyticsEvent("dfu_complete", {
                source: src.type,
                variant:
                    dfuState.chosenVariant || dfuState.variant || "unknown",
            });
        }
        dfuShowSuccessView();
        updateControls();
    } catch (err) {
        if (err.name === "NotFoundError") {
            log("[DFU] Bluetooth picker dismissed.", "err");
            dfuState.phase = "failed";
            dfuState.pickerDismissed = true;
            if (dfuState.enterDfuDone) {
                dfuShowFailedView(
                    "No device was selected. Your device may still be in update mode. Tap Retry and pick it from the Bluetooth list to continue.",
                    { title: "No device selected", subhead: "NOT CONNECTED" },
                );
            } else {
                dfuShowFailedView(
                    "No device was selected. Tap Retry and choose your device to continue.",
                    { title: "No device selected", subhead: "NOT CONNECTED" },
                );
            }
            updateControls();
        } else if (
            dfuState.cancelFlag ||
            err.message?.toLowerCase().includes("cancel")
        ) {
            log("[DFU] Update cancelled.", "err");
            if (shouldTrackDfuAnalytics) trackAnalyticsEvent("dfu_cancel");
            closeDfuModal();
        } else {
            log(`[DFU] Update failed: ${err.message}`, "err");
            dfuState.phase = "failed";
            if (shouldTrackDfuAnalytics) {
                trackAnalyticsEvent("dfu_fail", {
                    source: dfuState.source?.type || "unknown",
                    variant:
                        dfuState.chosenVariant || dfuState.variant || "unknown",
                    error: err.message,
                });
            }
            const guidance = dfuState.enterDfuDone
                ? " Your device may still be in update mode. Tap Retry to try again."
                : " Tap Retry to start over.";
            dfuShowFailedView(err.message + guidance);
            updateControls();
        }
    } finally {
        wakeLock?.release().catch(() => {});
    }
}

// ── Event listeners ───────────────────────────────────────────────────────────

el.btnUpdateFirmware.addEventListener("click", () => {
    if (!dfuIsDev() && (!window.JSZip || !window.SecureDfu)) {
        showErrorToast(
            "Update tools are still loading",
            "Wait a moment, then try again. If it keeps happening, refresh the page.",
        );
        return;
    }
    el.dfuUpdateDot.hidden = true;
    resetDfuUi();
    dfuState.phase = "confirming";
    dfuShowConfirmView();
    openModal(el.dfuModal);
    setStateColors("dfu", false);
    updateControls();
    trackAnalyticsEvent("dfu_open");
    fetchDfuRelease();
});

el.btnDfuFromDfu.addEventListener("click", () => {
    if (!dfuIsDev() && (!window.JSZip || !window.SecureDfu)) {
        showErrorToast(
            "Update tools are still loading",
            "Wait a moment, then try again. If it keeps happening, refresh the page.",
        );
        return;
    }
    resetDfuUi();
    dfuState.phase = "confirming";
    dfuShowConfirmView();
    openModal(el.dfuModal);
    setStateColors("dfu", false);
    updateControls();
    fetchDfuRelease();
});

el.btnDfuClose.addEventListener("click", () => {
    // Use the same guard as Esc and backdrop so the three close paths agree.
    // Previously the X allowed dismissal mid-warn (where Esc/backdrop did not).
    if (dfuCanCloseFromBackdrop()) closeDfuModal();
});

el.btnDfuPickFile.addEventListener("click", () => {
    el.dfuFileInput.value = "";
    el.dfuFileInput.click();
});

el.btnDfuChangeFile.addEventListener("click", () => {
    el.dfuFileInput.value = "";
    el.dfuFileInput.click();
});

el.dfuFileInput.addEventListener("change", async () => {
    const file = el.dfuFileInput.files[0];
    if (!file) return;
    clearToasts();
    try {
        await validateDfuZip(file);
    } catch (err) {
        showErrorToast("Couldn't use this update file", err.message);
        el.dfuFileInput.value = "";
        return;
    }
    selectDfuSource({ type: "file", file, name: file.name });
});

el.btnDfuVariantLCD.addEventListener("click", () => {
    setDfuFirmwareType("native");
    dfuState.chosenVariant = "LCD";
    updateDfuVariantUI();
    autoSelectReleaseSource("LCD");
    updateDfuStartButton();
});

el.btnDfuVariantOLED.addEventListener("click", () => {
    setDfuFirmwareType("native");
    dfuState.chosenVariant = "OLED";
    updateDfuVariantUI();
    autoSelectReleaseSource("OLED");
    updateDfuStartButton();
});

el.btnDfuVariantCustom.addEventListener("click", () => {
    setDfuFirmwareType("custom");
});

el.btnDfuStart.addEventListener("click", () => {
    if (el.btnDfuStart.disabled) return;
    dfuShowWarnView();
});

el.btnDfuCancelConfirm.addEventListener("click", () => {
    closeDfuModal();
});

el.btnDfuBackToConfirm.addEventListener("click", () => {
    dfuShowConfirmView();
});

el.btnDfuProceed.addEventListener("click", async () => {
    if (el.btnDfuProceed.disabled) return;
    await runDfuTransfer();
});

el.btnDfuCancelTransfer.addEventListener("click", () => {
    if (!dfuState.enterDfuDone) {
        // Pre-DFU cancel is unambiguous (nothing has been written yet) — no
        // confirmation needed; the in-flight transfer will throw on next tick.
        dfuState.cancelFlag = true;
        return;
    }
    // Mid-DFU: swap the progress footer for an inline confirmation. Keeps
    // the live progress visible behind the prompt and avoids stacking a
    // second modal-overlay on top of the DFU modal.
    el.dfuFooterProgress.hidden = true;
    el.dfuFooterCancelConfirm.hidden = false;
});

el.btnDfuCancelKeep.addEventListener("click", () => {
    el.dfuFooterCancelConfirm.hidden = true;
    el.dfuFooterProgress.hidden = false;
});

el.btnDfuCancelConfirmYes.addEventListener("click", () => {
    dfuState.cancelFlag = true;
    // Swap back to the progress footer but lock the cancel button so the user
    // can't double-fire while we're waiting for the next loop iteration to
    // observe the flag and bail out.
    el.dfuFooterCancelConfirm.hidden = true;
    el.dfuFooterProgress.hidden = false;
    el.btnDfuCancelTransfer.disabled = true;
    el.btnDfuCancelTransfer.textContent = "Cancelling…";
});

function dfuReconnect() {
    const shouldReconnectMock = state.client instanceof DevMockClient;
    closeDfuModal();
    // DFU may have left the connection in an ambiguous state (mock never
    // disconnects; real device may have already dropped). Tear it down
    // explicitly so connectOrDisconnect / devConnect always enter the
    // connect path.
    if (state.connState === "connected" || state.connState === "reconnecting") {
        if (state.client) state.client.disconnect();
        setConnState("disconnected");
    }
    if (shouldReconnectMock) {
        devConnect();
    } else {
        connectOrDisconnect();
    }
}

el.btnDfuReconnect.addEventListener("click", dfuReconnect);

el.btnDfuReboot.addEventListener("click", () => {
    const device = dfuState.dfuDevice;
    if (device?.gatt?.connected) {
        device.gatt.disconnect();
    }
    closeDfuModal();
    showSuccessToast(
        "Exit update mode requested",
        "Power-cycle your device to return to normal mode.",
    );
});

el.btnDfuRetry.addEventListener("click", async () => {
    if (dfuInProgress()) return;
    if (!dfuState.source) {
        closeDfuModal();
        return;
    }
    await runDfuTransfer();
});

el.btnDfuRetryConnect.addEventListener("click", async () => {
    if (dfuInProgress()) return;
    dfuState.pickerDismissed = true; // preserved so wait is skipped
    await runDfuTransfer();
});

el.btnDfuCloseSuccess.addEventListener("click", () => {
    closeDfuModal();
    if (state.connState === "connected" || state.connState === "reconnecting") {
        if (state.client) state.client.disconnect();
        setConnState("disconnected");
    }
});

// === Initial state ===

function stampFooters(commitText) {
    const html = `
    <div class="footer-made">Made with <span class="ms-sm footer-heart">favorite</span> from Argentina</div>
    <div class="footer-meta">
      <span class="nav-commit">${escapeHtml(commitText)}</span>
      <span class="panel-footer-sep">&middot;</span>
      <a href="https://github.com/tasken/Mochi" target="_blank" rel="noopener">Mochi &copy; 2026 Nimbo</a>
      <span class="panel-footer-sep">&middot;</span>
      <a href="https://github.com/tasken/Mochi/blob/main/LICENSE" target="_blank" rel="noopener">MIT</a>
    </div>`;
    el.footers.forEach((f) => {
        f.innerHTML = html;
    });
}

const _buildCommit = document.querySelector(
    'meta[name="build-commit"]',
)?.content;

const isDevMode = !_buildCommit || _buildCommit === "dev";
stampFooters(isDevMode ? "dev" : _buildCommit);

if (isDevMode) {
    el.btnDev.addEventListener("click", devConnect);
}

setConnState("disconnected");
updateControls();

const isIOS =
    (/iPhone|iPad|iPod/.test(navigator.userAgent) ||
        (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)) &&
    !/Bluefy/i.test(navigator.userAgent);

if (isIOS || isDevMode) {
    el.iosBanner.hidden = false;
    if (isIOS) trackAnalyticsEvent("ios_banner_shown");
    el.iosBannerClose.addEventListener("click", () => {
        el.iosBanner.hidden = true;
    });
}

if (!navigator.bluetooth) {
    const [summary, detail, overlaySub] = window.isSecureContext
        ? isIOS
            ? [
                  "Bluetooth not available",
                  "Most iOS browsers don't support Web Bluetooth yet. Open Mochi in Bluefy to connect over Bluetooth.",
                  "Open Mochi in Bluefy to connect to your Pixl.js.",
              ]
            : [
                  "Chrome or Edge required",
                  "This browser doesn't support Web Bluetooth device connections. Use Chrome or Edge.",
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

// Signal the boot loader (index.html) that the app finished its initial
// synchronous render and is safe to reveal.
document.dispatchEvent(new CustomEvent("app:ready"));
