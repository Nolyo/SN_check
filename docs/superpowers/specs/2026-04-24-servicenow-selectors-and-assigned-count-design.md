# ServiceNow Next Experience — selector rewrite + assigned count

Date: 2026-04-24
Status: Draft — awaiting user review

## Context

The extension scrapes a ServiceNow incident list from the DOM to detect unassigned tickets. After the user activated the *Next Experience UI* on their instance, the table cells no longer expose any semantic attribute (`name=`, `data-field=`, etc.) — only a generic `td.vt`. The current implementation relies on positional selectors (`td:nth-child(3)`, `td:nth-child(5)`, …), which are fragile on two counts:

1. The new UI does not guarantee the same column order as before.
2. Each user can freely reorder, hide, or add columns on their own dashboard. A selector that works for one user breaks for their colleagues.

Sample from the new UI confirms, however, that the `<thead>` still exposes the field name on every column header via `<th name="number">`, `<th name="assigned_to">`, `<th name="short_description">`, etc. That attribute is the reliable anchor.

While we are in this file, the user also wants the popup to surface the count of *assigned* tickets, alongside the existing "unassigned" metric.

## Goals

1. Scrape tickets correctly on the Next Experience UI.
2. Make scraping resilient to any column reordering / hiding / adding on the user's own dashboard and on their colleagues' dashboards.
3. Display the number of assigned tickets in the popup, as a secondary (non-alerting) metric.
4. Fail explicitly — not silently — when a required column is missing from the user's dashboard.

## Non-goals

- Supporting ServiceNow Workspaces (Agent / Service Operations Workspace) built on `sn-*` web components. The extension targets the classic incident list rendered under `#gsft_main`.
- Replacing the polling mechanism or the message protocol.
- Changing the notification logic. Notifications still fire only on newly-appeared *unassigned* tickets.
- Supporting localized column labels or translated `(empty)` strings (the `name=` attribute is locale-independent; the `(empty)` sentinel text is what ServiceNow renders for empty references in English and is the only value we need to match).

## Architecture

No change to the overall data flow. All modifications are localized:

```
ServiceNow tab (DOM)
  → content.js   (NEW: header → field-index map, then per-field extraction)
  → background.js (CHANGED: also computes assignedCount)
  → popup.js     (CHANGED: displays assigned count under the primary metric)
```

Message protocol (`REQUEST_SCRAPE`, `TICKETS_UPDATE`, `FORCE_CHECK`, `GET_STATUS`) and polling interval (`POLL_INTERVAL_MINUTES = 5`) are untouched.

## Scraping redesign (content.js + config.js)

### Field-index map

At each scrape, before iterating rows, build a map from ServiceNow field name to column index by reading the header row:

```
thead > tr:first-child > th
```

For each `<th>`, read its `name` attribute. Record `name → index` where `index` is the position of the `<th>` among its siblings (this is also the index of the matching `<td>` in every data row, since ServiceNow uses one `<td>` per `<th>` in the same order).

The first two `<th>` elements are decorations (checkbox "Select All", preview column) and carry no `name` attribute (or a non-field name like `search`). They are simply absent from the map — that's fine, we only look up fields we need.

Example resulting map (for the current sample dashboard):

```
{
  number:            2,
  priority:          3,
  assigned_to:       4,
  short_description: 5,
  sys_updated_on:    6,
  sys_updated_by:    7,
  assignment_group:  8,
  state:             9,
  parent_incident:   10,
  u_boolean_1:       11,
  cmdb_ci:           12,
}
```

### Required vs optional fields

The extension treats fields in two tiers:

| Field | Required? | Used for |
|---|---|---|
| `number` | **required** | ticket id, deduplication, popup display |
| `assigned_to` | **required** | `isAssigned` detection, the core purpose of the extension |
| `short_description` | optional | notification body, popup title (fallback: empty string) |
| `priority` | optional | popup display (fallback: empty string) |

If either required field is missing from the map (meaning the user or a colleague has hidden that column on their dashboard), the scrape returns `{ tickets: [], error: <code> }` with:

- `error: 'MISSING_NUMBER'` — the ticket number column is not displayed
- `error: 'MISSING_ASSIGNED_TO'` — the assigned-to column is not displayed
- `error: 'NO_HEADER'` — `<thead>` not found at all (page still loading, or unexpected layout)

The current `TICKETS_UPDATE` payload becomes:

```js
{
  type: 'TICKETS_UPDATE',
  tickets: [...],     // possibly empty
  error: null | 'MISSING_NUMBER' | 'MISSING_ASSIGNED_TO' | 'NO_HEADER',
  url, timestamp,
}
```

`REQUEST_SCRAPE` response mirrors the same shape.

### Per-field extraction

For each row, look up the cell via `row.children[fieldIndex[name]]`, then extract with a field-specific helper:

- **number**: `cell.querySelector('a.linked.formlink')?.textContent.trim()` for the id, and `.href` for the URL. If no anchor, the row is skipped (malformed row).
- **assigned_to**: read `cell.textContent.trim()`. Treat as *unassigned* if the trimmed text is empty or equals `(empty)` (case-insensitive). Otherwise, the trimmed text is the assignee display name.
- **short_description**: `cell.textContent.trim()`.
- **priority**: `cell.textContent.trim()`. The decorative `div.list2_cell_background` is empty (its background colour is set via inline `style`, no text content), so `textContent` on the cell yields only the priority label like `2 - High`.

