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

// ServiceNow's Next Experience wraps every screen under /now/nav/..., so the URL
// path alone doesn't tell a list from a ticket. The reliable discriminator is
// the classic target embedded in the URL:
//   - list -> `..._list.do`   (e.g. incident_list.do)
//   - form -> `<table>.do`    (e.g. incident.do)
// Used to keep ticket-form tabs from being scraped or monitored as if they were
// the incident list.
function isListUrl(url) { return /_list\.do/i.test(url || ''); }
function isFormUrl(url) { return /\.do/i.test(url || '') && !isListUrl(url); }
