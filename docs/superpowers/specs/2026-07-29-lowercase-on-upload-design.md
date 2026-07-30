# Case normalization on upload: make it a Tools menu toggle

## Motivation

Every upload today silently lowercases file and folder names (`buildUploadPlan()` in `app/app.js`). Some users want to keep their original casing. This makes that behavior a persisted, user-facing toggle in the Tools menu (`#moreActionsMenu`), distinct from the existing one-shot "Lowercase filenames" tool (which retroactively renames files already on the device and is untouched by this change).

## State & persistence

New `state.lowercaseOnUpload` boolean, seeded at boot from `localStorage["mochi.lowercaseOnUpload"]`:

```js
function loadLowercaseOnUploadPref() {
    try {
        const val = localStorage.getItem("mochi.lowercaseOnUpload");
        return val !== "false"; // absent, "true", or anything but the literal "false" -> on
    } catch {
        return true;
    }
}
```

Default is **on** (matches current always-lowercase behavior; existing users see no change until they opt out). Both read and write go through try/catch — this is the app's first `localStorage` use, and private-browsing/storage-restricted contexts can throw; on failure it just falls back to the in-memory default with no user-facing error.

Write side:

```js
function saveLowercaseOnUploadPref(enabled) {
    try {
        localStorage.setItem("mochi.lowercaseOnUpload", String(enabled));
    } catch {
        // best-effort; setting just won't persist this session
    }
}
```

## UI

New checkable item in `#moreActionsMenu` (`app/index.html`), placed next to the existing "Lowercase filenames" button:

```html
<button
    class="more-actions-item"
    id="btnLowercaseOnUpload"
    role="menuitemcheckbox"
    aria-checked="true"
    title="Automatically lowercase file and folder names when uploading"
>
    <span class="ms-sm">toggle_on</span>
    <span>Lowercase names on upload</span>
</button>
```

`toggle_on`/`toggle_off` are already in the Material Symbols `icon_names` subset (`app/index.html:1556`) — no CSP/font changes needed.

In `app/app.js`:

- Add `btnLowercaseOnUpload: document.getElementById("btnLowercaseOnUpload"),` to the `el` object (required — `validateElementBindings()` only catches a registered key resolving to a missing node, not a key that was never added, so omitting it would surface as a runtime `TypeError` on first click instead of a boot-time error).
- `state.lowercaseOnUpload = loadLowercaseOnUploadPref();` added where `state` is initialized.
- A render helper, called once at boot and after every toggle:

```js
function renderLowercaseOnUploadToggle() {
    const on = state.lowercaseOnUpload;
    el.btnLowercaseOnUpload.setAttribute("aria-checked", String(on));
    el.btnLowercaseOnUpload.querySelector(".ms-sm").textContent = on ? "toggle_on" : "toggle_off";
}
```

- Click handler:

```js
el.btnLowercaseOnUpload.addEventListener("click", () => {
    state.lowercaseOnUpload = !state.lowercaseOnUpload;
    saveLowercaseOnUploadPref(state.lowercaseOnUpload);
    renderLowercaseOnUploadToggle();
    trackAnalyticsEvent("lowercase_on_upload_toggle", { enabled: state.lowercaseOnUpload });
});
```

The menu's existing delegated handler (`el.moreActionsMenu` closes on any button click) closes the dropdown after toggling too, same as every other item — no special-casing needed.

## Upload plan changes

In `buildUploadPlan()`, both unconditional lowercase calls become conditional on the setting:

- Folder loop (`app/app.js:3994`): `joinChildPath(base, rel.toLowerCase())` → `joinChildPath(base, state.lowercaseOnUpload ? rel.toLowerCase() : rel)`
- File loop (`app/app.js:4029`): same change for `entry.relativePath`.

When off, uploaded names keep whatever case the browser reports for the local file/folder.

## Sync matching fix

`runSync()`'s device-tree scan currently lowercases only the *leaf* name at each recursive step (`entry.name.toLowerCase()` in `walk()`, `app/app.js:4264`, and in the flat base-folder scan, `app/app.js:4299`). The path segment the scan starts from (`state.uploadBase`, i.e. wherever the user is currently sitting) is never itself lowercased. Today this is harmless by coincidence: both the plan-building side and the tree-scanning side derive that prefix from the exact same unlowercased `state.currentPath`, so raw string equality still lines up.

That coincidence breaks once uploaded paths can carry original case: a naive `item.remotePath.toLowerCase()` comparison would over-lowercase relative to what `deviceTree`'s keys actually contain, causing mismatches whenever `state.uploadBase` itself isn't already all-lowercase (e.g. a folder created via the "New folder" button, which has never lowercased). Fix: key `deviceTree` by the fully-lowercased path, and carry the real device-reported casing alongside it for display/deletion:

