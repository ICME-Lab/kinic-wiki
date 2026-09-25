# Kinic Wiki Clipper Privacy Policy

Public URL: `https://kinic.io/privacy-policy`

Before Chrome Web Store submission, verify that the public URL contains the Wiki Clipper-specific behavior described below. The generic Kinic privacy policy is not enough for this extension listing unless it explicitly covers ChatGPT/Claude/Gemini export, active-tab source capture, Internet Identity auth, and selected database storage.

Kinic Wiki Clipper saves user-selected web page URLs and ChatGPT, Claude, and Gemini conversations into a Kinic Wiki database. The extension requires the user to authenticate with Internet Identity and choose or explicitly create a writable database before writing data.

## Data processed

- Active tab URL and page title when the user clicks the extension action.
- ChatGPT/Claude/Gemini conversation titles, URLs, message roles, and message content when the user starts export.
- The current ChatGPT question transiently when the user enables `Recall beta`; matching previews and a bounded node excerpt are returned only for the active Recall interaction.
- Internet Identity principal and delegation material needed for authenticated canister writes.
- Selected Kinic Wiki database id and temporary extension status values.
- Before a generated Wiki page is created, an excerpt of the captured source and up to 20 candidate Wiki paths and short previews are processed for relevance ranking.

## Data use

The extension uses export data to create evidence source files in the selected Kinic Wiki database. Recall data is used only for a read-only search and explicit context insertion; Recall questions and returned previews are not persisted by the extension.

## Data sharing

Data is sent to:

- the Kinic Wiki canister through `https://icp0.io`;
- `https://wiki.kinic.xyz` for Kinic Wiki web app coordination;
- Internet Identity at `https://id.ai` for authentication.
- TypeSafe's United States service for Jev relevance ranking of the source excerpt and candidate paths/previews. TypeSafe states that Input is not used for training or fine-tuning, but the service is not Zero Data Retention and may retain Input for the period needed to provide and protect the service.
- DeepSeek for generation using the source material and only the context selected after ranking.

The extension does not sell user data, use user data for advertising, or transfer user data for unrelated purposes.

## User control

Users choose the destination database and initiate each source capture or ChatGPT/Claude/Gemini export. Recall is disabled by default and can be turned off in settings. Data written to Kinic Wiki is managed through Kinic Wiki access controls and database operations.

## Contact

Use the support contact listed in the Chrome Web Store listing.
