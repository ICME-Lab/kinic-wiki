# Kinic Wiki Plugin

Obsidian desktop plugin that mirrors a Kinic FS-first canister into your vault under `Wiki/`.

## What it does

- mirrors remote `/Wiki/...` paths directly into the vault
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

Example local replica host:

```text
http://127.0.0.1:8000
```

The plugin calls these canister methods directly:

- `status`
- `read_node`
- `list_nodes`
- `write_node`
- `delete_node`
- `search_nodes`
- `export_snapshot`
- `fetch_updates`

When the host is `localhost` or `127.0.0.1`, the plugin automatically fetches the local root key before the first request.

## Candid interface

The canister interface is defined in:

```text
crates/wiki_canister/wiki.did
```

The plugin keeps its local IDL in `candid.ts`, matching the same FS-first methods.

## Manual E2E checklist

1. Start a local replica or target replica host.
2. If using the local project network, run `icp network start -d` and `icp deploy -e local`.
3. Build the plugin and place it in `<Vault>/.obsidian/plugins/kinic-wiki/`.
4. Set `Replica Host` and `Canister ID`.
5. Run `Wiki: Initial Sync`.
6. Confirm remote `/Wiki/...` paths are created directly under the configured mirror root.
7. Run `Wiki: Pull Updates` after a remote change.
8. Edit a mirrored file and run `Wiki: Push Current Note`.
9. Run `Wiki: Delete Current Wiki Page`.
10. Force a conflict and confirm `Wiki/conflicts/*.conflict.md` is created.

## Notes

- The plugin does not currently install itself into a vault automatically.
- Anonymous update calls must be allowed by the canister, otherwise push/delete will fail.
- If the Candid interface changes, `plugins/kinic-wiki/candid.ts` must be updated to match.