### Rows to scrape

Still `tr.list_row` inside the same frame (content script runs on all frames via `all_frames: true`; the `#gsft_main` iframe is where the list lives). The existing guard `isTopFrameWithIframe()` is unchanged.

### config.js

Current positional `SELECTORS` object is replaced by a declarative description keyed by field name:

```js
const TABLE = {
  row:         'tr.list_row',
  headerCell:  'thead > tr:first-child > th',
};

const FIELDS = {
  required: ['number', 'assigned_to'],
  optional: ['short_description', 'priority'],
};

const POLL_INTERVAL_MINUTES = 5;
```

No more `td:nth-child(...)` anywhere in the codebase.

## Assigned count (background.js + popup)

### background.js

In `processTickets`, after filtering:

```js
const unassignedTickets = tickets.filter(t => !t.isAssigned);
const assignedCount     = tickets.length - unassignedTickets.length;
```

Persist both counters plus the error code:

```js
chrome.storage.local.set({
  knownTicketIds: allIds,
  lastCheck: Date.now(),
  lastTickets: tickets,
  unassignedCount: unassignedTickets.length,
  assignedCount,
  scrapeError: error || null,
});
```

`GET_STATUS` returns those new fields alongside the existing ones.

The badge keeps tracking `unassignedCount` only — that is the alerting signal. If `scrapeError` is set, the badge shows `!` (distinct from the existing `?` used for "no ServiceNow tab open").

### popup

Layout follows option **B** from the design discussion: the unassigned count stays dominant, the assigned count is a secondary, discreet line.

Changes to `popup.html`:

- Inside `.metric.metric--primary`, add a secondary line under the big number:
  ```
  <span class="metric-sub">
    <span id="assigned-count">0</span> assigned
  </span>
  ```
- Add an error banner element (hidden by default) shown when `scrapeError` is truthy. One line of text explaining which column is missing, e.g.:
  - `MISSING_ASSIGNED_TO` → "The *Assigned to* column is not displayed on this dashboard. Add it to monitor unassigned tickets."
  - `MISSING_NUMBER` → "The *Number* column is not displayed on this dashboard."
  - `NO_HEADER` → "Could not read the dashboard. Is the incident list loaded?"

Changes to `popup.js`:

- Read `assignedCount` and `scrapeError` from `GET_STATUS`.
- Update the secondary line with `assignedCount`.
- Toggle the error banner based on `scrapeError`.

Changes to `popup.css`:

- `.metric-sub` — small, muted text (same visual weight as `.metric-value--sm`) placed directly under the primary number.
- `.alert-banner` — subdued warning style (yellow/amber accent). Must be toggled via the `hidden` HTML attribute, and the CSS rule must include `[hidden] { display: none !important; }` because author `display:` rules in this stylesheet otherwise win over the browser default for `[hidden]`.
- When `scrapeError` is set, the primary metric does **not** get the `.metric--alert` style — the unassigned count is unreliable, so showing it as an alert would be misleading. The banner carries the warning instead.

## Error handling summary

| Situation | What scrape returns | Badge | Popup |
|---|---|---|---|
| Normal, tickets found | `{tickets, error:null}` | count of unassigned | normal |
| Normal, no tickets | `{tickets:[], error:null}` | empty | "All clear" |
| Missing `assigned_to` column | `{tickets:[], error:'MISSING_ASSIGNED_TO'}` | `!` | error banner |
| Missing `number` column | `{tickets:[], error:'MISSING_NUMBER'}` | `!` | error banner |
| No `<thead>` at all | `{tickets:[], error:'NO_HEADER'}` | `!` | error banner |
| No ServiceNow tab open | (scrape never runs) | `?` | (unchanged) |

Notifications do **not** fire when `error` is set, even if `knownTicketIds` is empty — a dashboard misconfiguration must not generate spurious "new ticket" notifications.

## Testing plan

No automated tests (the project has no runner; not introducing one for this change).

Manual verification, in order:

1. Load the extension in `chrome://extensions/` (Developer mode → Load unpacked).
2. Open the ServiceNow incident list with the Next Experience UI active.
3. Confirm the popup shows a non-zero unassigned count matching the actual list (or "All clear" if none).
4. Confirm the popup shows an `N assigned` secondary line, with N matching reality.
5. Reorder two columns in the ServiceNow dashboard (drag-and-drop). Force-check: the counts must remain correct.
6. Hide the *Assigned to* column on the dashboard. Force-check: badge becomes `!`, popup shows the error banner, no notification fires.
7. Restore *Assigned to*. Counts should come back on the next tick.
8. Trigger a new unassigned ticket (or simulate it by having a colleague unassign one). Confirm the notification fires on the next poll and points to the right ticket.

Steps 5-6 are the key acceptance criteria for the robustness goal.

## Out of scope / deferred

- Translated ServiceNow UIs (French, etc.). The `name=` attributes are not localized, but the `(empty)` sentinel string may be in some locales. If that becomes a problem, the extension would need to detect empty references structurally (absence of the inner `<a class="linked">`) — deferrable.
- Moving away from DOM scraping toward the ServiceNow REST API. Out of scope for this iteration; would require per-user auth handling.
- Surfacing the assignment group or state in the popup. The scraper will not extract them, even though they are present in the HTML — YAGNI.
