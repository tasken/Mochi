# File Search — Design

Status: v1 (navigate-only) implemented and shipped 2026-07-19. Superseded
2026-07-19 by an in-place-actions revision — see "Revision: in-place actions".
A further "Revision: tag identity search (phase 2)" is designed (not yet
implemented) at the end of this document. The "Navigate-only results" and
"Names only, v1" decisions below are kept as historical record of why v1 was
built that way; they no longer fully reflect current/planned behavior.
Date: 2026-07-19

## Problem

Mochi's file browser shows one folder at a time (`state.entries`, populated from
`state.client.folderCache` on demand). There's no way to find a file without
manually navigating folder by folder. This adds a whole-drive recursive search.

## Scope decisions

- **Whole-drive, recursive.** Search always walks from `E:/`, not just the
  current folder. (Considered defaulting to current-folder-first to reduce BLE
  cost; rejected — whole-drive-from-root always, per explicit decision.)
- **Names only, v1.** Matches file/folder names (case-insensitive substring).
  NFC tag identity matching (character/game/series via the existing
  `lookupNfcTag` / AmiiboAPI cache) is an explicit phase 2 — it requires
  reading file content (UID bytes), not just directory listings, for every
  `.bin` file, which is a much heavier walk.
- **Navigate-only results.** Clicking a result exits search and opens its real
  parent folder via `browseFolder()`, selecting the file there. No
  delete/download/multi-select from the results list itself.

  Rejected alternative: full in-place actions on results (select/delete/download
  across folders without navigating). Rejected because every existing action
  handler (`doDeleteSelected` at `app.js:2752`, the download handler at
  `app.js:2057`) constructs its target path as
  `joinChildPath(state.currentPath, entry.name)` — entries carry no path of
  their own, and `state.selectedNames` is a `Set` of bare names. Supporting
  cross-folder actions would mean reworking path resolution and selection
  state throughout the File Table Event Delegation section, and would risk
  name collisions (two files named `00.bin` in different folders selected as
  one). Out of scope for v1.
- **On-demand walk, debounced live search.** No background indexing on
  connect, no separate manual "index drive" step. Typing debounces ~400ms then
  walks. Cache (`state.client.folderCache`) isn't cleared between searches
  (only on connect/upload/delete/format, same as today), so refining a query
  after the first walk is mostly cache hits.

  **Important divergence from `runSync`'s `walk()`:** sync's `walk()`
  (`app.js:3706`) intentionally *never* checks `folderCache` before calling
  `readFolder` — it wants live truth from the device to detect orphans, so a
  stale cache would be a correctness bug there. The search walk has the
  opposite goal (avoid redundant BLE reads on every keystroke), so it is
  **not** a literal reuse of sync's walk — it's the same recursive shape, but
  it checks `state.client.folderCache.get(path)` first and only calls
  `readFolder` on a cache miss. Without this check, "refining a query is
  mostly cache hits" (above) would be false and every keystroke would re-walk
  the whole drive over BLE.

## Why debounced-live is safe despite a slow, serial link

`Client`'s command queue (`client.js:687-690`) is a strict FIFO promise chain
(`this.queue = result.catch(() => {})`) — commands run one at a time, in
order, and a rejected/discarded command doesn't skip the ones already queued
behind it. A naive "debounce + walk, drop stale results" implementation would
still let every already-queued `readFolder` from a superseded walk execute to
completion before its results got thrown away, wasting BLE round trips and
device time on every keystroke.

Fix: the walk carries a `searchId` token (captured from `state.activeSearchId`
at the start of each walk — see State section below — same shape as the
existing `state.dirLoadingPath` staleness guard in `browseFolder`). Before
recursing into each subfolder, the walk checks
`searchId === state.activeSearchId`; if a newer search has started, it stops
immediately instead of continuing to enqueue more reads. This bounds the waste
from a superseded walk to at most one in-flight command, not the whole
remaining subtree.

