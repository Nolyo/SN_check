// =============================================================================
// DOM selector configuration for ServiceNow
// =============================================================================
// Adapted to the actual dashboard HTML (positional columns td.vt)
//
// Observed column structure:
//   td 1 : checkbox (list_decoration_cell)
//   td 2 : preview  (list_decoration_cell)
//   td 3 : Ticket number (a.linked.formlink)
//   td 4 : Priority
//   td 5 : Assigned To (a.linked with name, or empty)
//   td 6 : Short Description
//   td 7 : Updated date
//   td 8 : Caller email
//   td 9 : Assignment Group
//   td 10 : State
//   ...

const SELECTORS = {
  // Each ticket row
  ticketRow: 'tr.list_row',

  // Ticket number (3rd column, link with formlink class)
  ticketId: 'td:nth-child(3) a.linked.formlink',

  // "Assigned To" field (5th column)
  assignedTo: 'td:nth-child(5)',

  // Short description (6th column)
  ticketTitle: 'td:nth-child(6)',

  // Priority (4th column)
  ticketPriority: 'td:nth-child(4)',
};

// Polling interval in minutes
const POLL_INTERVAL_MINUTES = 5;
