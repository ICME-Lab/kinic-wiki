# Kinic Wiki Clipper Privacy Policy

Public URL: `https://kinic.io/privacy-policy`

Kinic Wiki Clipper saves user-selected web page URLs and ChatGPT conversations into a Kinic Wiki database. The extension requires the user to authenticate with Internet Identity and choose a writable database before writing data.

## Data processed

- Active tab URL and page title when the user clicks the extension action.
- ChatGPT conversation titles, URLs, message roles, and message content when the user starts ChatGPT export.
- Internet Identity principal and delegation material needed for authenticated canister writes.
- Selected Kinic Wiki database id and temporary extension status values.

## Data use

The extension uses this data only to create raw source files or URL ingest requests in the selected Kinic Wiki database.

## Data sharing

Data is sent to:

- the Kinic Wiki canister through `https://icp0.io`;
- `https://wiki.kinic.xyz` for URL ingest trigger processing;
- Internet Identity at `https://id.ai` for authentication.

The extension does not sell user data, use user data for advertising, or transfer user data for unrelated purposes.

## User control

Users choose the destination database and initiate each URL ingest or ChatGPT export. Data written to Kinic Wiki is managed through Kinic Wiki access controls and database operations.

## Contact

Use the support contact listed in the Chrome Web Store listing.
