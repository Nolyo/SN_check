// =============================================================================
// Popup - Extension interface
// =============================================================================

const statusPill = document.getElementById('status-pill');
const statusLabel = document.getElementById('status-label');
const lastCheckEl = document.getElementById('last-check');
const unassignedCountEl = document.getElementById('unassigned-count');
const primaryMetric = unassignedCountEl.closest('.metric');
const ticketsSection = document.getElementById('tickets-section');
const ticketsList = document.getElementById('tickets-list');
const ticketsCountEl = document.getElementById('tickets-count');
const emptyState = document.getElementById('empty-state');
const toggleEnabled = document.getElementById('toggle-enabled');
const btnCheck = document.getElementById('btn-check');
const btnLabel = btnCheck.querySelector('.btn-label');

// -- Helpers ------------------------------------------------------------------

function formatTime(ts) {
  if (!ts) return 'Never';
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function setStatus(enabled) {
  statusPill.classList.remove('pill--active', 'pill--inactive', 'pill--muted');
  if (enabled) {
    statusPill.classList.add('pill--active');
    statusLabel.textContent = 'Active';
  } else {
    statusPill.classList.add('pill--inactive');
    statusLabel.textContent = 'Paused';
  }
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
  ticketsCountEl.textContent = String(unassigned.length);

  const fragment = document.createDocumentFragment();
  unassigned.forEach((t) => {
    const li = document.createElement('li');
    li.className = 'ticket';

    const id = document.createElement('span');
    id.className = 'ticket-id';
    id.textContent = t.id;

    const title = document.createElement('span');
    title.className = 'ticket-title';
    title.textContent = t.title || 'No description';

    li.appendChild(id);
    li.appendChild(title);
    fragment.appendChild(li);
  });

  ticketsList.replaceChildren(fragment);
}

// -- Initial load -------------------------------------------------------------

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

    const count = data.unassignedCount || 0;
    unassignedCountEl.textContent = count;
    primaryMetric.classList.toggle('metric--alert', count > 0);
    primaryMetric.classList.toggle('metric--primary', count === 0);

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
    }, 1000);
  });
});

// -- Init ---------------------------------------------------------------------

refreshStatus();
