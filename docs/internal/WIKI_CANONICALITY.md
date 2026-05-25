# Wiki Canonicality Policy

This document defines the current repo-local wiki schema.

- Keep general principles in skills.
- Keep current note names and responsibilities here.
- When the schema changes, update this document as the source of truth.

## Current Principles

- `/Sources/raw/...` is the canonical raw source layer.
- `/Wiki/...` is the organized knowledge layer.
- Do not duplicate raw transcripts into `/Wiki/...` as canonical wiki content.
- Do not mix exact evidence with recap.
- Do not promote unresolved state into settled facts.
- When old and new values both exist, state the current value explicitly in `facts.md`.

## Current Note Roles

- Root catalog:
  - `/Wiki/index.md`
    - required content-oriented catalog
    - List key pages with short descriptions.
    - Do not pack the full overview or detailed body text into the index.

- Optional scoped pages:
  - `<scope>/index.md`
    - optional scoped catalog only when the user explicitly wants hierarchy.
  - `overview.md`
    - optional corpus-level synthesis.
    - Capture the scope purpose, structure, main themes, gaps, and reading path.
    - Do not make this the canonical source for exact evidence or stable facts.
  - `log.md`
    - optional append-only chronological mutation log.
    - Append ingest, restructure, lint, and query-derived update entries.
    - Do not rewrite existing entries.
  - `schema.md`
    - optional scope-local conventions.
    - Capture operational rules for raw, wiki, topic, summary, and log pages.
  - `topics/*.md`
    - optional category or topic-level synthesis.
    - Connect multiple sources or child summaries.
    - Do not use topic pages as raw transcript copies.

- Child-level pages:
- `facts.md`
  - Settled stable facts and stable attributes.
  - Store exact facts, current values, selected options, and stable relationships or durations.
  - Do not store topic-only mentions, ambiguous information, unresolved items, future or pending items, chronology-only events, or recap prose.
- `events.md`
  - Chronology of events that happened.
  - Store only completed events and dated events.
  - Do not store interpretation, summary, future, or pending items.
- `plans.md`
  - Future or pending items, plans, intentions, and next actions.
  - Scope-specific explicit instructions, temporary constraints, and operational policies.
- `preferences.md`
  - Preferences, decision criteria, and choices.
- `open_questions.md`
  - Unresolved items, questions to verify, and conflicting information.
- `summary.md`
  - Human-facing recap.
  - Do not use as the exact evidence source.
  - Do not use as the canonical stable fact source.
- `provenance.md`
  - Raw source id, path, import metadata, and reference locations.

## Current Anti-Rules

- Do not put topic-only lines in `facts.md`.
- Do not put future or pending items, chronology-only events, or recap prose in `facts.md`.
- Do not leave only old values in `facts.md` while omitting the current value.
- Do not put exact facts, causal claims, or resolution claims in `summary.md`.
- Do not put unresolved contradictions in settled notes.
- Do not duplicate raw transcripts into `/Wiki/...` as canonical content.
