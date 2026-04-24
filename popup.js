// =============================================================================
// Popup - Extension interface
// =============================================================================

const app               = document.querySelector('.app');
const statusPill        = document.getElementById('status-pill');
const statusLabel       = document.getElementById('status-label');
const lastCheckEl       = document.getElementById('last-check');
const unassignedCountEl = document.getElementById('unassigned-count');
const ticketsSection    = document.getElementById('tickets-section');
const ticketsList       = document.getElementById('tickets-list');
const ticketsCountEl    = document.getElementById('tickets-count');
const emptyState        = document.getElementById('empty-state');
const toggleEnabled     = document.getElementById('toggle-enabled');
const btnCheck          = document.getElementById('btn-check');
const btnLabel          = btnCheck.querySelector('.btn-label');
const assignedCountEl   = document.getElementById('assigned-count');
const scrapeErrorEl     = document.getElementById('scrape-error');
const scrapeErrorTextEl = document.getElementById('scrape-error-text');
const sparkEl           = document.getElementById('spark');

const SCRAPE_ERROR_MESSAGES = {
  MISSING_ASSIGNED_TO: 'The "Assigned to" column is not displayed on this dashboard. Add it to monitor unassigned tickets.',
  MISSING_NUMBER:      'The "Number" column is not displayed on this dashboard.',
  NO_HEADER:           'Could not read the dashboard. Is the incident list loaded?',
};

const SPARK_LEN = 12;
let sparkHistory = [];

// -- Helpers ------------------------------------------------------------------

function formatTime(ts) {
  if (!ts) return '--:--:--';
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function setStatus(enabled) {
  statusPill.classList.toggle('pill--inactive', !enabled);
  statusLabel.textContent = enabled ? 'Live' : 'Paused';
}

function setAlertState(unassigned, hasError) {
  app.dataset.state = (!hasError && unassigned > 0) ? 'alert' : 'clear';
}

function renderSpark(history) {
  sparkEl.innerHTML = '';
  const max = Math.max(1, ...history);
  const padded = [...Array(Math.max(0, SPARK_LEN - history.length)).fill(0), ...history].slice(-SPARK_LEN);
  padded.forEach((v, i) => {
    const bar = document.createElement('div');
    bar.className = 'spark-bar' + (i === padded.length - 1 ? ' is-last' : '');
    const h = Math.max(6, (v / max) * 100);
    bar.style.height = `${h}%`;
    sparkEl.appendChild(bar);
  });
}

function pushSpark(value) {
  sparkHistory.push(value);
  if (sparkHistory.length > SPARK_LEN) sparkHistory = sparkHistory.slice(-SPARK_LEN);
  chrome.storage.local.set({ sparkHistory });
  renderSpark(sparkHistory);
}

function ticketUrl(t) {
  if (t.url) return t.url;
  return `https://service-now.com/now/nav/ui/classic/params/target/incident.do%3Fsysparm_query%3Dnumber%3D${encodeURIComponent(t.id)}`;
}

function priorityOf(t) {
  const p = parseInt(t.priority, 10);
  return Number.isFinite(p) && p >= 1 && p <= 4 ? p : 4;
}

function ageOf(t) {
  if (t.age) return t.age;
  if (!t.openedAt) return '';
  const mins = Math.floor((Date.now() - t.openedAt) / 60000);
  if (mins < 1)  return 'now';
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  if (h < 24)    return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function renderTickets(tickets) {
  const unassigned = tickets.filter((t) => !t.isAssigned);

  if (unassigned.length === 0) {
    ticketsSection.hidden = true;
    emptyState.hidden = false;
    return;
  }

  emptyState.hidden = true;
  ticketsSection.hidden = false;
  ticketsCountEl.textContent = String(unassigned.length).padStart(2, '0');

  const fragment = document.createDocumentFragment();
  unassigned.forEach((t) => {
    const li = document.createElement('li');

    const a = document.createElement('a');
    a.className = 'ticket';
    a.href = ticketUrl(t);
    a.target = '_blank';
    a.rel = 'noopener';
    a.addEventListener('click', (e) => {
      e.preventDefault();
      chrome.tabs.create({ url: a.href });
    });

    const dot = document.createElement('span');
    dot.className = 'prio-dot';
    dot.dataset.prio = String(priorityOf(t));
    dot.title = `Priority ${priorityOf(t)}`;

    const id = document.createElement('span');
    id.className = 'ticket-id';
    id.textContent = t.id;

    const title = document.createElement('span');
    title.className = 'ticket-title';
    title.textContent = t.title || 'No description';

    const age = document.createElement('span');
    age.className = 'ticket-age';
    age.textContent = ageOf(t);

    a.append(dot, id, title, age);
    li.appendChild(a);
    fragment.appendChild(li);
  });

  ticketsList.replaceChildren(fragment);
}

// -- Initial load -------------------------------------------------------------

function refreshStatus() {
  chrome.storage.local.get(['sparkHistory'], ({ sparkHistory: saved }) => {
    sparkHistory = Array.isArray(saved) ? saved.slice(-SPARK_LEN) : [];
    renderSpark(sparkHistory);
  });

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
    const assigned   = data.assignedCount || 0;
    unassignedCountEl.textContent = String(unassigned).padStart(2, '0');
    assignedCountEl.textContent   = assigned;

    const err = data.scrapeError;
    if (err) {
      scrapeErrorEl.hidden = false;
      scrapeErrorTextEl.textContent =
        SCRAPE_ERROR_MESSAGES[err] || 'Dashboard scraping failed.';
    } else {
      scrapeErrorEl.hidden = true;
    }

    setAlertState(unassigned, !!err);
    renderTickets(data.lastTickets || []);
  });
}

// -- Toggle activation --------------------------------------------------------

toggleEnabled.addEventListener('change', () => {
  chrome.storage.local.set({ enabled: toggleEnabled.checked }, refreshStatus);
});

// -- Check now button ---------------------------------------------------------

btnCheck.addEventListener('click', () => {
  btnCheck.disabled = true;
  btnLabel.textContent = 'Checking…';
  chrome.runtime.sendMessage({ type: 'FORCE_CHECK' }, () => {
    if (chrome.runtime.lastError) {
      console.warn('Service worker unavailable:', chrome.runtime.lastError.message);
    }
    setTimeout(() => {
      btnCheck.disabled = false;
      btnLabel.textContent = 'Check now';
      refreshStatus();
      chrome.runtime.sendMessage({ type: 'GET_STATUS' }, (data) => {
        if (data) pushSpark(data.unassignedCount || 0);
      });
    }, 1000);
  });
});

// -- Init ---------------------------------------------------------------------

refreshStatus();
