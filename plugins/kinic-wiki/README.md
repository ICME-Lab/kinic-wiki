# Kinic Wiki Plugin

Obsidian desktop plugin that mirrors a Kinic wiki canister into your vault under `Wiki/`.

## What it does

- mirrors `index.md`, `log.md`, and wiki pages into the vault
- normalizes internal links to `[[slug]]`
- supports pull, push, delete, and conflict notes
- calls the canister directly with `query` / `update`

The plugin is **desktop-only** and currently uses an **anonymous** identity.

## Local canister workflow with `icp`

This repo is configured for `icp-cli` with a single Rust canister named `wiki`.

One-time setup:

```bash
rustup target add wasm32-unknown-unknown
```

Inspect the effective project config:

```bash
icp project show
```

Run the local replica and deploy:

```bash
icp network start -d
icp deploy -e local
```

Get the local canister ID for the plugin:

```bash
icp canister status wiki -e local --id-only
```

For local Obsidian testing, use:

- `Replica Host`: `http://127.0.0.1:8000`
- `Canister ID`: output of `icp canister status wiki -e local --id-only`

## Local development

Requirements:

- Node.js 20+
- npm

Commands:

```bash
npm install
npm run check
```

Useful commands:

```bash
npm run dev
npm run build
npm run test
npm run typecheck
npm run lint
```

`npm run build` writes `main.js` next to `manifest.json` and `styles.css`, which is what Obsidian expects.

## Install into an Obsidian vault

1. Build the plugin:

```bash
npm install
npm run build
```

2. Copy this directory into your vault:

```text
<Vault>/.obsidian/plugins/kinic-wiki/
```

Required files in that directory:

- `manifest.json`
- `main.js`
- `styles.css`

3. Enable the plugin in Obsidian community plugins.

## Plugin settings

The plugin requires these settings:

- `Replica Host`
- `Canister ID`
- `Mirror root`
- `Auto pull on startup`
- `Open index after initial sync`

Example local replica host:

```text
http://127.0.0.1:8000
```

The plugin calls these canister methods directly:

- `status`
- `export_wiki_snapshot`
- `fetch_wiki_updates`
- `commit_wiki_changes`

When the host is `localhost` or `127.0.0.1`, the plugin automatically fetches the local root key before the first request.

## Candid interface

The canister interface is defined in:

```text
crates/wiki_canister/wiki.did
```

The plugin keeps its local IDL in `candid.ts`, matching the same four methods.

## Manual E2E checklist

1. Start a local replica or target replica host.
2. If using the local project network, run `icp network start -d` and `icp deploy -e local`.
3. Build the plugin and place it in `<Vault>/.obsidian/plugins/kinic-wiki/`.
4. Set `Replica Host` and `Canister ID`.
5. Run `Wiki: Initial Sync`.
6. Confirm `Wiki/index.md`, `Wiki/log.md`, and `Wiki/pages/*.md` are created.
7. Confirm `[[slug]]` links resolve and Graph View / Backlinks / Search work.
8. Run `Wiki: Pull Updates` after a remote change.
9. Edit a mirrored page and run `Wiki: Push Current Note`.
10. Run `Wiki: Delete Current Wiki Page`.
11. Force a conflict and confirm `Wiki/conflicts/*.conflict.md` is created.

## Notes

- The plugin does not currently install itself into a vault automatically.
- Anonymous update calls must be allowed by the canister, otherwise push/delete will fail.
- If the Candid interface changes, `plugins/kinic-wiki/candid.ts` must be updated to match.
