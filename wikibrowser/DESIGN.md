# Wiki Canister Browser Design

## Product Positioning

Create a read-only Wiki Canister Browser UI.

The product is not a database admin UI. It should feel like a lightweight knowledge IDE:

- VS Code / Cursor-style three-pane app shell
- Notion / GitHub Docs-style readable Markdown preview
- Supabase-style metadata inspector only as a secondary right panel

## Layout

- Left sidebar: collapsible file tree for `/Wiki` and `/Sources/raw`
- Center: selected Markdown note rendered as readable document
- Right: inspector showing path, etag, updated_at, backlinks, outgoing links, note role, canonicality warnings, raw source, provenance
- Top bar: global search, path search, full-text search, mode tabs: Browse, Search, Lint, Recent

## Visual Style

- Light-first, neutral, quiet developer tool
- Warm off-white app background
- White document surface
- Subtle 1px borders
- Minimal shadows
- Blue accent only for links, focus, selected states
- Yellow/red/green only for warning/error/ok statuses
- Dense but readable spacing
- 8px spacing system
- Small monospace labels for paths, etags, hashes, source IDs

## MVP Behavior

- Read-only first
- No editing UI
- Markdown rendering
- Raw / rendered split toggle
- Search results with snippets
- Recent nodes
- Lint warnings panel
- Provenance jump from Wiki note to `/Sources/raw`

