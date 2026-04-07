// =============================================================================
// Content Script - Scrapes the ServiceNow dashboard DOM
// =============================================================================
// With "all_frames: true" in the manifest, this script runs in every frame.
// In #gsft_main, document IS the iframe's document -> direct scrape.

function scrapeTickets() {
  const rows = document.querySelectorAll(SELECTORS.ticketRow);
  const tickets = [];

  rows.forEach((row) => {
    const idEl = row.querySelector(SELECTORS.ticketId);
    const assignedEl = row.querySelector(SELECTORS.assignedTo);
    const titleEl = row.querySelector(SELECTORS.ticketTitle);
    const priorityEl = row.querySelector(SELECTORS.ticketPriority);

    if (!idEl) return;

    // The "Assigned To" field contains an <a> link with the name if assigned,
    // or the literal text "(empty)" if unassigned
    const assignedText = assignedEl ? assignedEl.textContent.trim() : '';
    const isAssigned = assignedText !== '' && assignedText.toLowerCase() !== '(empty)';

    tickets.push({
      id: idEl.textContent.trim(),
      url: idEl.href || '',
      title: titleEl ? titleEl.textContent.trim() : '',
      assignedTo: isAssigned ? assignedText : '',
      isAssigned,
      priority: priorityEl ? priorityEl.textContent.trim() : '',
    });
  });

  return tickets;
}

// Returns true if this frame is the top frame AND it contains #gsft_main.
// In that case, we let the iframe respond instead.
function isTopFrameWithIframe() {
  return window.frameElement === null && !!document.getElementById('gsft_main');
}

function sendTicketsToBackground() {
  // Do not send from the top frame when #gsft_main exists:
  // the iframe will send its own data after loading.
  if (isTopFrameWithIframe()) return;

  const tickets = scrapeTickets();
  chrome.runtime.sendMessage({
    type: 'TICKETS_UPDATE',
    tickets,
    url: window.location.href,
    timestamp: Date.now(),
  });
}

// Listen for scrape requests from the background
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'REQUEST_SCRAPE') {
    // Only respond from the iframe (or a page without iframe).
    // Prevents the top frame from responding with an empty array
    // while #gsft_main is still loading its tickets.
    if (!isTopFrameWithIframe()) {
      const tickets = scrapeTickets();
      sendResponse({
        tickets,
        url: window.location.href,
        timestamp: Date.now(),
      });
    }
    return false;
  }
});

// Initial scrape on page load
sendTicketsToBackground();
