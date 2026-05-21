# Permission Justifications

## storage

Stores the selected database id and short-lived export or ingest status. It does not store ChatGPT conversation bodies after export completes.

## activeTab

Reads the URL and title of the active tab only after the user clicks the extension action. This is required to queue the current page for wiki ingest.

## offscreen

Runs Internet Identity and authenticated canister writes in a DOM-capable extension context.

## contextMenus

Adds an extension settings shortcut.

## Host permissions

- `https://wiki.kinic.xyz/*`: triggers URL ingest through the Kinic Wiki web app.
- `https://id.ai/*`: authenticates with Internet Identity.
- `https://chatgpt.com/*` and `https://chat.openai.com/*`: shows the ChatGPT export UI and reads conversations only when the user starts export.
- `https://icp0.io/*`: writes raw sources and ingest requests to the Kinic Wiki canister.
- `https://xis3j-paaaa-aaaai-axumq-cai.icp0.io/*`: fixed derivation origin for Internet Identity.
