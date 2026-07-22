// =============================================================================
// Background Service Worker
// =============================================================================

importScripts('config.js');

const ALARM_NAME = 'check-tickets';

// A frame that is not the list owner (or a frame caught mid-navigation) can
// report NO_HEADER a beat *after* the real list frame already reported success.
// Within this window, an incoming error is treated as stale and never allowed to
// clobber the fresh successful reading.
const SUCCESS_GRACE_MS = 15000;

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

// The extension can only monitor the tab that holds the incident *list*. With
// several ServiceNow tabs open (dashboard + individual tickets), picking the
// first tab blindly could reload a ticket form the user is editing and scrape
// NO_HEADER (or an empty related list) from it. isListUrl / isFormUrl live in
// config.js.
async function findListTab() {
  const tabs = await chrome.tabs.query({ url: '*://*.service-now.com/*' });
  if (tabs.length === 0) return null;

  // 1. Ground truth: the tab that actually scraped the list last time, unless
  //    it has since been navigated to a form.
  const { lastSuccessTabId } = await chrome.storage.local.get('lastSuccessTabId');
  const remembered = tabs.find((t) => t.id === lastSuccessTabId && !isFormUrl(t.url));
  if (remembered) return remembered;

  // 2. A list-looking tab (`..._list.do`), never a ticket form.
  const listLike = tabs.find((t) => isListUrl(t.url));
  if (listLike) return listLike;

  // 3. Last resort: any ServiceNow tab that isn't obviously a form.
  return tabs.find((t) => !isFormUrl(t.url)) || null;
}

async function checkTickets() {
  const { enabled } = await chrome.storage.local.get('enabled');
  if (!enabled) {
    chrome.action.setBadgeText({ text: '' });
    return;
  }

  const tab = await findListTab();
  if (!tab) {
    chrome.action.setBadgeText({ text: '?' });
    return;
  }

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
  // Preserve the last successful reading so the popup keeps showing the most
  // recent truth instead of replacing it with a misleading "0".
  if (error) {
    // Defense in depth against the multi-frame race: ignore an error that lands
    // right after a successful scrape, so a non-list frame's NO_HEADER can never
    // overwrite the real reading.
    const { lastSuccessAt = 0 } = await chrome.storage.local.get('lastSuccessAt');
    if (Date.now() - lastSuccessAt < SUCCESS_GRACE_MS) return;

    chrome.action.setBadgeText({ text: '!' });
    await chrome.storage.local.set({
      lastCheck: Date.now(),
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
  const stored = {
    knownTicketIds: allIds,
    lastCheck: Date.now(),
    lastSuccessAt: Date.now(),
    lastTickets: tickets,
    unassignedCount,
    assignedCount,
    scrapeError: null,
  };
  // Remember which tab owns the list so the periodic check targets it directly
  // instead of a ticket form that happens to be the first ServiceNow tab.
  if (tabId != null) stored.lastSuccessTabId = tabId;
  await chrome.storage.local.set(stored);
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
    // Ignore unsolicited scrapes from ticket-form tabs: a form's related list
    // can scrape "successfully" with 0 rows and clobber the real reading.
    if (!isFormUrl(_sender.url)) {
      processTickets(message.tickets || [], _sender.tab?.id, message.error || null);
    }
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
