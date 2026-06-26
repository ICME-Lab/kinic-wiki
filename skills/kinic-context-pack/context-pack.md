# Kinic Context Pack Workflow

## Goal

Export a selected `/Wiki/...` scope into an OKF v0.1 markdown bundle that another AI can read, then verify that the bundle is structurally valid and does not contain copied evidence source bodies.

## Workflow

1. Identify the `database_id` and the `/Wiki/...` root to export.
2. Export the scope with `context-pack export`.
3. Verify the output directory with `context-pack verify`.
4. Inspect the bundle with `context-pack inspect` when a summary or JSON handoff record is useful.
5. Hand off the bundle only after verification passes.

## Commands

Export:

```bash
kinic-vfs-cli --database-id <db> context-pack export \
  --root /Wiki/projects/acme \
  --out ./okf \
  --expires-at 2026-09-22T00:00:00Z \
  --trust-level team-approved \
  --approved-by principal:aaaaa-aa
```

Verify:

```bash
kinic-vfs-cli context-pack verify ./okf
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

Concept files:

- every non-reserved `.md` file has YAML frontmatter
- `type` is required and non-empty
- Kinic-specific data lives under the `kinic:` frontmatter extension

Directory meaning:

- `facts/*.md`: settled fact concepts from fact-like wiki nodes
- `decisions/*.md`: decision concepts
- `tasks/*.md`: task or plan concepts
- `policies/*.md`: style, preference, and do-not-do concepts
- `notes/*.md`: unclassified wiki nodes that are still normal OKF concepts
- `references/*.md`: source reference concepts only; `kinic.source_path` must point under `/Sources/evidence/...`

## Rules

- Do not export from `/Sources/evidence/...` as the root.
- Do not copy evidence source body text into `references/*.md`.
- Do not use `references/*.md` for ordinary wiki notes.
- Do not treat a passed `inspect` summary as verification; run `verify`.
- Do not use this skill to mutate the wiki.
- If `verify` reports an expired `kinic.expires_at`, re-export from the source wiki instead of extending the local bundle by hand.

## Output

For handoff, include:

- bundle path
- exported wiki root
- verification result
- inspect summary when requested
- any verification failure that blocks AI handoff
