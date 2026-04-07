// =============================================================================
// Background Service Worker
// =============================================================================

importScripts('config.js');

const ALARM_NAME = 'check-tickets';

// -- Initialization -----------------------------------------------------------

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: POLL_INTERVAL_MINUTES });
  chrome.action.setBadgeBackgroundColor({ color: '#e74c3c' });
  chrome.storage.local.set({ enabled: true, knownTicketIds: [], lastCheck: null });
});

// Re-create the alarm on service worker startup
chrome.alarms.get(ALARM_NAME, (alarm) => {
  if (!alarm) {
    chrome.alarms.create(ALARM_NAME, { periodInMinutes: POLL_INTERVAL_MINUTES });
  }
});

// -- Periodic alarm -----------------------------------------------------------

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    checkTickets();
  }
});

// -- Ticket check -------------------------------------------------------------

function waitForTabLoad(tabId, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, timeoutMs);

    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        // Delay to let the content script initialize in the iframe
        setTimeout(resolve, 1500);
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function checkTickets() {
  const { enabled } = await chrome.storage.local.get('enabled');
  if (!enabled) {
    chrome.action.setBadgeText({ text: '' });
    return;
  }

  // Find an open ServiceNow tab
  const tabs = await chrome.tabs.query({ url: '*://*.service-now.com/*' });
  if (tabs.length === 0) {
    chrome.action.setBadgeText({ text: '?' });
    return;
  }

  const tab = tabs[0];

  // Reload the page to get fresh data
  chrome.tabs.reload(tab.id);
  await waitForTabLoad(tab.id);

  try {
    const response = await chrome.tabs.sendMessage(tab.id, { type: 'REQUEST_SCRAPE' });
    if (response && response.tickets) {
      await processTickets(response.tickets, tab.id);
    }
  } catch (err) {
    // Content script not loaded yet or tab not accessible
    console.warn('Unable to contact content script:', err.message);
  }
}

async function processTickets(tickets, tabId) {
  const { knownTicketIds = [] } = await chrome.storage.local.get('knownTicketIds');

  const unassignedTickets = tickets.filter((t) => !t.isAssigned);
  const newUnassigned = unassignedTickets.filter((t) => !knownTicketIds.includes(t.id));

  // Update the badge
  const count = unassignedTickets.length;
  chrome.action.setBadgeText({ text: count > 0 ? String(count) : '' });

  // Notification for new unassigned tickets
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

  // Save state
  const allIds = tickets.map((t) => t.id);
  await chrome.storage.local.set({
    knownTicketIds: allIds,
    lastCheck: Date.now(),
    lastTickets: tickets,
    unassignedCount: count,
  });
}

// -- Notification click -> focus ServiceNow tab -------------------------------

chrome.notifications.onClicked.addListener(async () => {
  const tabs = await chrome.tabs.query({ url: '*://*.service-now.com/*' });
  if (tabs.length > 0) {
    chrome.tabs.update(tabs[0].id, { active: true });
    chrome.windows.update(tabs[0].windowId, { focused: true });
  }
});

// -- Messages from content script and popup -----------------------------------

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'TICKETS_UPDATE') {
    processTickets(message.tickets, _sender.tab?.id);
  }

  if (message.type === 'FORCE_CHECK') {
    checkTickets().then(() => sendResponse({ done: true }));
    return true;
  }

  if (message.type === 'GET_STATUS') {
    chrome.storage.local.get(
      ['enabled', 'lastCheck', 'lastTickets', 'unassignedCount'],
      (data) => sendResponse(data)
    );
    return true;
  }
});
