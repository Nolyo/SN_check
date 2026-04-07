# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Chrome extension (Manifest V3) that monitors a ServiceNow dashboard and notifies the user of new unassigned tickets. No build step, no external dependencies.

## Loading and Testing

1. Open `chrome://extensions/` in Chrome
2. Enable Developer mode
3. Click "Load unpacked" and select this folder
4. After each JS/HTML/CSS file change: click the reload icon on `chrome://extensions/`
5. For changes to `content.js` or `config.js`: also reload the target ServiceNow tab

There is no linter, test runner, or CI pipeline configured.

## Architecture

### Data flow

```
ServiceNow tab (DOM)
  → content.js  (scrapes tickets via CSS selectors from config.js)
  → background.js  (compares with knownTicketIds, sends notifications, updates badge)
  → popup.js  (displays status on icon click)
```

### Message protocol

| Message         | From        | To            | Purpose                              |
|----------------|-------------|---------------|--------------------------------------|
| `REQUEST_SCRAPE` | background  | content       | Trigger a scrape                     |
| `TICKETS_UPDATE` | content     | background    | Deliver scraped tickets              |
| `FORCE_CHECK`    | popup       | background    | Trigger an immediate check           |
| `GET_STATUS`     | popup       | background    | Read current state                   |

### Persisted state (`chrome.storage.local`)

- `enabled` — whether monitoring is active
- `knownTicketIds` — IDs seen in the last check (deduplication)
- `lastCheck` — timestamp of the last check
- `lastTickets` — full ticket list from the last check
- `unassignedCount` — count displayed on the badge

### DOM selectors (config.js)

The selectors are **positional** (`td:nth-child(N)`) and target `tr.list_row` rows inside the ServiceNow iframe (`#gsft_main`). Any change to the dashboard column layout will break scraping. If tickets stop appearing, check these selectors first.

### Polling

Interval defined by `POLL_INTERVAL_MINUTES = 5` (minutes) in `config.js`. Works via `chrome.alarms`. The background service worker imports `config.js` via `importScripts('config.js')`.

## Language

All code, comments, and UI text are in English. Maintain this convention.
