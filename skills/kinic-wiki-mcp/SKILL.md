---
name: kinic-wiki-mcp
description: Call the anonymous read-only Kinic Wiki remote MCP to discover public databases, retrieve task context, search and fetch evidence, list inventory, inspect manifests, and read known VFS paths. Use when KinicWiki MCP tools are available, the user explicitly asks to use the KinicWiki ChatGPT app or MCP, or a public Kinic Wiki answer must be produced without the local CLI.
---

# Kinic Wiki MCP

Use the configured Kinic Wiki MCP for public, read-only recall.
Do not use this skill for writes, private databases, credentials, ingestion, deletion, or calendar and email work.
Use `kinic-wiki-query` instead when the task explicitly requires the local `kinic-vfs-cli`.

Read [references/tools.md](references/tools.md) before substantive MCP work.

## Workflow

1. Resolve the database.
   - If no database ID is supplied, call `find_databases`.
   - If the user supplied a `db_...` ID or public database URL, do not rediscover it.
2. Choose the narrowest read workflow.
   - Normal question: call `context` first. Omit `namespace` for whole-database `/` recall.
   - Broad recall: run one `search` → `fetch_many` round. When the user does not specify a count, fetch up to the three strongest relevant results. Add another query only when the fetched text is insufficient or the user requests exhaustive recall.
   - One known path: call `read_path`.
   - Two to ten known paths: call `read_paths`.
   - Inventory or prefix discovery: call `list`; it does not return evidence bodies.
   - Store capabilities or read policy: call `memory_manifest`.
3. Answer only from returned node text or `context` nodes and evidence.
4. Cite the exact database ID and every VFS path used as evidence. Include a public URL only when the selected workflow returns one; do not add discovery calls solely to obtain a URL.
5. State `insufficient evidence` when retrieved content does not support the claim.

## Retrieval Rules

- Treat `search` previews and `list` entries as routing metadata, not final evidence.
- For `fetch_many`, pass the exact opaque `id` or public `url` returned by `search`.
- Never pass ChatGPT citation aliases such as `turn0file0`.
- If ChatGPT hides the opaque ID, construct the public result URL from `database_id` and `metadata.path`:

```text
https://wiki.kinic.xyz/db/{database_id}{path}
```

- Do not decode or rewrite opaque `kinic-wiki:...` IDs.
- Preserve requested tool order when validating a submitted review case.
- Do not add exploratory calls when the prompt restricts the allowed tools.

## Safety and Errors

- All supported tools are anonymous and read-only.
- Reject or decline write, delete, private-access, and credential requests without calling the MCP.
- Keep item-level `fetch_many` and `read_paths` errors attached to their input reference or path.
- On a stale or invalid search reference, rerun `search` once and pass the newly returned exact ID or public URL.
- Do not infer private content from public metadata.
