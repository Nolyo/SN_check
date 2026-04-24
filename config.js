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
