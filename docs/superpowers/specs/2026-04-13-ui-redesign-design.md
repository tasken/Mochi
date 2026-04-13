# MochiNest UI Redesign — Design Spec

## Goal

Replace the current sidebar-heavy layout with a cleaner, more intuitive file manager structure: a slim top bar for device/navigation controls and a single contextual left panel that morphs based on what is selected or active.

## Motivation

The current layout has four stacked sidebar sections (Connection, Drive, Upload, Log) competing for space alongside a dense 7-column file table and a metadata drawer that slides in from the right. The result is visually noisy and unintuitive for a file manager — the primary content (files) does not have enough prominence, the log occupies permanent real estate, and the upload queue is buried in the sidebar.

---

## Layout Structure

```
┌─────────────────────────────────────────────────────────┐
│  TOP BAR                                                │
├──────────────┬──────────────────────────────────────────┤
│              │                                          │
│  CONTEXTUAL  │  FILE BROWSER                            │
│  LEFT PANEL  │  (hybrid list, full height)              │
│  (~200px)    │                                          │
│              │                                          │
└──────────────┴──────────────────────────────────────────┘
```

---

## Top Bar

A single slim dark bar (`#1a1a2e` background) replacing the current sidebar header and the floating toolbar.

**Contents (left → right):**

1. **App name** — "MochiNest", dimmed
2. **Connection badge** — pill showing `● Connected · Pixl.js` (green) or `● Disconnected` (dimmed). When disconnected the badge is a Connect button. When connecting it shows the spinner.
3. **Drive usage** — `811 KB / 1.83 MB` text + a small Format icon button (🗑) immediately after, shown only when connected; Format opens the existing format confirmation modal
4. **Path breadcrumb** — `E:/ › amiibo › chibi-robo`, takes remaining flex space
5. **Upload button** — `↑ Upload`, activates upload panel state
6. **Log toggle** — `≡` icon, opens/closes the log overlay
7. **New folder button** — `+ Folder`

**States:**
- **Disconnected**: connection badge is a clickable Connect button; drive usage, breadcrumb, upload, new folder are hidden
- **Connecting**: badge shows spinner + "Connecting…"; same items hidden
- **Connected**: full bar shown

---

## Contextual Left Panel

Fixed width (~200px), always visible when connected. Morphs between four states based on context. Has a smooth transition between states.

### State 1 — Folder view (default, nothing selected)

Shown when the user navigates to a folder with no file selected.

- Section label: "Folder"
- Folder name (bold)
- Full path (dimmed)
- Item count
- Drive usage bar + "used / total" label

### State 2 — File selected

Shown when any non-.bin file is clicked, or a .bin file before the amiibo API responds.

- Section label: "File"
- Filename (bold, word-break)
- Size, Flags (RHS abbreviation), Notes rows
- Rename button, Delete button

Clicking elsewhere in the file browser (not on a file) returns to State 1.

### State 3 — Amiibo .bin selected

Shown when a `.bin` file is clicked and the amiibo API lookup completes. Extends State 2.

- Everything in State 2, plus:
- Section label: "Amiibo"
- Character name (bold)
- Game series · Amiibo series (if different, joined with ·)
- Amiibo image (full panel width)
- Hex ID (`XXXXXXXX:XXXXXXXX`) in monospace below image
- While the API is loading: show State 2 with a spinner where the amiibo section will appear. When the API response arrives, the panel transitions to State 3 in place — no click required.
- If the API returns no result, the panel stays in State 2 (no amiibo section shown).

### State 4 — Upload mode

Activated when the user clicks "↑ Upload" in the top bar. The panel transforms into the uploader.

- Section label: "Upload" + ✕ close button (top right)
- Folder picker button + Files picker button
- Upload queue list (filename, size, status icon per item)
- Start button (primary), Abort button (danger), Clear button (ghost)
- Progress/speed info during transfer

**Lock rule**: the file browser receives the lock overlay (blocking interaction) only while a transfer is actively in progress — not merely because the upload panel is open. The user can browse folders and view file details while the upload panel is open and idle.

Closing the panel (✕) or completing a transfer returns to whichever state was active before upload mode (folder view or last selected file).

---

## File Browser

The main content area, full height, full remaining width.

### List style — Hybrid rows

Each row has two columns: **Name** and **Size**.

The Name cell contains:
- File/folder icon (left)
- Primary line: filename (bold)
- Secondary line (files only): amiibo character name if resolved, otherwise flags abbreviation (e.g. `RHS`), otherwise empty

Size cell: formatted bytes for files, `—` for folders.

**Removed columns**: Kind (redundant with icon), Flags (moved to panel), Amiibo (moved to panel), Notes (moved to panel).

### Selection

- Checkbox column remains (leftmost)
- "Select all" checkbox in header
- Selection action bar appears above the list when ≥1 item is checked: shows count, Lowercase button, Delete button, Select All, Clear Selection

### Navigation

- Clicking a folder navigates into it (no separate "open" button needed)
- Clicking a file selects it and updates the left panel
- Up / Refresh buttons remain in the top bar area (can be icon buttons near the breadcrumb)

---

## Log Overlay

The log is hidden by default. The `≡` toggle in the top bar opens it as a bottom panel overlay (slides up from the bottom edge, ~30% screen height). It does not displace the file browser or left panel. Clicking `≡` again or pressing Escape closes it.

The log retains its existing monospace styling and auto-scroll behaviour.

---

## Connection / Disconnected State

When no device is connected:
- Top bar shows only the app name and a Connect button
- The left panel and file browser are hidden behind the existing main overlay card (centred, "No device connected")
- On connect success, the overlay fades out and the full layout appears

---

## Modals

All existing modals (Format, New Folder, Rename, Delete, Lowercase/Sanitize variants) are unchanged in behaviour. They are triggered the same way; only their trigger points move (e.g. Delete is now in the left panel for single-file selections, and in the selection bar for multi-select).

---

## What Is Removed

| Element | Disposition |
|---|---|
| Sidebar (Connection section) | Merged into top bar |
| Sidebar (Drive section) | Drive usage + Format icon button in top bar |
| Sidebar (Upload section) | Becomes left panel State 4 |
| Sidebar (Log section) | Becomes bottom overlay toggle |
| Right metadata drawer | Replaced entirely by left panel States 2 and 3 |
| Kind column | Removed |
| Flags column | Moved to left panel |
| Amiibo column | Moved to left panel |
| Notes column | Moved to left panel |

---

## Files Changed

- `index.html` — new top bar markup, left panel markup, file browser rows (no drawer), log overlay; remove old sidebar and drawer
- `styles.css` — new top bar, left panel, hybrid row, log overlay styles; remove old sidebar, drawer, and drive section styles
- `app.js` — new `setPanelState(state)` function, updated `renderFileTable()` for hybrid rows, updated `setConnState()` for top bar, upload panel wired to left panel, log overlay toggle, browser lock now only set during active transfer
