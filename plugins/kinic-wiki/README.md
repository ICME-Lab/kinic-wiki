# Kinic Wiki Plugin

Obsidian desktop plugin that mirrors the Kinic-backed wiki into your vault under `Wiki/`.

## What it does

- mirrors `index.md`, `log.md`, and wiki pages into the vault
- normalizes internal links to `[[slug]]`
- supports pull, push, delete, and conflict notes
- relies on the existing wiki HTTP adapter, not direct canister calls

The plugin is **desktop-only**.

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

- `Adapter base URL`
- `Mirror root`
- `Auto pull on startup`
- `Open index after initial sync`

`Adapter base URL` is the base URL for the local HTTP adapter. Example:

```text
http://127.0.0.1:8787
```

The plugin will call:

- `POST /export_wiki_snapshot`
- `POST /fetch_wiki_updates`
- `POST /commit_wiki_changes`
- `GET /status`

## HTTP adapter contract

The plugin expects a thin JSON adapter whose routes exactly match the runtime DTOs.

## Run the local HTTP adapter

From the repo root:

```bash
cargo run -p wiki-http-adapter -- --db-path /absolute/path/to/wiki.sqlite3 --bind 127.0.0.1:8787
```

The adapter runs migrations on startup and only needs a SQLite DB path.

### `POST /export_wiki_snapshot`

Request:

```json
{
  "include_system_pages": true,
  "page_slugs": null
}
```

Response shape:

```json
{
  "snapshot_revision": "string",
  "pages": [
    {
      "page_id": "string",
      "slug": "string",
      "title": "string",
      "page_type": "entity",
      "revision_id": "string",
      "updated_at": 1700000000,
      "markdown": "string",
      "section_hashes": [
        { "section_path": "string", "content_hash": "string" }
      ]
    }
  ],
  "system_pages": [
    {
      "slug": "index.md",
      "markdown": "string",
      "updated_at": 1700000000,
      "etag": "string"
    }
  ]
}
```

### `POST /fetch_wiki_updates`

Request:

```json
{
  "known_snapshot_revision": "string",
  "known_page_revisions": [
    { "page_id": "string", "revision_id": "string" }
  ],
  "include_system_pages": true
}
```

Response shape:

```json
{
  "snapshot_revision": "string",
  "changed_pages": [],
  "removed_page_ids": [],
  "system_pages": [],
  "manifest_delta": {
    "upserted_pages": [
      {
        "page_id": "string",
        "slug": "string",
        "revision_id": "string",
        "updated_at": 1700000000
      }
    ],
    "removed_page_ids": []
  }
}
```

### `POST /commit_wiki_changes`

Request:

```json
{
  "base_snapshot_revision": "string",
  "page_changes": [
    {
      "change_type": "Update",
      "page_id": "string",
      "base_revision_id": "string",
      "new_markdown": "string"
    }
  ]
}
```

Delete request example:

```json
{
  "base_snapshot_revision": "string",
  "page_changes": [
    {
      "change_type": "Delete",
      "page_id": "string",
      "base_revision_id": "string",
      "new_markdown": null
    }
  ]
}
```

Response shape:

```json
{
  "committed_pages": [
    {
      "page_id": "string",
      "revision_id": "string",
      "section_hashes": []
    }
  ],
  "rejected_pages": [
    {
      "page_id": "string",
      "reason": "string",
      "conflicting_section_paths": [],
      "local_changed_section_paths": [],
      "remote_changed_section_paths": [],
      "conflict_markdown": "<<<<<<< LOCAL\n..."
    }
  ],
  "snapshot_revision": "string",
  "snapshot_was_stale": false,
  "system_pages": [],
  "manifest_delta": {
    "upserted_pages": [],
    "removed_page_ids": []
  }
}
```

### `GET /status`

Response:

```json
{
  "page_count": 1,
  "source_count": 2,
  "system_page_count": 2
}
```

## Notes

- The plugin does not currently install itself into a vault automatically.
- The HTTP adapter must expose these routes with JSON payloads matching the runtime DTOs.
- If the adapter changes route names or wire format, `client.ts` must be updated to match.

## Manual E2E checklist

1. Start the HTTP adapter.
2. Build the plugin and place it in `<Vault>/.obsidian/plugins/kinic-wiki/`.
3. Set `Adapter base URL` to `http://127.0.0.1:8787`.
4. Run `Wiki: Initial Sync`.
5. Confirm `Wiki/index.md`, `Wiki/log.md`, and `Wiki/pages/*.md` are created.
6. Confirm `[[slug]]` links resolve and Graph View / Backlinks / Search work.
7. Run `Wiki: Pull Updates` after a remote change.
8. Edit a mirrored page and run `Wiki: Push Current Note`.
9. Run `Wiki: Delete Current Wiki Page`.
10. Force a conflict and confirm `Wiki/conflicts/*.conflict.md` is created.
