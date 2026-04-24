# Next Experience selector rewrite + assigned count — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the ServiceNow scraping resilient to column reordering/hiding in the Next Experience UI by keying off `<th name="...">` instead of positions, and surface an "assigned" count in the popup next to the existing "unassigned" metric.

**Architecture:** The content script builds a `fieldName → columnIndex` map from the list `<thead>` at every scrape, then reads each row through that map. The background worker computes both counters, stores them plus an error code, and drives the badge. The popup shows the assigned count as a discreet secondary line under the dominant unassigned metric, and surfaces an error banner when a required column is hidden.

**Tech Stack:** Chrome Extension Manifest V3, vanilla JS/HTML/CSS. No build step, no test runner, no linter. Manual verification in Chrome after each change.

**Spec:** `docs/superpowers/specs/2026-04-24-servicenow-selectors-and-assigned-count-design.md`

**Testing note:** The project has no automated test runner. Each task ends with a manual smoke check (reload extension, open the ServiceNow tab, click the icon) rather than a `pytest`-style command. Full end-to-end verification happens in Task 7.

---

## File map

| File | Action | Responsibility after change |
|---|---|---|
| `config.js` | Modify | Declarative `TABLE` selectors + `FIELDS` (required/optional) by ServiceNow field name |
| `content.js` | Modify | Build field-index map from `<thead>`, extract each cell by field name, report error codes |
| `background.js` | Modify | Compute `assignedCount`, persist `scrapeError`, drive badge state (`!` on error), suppress notifications on error |
| `popup.html` | Modify | Add secondary "assigned" line in primary metric, add hidden error banner element |
| `popup.css` | Modify | Add `.metric-sub` and `.alert-banner` styles (`[hidden] { display: none !important }` reset already present, line 68) |
| `popup.js` | Modify | Read `assignedCount` and `scrapeError`, render the sub-line and toggle the banner, skip alert styling when scrape errored |

Task ordering follows the data flow: config → scraper → background → popup markup → popup style → popup script → manual verification.

---

## Task 1: Update `config.js` — declarative field configuration

**Files:**
- Modify: `config.js` (full rewrite, ~30 lines)

- [ ] **Step 1: Rewrite `config.js`**

Replace the entire contents of `config.js` with:

```js
// =============================================================================
// Scraping configuration for the ServiceNow incident list
// =============================================================================
// Column positions are NOT hardcoded. The extension reads column names from
// the list's <thead> at runtime so it survives any reordering / hiding /
// adding of columns by the user or their colleagues.
//
// For each <th>, ServiceNow exposes the field name via a name="..." attribute
// (e.g. name="number", name="assigned_to"). Those names drive extraction.

const TABLE = {
  row:        'tr.list_row',
  headerCell: 'thead > tr:first-child > th',
};

const FIELDS = {
  // Scrape aborts with an error code if any of these is not displayed.
  required: ['number', 'assigned_to'],
  // Missing optional fields fall back to empty strings.
  optional: ['short_description', 'priority'],
};

// Polling interval in minutes
const POLL_INTERVAL_MINUTES = 5;
```

- [ ] **Step 2: Smoke check — extension still loads**

1. Open `chrome://extensions/`
2. Click the reload icon on the ServiceNow Run Monitor card
3. Open the service worker console (link "service worker" on the extension card)

Expected: no syntax error in the console. The other files still reference old symbols (`SELECTORS`) — those errors will appear when the content script runs. They are expected at this stage and will be resolved in Task 2.

- [ ] **Step 3: Commit**

```bash
git add config.js
git commit -m "refactor(config): switch from positional to name-based field selectors"
```

---

## Task 2: Rewrite `content.js` — field-index map + per-field extraction

**Files:**
- Modify: `content.js` (full rewrite, ~95 lines)

- [ ] **Step 1: Rewrite `content.js`**

Replace the entire contents of `content.js` with:

