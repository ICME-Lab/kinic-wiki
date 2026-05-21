# Skill Vendor Plan

この repo では外部 skill をそのまま runtime dependency にせず、必要なものだけ vendor する。

## 目的

- repo 固有 workflow を `kinic-wiki-ingest` `kinic-wiki-query` `kinic-wiki-lint` に分割して維持する
- Obsidian 一般の知識は外部 skill から再利用する
- upstream の全体構成に引きずられず、この repo の canister / CLI / plugin 前提を守る

## 採用候補

優先して取り込む候補:

- `obsidian-markdown`
- `defuddle`

後回し:

- `json-canvas`
- `obsidian-bases`

## 推奨ディレクトリ構成

```text
.agents/skills/
  kinic-wiki-ingest/
    SKILL.md
  kinic-wiki-query/
    SKILL.md
  kinic-wiki-lint/
    SKILL.md
  references/
    shared-rules.md
    query-rules.md
  vendor/
    obsidian-skills/
      obsidian-markdown/
        SKILL.md
        ...
      defuddle/
        SKILL.md
        ...
```

## 役割分担

### `kinic-wiki-ingest`

- source-driven wiki 更新
- source normalization
- page map
- review-first draft generation

### `kinic-wiki-query`

- wiki に対する探索と回答
- 必要時だけ page synthesis を戻す

### `kinic-wiki-lint`

- local / remote health inspection
- report-first repair planning

### `references/`

- repo 共通 reference
- repo skill 間で共有する compact rules
- `shared-rules.md` は mirror / review / optional external guidance
- `query-rules.md` は query 専用回答規約

### `vendor/obsidian-markdown`

- Obsidian Flavored Markdown の一般知識
- wikilinks
- embeds
- callouts
- properties

### `vendor/defuddle`

- web/source から clean markdown を抽出する前処理知識
- source intake の補助

## 依存の向き

repo skill が vendor skill を参照する。

- `kinic-wiki-ingest` -> `vendor/obsidian-markdown`
- `kinic-wiki-ingest` -> `vendor/defuddle`
- `kinic-wiki-query` -> `vendor/obsidian-markdown` when page write-back is needed
- `kinic-wiki-lint` -> `vendor/obsidian-markdown` when mirror-shape checks need markdown details

逆方向の依存は作らない。

`graphify` のような外部ツールは vendor skill ではなく、optional な page-map assistant として扱う。

## 取り込み方針

- upstream を wholesale import しない
- 必要 skill だけ vendor する
- vendor 後に、この repo で不要な記述は削る
- repo 固有 workflow は vendor 側に移さない

## 更新方針

- upstream 更新を常時追従しない
- 必要な時だけ差分確認して手動更新する
- vendor した skill はこの repo の運用に合わせて編集してよい
