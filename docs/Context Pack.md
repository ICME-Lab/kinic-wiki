# Context Pack

Context Pack exports task-scoped Kinic Wiki context as an Open Knowledge Format (OKF) v0.1 bundle.
The output is plain Markdown with YAML frontmatter.
There is no Kinic-specific `manifest.json`, `sources.json`, or `provenance.json` in the bundle.
It is a generated handoff artifact derived from store content, not a fifth Kinic store.

## Product Concept

The Kinic stores remain the source of truth.
Context Pack is a generated OKF bundle for agent handoff, review, and portable project context.

The bundle is meant to be readable by humans, parseable by agents, and shippable as a directory, archive, or git repository.
Kinic-specific verification data lives in YAML frontmatter under the `kinic` extension key.
Bundle-level provenance lives in `okf.yaml`.

## OKF Bundle Shape

An export writes this directory shape:

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

- `index.md`: progressive disclosure entrypoint. It has no frontmatter.
- `log.md`: export history. It has no frontmatter.
- `okf.yaml`: machine-readable provenance manifest with task, namespace, budget, truncation, counts, and selected node hashes.

Concept files:

- `facts/*.md`: settled fact concepts from `facts.md` knowledge nodes.
- `decisions/*.md`: decision concepts from decision knowledge nodes.
- `tasks/*.md`: pending work from `plans.md` or `tasks.md`.
- `policies/*.md`: style, preference, and do-not-do concepts.
- `notes/*.md`: general knowledge notes that do not map to a narrower type.
- `references/*.md`: store references without target body text.

## Frontmatter

Every non-reserved `.md` file has YAML frontmatter.
The required OKF field is `type`.

Example:

```md
---
type: Decision
title: sqlite vfs
description: Generated from Kinic Wiki node /Knowledge/projects/acme/decisions/sqlite-vfs.md
resource: kinic://db_alpha/Knowledge/projects/acme/decisions/sqlite-vfs.md
tags:
- kinic
- decisions
timestamp: 2026-06-22T00:00:00Z
kinic:
  database_id: db_alpha
  root: /Knowledge/projects/acme
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

Reference concepts add `kinic.store` and `kinic.store_path`:

```md
---
type: Reference
title: source
resource: kinic://db_alpha/Sources/web/source.md
tags:
- kinic
- reference
kinic:
  database_id: db_alpha
  root: /Knowledge/projects/acme
  store: knowledge_evidence
  store_path: /Sources/web/source.md
  etag: v4h:...
  content_hash: sha256:...
  expires_at: 2026-09-22T00:00:00Z
---

# Reference

- store: `knowledge_evidence`
- store_path: `/Sources/web/source.md`
- via_path: `/Knowledge/projects/acme/facts.md`
- target_href: `/Sources/web/source.md`
- link_text: `Raw`
- etag: `v4h:...`
- updated_at: `1780000000000`
- content_hash: `sha256:...`

Referenced store content is not copied into this OKF bundle.
```

## Canonicality Rules

- `/Knowledge/...` is the organized knowledge layer.
- `/Sources/...` is the canonical raw evidence layer.
- Prefer reviewed role-page concepts over unreviewed working-note concepts for trusted agent handoff.
- Referenced store body text is not copied into `references/*.md`.
- `index.md` and `log.md` are OKF reserved files and must not carry frontmatter.
- `okf.yaml` is the verification source of truth for task scope and selected node metadata.
- Unknown frontmatter keys are allowed.
- Expired `kinic.expires_at` makes a concept invalid for trusted agent use.

## CLI

Export:

```bash
kinic-vfs-cli --database-id <database-id> context-pack export \
  --task "review auth token refresh design" \
  --namespace /Knowledge/projects/acme \
  --out ./okf \
  --expires-at 2026-09-22T00:00:00Z \
  --trust-level team-approved \
  --approved-by principal:aaaaa-aa
```

Verify and inspect:

```bash
kinic-vfs-cli context-pack verify ./okf --fail-on-truncated
kinic-vfs-cli context-pack inspect ./okf --json
```

`export` reads the remote database and writes a local OKF bundle.
`export` uses `memory_recall`; it does not recursively dump the full namespace.
`verify` and `inspect` read only the local bundle and do not require a canister connection.
Pass `--overwrite` to replace existing markdown files in the output directory.

## Verification

`context-pack verify` checks:

- every non-reserved `.md` file has parseable YAML frontmatter
- every concept has non-empty `type`
- `okf.yaml` exists and its counts, namespace, and selected node metadata match the exported files
- non-reference concepts with `kinic.content_hash` match the exported Markdown body
- `index.md` and `log.md` do not use frontmatter
- `kinic.expires_at` is in the future when present
- `references/*.md` uses `kinic.store` and `kinic.store_path`
- reference `kinic.store_path` stays under a Kinic store root such as `/Sources/<provider>`, `/Sources/sessions`, `/Sources/skill-runs`, or `/Sessions`
- reference concepts include `kinic.etag` and `kinic.content_hash`
- reference bodies use the fixed metadata-only shape
- `--fail-on-truncated` fails when `okf.yaml.truncated` is true

`context-pack inspect --json` reports:

- `okf_version`
- `task`
- `namespace`
- `budget_tokens`
- `depth`
- `truncated`
- `concept_count`
- `types`
- Kinic database ids and roots
- `expired_concept_count`
- `reference_count`

## Limits

- Context Pack is generated from memory and knowledge store content; it is not a separate canonical store.
- Skill, session, and evidence store paths may be referenced by exported knowledge, but Context Pack does not manage those stores.
- Context Pack does not define write-back, patch approval, or checkpoint APIs.
- OKF remains the bundle format; Kinic metadata stays inside `kinic` frontmatter.
