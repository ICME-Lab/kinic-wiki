---
name: kinic-context-pack
description: Kinic workflow skill for exporting /Wiki scopes as OKF v0.1 Context Pack markdown bundles, then verifying and inspecting those bundles before portable AI handoff.
---

# Kinic Context Pack

Use this skill when the user wants to:

- export a `/Wiki/...` scope as an OKF v0.1 markdown bundle
- verify or inspect a local OKF Context Pack bundle
- prepare portable context for another AI client or agent
- confirm that raw source body text is not copied into the bundle

Do not use this skill for:

- answering questions against the live wiki; use `kinic-wiki-query`
- ingesting new source material; use `kinic-wiki-ingest`
- repairing live wiki pages; use `kinic-wiki-edit`
- general wiki health review; use `kinic-wiki-lint`
- skill store package lifecycle work; use `kinic-skill-registry`

Core rules:

- Treat the canister-backed VFS as the source of truth.
- Export only from `/Wiki/...`.
- Output OKF markdown only. Do not expect Kinic `manifest.json`, `sources.json`, or `provenance.json`.
- Keep `index.md` and `log.md` as reserved OKF files without frontmatter.
- Require YAML frontmatter with a non-empty `type` for every non-reserved `.md` file.
- Treat `notes/*.md` as unclassified wiki notes.
- Treat `references/*.md` as `/Sources/raw/...` reference metadata only.
- Do not copy raw source body text into the OKF bundle.
- Verify a bundle before handing it to an AI.
- Do not write from an OKF bundle back into the wiki.

Read [context-pack.md](context-pack.md) before doing substantive Kinic Context Pack work.
