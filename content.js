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
