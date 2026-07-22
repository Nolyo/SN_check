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

// Background-tab throttling + ServiceNow's async list render mean the <thead>
// is often absent right after document_idle. Wait for required fields to appear
// (via MutationObserver) before scraping, instead of racing against them.
function waitForRequiredHeaders(timeoutMs = 8000) {
  const ready = () => {
    const map = buildFieldIndex();
    if (!map) return false;
    return FIELDS.required.every((field) => field in map);
  };

  return new Promise((resolve) => {
    if (ready()) return resolve(true);

    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      observer.disconnect();
      clearTimeout(timer);
      resolve(ok);
    };

    const observer = new MutationObserver(() => {
      if (ready()) finish(true);
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    const timer = setTimeout(() => finish(false), timeoutMs);
  });
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

// Only one frame should scrape: the one that actually owns the incident list.
// ServiceNow injects several auxiliary same-origin iframes (user menu, notif
// panel, widgets) that also receive this content script under all_frames=true
// but have no <thead>. If we let them speak to the background, their NO_HEADER
// reply overwrites the main iframe's successful scrape.
//  - Iframe-mode layout: the list lives inside <iframe id="gsft_main">.
//  - Single-frame layout (legacy / deep links): the list lives in the top frame.
//
// IMPORTANT: this is a point-in-time test and MUST be re-checked after any wait.
// ServiceNow injects #gsft_main a beat *after* the top document's document_idle,
// so at content-script start the top shell frame sees no #gsft_main and wrongly
// believes it owns the list. It then waits, finds no <thead>, and sends
// NO_HEADER, clobbering the real list frame's success. Re-evaluating this once
// the header wait resolves fixes the race: by then #gsft_main exists and the top
// frame correctly yields.
function isScrapableFrame() {
  if (window.frameElement === null) {
    // Single-frame list layout only. A directly-opened ticket form (incident.do)
    // is also a top frame with no #gsft_main, but its related lists can scrape as
    // an empty "success" and clobber the dashboard reading -> exclude forms.
    return !document.getElementById('gsft_main') && !isFormUrl(location.href);
  }
  try {
    return window.frameElement.id === 'gsft_main';
  } catch (_) {
    return false;
  }
}

async function sendTicketsToBackground() {
  if (!isScrapableFrame()) return;

  await waitForRequiredHeaders();
  // Re-check: #gsft_main may have been injected while we waited, in which case
  // this top frame is not the list owner and must stay silent.
  if (!isScrapableFrame()) return;

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
    if (!isScrapableFrame()) return false;

    waitForRequiredHeaders().then(() => {
      // Same late re-check as the auto path: yield if #gsft_main appeared while
      // we were waiting for headers.
      if (!isScrapableFrame()) return;

      const { tickets, error } = scrapeTickets();
      sendResponse({
        tickets,
        error,
        url: window.location.href,
        timestamp: Date.now(),
      });
    });
    return true;
  }
});

sendTicketsToBackground();