```js
// walk() and the flat base-folder scan, app/app.js ~4264 and ~4299
const devicePathLower = entryPath.toLowerCase();
deviceTree.set(devicePathLower, { size: entry.size, kind, actualPath: entryPath });
```

Then the three comparison sites in `runSync()` switch to the lowercase key while using `actualPath` wherever the real device path is needed:

```js
// localPaths (orphan detection), app/app.js:4325
const localPathsLower = new Set(state.uploadPlan.map((i) => i.remotePath.toLowerCase()));

// file skip-if-present check, app/app.js:4336
const remote = deviceTree.get(item.remotePath.toLowerCase());
// ...unchanged below this, remote.size/remote.kind still read the same way

// folder skip-if-present check, app/app.js:4344
} else if (item.kind === "folder" && deviceTree.has(item.remotePath.toLowerCase())) {

// orphan collection loop, app/app.js:4352
for (const [devicePathLower, { size, kind, actualPath }] of deviceTree) {
    if (localPathsLower.has(devicePathLower)) continue;
    // ...deletable computation unchanged, but push actualPath, not devicePathLower
    orphans.push({ remotePath: actualPath, size, kind, deletable, status: "pending" });
}
```

The nested-folder `deletable` check (`app/app.js:4356-4365`, walking `deviceTree.keys()` for a prefix match) also needs its `prefix` built from `actualPath` rather than the lowercase key, and compared against other entries' `actualPath` — using the lowercase keys there would still work for the "is there anything under this folder" question (case-insensitive is actually correct there too), so this loop can keep using the lowercase keys directly; only the emitted `orphans.push` needs `actualPath`.

`detectSystemFolderWarnings()` (`app/app.js:4155-4168`) needs no change — it already lowercases independently, purely to compare against its own hardcoded lowercase literals (`e:/amiibo/data`, `e:/amiibo/fav`), unrelated to what actually gets uploaded.

## Same-batch case-collision warning

When normalization is off, dropping e.g. `FILE.BIN` and `file.bin` into the same folder in one batch produces two plan items that resolve to the same name on the device's case-insensitive-but-case-preserving FAT32 filesystem — one silently overwrites the other with no warning today. Reusing the existing non-blocking warning banner (`checkUploadPlanWarnings()` / `warningsToStrings()` / `el.uploadWarningBanner`, the same mechanism already used for "large folder" and "large batch" warnings):

- In `checkUploadPlanWarnings(plan)`: group non-skipped items by `getParentPath(item.remotePath) + "|" + item.remotePath.toLowerCase()`; any group with more than one distinct original-case `remotePath` becomes a `{ type: "case-collision", groups: [{ paths: [...] }] }` warning entry.
- In `warningsToStrings()`: render each group as a line, e.g. `"FILE.BIN and file.bin resolve to the same name on the device — only one will be kept"`.
- In the upload-queue warning banner render block (`app/app.js:3933-3970`): add a `"case-collision"` summary part (`pluralize(count, "name collision")`) and a detail block listing the colliding paths (through `escapeHtml()`, per project convention).

This check runs on the final computed `remotePath` regardless of the toggle, so it also catches the pre-existing case where normalization is *on* and two differently-cased local names collapse to the same lowercased name — a latent gap in the shipped app today, fixed as a side effect of reusing this mechanism, not scope creep.

## Analytics

One new event, matching the existing snake_case-name + params-object convention (`file_search`, `folder_create`, `normalize_run`, etc.):

```js
trackAnalyticsEvent("lowercase_on_upload_toggle", { enabled: state.lowercaseOnUpload });
```

## Out of scope

- The manual "New folder" flow doesn't lowercase today and isn't touched.
- The existing one-shot "Lowercase filenames" device-wide tool (`btnNormalize`) is untouched and independent.
- Cross-batch or cross-session collision detection (e.g. uploading `file.bin` today and `FILE.BIN` next week) is not covered — this only catches collisions within a single upload batch, matching the existing warning banner's scope (which is also per-batch).

## Testing plan

No test suite exists in this repo (per `CLAUDE.md`). Manual verification via `inv serve` / the Mock device button:

1. Toggle off, upload a folder with mixed-case names, confirm names land un-lowercased in the file browser.
2. Toggle off, run Sync in that folder immediately after — confirm no false orphans, no re-uploads (validates the `deviceTree` key fix).
3. Toggle off, drop `FILE.BIN` and `file.bin` together — confirm the collision warning banner appears with both names listed.
4. Toggle on (default), confirm behavior is byte-identical to current shipped behavior (regression check).
5. Reload the page after toggling off — confirm the toggle stays off (localStorage persistence) and the menu icon/`aria-checked` reflect it correctly on boot.
6. With devtools blocking `localStorage` (or an incognito/private-mode equivalent if available), confirm the toggle still functions in-memory for the session without throwing.
