# Kinic Wiki Clipper

MV3 Chrome extension for creating Kinic Wiki pages from the active tab and saving recent ChatGPT conversations as raw sources.

See [USAGE.md](./USAGE.md) for local canister setup and Chrome loading steps.

ChatGPT raw-source export and URL ingest use Internet Identity and require writer access for the selected database.

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
The manifest includes a fixed Chrome extension key. Local unpacked installs use `chrome-extension://jcfniiflikojmbfnaoamlbbddlikchaj`. Internet Identity uses `https://xis3j-paaaa-aaaai-axumq-cai.icp0.io` as the derivation origin, and that VFS canister allows the fixed ID, the old local ID `chrome-extension://hbnicbmdodpmihmcnfgejcdgbfmemoci`, and the additional Chrome extension origin `chrome-extension://moebdnadaffhlddnhifmmdoecifhcbdi`.
Open settings from the extension details page `Extension options`.

## Chrome Web Store release

```bash
npm run store-assets:generate
npm run release:package
```

The package is written to `extensions/wiki-clipper/release/`. Public listing copy, permission reasons, review notes, generated store assets, and the privacy policy draft live in `store-listing/`. `release:check` verifies required store image files and dimensions.
Use `https://kinic.io/privacy-policy` as the Chrome Web Store privacy policy URL only after the public page covers Wiki Clipper's ChatGPT export, active-tab URL ingest, Internet Identity auth, and selected database storage behavior.

## Flow

1. Open a ChatGPT conversation tab.
2. Select and save a database from extension settings.
3. Use the page-level `Kinic Memory` button.
4. Enter the number of recent chats to export. The default is `10`.
5. Export to `/Sources/raw/<source_id>/<source_id>.md`.

## Active Tab URL Ingest

Clicking the extension toolbar icon queues the active `http` / `https` tab URL as a wiki ingest request. If settings or Internet Identity login are missing, the extension opens the settings page.

Required settings:

- `Database`: loaded from writable hot databases for the logged-in Internet Identity principal

The active-tab flow writes `/Sources/ingest-requests/<request-id>.md` as a VFS `file`, then asks WikiBrowser to trigger the generator Worker with its server-side token.

ChatGPT export only writes raw evidence. Generate wiki pages later:

```bash
cargo run -p kinic-vfs-cli --bin kinic-vfs-cli -- generate-conversation-wiki --source-path /Sources/raw/<source_id>/<source_id>.md
```

The CLI creates a conversation wiki scaffold. Re-running it preserves hand-edited scaffold pages unless `--force` is supplied.

## Safety Notes

- Canister ID is fixed to `xis3j-paaaa-aaaai-axumq-cai`.
- IC host is fixed to `https://icp0.io`.
- Database ID is unset until explicitly saved. `KINIC_CAPTURE_DATABASE_ID` only preselects a matching settings option.
- Public manifest host permissions exclude local `localhost` and `127.0.0.1` canister hosts.
- Mainnet hosts require explicit confirmation before export.
- ChatGPT raw-source export and URL ingest writes use the logged-in Internet Identity principal and require writer access for that principal.
- URL ingest needs WikiBrowser `KINIC_WIKI_WORKER_TOKEN` configured to trigger processing.
- ChatGPT export uses private `/backend-api/*` endpoints. Endpoint shape can change without notice.
- Public release requires owner, allowlist, token, delegation, or equivalent write authorization on the canister.
