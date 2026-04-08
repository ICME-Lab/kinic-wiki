# Skill Vendor Plan

この repo では外部 skill をそのまま runtime dependency にせず、必要なものだけ vendor する。

## 目的

- `wiki-generate` をこの repo 固有の親 skill として維持する
- Obsidian 一般の知識は外部 skill から再利用する
- upstream の全体構成に引きずられず、この repo の canister / CLI / plugin 前提を守る

## 採用候補

優先して取り込む候補:

- `obsidian-markdown`
- `obsidian-cli`
- `defuddle`

後回し:

- `json-canvas`
- `obsidian-bases`

## 推奨ディレクトリ構成

```text
.agents/skills/
  wiki-generate/
    SKILL.md
    references/
    agents/
  vendor/
    obsidian-skills/
      obsidian-markdown/
        SKILL.md
        ...
      obsidian-cli/
        SKILL.md
        ...
      defuddle/
        SKILL.md
        ...
```

## 役割分担

### `wiki-generate`

- この repo の正本 workflow を持つ親 skill
- canister-backed wiki
- `Wiki/` working copy
- review gate / push gate
- page map / draft generation

### `vendor/obsidian-markdown`

- Obsidian Flavored Markdown の一般知識
- wikilinks
- embeds
- callouts
- properties

### `vendor/obsidian-cli`

- vault や Obsidian CLI に関する一般知識
- Obsidian 側の操作文脈

### `vendor/defuddle`

- web/source から clean markdown を抽出する前処理知識
- source intake の補助

## 依存の向き

`wiki-generate` が vendor skill を参照する。

- `wiki-generate` -> `vendor/obsidian-markdown`
- `wiki-generate` -> `vendor/obsidian-cli`
- `wiki-generate` -> `vendor/defuddle`

逆方向の依存は作らない。

`graphify` のような外部ツールは vendor skill ではなく、optional な page-map assistant として扱う。

## 取り込み方針

- upstream を wholesale import しない
- 必要 skill だけ vendor する
- vendor 後に、この repo で不要な記述は削る
- `wiki-generate` の正本 workflow は vendor 側に移さない

## 更新方針

- upstream 更新を常時追従しない
- 必要な時だけ差分確認して手動更新する
- vendor した skill はこの repo の運用に合わせて編集してよい
