// =============================================================================
// Popup - Extension interface
// =============================================================================

const statusEl = document.getElementById('status');
const lastCheckEl = document.getElementById('last-check');
const unassignedCountEl = document.getElementById('unassigned-count');
const ticketsSection = document.getElementById('tickets-section');
const ticketsList = document.getElementById('tickets-list');
const toggleEnabled = document.getElementById('toggle-enabled');
const btnCheck = document.getElementById('btn-check');

// -- Initial load -------------------------------------------------------------

function refreshStatus() {
  chrome.runtime.sendMessage({ type: 'GET_STATUS' }, (data) => {
    if (chrome.runtime.lastError) {
      console.warn('Service worker unavailable:', chrome.runtime.lastError.message);
      return;
    }
    if (!data) return;

    // Status
    statusEl.textContent = data.enabled ? 'Active' : 'Inactive';
    statusEl.style.color = data.enabled ? '#27ae60' : '#e74c3c';
    toggleEnabled.checked = data.enabled;

    // Last check
    if (data.lastCheck) {
      const d = new Date(data.lastCheck);
      lastCheckEl.textContent = d.toLocaleTimeString();
    } else {
      lastCheckEl.textContent = 'Never';
    }

    // Unassigned tickets count
    const count = data.unassignedCount || 0;
    unassignedCountEl.textContent = count;
    unassignedCountEl.classList.toggle('zero', count === 0);

    // Ticket list
    const tickets = data.lastTickets || [];
    const unassigned = tickets.filter((t) => !t.isAssigned);

    if (unassigned.length > 0) {
      ticketsSection.style.display = 'block';
      ticketsList.innerHTML = '';
      unassigned.forEach((t) => {
        const li = document.createElement('li');
        const idSpan = document.createElement('span');
        idSpan.className = 'ticket-id';
        idSpan.textContent = t.id;
        li.appendChild(idSpan);
        li.appendChild(document.createTextNode(' ' + t.title));
        ticketsList.appendChild(li);
      });
    } else {
      ticketsSection.style.display = 'none';
    }
  });
}

// -- Toggle activation --------------------------------------------------------

toggleEnabled.addEventListener('change', () => {
  chrome.storage.local.set({ enabled: toggleEnabled.checked }, () => {
    refreshStatus();
  });
});

// -- Check now button ---------------------------------------------------------

btnCheck.addEventListener('click', () => {
  btnCheck.disabled = true;
  btnCheck.textContent = 'Checking...';
  chrome.runtime.sendMessage({ type: 'FORCE_CHECK' }, () => {
    if (chrome.runtime.lastError) {
      console.warn('Service worker unavailable:', chrome.runtime.lastError.message);
    }
    setTimeout(() => {
      btnCheck.disabled = false;
      btnCheck.textContent = 'Check now';
      refreshStatus();
    }, 1000);
  });
});

// -- Init ---------------------------------------------------------------------

refreshStatus();
