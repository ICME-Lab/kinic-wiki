---
name: wiki-generate
description: Generate or expand the llm-wiki knowledge base from local source material. Use when the task is to turn raw notes, documents, or folders into draft wiki pages, refine those drafts for Obsidian working copies, or prepare reviewed content for canister push via wiki-cli. This skill is specific to the current repo's model: canister-backed SQLite source of truth, Obsidian vault Wiki/ working copy, plugin for human review, and CLI for agent operations.
---

# Wiki Generate

Use this skill when the user wants to:

- create draft wiki pages from local markdown, notes, docs, or folders
- ingest local markdown as raw source material before drafting
- convert research/source material into linked pages under `Wiki/`
- turn query or comparison results into new draft pages under `Wiki/`
- prepare content for human review in Obsidian before push
- structure knowledge into overview/entity/concept/comparison/query/source-summary pages

Do not use this skill for:

- low-level canister storage changes
- plugin UI changes
- direct schema migrations

## Workflow

Follow these gates in order:

1. **Source intake**
   - prefer `wiki-cli source-to-draft` as the main source-oriented entry point
   - add `--persist-sources` when the local markdown should also be stored as raw source material
   - inspect the input material
   - decide whether the job is small direct drafting or graph-assisted drafting
2. **Page map**
   - propose the initial set of pages, slugs, and page types
   - identify likely links and overlaps with existing pages
3. **Draft writing**
   - write draft pages into the local working copy shape, not directly into the canister
4. **Review gate**
   - normalize links and metadata
   - leave the result ready for human review in Obsidian
5. **Push gate**
   - only after review, use `wiki-cli push` or plugin push flows
6. **Lint gate**
   - after review or push, run `wiki-cli lint` and let the LLM decide what to fix next
   - before adopt-draft or push, run `wiki-cli lint-local` on the working copy when you want a local structure pass

For the exact phase contract and required outputs, read [references/phases.md](references/phases.md).

## Working Rules

- Treat the canister as the source of truth.
- Treat `Wiki/` as the shared human/agent working copy.
- Keep raw source ingestion separate from draft generation.
- Prefer producing a small number of coherent draft pages over many shallow stubs.
- Reuse existing pages when possible instead of duplicating topics.
- Treat graph-assisted tooling as optional page-map assistance, not as the source of truth.
- Use page types intentionally:
  - `overview` for indexes and broad topics
  - `entity` for people, orgs, products, places
  - `concept` for ideas and mechanisms
  - `comparison` for tradeoff pages
  - `query_note` for exploratory synthesis
  - `source_summary` for source-grounded notes

## Repo-Specific Contract

- Working copy root: `Wiki/`
- Preferred source-to-draft command: `wiki-cli source-to-draft --vault-path <path> --input <file>...`
- Raw source ingest command: `wiki-cli ingest-source --input <file>...`
- Source-only draft command: `wiki-cli generate-draft --vault-path <path> --input <file>...`
- Query result draft command: `wiki-cli query-to-page --vault-path <path> --input <file> --title <title>`
- Health report command: `wiki-cli lint [--json]`
- Local health report command: `wiki-cli lint-local --vault-path <path> [--json]`
- Managed pages: `Wiki/pages/<slug>.md`
- System pages: `Wiki/index.md`, `Wiki/log.md`
- Conflict pages: `Wiki/conflicts/<slug>.conflict.md`
- Managed frontmatter:
  - `page_id`
  - `slug`
  - `page_type`
  - `revision_id`
  - `updated_at`
  - `mirror: true`

When editing or generating drafts, read these references as needed:

- For workflow and page-shaping rules: [references/workflow.md](references/workflow.md)
- For the concrete phase-by-phase contract: [references/phases.md](references/phases.md)
- For Obsidian and mirror formatting rules: [references/obsidian-rules.md](references/obsidian-rules.md)
- For external inputs worth borrowing from `graphify` and `obsidian-skills`: [references/external-inputs.md](references/external-inputs.md)
- For graph-assisted page map rules: [references/graph-assisted.md](references/graph-assisted.md)

Read vendor skills only when needed:

- For Obsidian markdown syntax details: [../vendor/obsidian-skills/obsidian-markdown/SKILL.md](../vendor/obsidian-skills/obsidian-markdown/SKILL.md)
- For vault and CLI-side note operation guidance: [../vendor/obsidian-skills/obsidian-cli/SKILL.md](../vendor/obsidian-skills/obsidian-cli/SKILL.md)
- For web/source cleanup before drafting: [../vendor/obsidian-skills/defuddle/SKILL.md](../vendor/obsidian-skills/defuddle/SKILL.md)

## Output Targets

Prefer one of these outputs:

- draft markdown pages in `Wiki/pages/`
- a proposed page map with slugs and page types
- a reviewed set of page updates ready for `wiki-cli push`

When useful, also produce:

- a short page inventory
- unresolved questions that block push
- a note of which pages are safe to review first

Do not invent a separate storage format. Keep drafts in the same markdown form that humans will inspect.
Do not merge raw source ingest, draft adoption, and push into one hidden step unless the user explicitly asks for that workflow.
Use `source-to-draft` for source-driven work and `query-to-page` for query/comparison-driven work.