```js
// =============================================================================
// Content Script - Scrapes the ServiceNow dashboard DOM
// =============================================================================
// With "all_frames: true" in the manifest, this script runs in every frame.
// In #gsft_main, document IS the iframe's document -> direct scrape.
//
// Strategy: build a fieldName -> column-index map from the list <thead>
// on every scrape, then read each row through that map. This makes the
// scraper immune to column reordering or to dashboard personalisations
// that add/remove unrelated columns.

function buildFieldIndex() {
  const headers = document.querySelectorAll(TABLE.headerCell);
  if (headers.length === 0) return null;

  const map = {};
  headers.forEach((th, index) => {
    const name = th.getAttribute('name');
    if (name) map[name] = index;
  });
  return map;
}

function extractNumber(cell) {
  const a = cell.querySelector('a.linked.formlink');
  if (!a) return null;
  return { id: a.textContent.trim(), url: a.href || '' };
}

function extractAssignee(cell) {
  const text = cell.textContent.trim();
  const isEmpty = text === '' || text.toLowerCase() === '(empty)';
  return {
    assignedTo: isEmpty ? '' : text,
    isAssigned: !isEmpty,
  };
}

function extractText(cell) {
  return cell.textContent.trim();
}

function scrapeTickets() {
  const fieldIndex = buildFieldIndex();
  if (!fieldIndex) return { tickets: [], error: 'NO_HEADER' };

  for (const field of FIELDS.required) {
    if (!(field in fieldIndex)) {
      return { tickets: [], error: `MISSING_${field.toUpperCase()}` };
    }
  }

  const rows = document.querySelectorAll(TABLE.row);
  const tickets = [];

  rows.forEach((row) => {
    const cells = row.children;

    const numberCell = cells[fieldIndex.number];
    const assignedCell = cells[fieldIndex.assigned_to];
    if (!numberCell || !assignedCell) return;

    const number = extractNumber(numberCell);
    if (!number) return;

    const { assignedTo, isAssigned } = extractAssignee(assignedCell);

    const titleCell = 'short_description' in fieldIndex
      ? cells[fieldIndex.short_description] : null;
    const priorityCell = 'priority' in fieldIndex
      ? cells[fieldIndex.priority] : null;

    tickets.push({
      id: number.id,
      url: number.url,
      title: titleCell ? extractText(titleCell) : '',
      assignedTo,
      isAssigned,
      priority: priorityCell ? extractText(priorityCell) : '',
    });
  });

  return { tickets, error: null };
}

// Returns true if this frame is the top frame AND it contains #gsft_main.
// In that case, we let the iframe respond instead.
function isTopFrameWithIframe() {
  return window.frameElement === null && !!document.getElementById('gsft_main');
}

function sendTicketsToBackground() {
  if (isTopFrameWithIframe()) return;

  const { tickets, error } = scrapeTickets();
  chrome.runtime.sendMessage({
    type: 'TICKETS_UPDATE',
    tickets,
    error,
    url: window.location.href,
    timestamp: Date.now(),
  });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'REQUEST_SCRAPE') {
    if (!isTopFrameWithIframe()) {
      const { tickets, error } = scrapeTickets();
      sendResponse({
        tickets,
        error,
        url: window.location.href,
        timestamp: Date.now(),
      });
    }
    return false;
  }
});

sendTicketsToBackground();
```

- [ ] **Step 2: Reload the extension**

1. `chrome://extensions/` → reload icon on the card.
2. In the ServiceNow tab (Next Experience UI, incident list visible), reload the tab (`F5`).

- [ ] **Step 3: Smoke check — content script runs without error**

1. Open DevTools on the ServiceNow tab → Console → select the `#gsft_main` iframe context.
2. Expected: no red error from `content.js` (reference to `SELECTORS` etc.).
3. In the service worker DevTools, look for an incoming message. Expected log trace: a `chrome.runtime.sendMessage` with `type: 'TICKETS_UPDATE'` and a non-empty `tickets` array (or `error: null` with tickets, or `error: 'MISSING_*'` if the dashboard is misconfigured — this validates the error path).

At this point the popup will break (it still reads old storage keys only) — fixed in Task 3.

- [ ] **Step 4: Commit**

```bash
git add content.js
git commit -m "feat(content): scrape by field name via <thead> mapping"
```

---

## Task 3: Update `background.js` — assigned count + error handling

**Files:**
- Modify: `background.js` (targeted edits in `processTickets`, `checkTickets`, and the `GET_STATUS` handler)

- [ ] **Step 1: Replace `processTickets` and update `checkTickets` call site**

Replace the existing `processTickets` function and the `try { ... }` block inside `checkTickets` with:

```js
async function checkTickets() {
  const { enabled } = await chrome.storage.local.get('enabled');
  if (!enabled) {
    chrome.action.setBadgeText({ text: '' });
    return;
  }

  const tabs = await chrome.tabs.query({ url: '*://*.service-now.com/*' });
  if (tabs.length === 0) {
    chrome.action.setBadgeText({ text: '?' });
    return;
  }

  const tab = tabs[0];

  chrome.tabs.reload(tab.id);
  await waitForTabLoad(tab.id);

  try {
    const response = await chrome.tabs.sendMessage(tab.id, { type: 'REQUEST_SCRAPE' });
    if (response) {
      await processTickets(response.tickets || [], tab.id, response.error || null);
    }
  } catch (err) {
    console.warn('Unable to contact content script:', err.message);
  }
}

async function processTickets(tickets, tabId, error = null) {
  // When scraping errored, do not update knownTicketIds (keep them for the
  // next successful tick), do not notify, and surface the error on the badge.
  if (error) {
    chrome.action.setBadgeText({ text: '!' });
    await chrome.storage.local.set({
      lastCheck: Date.now(),
      lastTickets: [],
      unassignedCount: 0,
      assignedCount: 0,
      scrapeError: error,
    });
    return;
  }

  const { knownTicketIds = [] } = await chrome.storage.local.get('knownTicketIds');

  const unassignedTickets = tickets.filter((t) => !t.isAssigned);
  const newUnassigned = unassignedTickets.filter((t) => !knownTicketIds.includes(t.id));

  const unassignedCount = unassignedTickets.length;
  const assignedCount = tickets.length - unassignedCount;

  chrome.action.setBadgeText({ text: unassignedCount > 0 ? String(unassignedCount) : '' });

  if (newUnassigned.length > 0) {
    const title = newUnassigned.length === 1
      ? `New ticket: ${newUnassigned[0].id}`
      : `${newUnassigned.length} new unassigned tickets`;

    const body = newUnassigned.length === 1
      ? newUnassigned[0].title || 'No description'
      : newUnassigned.map((t) => `${t.id}: ${t.title || '(no title)'}`).join('\n');

    chrome.notifications.create(`tickets-${Date.now()}`, {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title,
      message: body,
    });
  }

  const allIds = tickets.map((t) => t.id);
  await chrome.storage.local.set({
    knownTicketIds: allIds,
    lastCheck: Date.now(),
    lastTickets: tickets,
    unassignedCount,
    assignedCount,
    scrapeError: null,
  });
}
```

- [ ] **Step 2: Update the message listener to pass `error` and return the new storage keys**

Replace the `chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => { ... })` block at the bottom of `background.js` with:

```js
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'TICKETS_UPDATE') {
    processTickets(message.tickets || [], _sender.tab?.id, message.error || null);
  }

  if (message.type === 'FORCE_CHECK') {
    checkTickets().then(() => sendResponse({ done: true }));
    return true;
  }

  if (message.type === 'GET_STATUS') {
    chrome.storage.local.get(
      ['enabled', 'lastCheck', 'lastTickets', 'unassignedCount', 'assignedCount', 'scrapeError'],
      (data) => sendResponse(data)
    );
    return true;
  }
});
```

- [ ] **Step 3: Reload the extension and smoke-check storage**

1. `chrome://extensions/` → reload.
2. Open the service worker DevTools → Console:
   ```js
   chrome.storage.local.get(null, (d) => console.log(d));
   ```
3. Force a check: click the extension icon → "Check now".
4. Re-run the console command.

Expected: the storage now contains `assignedCount` (a number) and `scrapeError` (either `null` or one of `MISSING_NUMBER` / `MISSING_ASSIGNED_TO` / `NO_HEADER`).

- [ ] **Step 4: Commit**

```bash
git add background.js
git commit -m "feat(background): compute assignedCount and surface scrape errors"
```

---

## Task 4: Update `popup.html` — secondary line + error banner

**Files:**
- Modify: `popup.html` (two edits inside `<section class="metrics">` area)

- [ ] **Step 1: Add the assigned-count sub-line inside the primary metric**

In `popup.html`, replace:

```html
      <div class="metric metric--primary">
        <span class="metric-label">Unassigned</span>
        <span id="unassigned-count" class="metric-value">0</span>
      </div>
```

with:

```html
      <div class="metric metric--primary">
        <span class="metric-label">Unassigned</span>
        <span id="unassigned-count" class="metric-value">0</span>
        <span class="metric-sub">
          <span id="assigned-count">0</span> assigned
        </span>
      </div>
```

- [ ] **Step 2: Add the error banner right after the metrics section**

In `popup.html`, locate the closing `</section>` of the metrics block (immediately before `<section class="tickets" id="tickets-section" hidden>`). Insert **after** that closing `</section>`:

```html
    <div id="scrape-error" class="alert-banner" role="status" hidden>
      <span id="scrape-error-text"></span>
    </div>
```

