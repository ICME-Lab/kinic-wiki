# Kinic Wiki Clipper Usage

Usage guide for exporting recent ChatGPT/Claude conversations and active-tab evidence sources into the mainnet Kinic Wiki canister.

ChatGPT/Claude evidence-source export and active-tab evidence-source capture use Internet Identity and require writer access for the selected database.

## Prerequisites

- Chrome is logged in to ChatGPT or Claude.
- This extension is loaded as an unpacked extension.

## Build

```bash
cd extensions/wiki-clipper
npm install
cat > .env <<'EOF'
KINIC_CAPTURE_DATABASE_ID=<database-id>
EOF
npm run build
```

`KINIC_CAPTURE_DATABASE_ID` only preselects a matching database in settings. It is not used as an automatic write target.

The build creates:

- `dist/content-ui.js`
- `dist/offscreen.js`
- `dist/popup.js`
- `dist/service-worker.js`

For Chrome Web Store packaging:

```bash
npm run store-assets:generate
npm run release:listing-check
npm run release:package
```

The release package excludes source files, tests, `node_modules`, and local `.env` files. `release:check` verifies package inputs before packaging. `release:listing-check` also verifies required store image files and dimensions.

## Load in Chrome

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Select `Load unpacked`.
4. Select `extensions/wiki-clipper`.

Do not use `Pack extension` for local testing. `Pack extension` is for producing a `.crx` package and reusing a private key.
The extension has a fixed manifest key, so local unpacked installs use `chrome-extension://jcfniiflikojmbfnaoamlbbddlikchaj`. Internet Identity derives principals from `https://6emaw-iyaaa-aaaay-aacka-cai.icp0.io`; that canister also accepts the old local ID `chrome-extension://hbnicbmdodpmihmcnfgejcdgbfmemoci` and the additional Chrome extension origin `chrome-extension://moebdnadaffhlddnhifmmdoecifhcbdi`.

Normal local testing does not require changing extension IDs. Treat the old local ID and additional Chrome extension origin as allowlist/debug notes only.

## Configure

Open settings from `chrome://extensions` → Kinic Wiki Clipper → `Extension options`.

Use these extension settings:

- `Database`: select a writable active database for the logged-in Internet Identity principal

The extension fixes canister ID to `6emaw-iyaaa-aaaay-aacka-cai` and IC host to `https://icp0.io`. If no writable database exists, enter a name in settings and click `Create`. The extension never creates a database automatically. Mainnet writes require explicit confirmation before ChatGPT/Claude raw export.

Login with Internet Identity from the extension settings page and select a writable database before clicking the toolbar icon. The selected database is saved automatically. The logged-in principal must have writer access to the selected database.

## Export

1. Open `https://chatgpt.com` or `https://claude.ai`.
2. Click the page-level `Kinic Memory` button.
3. Set the recent chat count. The default is `10`.
4. Click `Export`.
5. Watch `Logs` for success or error entries.

The extension fetches ChatGPT conversation data from ChatGPT backend API endpoints and Claude conversation data from Claude private API endpoints in the current tab session. It does not open background tabs, use DOM message fallback, or use a fetch interceptor.

Those `/backend-api/*` and `claude.ai/api/.../chat_conversations/*` endpoints are private provider internals. If a provider changes the response shape, export can fail or omit messages.

Evidence sources are saved as:

```text
/Sources/chatgpt/<conversationId>.md
/Sources/claude/<conversationId>.md
```

## Active Tab Capture

1. Open any public `http` / `https` page.
2. Click the extension toolbar icon.
3. The extension captures the active tab DOM and writes `/Sources/web/<source_id>.md`.
4. The extension asks the VFS canister to authorize a 30 minute source-run ticket for the same II principal.
5. WikiBrowser checks the session ticket and configured canister id through `https://wiki.kinic.xyz/api/source/run`, then triggers the generator Worker.

Writer access is checked when the session ticket is issued. Revoking writer access does not immediately invalidate an already issued ticket before its TTL.

Non-web pages such as `chrome://extensions` are rejected.

## Verify

Confirm that `/Sources/...` is created in the selected database after successful exports.

## Generate Wiki Pages

ChatGPT/Claude export only writes source evidence. Generate wiki pages from the CLI:

```bash
cargo run -p kinic-vfs-cli --bin kinic-vfs-cli -- generate-conversation-wiki --source-path /Sources/chatgpt/<conversationId>.md
```

This command creates a wiki scaffold. Re-running it preserves existing `summary.md`, `facts.md`, `events.md`, `plans.md`, `preferences.md`, and `open_questions.md`. Use `--force` only when those pages should be regenerated.

## Known Limits

- ChatGPT and Claude private API shapes can change.
- Stopping an export can allow up to 2 in-flight conversations to finish saving.
- ChatGPT/Claude evidence-source export and active-tab source capture writes require writer access for the logged-in Internet Identity principal.
