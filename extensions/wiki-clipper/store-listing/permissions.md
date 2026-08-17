# Permission Justifications

## storage

Stores the selected database id and short-lived export or ingest status. It does not store ChatGPT, Claude, or Gemini conversation bodies after export completes.

## activeTab

Reads the URL and title of the active tab only after the user clicks the extension action. This is required to queue the current page for wiki ingest.

## scripting

Captures the visible active page content only after the user clicks the extension action. This is required to create an evidence source snapshot for wiki ingest and does not run on pages without user action.

## offscreen

Runs Internet Identity and authenticated canister reads/writes in a DOM-capable extension context.

## contextMenus

Adds an extension settings shortcut.

## Host permissions

- `https://wiki.kinic.xyz/*`: opens and coordinates Kinic Wiki web app flows.
- `https://id.ai/*`: authenticates with Internet Identity.
- `https://chatgpt.com/*` and `https://chat.openai.com/*`: shows the ChatGPT export UI and, only when `Recall beta` is enabled, reads the submitted question to perform a read-only Kinic search. Conversation export still reads conversations only when the user starts export.
- `https://claude.ai/*`: shows the Claude export UI and reads conversations only when the user starts export.
- `https://gemini.google.com/*`: shows the Gemini export UI and reads the current rendered conversation only when the user starts export.
- `https://icp0.io/*`: writes evidence sources and ingest requests to the Kinic Wiki canister.
- `https://6emaw-iyaaa-aaaay-aacka-cai.icp0.io/*`: fixed derivation origin for Internet Identity.