`state.activeSearchId` is incremented in three places, not just "a newer
search starts":
1. A new debounced query fires (already covered above).
2. The user clicks a search result. Without this, clicking a result while a
   walk is still in flight would enqueue the `browseFolder()` navigation
   *behind* every remaining queued `readFolder` in the FIFO queue — the user
   would watch the folder open several seconds late, well after the click,
   because navigation has to wait its turn in line behind a walk they no
   longer care about.
3. The user exits search (Escape, close button, or clearing the query) —
   same reasoning, an abandoned walk shouldn't keep consuming the BLE queue.

## Latency mitigation: progressive rendering

Directory-read latency over BLE is not measured in this session (upload
throughput was measured at ~600-900 B/s, but that's file *writes*, a different
operation with per-chunk round trips — folder-read latency is a reasonable-but-
unverified estimate, plausible given the firmware's 20-75ms connection interval
but not something to design around as fact).

Rather than betting the design on a specific number, results render
progressively: each folder's `readFolder` resolution immediately appends any
matches to the visible results table, instead of buffering everything until
the whole walk finishes. First matches can appear after a single round trip.
A user who finds what they want early can click it immediately — the
cancellation token (above) means the rest of the walk stops being useful work
the moment that happens.

Because folder reads are async, a cancelled walk can still have one in-flight
`readFolder` promise resolve after `state.activeSearchId` has already moved on
(the recursion-time check stops it from recursing further, but doesn't
retroactively cancel a promise already in flight). The render callback itself
must also check `searchId === state.activeSearchId` before appending to
`state.searchResults`
— otherwise a stale response from an abandoned query could flash matches from
the *previous* search into the current results table.

## UI

**Trigger.** A search icon joins the existing nav-bar icon row (next to
Refresh / New folder / Upload). Available whenever connected and browsing
(`state.panelMode` is `"folder"` or `"file"`); hidden/inactive while the
upload panel is open, same as Refresh and New folder today. Clicking it
toggles an `is-searching` class on
`.selection-bar`, which:
- hides `.nav-breadcrumb`, `.mobile-folder-name`, and the other nav buttons
- shows a search input at full width

This is a CSS class toggle on the container, not nesting the input inside
`.nav-breadcrumb` — that element is `display: none` on mobile
(`styles.css:2374`), so nesting inside it would make search invisible on
small viewports.

**Conflict with an existing selection.** `.selection-bar.has-selection .sb-nav`
is already `display: none` (`styles.css:1679`) — that's how the selection
banner (`.sb-sel`) takes over the row when files are checked. If the search
icon lives inside `.sb-nav` and the user opens search while files are still
selected from browsing, `.has-selection` and `is-searching` would be active
simultaneously and the search input would be invisible (hidden by the
existing rule). Resolution: opening search clears any active folder selection
(`state.selectedNames.clear()` + `updateSelectionBar()`) before setting
`state.searchActive = true` — the two modes are mutually exclusive, so there's
no state where both banners need to coexist, and no CSS specificity override
needed.

**Icon.** The search trigger uses the `search` Material Symbol. It is not
currently in the subsetted `icon_names` list
(`index.html:1532` — verified missing between `screen_lock_portrait` and
`settings`), so per the CLAUDE.md convention it must be added there or the
button renders the literal word "search" instead of a glyph.

**Results rendering.** Search results get their own render path (e.g.
`renderSearchResults()`), not literal reuse of the existing row markup.
Reasons:
- The existing rows include a selection checkbox and `.cell-actions` buttons
  (download/delete/rename) wired to click handlers that assume
  `state.currentPath`-relative entries. Reusing that markup verbatim would
  ship live controls that do the wrong thing (or throw) when clicked from a
  cross-folder results list.
- Each result needs a path subtitle (its parent folder) since folder context
  is no longer implicit. `.cell-name-inner` (`styles.css:1507-1520`) has
  `align-items: center` and forces single-line ellipsis on its last child —
  a naive second line breaks. The subtitle needs its own flex-column wrapper:

  ```html
  <div class="cell-name-text-container">
      <span class="cell-name-title">${escapeHtml(entry.name)}</span>
      <span class="cell-name-subtitle">${escapeHtml(entry.parentPath)}</span>
  </div>
  ```

