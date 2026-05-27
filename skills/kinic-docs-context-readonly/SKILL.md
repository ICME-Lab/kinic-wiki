---
name: kinic-docs-context-readonly
description: Read official docs context from Kinic Wiki docs chunks with citation metadata; use docs source list, docs source resolve, docs source query, docs context pack, and docs cite.
---

# Kinic Docs Context Readonly

Use this skill when the user asks for official docs context, source candidates, citation-backed snippets, or an evidence pack for an LLM answer.

## Rules

- Use `kinic-vfs-cli docs ...` before low-level VFS commands.
- Treat `/Wiki/sources/...` as the only docs context tree.
- Return docs metadata as `source_id`, `title`, `citation`, `version`, `chunk_id`, and `trust`.
- Treat search scores as raw backend scores where lower values rank earlier.
- Use `docs source query` when `source_id` is known.
- Use `docs source resolve` first when `source_id` is unknown.
- Use `docs context pack` when the caller wants LLM-ready evidence.
- Use `docs cite` to verify citations from a saved evidence pack.
- Do not use `write-node`, `append-node`, `edit-node`, `multi-edit-node`, `delete-node`, `delete-tree`, or `purge-url-ingest`.

## Commands

```bash
kinic-vfs-cli docs source list --json
kinic-vfs-cli docs source resolve "next middleware" --top-k 10 --json
kinic-vfs-cli docs source query --source-id /vercel/next.js "next middleware" --version 16 --top-k 10 --max-tokens 4000 --json
kinic-vfs-cli docs context pack "next middleware" --top-sources 3 --top-k-per-source 6 --max-tokens 8000 --json
kinic-vfs-cli docs cite --input evidence-pack.json --json
```

## Fallback

If `docs` commands are unavailable, stop and report that the local CLI is too old. Do not manually compose context from raw `search-remote` results unless the user explicitly asks for a low-level investigation.
