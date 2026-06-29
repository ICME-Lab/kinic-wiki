# Kinic Context Pack Workflow

## Goal

Export task-scoped `/Knowledge/...` context into an OKF v0.1 markdown bundle that another AI can read, then verify that the bundle is structurally valid and does not contain copied referenced store bodies.

## Workflow

1. Identify the `database_id`, task, and `/Knowledge/...` namespace to query.
2. Export the task-scoped context with `context-pack export`.
3. Verify the output directory with `context-pack verify`.
4. Inspect the bundle with `context-pack inspect` when a summary or JSON handoff record is useful.
5. Hand off the bundle only after verification passes.

## Commands

Export:

```bash
kinic-vfs-cli --database-id <db> context-pack export \
  --task "review auth token refresh design" \
  --namespace /Knowledge/projects/acme \
  --out ./okf \
  --expires-at 2026-09-22T00:00:00Z \
  --trust-level team-approved \
  --approved-by principal:aaaaa-aa
```

Verify:

```bash
kinic-vfs-cli context-pack verify ./okf --fail-on-truncated
```

Inspect:

```bash
kinic-vfs-cli context-pack inspect ./okf --json
```

## OKF Shape

Expected bundle shape:

```text
index.md
log.md
okf.yaml
facts/*.md
decisions/*.md
tasks/*.md
policies/*.md
notes/*.md
references/*.md
```

Reserved files:

- `index.md`: progressive-disclosure entrypoint; no frontmatter
- `log.md`: export history; no frontmatter
- `okf.yaml`: machine-readable provenance manifest with task, namespace, budget, truncation, counts, and selected node hashes

Concept files:

- every non-reserved `.md` file has YAML frontmatter
- `type` is required and non-empty
- Kinic-specific data lives under the `kinic:` frontmatter extension
- `okf.yaml` is the source of truth for task scope and selected node metadata

Directory meaning:

- `facts/*.md`: settled fact concepts from fact-like knowledge nodes
- `decisions/*.md`: decision concepts
- `tasks/*.md`: task or plan concepts
- `policies/*.md`: style, preference, and do-not-do concepts
- `notes/*.md`: unclassified knowledge nodes that are still normal OKF concepts
- `references/*.md`: store reference concepts only; `kinic.store` and `kinic.store_path` must identify a supported Kinic store path, with `kinic.etag` and `kinic.content_hash`

## Rules

- Do not export from `/Sources/...` as the namespace.
- Do not copy referenced store body text into `references/*.md`.
- Do not hand off a bundle with `truncated: true` unless the recipient explicitly accepts incomplete context.
- Do not use `references/*.md` for ordinary knowledge notes.
- Do not treat a passed `inspect` summary as verification; run `verify`.
- Do not use this skill to mutate the wiki.
- If `verify` reports an expired `kinic.expires_at`, re-export from the source wiki instead of extending the local bundle by hand.

## Output

For handoff, include:

- bundle path
- exported task and knowledge namespace
- verification result
- inspect summary when requested
- any verification failure that blocks AI handoff