**Loading state.** A progress row renders inside the results table itself
(not `setScanText`'s target `el.uploadQueue`, which lives in the side panel
and wouldn't be visible while looking at the file table during search) —
e.g. `<tr class="search-progress-row"><td colspan="3">Scanning… (N folders
scanned)</td></tr>`, updated as the walk progresses. Progressive rendering
means real matches typically appear well before the walk finishes, so this
is mostly relevant for the "still scanning, no matches yet" state.

**Empty state.** Zero matches after the walk completes reuses the file
browser's own empty-state element, `#browserEmptyState`
(`.browser-empty-state`, `index.html:603-604`, driven by
`getBrowserEmptyStateContent`/`app.js:1830`+) — *not* `queue-empty`, which is
a different pattern scoped to the upload panel's queue (`el.uploadQueue`).
Content: "No files match '\<query\>'".

**Exit.** Clearing the query, pressing Escape, or clicking a close button
exits search: `state.searchActive = false`, `is-searching` class removed,
`renderFileTable()` re-renders the real current folder from `state.entries`
with no device access (nothing was lost — `state.entries` was never
overwritten by search).

Escape specifically must hook into the existing prioritized Escape cascade at
`app.js:1362` (`document.addEventListener("keydown", ...)`, "close surfaces
from most to least prominent": lightbox → modal stack → ...) as a new tier,
rather than registering a separate competing listener.

## State

```js
state.searchActive = false;
state.searchResults = [];    // [{ name, type, size, parentPath }]
state.activeSearchId = 0;    // cancellation token, same role as state.dirLoadingPath
```

`activeSearchId` lives on `state`, not as a module-level variable — it's the
same kind of staleness guard as the existing `state.dirLoadingPath` in
`browseFolder`, so it belongs alongside it rather than as a separate
free-floating counter.

Added alongside the existing state fields, not replacing any of them.
`state.entries`/`state.currentPath` are untouched by search — this is what
makes exiting search free.

`renderFileTable()` routes on `state.searchActive`:

```js
function renderFileTable() {
    const itemsToRender = state.searchActive ? state.searchResults : state.entries;
    // ... existing render logic, but branching to the no-checkbox/no-actions
    // row variant when state.searchActive is true
}
```

**Click delegation must branch too.** The existing `el.fileTableBody` click
listener (`app.js:2017`) resolves the clicked row's entry as
`state.entries.find((en) => en.name === name)` unconditionally, before any
other logic runs (`if (!entry) return;` is the second line of the handler).
Search results are not in `state.entries` — they're a different folder's
listing than whatever happens to be cached in `state.entries` at the moment,
so this lookup would almost always fail silently (click does nothing) rather
than merely resolving to the wrong file. The listener needs an explicit branch
at the top: when `state.searchActive`, resolve from `state.searchResults`
(matched on `name` *and* `parentPath`, since two results can share a bare
name in different folders), skip the checkbox/action-button branches
entirely, and route straight to "exit search, `browseFolder(entry.parentPath)`,
select `entry.name`" — this is also where `state.activeSearchId` gets
incremented (see cancellation section above).

For the click handler to match on `parentPath`, it has to survive from render
to click somehow — the result row's `<tr>` needs a `data-parent-path`
attribute alongside the existing `data-name` (mirrors how today's rows already
carry `data-name` per `app.js:1926`), so the click handler can read
`row.dataset.parentPath` without needing a second lookup structure.

## Error handling

- One folder's `readFolder` failure during the walk logs via
  `log(..., "err")` and does not abort sibling folders elsewhere in the tree.

  **This is deliberately more tolerant than `runSync`'s `walk()`, not a
  reuse of its behavior.** Re-checked: sync's `try/catch` (`app.js:3765-3771`)
  only wraps the top-level `walk(root)` call inside the `scanRoots` loop —
  there's no try/catch around the *recursive* `walk(entryPath)` call inside
  the function body (`app.js:3728`), so a failure anywhere in a subtree
  propagates all the way up and aborts that entire top-level root's scan
  (sync only tolerates `"Not found"` at the root level, and even then loses
  the rest of that root's subtree, not just the failing folder). Search
  needs the opposite behavior — a single unreadable folder somewhere deep in
  the tree shouldn't cost the user every match that would've been found in
  its siblings — so the search walk wraps *each* recursive call in its own
  try/catch, logging and continuing rather than letting one failure unwind
  the whole walk.
- Disconnect mid-walk is caught by the same `searchId`/connection-state check
  used for cancellation — the walk bails on its next recursive step, same
  pattern `browseFolder` already uses at its top (`state.connState !==
  "connected"` guard).
- **Disconnect must also reset search UI**, not just stop the walk:
  `setConnState("disconnected")` (`app.js:613`) needs to clear
  `state.searchActive`/`state.searchResults` and remove the `is-searching`
  class. Without this, a disconnect mid-search leaves the search input and a
  stale results table visible over a now-disconnected app — nothing else in
  `setConnState` currently touches search state since these fields don't
  exist yet.

## Out of scope (deferred)

- NFC tag identity matching (character/game/series) — phase 2, reuses
  `lookupNfcTag`'s existing cache once built.
- In-place multi-folder actions (select/delete/download across search
  results without navigating).
- Persistent/background indexing across sessions or on connect.
- Narrowing default scope to current-folder-first — considered as a latency
  mitigation, explicitly rejected in favor of progressive rendering plus the
  cancellation token.

## Testing

No test infra exists in this repo (per `CLAUDE.md`). Consistent with how the
BLE transport hardening work on this branch was validated: a Node scratchpad
harness exercises the pure logic (name matching, path collection during the
walk, cancellation-token bailout) against a stubbed `readFolder`. UI/
interaction — debounce timing, mobile layout, click-to-navigate, progressive
rendering feel — gets a manual hardware test pass.

## Review

Two rounds of review by agy (Gemini CLI) via the shared-brain delegation
system, both read-only against the code and both fully hand-verified
(line numbers, CSS rules, and behavior all checked against the actual files,
not taken on trust):

- **Round 1** (`del_59`, informal design summary): navigate-only vs. in-place
  actions, BLE queue seriality, mobile breadcrumb CSS, results row markup
  reuse, progress-row placement, state isolation. Full report at
  `.brain/search_design_review.md`.
- **Round 2** (`del_60`, final spec): caught that "mirrors sync's `walk()`"
  and "mostly cache hits" were in tension (sync's walk never checks cache by
  design), that the click delegation handler needed an explicit search
  branch, that cancellation needed to fire on result-click/exit and not just
  on a newer query, a progressive-render staleness gap, the
  `has-selection`/`is-searching` CSS conflict, missing disconnect cleanup,
  an overstated error-tolerance claim, the missing `search` icon subset
  entry, and a wrong empty-state element reference. Full report at
  `.brain/search_design_review_final.md`. Every finding checked out on
  verification; all are incorporated above.

The one claim from round 1 never independently verified: the directory-read
round-trip latency estimate (flagged as an estimate, not fact, in the
latency mitigation section) — the design deliberately doesn't depend on that
number being right.

- **Round 3** (`del_61`, verification pass): confirmed all round-2 fixes were
  correctly incorporated. Its "newly identified gaps" section mostly reviewed
  its own round-1 proposed code snippets (a separate document) rather than
  this spec, and several citations pointed at a "Proposed Code Revisions"
  section that doesn't exist in this file — those were not incorporated.
  Three findings held up on independent verification and are incorporated
  above: the existing Escape-key cascade at `app.js:1362` that search should
  hook into, `state.activeSearchId` needing an explicit declared home (now in
  the State section), and the click handler needing `parentPath` threaded
  onto the row via `data-parent-path`. Full report at
  `.brain/search_design_review_round3.md`.

## Revision: in-place actions

After v1 shipped and was used, the "Navigate-only results" decision (above)
was reversed: search results now support the same actions as normal browsing
— select, rename, delete, download, and viewing file/NFC-tag details —
without leaving the results list. Only clicking a folder result's name still
navigates (exits search, opens the folder), since that's the one action that
inherently means "go there."

**Why the original tradeoff no longer applies.** v1 avoided in-place actions
because `state.selectedNames` is a bare-name `Set` and every action
(`doDeleteSelected`, download, rename) builds its target path from
`state.currentPath` — neither concept exists for a flat, cross-folder result
list. The fix is not to make the *existing* selection/action code path-aware
(too risky, too much blast radius on already-shipped, well-tested browsing
code) but to add a **parallel, search-scoped** selection state and thread an
explicit base path through the handful of leaf functions that hard-coded
`state.currentPath`, while leaving their default (no-args) behavior for
normal browsing byte-for-byte unchanged.

**Selection state.** `state.searchSelected` is a `Set` of entry *object
references* from `state.searchResults` — not name strings, not composite
keys. Object identity sidesteps any need to invent a collision-safe key
format (a `name`+`parentPath` string would need an escape scheme for
separator collisions; object references need none) and reuses the exact
lookup (`name` + `parentPath`) the navigate-only click handler already
established.

**Selection-bar UI reuse.** No new markup or CSS. The search input already
lives inside `.sb-nav`; the existing `.selection-bar.has-selection` rule
already hides `.sb-nav` (search input included) and shows `.sb-sel` (the
count/clear/download/delete bar). Driving `.has-selection` off
`state.searchSelected.size` instead of `state.selectedNames.size` when
`state.searchActive` is true makes selecting a search result swap to the same
action bar normal browsing already uses, for free.

**Leaf-function generalization, not duplication.** Three functions that
assumed `state.currentPath`/`state.entries` gained explicit parameters
instead of being forked:
- `openRenameModal(entry, basePath, onRenamed)` — `basePath` defaults to
  `state.currentPath` (normal-mode call site passes nothing extra, behavior
  unchanged); search's call site passes `entry.parentPath` and an
  `onRenamed` callback that mutates the entry's `name` in place and
  re-renders, instead of the default post-rename `browseFolder()` navigation.
  Also: `ensureSiblingNameAvailable()`'s client-side collision pre-check only
  runs when `basePath === state.currentPath` — it depends on `state.entries`,
  which isn't necessarily the folder being renamed into when renaming from
  search; the server-side `renamePath` response is the correctness backstop
  either way, this only affects whether the client can short-circuit an
  obviously-taken name before making the call.
- `populateFileDetails(entry)` — both `joinChildPath` calls (display path,
  and the NFC-tag UID file read) switch from `state.currentPath` to
  `entry.parentPath ?? state.currentPath`. Normal entries never carry
  `parentPath`, so the fallback preserves existing behavior exactly; search
  entries always do, so this alone makes "see amiibo/file info" work
  correctly from search results with no further changes to that function.
- `setPanelState`'s row-highlight loop matches on `row.dataset.name ===
  entry.name` alone — insufficient once two results can share a name in
  different folders. Extended to also compare `(row.dataset.parentPath ??
  "") === (entry.parentPath ?? "")`, which is a no-op for normal rows (both
  sides empty string) and exact for search rows.
- The delete mechanics inside `doDeleteSelected()` (sort files-before-folders,
  per-item try/catch, toast/analytics) are extracted into a shared
  `deletePaths(paths)` taking `[{path, type, name}]`, so a new
  `doDeleteSearchResults()` reuses the same mechanics with paths built from
  `entry.parentPath` and a different post-delete refresh (remove the deleted
  entries from `state.searchResults` in place, not `browseFolder()`).

**Row markup.** Search-result rows regain the checkbox and action-button
cells v1 deliberately left empty — same markup, same `data-action` attributes
as normal rows (`rename`/`delete`/`download`), so the click-delegation
dispatch structure for action buttons is shared in shape even though the
search branch resolves paths differently.

**What still exits search.** Only navigating into a folder (clicking a
DIR-type result's name). Delete removes the affected rows from the visible
results and stays in search. Download and viewing file/NFC details never
touch navigation. Rename updates the entry in place and stays in search,
rather than jumping to the renamed file's folder the way normal-mode rename
does — consistent with "actions stay in place," and avoiding the extra
complexity `ensureSiblingNameAvailable`'s scoping already introduces.

## Revision: tag identity search (phase 2)

Designed 2026-07-19, not yet implemented. Extends search to match `.bin`
files by their NFC tag identity (character/tag series/game series, via the
existing AmiiboAPI integration) in addition to filename — the "phase 2"
explicitly deferred in the original "Names only, v1" decision above.

### Why this is opt-in, not automatic

Filename matching is drive-local and free (directory listings only).
Identity matching requires, for any `.bin` file whose UID isn't already
known from directory-listing TLV metadata, reading the file's full content
over BLE — the same cost as opening that file's details panel — multiplied
by however many untagged/uncached files exist across the whole drive. Making
this automatic on every keystroke would make even a plain filename search
pay that cost. It's a session-scoped toggle instead: off by default when
search opens, on by explicit choice.

### Two-phase walk

Phase 1 is the existing walk (`walkForSearchMatches`, `app/search.js:6`),
almost unchanged, plus one addition: it currently only ever surfaces entries
that already match the filename query, via `onMatch` — a non-matching
`.bin` file is read from the folder listing and then discarded the moment
`visit()` moves on. Phase 2 needs the *complete* list of `.bin` files across
the whole tree, matched or not, so `walkForSearchMatches` gains one more
optional callback in its `deps`: `onBinFile(entry, path)`, called for every
`FILE`-type entry whose name ends in `.bin` (case-insensitive), independent
of `onMatch` and independent of whether the query matched it. `app.js`'s
wrapper (`runSearchWalk`) uses it to build `state.searchBinFiles` — every
`.bin` file phase 1 saw, each carrying `{ name, parentPath, meta }`. `meta`
is always a real object here, never `null`/`undefined` — `readFolder`
(`client.js`) always constructs it as `{ flags, nfcTagHead, nfcTagTail }`;
only the `nfcTagHead`/`nfcTagTail` *values* can individually be `null` when
no TLV metadata was present. No optional-chaining needed on `entry.meta`
itself, only on checking whether the head/tail values are non-null.

Phase 2 only runs when the identity toggle is on, and only after phase 1
finishes:

- It processes every entry in `state.searchBinFiles` — the complete list
  from *all* visited folders, not only ones that already matched by name,
  since the point is to find files a filename search would miss entirely.
- For each `.bin` file, if `entry.meta.nfcTagHead`/`nfcTagTail` are already
  non-`null` (cached in the directory-listing TLV metadata phase 1 already
  read), no extra BLE cost — go straight to the identity check. Otherwise,
  read the file's content (`joinChildPath(entry.parentPath, entry.name)`,
  same pattern `populateFileDetails` already uses at `app.js:2656`) to
  extract the UID from bytes 84/88, same offsets `populateFileDetails`
  already decodes. The extracted UID is written back into this
  `state.searchBinFiles` entry's `meta` (mutated in place) once found, so
  toggling identity search off and back on within the same query doesn't
  re-read a file it already processed.
- Call `lookupNfcTag(head, tail)` (`app.js:1645`, existing, memoized via
  `_nfcTagCache`, `app.js:1643`) — a cache hit (common for duplicate/cloned
  tags across files) costs nothing further; a miss fetches
  `amiiboapi.org`.
- Match if the query is a case-insensitive substring of the resolved
  `name` (character), `tagSeries`, or `gameSeries` — the same three fields
  already surfaced in the file details panel (Character/Series/Game).
  Whichever of these actually matched becomes the result's displayed reason
  (see UI below).
- **If this file already has an entry in `state.searchResults`** (it also
  matched by filename in phase 1), the identity match enriches that existing
  entry in place — attaches `matchedField`/the resolved text so its subtitle
  can upgrade to show the character name — rather than pushing a second,
  duplicate row for the same file. De-duplication key is the same `name` +
  `parentPath` pair used everywhere else in search for this purpose.
- A file that fails to read, or doesn't decode as a valid tag, is silently
  skipped — not an error toast — matching how `populateFileDetails` already
  treats "Not a valid NFC file" as a neutral outcome, not a failure.

Phase 2 lives in `app/search.js` as its own function (e.g.
`enrichWithTagIdentity(files, query, deps)`), the same dependency-injected
shape as `walkForSearchMatches` — `readFileData`, `isCancelled`,
`lookupIdentity`, `onMatch` all injected, so it stays unit-testable with a
fake device and a fake identity lookup, no real BLE or network involved in
tests.

### Cancellation

Phase 2 shares the exact same `state.activeSearchId` token as phase 1 — a
new query, closing search, or disconnecting cancels it identically,
including mid-file-read (same pre-flight/post-await `isCancelled()` check
pattern `walkForSearchMatches` already uses).

Toggle-specific behavior:
- Turning the toggle **on** mid-session immediately starts phase 2 against
  whatever phase 1 already found — no need to retype the query. Folder
  listings are already warm in `folderCache`, so nothing gets re-walked;
  only the `.bin` files themselves (which were never cached, since directory
  listings and file content are different reads) get processed.
- Turning the toggle **off** mid-session cancels any in-flight phase 2 (same
  `activeSearchId` bump as any other cancellation) and removes identity-only
  matches from `state.searchResults` — filename matches are unaffected,
  since they don't depend on the toggle at all.

### UI

- **Toggle**: an icon button (`nfc` Material Symbol — needs adding to the
  `icon_names` subset, `index.html:1560` area, same mechanism as `search`
  was added for v1) between the text input and the close button, styled like
  `.btn-icon.ghost` (same 36px sizing as the close button), with a violet
  tint (`var(--violet)`, `rgba(139, 92, 246, 0.12)` background) when active
  via `[aria-pressed="true"]`. Chosen over a labeled chip after a live visual
  comparison — the bare icon matches the bar's existing all-icon convention
  and doesn't cost the limited horizontal space next to the query text.
- **Result subtitle**: a filename match keeps showing just the folder path,
  as today (`formatPathForUi(entry.parentPath)`). An identity-only match
  shows the matched field leading, folder path secondary — e.g.
  `Mario · /amiibo/data`.
- **Progress**: phase 1 keeps its existing progress row and spinning search
  icon unchanged. Phase 2 switches the progress row's text to "Checking tag
  identities… (N of M checked)" (M known once phase 1 finishes and the
  uncached-`.bin` list is final) and keeps the leading icon spinning
  throughout — so it stays visually obvious that work is still happening
  even after folder scanning visibly stops. `renderSearchResults()` needs an
  explicit signal for which phase is active to pick the right text —
  `state.searchIdentityChecked === 0` alone is ambiguous (also true before
  phase 2 has started at all) — see `state.searchIdentityScanning` below.
- **Known limitation, not addressed by this revision**: in-place actions
  (rename/delete/download) already queue behind an in-flight search walk
  today — the BLE queue is strictly serial, and only folder navigation exits
  search — so clicking an action while phase 2 is still working through a
  long list of uncached files means that action waits its turn, same as it
  already would behind a long phase-1 walk. Phase 2 can make that wait
  longer in the worst case, but doesn't introduce a new kind of problem;
  pausing/resuming an in-progress scan to prioritize a user action would be
  a real feature in its own right, out of scope here.

### State

New fields, alongside the existing search state:

```js
state.searchIdentityEnabled = false;   // toggle state, reset on enterSearchMode
state.searchBinFiles = [];             // every .bin file phase 1 saw, matched or not: { name, parentPath, meta }
state.searchIdentityScanning = false;  // true only while phase 2 is actively running
state.searchIdentityChecked = 0;       // progress counter for phase 2's "N of M"
```

`state.searchIdentityScanning` is what `renderSearchResults()` actually
branches on to choose the progress row's text (distinct from
`state.searchScanning`, which covers phase 1) — `searchIdentityChecked`
alone can't tell "phase 2 hasn't started" apart from "phase 2 just started
and hasn't found anything yet," both of which are `0`.

`state.searchBinFiles` is populated by `runSearchWalk`'s new `onBinFile`
callback during phase 1 (see "Two-phase walk" above), reset to `[]` at the
start of each new walk exactly like `state.searchResults` already is.

Existing `state.searchResults` entries gain an optional field when matched
by identity: `matchedField: "name" | "tagSeries" | "gameSeries"` (absent for
filename matches), plus the resolved text value, so `renderSearchResults()`
can build the `Mario · /amiibo/data`-style subtitle without a second
`lookupNfcTag()` call at render time.

### Out of scope

- No persistence of the toggle's on/off state across search sessions — it
  resets to off every time `enterSearchMode()` runs, consistent with how
  `searchQuery`/`searchResults`/etc. already reset there. No localStorage or
  other persistence layer exists in this app today; not introducing one for
  this.
- No cap on phase 2's scope — it processes every uncached `.bin` file found,
  however long that takes, stoppable only by cancellation (same as the rest
  of search already works). Explicitly decided over a bounded/capped
  alternative.
- No change to matching logic for non-`.bin` files — identity matching only
  ever applies to `.bin` files, since only those can carry an NFC tag UID.

### Review

Reviewed read-only by agy (Gemini CLI) via the shared-brain delegation
system (`del_63`), hand-verified against the actual code before acting on
any of it:

- All four file:line citations checked (`walkForSearchMatches`,
  `lookupNfcTag`, `_nfcTagCache`, `icon_names`) — accurate except
  `populateFileDetails`'s citation, which had drifted to `app.js:2656` since
  this doc was first written (fixed above).
- Confirmed missing `nfc` icon-subset entry (already known, noted in the UI
  section above; not yet added since this is design, not implementation).
- **Real gap, fixed**: phase 2 had no de-duplication against
  `state.searchResults` — a file matching by both filename and identity
  would have rendered as two rows. Now enriches the existing entry in place.
- **Real gap, fixed**: no explicit state to distinguish "phase 2 hasn't
  started" from "phase 2 just started" for progress-row rendering. Added
  `state.searchIdentityScanning`.
- **Real, worth doing, added**: UID backpropagation into
  `state.searchBinFiles` entries so toggling identity search off/on within
  one query doesn't re-read already-processed files.
- **Claim checked and found incorrect**: agy asserted `entry.meta` could be
  `null`/`undefined`, risking a `TypeError`. Verified against `client.js`'s
  `readFolder` — `meta` is always constructed as a real object; only its
  `nfcTagHead`/`nfcTagTail` fields can individually be `null`. No optional
  chaining needed on `entry.meta` itself. Corrected the doc's phrasing to
  make this guarantee explicit rather than adopt the incorrect premise.
- **Noted but not adopted**: caching the new toggle button in the `el`
  object — correct convention, but that's plan-level detail (the way
  `el.btnSearch` binding was never enumerated in this doc's v1 UI section
  either); not something a design doc needs to spell out.
- **Noted but not adopted**: pausing phase 2 when a mutating action starts.
  Documented instead as a known, pre-existing limitation (in-place actions
  already queue behind any in-flight walk) rather than solved — true
  pause/resume would be new scope, not implied by anything already decided.
