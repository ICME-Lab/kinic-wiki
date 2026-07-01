# Kinic Wiki Query Workflow

## Goal

Answer questions from Kinic Wiki VFS databases through `kinic-vfs-cli`.
Use this workflow for read-only search, inspection, summarization, and answer-only tasks.

## CLI Reference

- Use `kinic-vfs-cli` for `wiki.kinic.xyz` URLs and raw database IDs.
- Run `kinic-vfs-cli --help` for the command list.
- Run `kinic-vfs-cli <command> --help` before using an unfamiliar command.
- Use `docs/CLI.md` as the full CLI usage reference when working inside this repo.

## Workflow

1. Extract the database ID from `https://wiki.kinic.xyz/db/<database_id>/...` or from the user prompt.
2. Use the mainnet default canister for `wiki.kinic.xyz`; pass `--canister-id` only for an explicitly non-default canister.
3. Start with `status --json` to confirm target and access.
4. Prefer `query-context --json` for normal questions. Answer from returned nodes and evidence, not from search hits alone.
5. Use `search-remote` for content recall and `search-path-remote` for path or basename recall.
6. Use `list-nodes` for inventory and prefix discovery; do not treat inventory output as final evidence.
7. Use `query-sql` for 2 or more known-path body reads or narrow candidate classification.
8. Use `read-node --json` for one final evidence body, exact-value confirmation, or mutation-adjacent etag capture.
9. Use `source-evidence --json` only when the exact `/Knowledge/...` path is known and source refs are needed.
10. Use snapshot/export commands only for whole-scope CLI reads or trusted snapshot sync. Check the command help before use.

## Broad Questions

- Build a candidate set before answering broad, list, comparison, classification, or corpus-synthesis questions.
- Search multiple terms: the raw user phrase, key nouns, aliases, title terms, and discovered domain terms.
- Start with `/Knowledge`. If it is sparse or misses, inspect `/Sources` and root prefixes.
- Separate title/path matches from topic-term matches before synthesis.
- Group evidence by work, source, path, and prefix.
- Mark cross-work generalization as inference.
- Preserve exact spelling, paths, IDs, titles, dates, and URLs.

## Rules

- Never run destructive or write commands in this skill.
- Do not parse `wiki.kinic.xyz` client-rendered HTML when CLI access is available.
- Do not use Kinic Memory MCP for Kinic Wiki URLs or VFS database IDs.
- Do not answer from `status`, `list-nodes`, `search-remote`, or `search-path-remote` alone.
- Escape SQL literals correctly and do not put untrusted free text into `query-sql`.
- If no candidate remains after content search, path search, and inventory fallback, answer `insufficient evidence`.

## Output

- Cite paths actually read.
- Include source URL and source path only when present in read content or metadata.
- For exact-value questions, answer the exact value first, then cite the path.
- For broad synthesis, include scope, evidence groups, confirmed points, inference, and coverage limits.
