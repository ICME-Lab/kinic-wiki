---
name: wiki-workflow
description: Build LLM prompts and structured results for llm-wiki ingest, crystallize, integrate, and lint workflows from `wiki-cli build-*-context` output, then hand the JSON result back to `wiki-cli apply-workflow-result` or `wiki-cli apply-integrate`. Query remains read-only and any later wiki edits should use explicit node commands.
---

# Wiki Workflow

Use this skill when the user wants to run ingest, crystallize, integrate, or lint with LLM judgment, while query stays read-only and any later wiki edits happen through explicit node commands.
workflow transport は JSON。知識本文は markdown 文字列として JSON field に入れる。

## Workflow

1. Run one of:
   - `wiki-cli build-ingest-context`
   - `wiki-cli build-crystallize-context`
   - `wiki-cli build-integrate-context`
   - `wiki-cli build-lint-context`
2. Read the returned JSON bundle.
3. Generate JSON matching `response_schema` exactly.
4. Apply it with:
   - `wiki-cli apply-workflow-result --task ingest --input <file>`
   - `wiki-cli apply-workflow-result --task crystallize --input <file>`
   - `wiki-cli apply-integrate --input <file>`
   - `wiki-cli apply-workflow-result --task lint --input <file>`

For query:

1. Run `wiki-cli build-query-context`
2. Read the returned JSON bundle
3. Read `index.md` first, then open related durable pages
4. Answer from the provided context only
5. If the answer should update the wiki, name the target durable pages first
6. If a new durable page is needed, confirm there is no existing match by checking `candidate_pages` when present, then `search_paths` and related durable pages
7. For a new durable page, place entities under `/Wiki/entities/...` and concepts under `/Wiki/concepts/...`
8. For a new durable page, start from the durable page template shape:
   - entity: `# Title` / `## Summary` / `## Details` / `## Sources`
   - concept: `# Title` / `## Thesis` / `## Notes` / `## Sources`
9. Prefer updating an existing durable page over creating a new one, and choose a short stable path name when creating a new page
10. Use explicit node commands afterward:
   - new page: `write_node`
   - replace/update section: `edit_node` or `multi_edit_node`
   - append-only note: `append_node`
   - after edits: `rebuild_index`
   - if the activity should be recorded: `append-log --kind query`

## Hard Rules

- 根拠は context bundle のみ。
- `response_schema` 以外を返さない。
- ingest では context に入っている `source_path`, `source_id`, `source_etag`, `index_etag` はそのまま返す。
- crystallize では context に入っている `session_path`, `session_id`, `session_etag`, `index_etag` はそのまま返す。
- integrate/lint では context に入っている `index_etag` はそのまま返す。
- ingest の `related_updates[].path` は `/Wiki/...` 配下だけ。
- crystallize の `durable_updates[].path` は `/Wiki/...` 配下だけ。
- integrate の `page_updates[].path` は `/Wiki/...` 配下だけ。
- `/Wiki/index.md` と `/Wiki/log.md` を直接更新しない。
- 変更件数は最小限。
- summary / answer / report は markdown で返す。
- 空文字は返さない。
- context は schema caps 済み。`content_truncated` や `index_truncated` が `true` でも、与えられた範囲だけで判断する。

## Ingest

目的:
- raw source から `source_summary_markdown` を作る。
- 必要最小限の `related_updates` を提案する。

出力:
- `source_path`
- `source_id`
- `source_etag`
- `index_etag`
- `source_summary_markdown`
- `related_updates`
- `rationale`

基準:
- source の新規事実を wiki へ統合する。
- 固有対象は `/Wiki/entities/<agent-decided-name>.md`、一般概念は `/Wiki/concepts/<agent-decided-name>.md` を優先する。
- path 名は短く安定したものを選ぶ。厳密な slug 規則は固定しない。
- 既存 page の重複作成を避ける。
- `candidate_pages` と `recent_pages` を優先的に再利用する。

## Lint

目的:
- wiki の構造・整合性・更新漏れを短くレビューする。

出力:
- `index_etag`
- `report_markdown`
- `checked_paths`

基準:
- 事実ベースで指摘する。
- 空疎な一般論を避ける。
- `candidate_pages`, `recent_pages`, `index_markdown`, `structural_stats` を優先して使う。

## Crystallize

目的:
- 長い会話や session を durable wiki knowledge に蒸留する。

出力:
- `session_path`
- `session_id`
- `session_etag`
- `index_etag`
- `durable_updates`
- `rationale`

基準:
- session source は `/Sources/sessions/<session_id>/<session_id>.md` 前提で扱う。
- durable page だけを最小件数で更新する。
- raw transcript の写経ではなく、wiki に残す価値がある知識へ圧縮する。

## Integrate

目的:
- 既存 wiki page 群へ backlinks と周辺更新を編み込む。

出力:
- `target_paths`
- `index_etag`
- `page_updates`
- `rationale`

基準:
- `target_paths` と周辺 page の整合を優先する。
- `/Wiki/index.md` と `/Wiki/log.md` の直接更新は返さない。
- 必要最小限の page 更新だけ返す。

## Few-shot

### Ingest

入力:
- `task = ingest`
- `source_id = alpha`

出力:

```json
{
  "source_path": "/Sources/raw/alpha/alpha.md",
  "source_id": "alpha",
  "source_etag": "etag-/Sources/raw/alpha/alpha.md",
  "index_etag": "etag-/Wiki/index.md",
  "source_summary_markdown": "# Alpha\n\n## Summary\n\n- Fact A\n- Fact B",
  "related_updates": [
    {
      "path": "/Wiki/topic.md",
      "markdown": "# Topic\n\nUpdated with Alpha."
    }
  ],
  "rationale": "Alpha adds a concrete update to Topic."
}
```

### Lint

```json
{
  "index_etag": "etag-/Wiki/index.md",
  "report_markdown": "# Wiki Lint\n\n- `topic.md` mentions Alpha but has no backlink to `sources/alpha.md`.",
  "checked_paths": ["/Wiki/topic.md", "/Wiki/sources/alpha.md"]
}
```

### Crystallize

```json
{
  "session_path": "/Sources/sessions/session-1/session-1.md",
  "session_id": "session-1",
  "session_etag": "etag-/Sources/sessions/session-1/session-1.md",
  "index_etag": "etag-/Wiki/index.md",
  "durable_updates": [
    {
      "path": "/Wiki/entities/session-1.md",
      "markdown": "# Session 1\n\n## Summary\n\nDurable knowledge."
    }
  ],
  "rationale": "The session adds reusable durable knowledge."
}
```

### Integrate

```json
{
  "target_paths": ["/Wiki/topic.md"],
  "index_etag": "etag-/Wiki/index.md",
  "page_updates": [
    {
      "path": "/Wiki/topic.md",
      "markdown": "# Topic\n\nIntegrated with related pages."
    }
  ],
  "rationale": "Topic needs backlink and surrounding context."
}
```