The surrounding context should read:

```html
    <section class="metrics" aria-label="Status">
      ...
    </section>

    <div id="scrape-error" class="alert-banner" role="status" hidden>
      <span id="scrape-error-text"></span>
    </div>

    <section class="tickets" id="tickets-section" hidden>
      ...
```

- [ ] **Step 3: Smoke check — popup still opens without style/JS changes**

1. Reload the extension, click the icon.
2. The popup should render. The new `0 assigned` line may appear unstyled (that's fine, styling is Task 5).
3. The banner must stay hidden — both `popup.css` (line 68: `[hidden] { display: none !important; }`) and the `hidden` attribute cooperate. If it's visible, check that the `hidden` attribute is actually on the element.

- [ ] **Step 4: Commit**

```bash
git add popup.html
git commit -m "feat(popup): add assigned-count sub-line and error banner element"
```

---

## Task 5: Update `popup.css` — styles for the new elements

**Files:**
- Modify: `popup.css` (add rules; no existing rules change)

- [ ] **Step 1: Append the new rules to `popup.css`**

Append to the end of `popup.css`:

```css
/* Secondary metric line under the primary number */
.metric-sub {
  font-size: 11px;
  color: var(--text-muted);
  font-weight: 500;
  font-variant-numeric: tabular-nums;
  margin-top: 2px;
}

.metric--primary .metric-sub {
  color: var(--accent);
  opacity: 0.75;
}

.metric--alert .metric-sub {
  color: var(--danger);
  opacity: 0.85;
}

/* Scrape error banner */
.alert-banner {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 10px 12px;
  background: var(--warning-soft);
  border: 1px solid transparent;
  border-radius: var(--radius-md);
  color: var(--warning);
  font-size: 12px;
  line-height: 1.4;
}
```

No change to the existing `[hidden] { display: none !important; }` rule at line 68 — it already covers the banner.

- [ ] **Step 2: Smoke check — styling reads well in both light and dark mode**

1. Reload the extension, click the icon.
2. The sub-line `0 assigned` should sit directly under the big `0`, small and tinted with the accent colour (at ~75% opacity).
3. Toggle your OS to dark mode (or use DevTools → Rendering → "Emulate CSS media feature `prefers-color-scheme`"). The layout should still hold and colours should remain readable.
4. The banner should remain hidden because the `hidden` attribute is still set and JS hasn't removed it yet.

- [ ] **Step 3: Commit**

```bash
git add popup.css
git commit -m "style(popup): add metric-sub and alert-banner styles"
```

---

## Task 6: Update `popup.js` — wire up new elements + error handling

**Files:**
- Modify: `popup.js` (add element refs, add error-message map, update `refreshStatus`)

- [ ] **Step 1: Add element references and the error-message map**

In `popup.js`, after the existing const declarations at the top of the file (after the line `const btnLabel = btnCheck.querySelector('.btn-label');`), add:

```js
const assignedCountEl = document.getElementById('assigned-count');
const scrapeErrorEl = document.getElementById('scrape-error');
const scrapeErrorTextEl = document.getElementById('scrape-error-text');

const SCRAPE_ERROR_MESSAGES = {
  MISSING_ASSIGNED_TO: 'The "Assigned to" column is not displayed on this dashboard. Add it to monitor unassigned tickets.',
  MISSING_NUMBER:      'The "Number" column is not displayed on this dashboard.',
  NO_HEADER:           'Could not read the dashboard. Is the incident list loaded?',
};
```

- [ ] **Step 2: Replace `refreshStatus` with the error-aware version**

Replace the existing `refreshStatus` function with:

```js
function refreshStatus() {
  chrome.runtime.sendMessage({ type: 'GET_STATUS' }, (data) => {
    if (chrome.runtime.lastError) {
      console.warn('Service worker unavailable:', chrome.runtime.lastError.message);
      return;
    }
    if (!data) return;

    setStatus(data.enabled);
    toggleEnabled.checked = data.enabled;
    lastCheckEl.textContent = formatTime(data.lastCheck);

    const unassigned = data.unassignedCount || 0;
    const assigned = data.assignedCount || 0;
    unassignedCountEl.textContent = unassigned;
    assignedCountEl.textContent = assigned;

    const err = data.scrapeError;
    if (err) {
      scrapeErrorEl.hidden = false;
      scrapeErrorTextEl.textContent =
        SCRAPE_ERROR_MESSAGES[err] || 'Dashboard scraping failed.';
      // Count is unreliable when the scrape errored — do not alert-style it.
      primaryMetric.classList.remove('metric--alert');
      primaryMetric.classList.add('metric--primary');
    } else {
      scrapeErrorEl.hidden = true;
      primaryMetric.classList.toggle('metric--alert', unassigned > 0);
      primaryMetric.classList.toggle('metric--primary', unassigned === 0);
    }

    renderTickets(data.lastTickets || []);
  });
}
```

- [ ] **Step 3: Smoke check — popup shows both counters**

1. Reload the extension, open the ServiceNow tab and reload it.
2. Click the extension icon → "Check now".
3. Wait for the tab reload to finish (1-2 seconds), re-click the icon.
4. Expected: `Unassigned` shows a number, the `N assigned` line below shows the other number. `Last check` shows a fresh time.

- [ ] **Step 4: Smoke check — error banner appears when expected**

1. In the ServiceNow tab, click the column header menu for "Assigned to" → *Hide column* (or use *Personalize list* and deselect it).
2. In the popup, click "Check now".
3. After the reload, re-open the popup.
4. Expected: the banner at the top shows "The \"Assigned to\" column is not displayed on this dashboard. Add it to monitor unassigned tickets." The badge on the extension icon shows `!`. The `Unassigned` metric shows `0` without the red alert styling.
5. Restore the column (Personalize list → check "Assigned to"). Click "Check now". Banner disappears, counts return.

- [ ] **Step 5: Commit**

```bash
git add popup.js
git commit -m "feat(popup): display assigned count and scrape-error banner"
```

---

## Task 7: Full manual verification pass

**Files:** none — verification only.

Reference the spec's testing plan. These are the acceptance criteria.

- [ ] **Step 1: Clean reload of the extension**

1. `chrome://extensions/` → reload icon on the ServiceNow Run Monitor.
2. In the ServiceNow tab, hard-reload (`Ctrl+Shift+R`).

- [ ] **Step 2: Baseline scrape works on the default column layout**

1. Click the extension icon. Expected:
   - `Unassigned` shows the actual count of unassigned tickets on the dashboard.
   - `N assigned` shows the rest.
   - No error banner.
   - `Last check` is recent.
2. If `Unassigned > 0`, the tickets list appears below with the correct IDs and titles.

- [ ] **Step 3: Column reordering does not break scraping**

1. In ServiceNow, use *Personalize list* (gear icon) to reorder two or three columns (for example, move "Priority" to after "Assignment group").
2. Click the extension icon → "Check now".
3. Wait for the reload, re-open the popup.
4. Expected: counts are identical to Step 2. No error banner.

- [ ] **Step 4: Hiding the Assigned-to column surfaces the error**

1. *Personalize list* → uncheck "Assigned to" → Save.
2. Click "Check now", wait, re-open the popup.
3. Expected:
   - Banner: "The \"Assigned to\" column is not displayed on this dashboard. Add it to monitor unassigned tickets."
   - Extension badge: `!`.
   - Primary metric shows `0` without the red alert styling.
   - No Chrome notification fired during this tick (verify via the system notification centre).

- [ ] **Step 5: Restoring the column recovers the state**

1. *Personalize list* → check "Assigned to" → Save.
2. Click "Check now".
3. Expected: banner gone, counts restored, badge back to the normal count (or empty if no unassigned tickets).

- [ ] **Step 6: Notification fires on a new unassigned ticket**

1. Either wait for an unassigned ticket to appear naturally, or have a colleague unassign one on a ticket whose `assignment_group` matches the dashboard filter.
2. Within 5 minutes (next alarm tick) or on the next "Check now", expect:
   - A Chrome notification with the new ticket's ID and title.
   - The badge count increases by 1.
   - The popup's tickets list contains the new ID.

- [ ] **Step 7: Dark-mode sanity**

1. Toggle OS theme to dark (or DevTools → Rendering → `prefers-color-scheme: dark`).
2. Reopen the popup. Banner, counters, sub-line all legible.

- [ ] **Step 8: Final commit (empty, as a marker)**

If all steps passed, no further commit is needed — each task was committed. If any tweak was made during verification, commit it with an appropriate message.

---

## Done-definition checklist

- [ ] All 7 tasks' steps checked off.
- [ ] The codebase contains zero `td:nth-child(` occurrences (`git grep 'td:nth-child'` returns nothing).
- [ ] `git log --oneline` shows one commit per task (6 commits for Tasks 1–6, plus any Task 7 follow-ups).
