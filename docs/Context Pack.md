# Context Pack

Context Pack exports a Kinic Wiki scope as an Open Knowledge Format (OKF) v0.1 bundle.
The output is plain Markdown with YAML frontmatter.
There is no Kinic-specific `manifest.json`, `sources.json`, or `provenance.json` in the bundle.
It is a generated handoff artifact derived from store content, not a fifth Kinic store.

## Product Concept

The Kinic stores remain the source of truth.
Context Pack is a generated OKF bundle for agent handoff, review, and portable project context.

The bundle is meant to be readable by humans, parseable by agents, and shippable as a directory, archive, or git repository.
Kinic-specific verification data lives in YAML frontmatter under the `kinic` extension key.

## OKF Bundle Shape

An export writes this directory shape:

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

- `index.md`: progressive disclosure entrypoint. It has no frontmatter.
- `log.md`: export history. It has no frontmatter.

Concept files:

- `facts/*.md`: settled fact concepts from `facts.md` wiki nodes.
- `decisions/*.md`: decision concepts from decision wiki nodes.
- `tasks/*.md`: pending work from `plans.md` or `tasks.md`.
- `policies/*.md`: style, preference, and do-not-do concepts.
- `notes/*.md`: general wiki notes that do not map to a narrower type.
- `references/*.md`: source references without raw source body text.

## Frontmatter

Every non-reserved `.md` file has YAML frontmatter.
The required OKF field is `type`.

Example:

```md
---
type: Decision
title: sqlite vfs
description: Generated from Kinic Wiki node /Wiki/projects/acme/decisions/sqlite-vfs.md
resource: kinic://db_alpha/Wiki/projects/acme/decisions/sqlite-vfs.md
tags:
- kinic
- decisions
timestamp: 2026-06-22T00:00:00Z
kinic:
  database_id: db_alpha
  root: /Wiki/projects/acme
  etag: v4h:...
  content_hash: sha256:...
  trust_level: team-approved
  approved_by:
  - principal:aaaaa-aa
  expires_at: 2026-09-22T00:00:00Z
---

# Decision

...
```

Reference concepts add `kinic.source_path`:

```md
---
type: Reference
title: source
resource: kinic://db_alpha/Sources/raw/web/source.md
tags:
- kinic
- reference
kinic:
  database_id: db_alpha
  root: /Wiki/projects/acme
  source_path: /Sources/raw/web/source.md
  etag: v4h:...
  content_hash: sha256:...
  expires_at: 2026-09-22T00:00:00Z
---

# Reference

Raw source content is not copied into this OKF bundle.
```

## Canonicality Rules

- `/Wiki/...` is the organized knowledge layer.
- `/Sources/raw/...` is the canonical raw evidence layer.
- Prefer reviewed role-page concepts over unreviewed working-note concepts for trusted agent handoff.
- Raw source body text is not copied into `references/*.md`.
- `index.md` and `log.md` are OKF reserved files and must not carry frontmatter.
- Unknown frontmatter keys are allowed.
- Expired `kinic.expires_at` makes a concept invalid for trusted agent use.

## CLI

Export:

```bash
kinic-vfs-cli --database-id <database-id> context-pack export \
  --root /Wiki/projects/acme \
  --out ./okf \
  --expires-at 2026-09-22T00:00:00Z \
  --trust-level team-approved \
  --approved-by principal:aaaaa-aa
```

Verify and inspect:

```bash
kinic-vfs-cli context-pack verify ./okf
kinic-vfs-cli context-pack inspect ./okf --json
```

`export` reads the remote database and writes a local OKF bundle.
`verify` and `inspect` read only the local bundle and do not require a canister connection.
Pass `--overwrite` to replace existing markdown files in the output directory.

## Verification

`context-pack verify` checks:

- every non-reserved `.md` file has parseable YAML frontmatter
- every concept has non-empty `type`
- non-reference concepts with `kinic.content_hash` match the exported Markdown body
- `index.md` and `log.md` do not use frontmatter
- `kinic.expires_at` is in the future when present
- `references/*.md` uses `kinic.source_path` under `/Sources/raw/...`

`context-pack inspect --json` reports:

- `okf_version`
- `concept_count`
- `types`
- Kinic database ids and roots
- `expired_concept_count`
- `reference_count`

## Limits

- Context Pack is generated from memory and knowledge store content; it is not a separate canonical store.
- Skill and session stores may be referenced by exported knowledge, but Context Pack does not manage those stores.
- Context Pack does not define write-back, patch approval, or checkpoint APIs.
- OKF remains the bundle format; Kinic metadata stays inside `kinic` frontmatter.
