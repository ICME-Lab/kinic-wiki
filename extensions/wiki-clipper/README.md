# Kinic Wiki Clipper

MV3 Chrome extension for creating Kinic Wiki pages from the active tab and saving ChatGPT, Claude, and Gemini conversations as evidence sources.

See [USAGE.md](./USAGE.md) for local canister setup and Chrome loading steps.

ChatGPT/Claude/Gemini evidence-source export and active-tab evidence-source capture use Internet Identity and require writer access for the selected database.

## Build

```bash
npm install
npm run build
npm run release:check
```

Optional build-time database selection hints can be set in `extensions/wiki-clipper/.env`:

```env
KINIC_CAPTURE_DATABASE_ID=<database-id>
```

Use a writable database id. The public demo database from the root README is reader-oriented and is not a writer target.

Load `extensions/wiki-clipper` as an unpacked extension after `dist/service-worker.js`, `dist/content-ui.js`, and `dist/popup.js` exist.
The manifest includes a fixed Chrome extension key. Local unpacked installs use `chrome-extension://jcfniiflikojmbfnaoamlbbddlikchaj`. Internet Identity uses `https://6emaw-iyaaa-aaaay-aacka-cai.icp0.io` as the derivation origin, and that VFS canister allows the fixed ID, the old local ID `chrome-extension://hbnicbmdodpmihmcnfgejcdgbfmemoci`, and the additional Chrome extension origin `chrome-extension://moebdnadaffhlddnhifmmdoecifhcbdi`.
Open settings from the extension details page `Extension options`.

## Chrome Web Store release

```bash
npm run store-assets:generate
npm run release:listing-check
npm run release:package
```

The package is written to `extensions/wiki-clipper/release/`. Public listing copy, permission reasons, review notes, generated store assets, and the privacy policy draft live in `store-listing/`. `release:check` verifies package inputs. `release:listing-check` also verifies required store image files and dimensions.
Use `https://kinic.io/privacy-policy` as the Chrome Web Store privacy policy URL only after the public page covers Wiki Clipper's ChatGPT/Claude/Gemini export, active-tab capture, Internet Identity auth, and selected database storage behavior.

## Flow

1. Open a ChatGPT, Claude, or Gemini conversation tab.
2. Select a database from extension settings, or create one there if none exists.
3. Click `Save to Kinic` to save the open conversation immediately, or open save options to export multiple recent chats.
4. Multiple-chat exports use the count field, whose default is `1`.
5. Exported evidence is saved to `/Sources/<provider>/<source_id>.md`.

When `Recall beta` is enabled in extension settings, ChatGPT questions are searched against `/Knowledge` first and `/Sources` second. Up to three matching previews can appear after a question is sent. Clicking `Add context` reads the selected node and inserts a bounded citation block into the ChatGPT input without sending it. Recall does not save the question or conversation.

## Active Tab Capture

Clicking the extension toolbar icon captures the active `http` / `https` tab DOM as an evidence source, then queues generation from that source. If settings or Internet Identity login are missing, the extension opens the settings page.

Required settings:

- `Database`: loaded from writable active databases for the logged-in Internet Identity principal. If none exists, create one explicitly from settings.

The active-tab flow writes `/Sources/web/<source_id>.md` as a VFS `source`, then asks WikiBrowser to trigger generation for that source with its server-side token.

ChatGPT/Claude/Gemini export only writes source evidence. Generate wiki pages later:

```bash
cargo run -p kinic-vfs-cli --bin kinic-vfs-cli -- generate-conversation-wiki --source-path /Sources/chatgpt/<conversationId>.md
```

The CLI creates a conversation wiki scaffold. Re-running it preserves hand-edited scaffold pages unless `--force` is supplied.

## Safety Notes

- Canister ID is fixed to `6emaw-iyaaa-aaaay-aacka-cai`.
- IC host is fixed to `https://icp0.io`.
- Database ID is selected and saved automatically from writable active databases. If none exists, settings can create a new database after the user enters a name and clicks `Create`. `KINIC_CAPTURE_DATABASE_ID` only preselects a matching settings option.
- Public manifest host permissions exclude local `localhost` and `127.0.0.1` canister hosts.
- ChatGPT/Claude/Gemini evidence-source export and active-tab capture writes use the logged-in Internet Identity principal and require writer access for that principal.
- Active-tab generation needs WikiBrowser `KINIC_WIKI_WORKER_TOKEN` configured to trigger processing.
- ChatGPT export uses private `/backend-api/*` endpoints. Claude export uses private `claude.ai/api/.../chat_conversations/*` endpoints. Gemini current-chat export reads the rendered conversation DOM. Provider behavior can change without notice.
- Public release requires owner, allowlist, token, delegation, or equivalent write authorization on the canister.
