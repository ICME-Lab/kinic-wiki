# LLM Wiki 計画書

## 1. 目的

この repo の目的は、raw source を毎回 RAG し直すのではなく、LLM が継続保守する永続 wiki を FS-first の公開契約上に構築することです。

優先順位は次の通りです。

- raw source と wiki の責務を分離する
- agent が `index.md` を入口に辿れる運用を固める
- provenance を wiki 本文上で読める形に保つ
- 会話結果を知識ベースへ戻す規約を固定する
- FS API と wiki 運用規約を混同しない

## 2. 採用判断

この repo の上位方針は次の通りです。

- 正本の公開契約は FS-first の `Node` API とする
- raw source は `/Sources/...` に置く
- wiki は `/Wiki/...` に置く
- `index.md` と `log.md` は agent が普通の file として管理する
- query は page 種別ではなく workflow 名として扱う

この文書は wiki 運用規約の正本です。  
FS API と保存モデルの契約は `FS_FIRST_CONTRACT.md`、FS-first 化の移行記録は `FS_FIRST_PLAN.md` に残します。

## 3. 全体アーキテクチャ

### 3.1 Raw Sources

raw source は `/Sources/...` の raw 専用領域に置きます。

- `/Sources/...` に agent 生成物は置かない
- canonical source path は `/Sources/raw/<source_id>/<source_id>.md`
- `write-node --kind source` と `append-node --kind source` は canonical path を軽く検証する
- asset は同 directory の sibling file とする
- `source_id` は path 由来とする
- ingest 後の rename は原則禁止とし、必要なら新 source を作る

例:

```text
/Sources/raw/openai-api/openai-api.md
/Sources/raw/openai-api/figure-1.png
```

### 3.2 Wiki

wiki は `/Wiki/...` に置く agent 管理の知識層です。

主なページは次の通りです。

- source summary page: `/Wiki/sources/<source_id>.md`
- entity page
- concept page
- lint report: `/Wiki/lint/...`
- `index.md`
- `log.md`

`/Wiki/sources/<source_id>.md` は恒久 source summary page として残します。  
raw source の全文コピーではなく、要約・抽出・他ページへの参照中継点を担います。

### 3.3 Schema / Runtime Rules

schema は LLM が wiki をどう更新するかの規約です。

- ingest/query/lint の流れ
- index/log の運用
- provenance 表現
- 会話結果の反映規則
- entity / concept の分類原則

## 4. ナビゲーション方針

### 4.1 index.md

`index.md` は内容志向の全ページカタログです。

- agent 管理の普通の file とする
- 当面は 1 枚全件列挙で運用する
- query 時の基本運用は `index first` とする
- entry は自然文に寄せ、カテゴリ見出しで種別を表す

初期カテゴリは次の 3 つです。

- `Sources`
- `Entities`
- `Concepts`

`Lint` は `/Wiki/lint/...` に保存しますが、`index.md` の常設カテゴリにはしません。  
必要なら最新 lint report への最小リンクだけを置きます。

分類原則:

- `Entity = 固有対象`
- `Concept = 一般概念`

path 規約:

- `/Wiki/entities/<slug>.md`
- `/Wiki/concepts/<slug>.md`
- `/Wiki/sources/<source_id>.md`

slug は human-readable を優先し、小文字 kebab-case を推奨します。

作成規則:

- 固有対象なら `entities`
- 一般概念なら `concepts`
- raw source 由来要約なら `sources`

更新規則:

- 同じ対象の既存 page があれば新規作成しない
- path 不一致や未分類 page を見つけたら、まず既存 page を読む
- rename / move が必要なら明示操作として扱う
- `rebuild_index` は path で分類するので、分類対象 page は対応 path 配下に置く

### 4.2 log.md

`log.md` は append-only の時系列台帳です。

- agent 管理の普通の file とする
- ingest / query / lint を追記式で記録する
- recent activity の把握と unix tool での解析を両立する

heading 形式:

```text
## [YYYY-MM-DD HH:MM] kind | Title
```

本文は次の key-value 行を基本とします。

- `target_paths`
- `updated_paths`
- `notes`
- `failure`

例:

```text
## [2026-04-15 10:32] ingest | OpenAI API

target_paths: /Sources/raw/openai-api/openai-api.md
updated_paths: /Wiki/sources/openai-api.md, /Wiki/concepts/tool-calling.md, /Wiki/index.md
notes: added source summary and updated related concept page
```

## 5. Provenance 方針

provenance は frontmatter ではなく wiki 本文で表現します。

- 恒久 wiki page は `## Sources` 節を持つ
- source 一覧は page 末尾の `## Sources` に置く
- 重要主張の近くでは本文中リンクも使う
- frontmatter に provenance の正本は置かない

これにより、人間と agent が同じ表現を読めます。

## 6. Workflow 方針

### 6.1 Ingest

ingest は新しい raw source を wiki へ統合する workflow です。

- raw source を読む
- `/Wiki/sources/<source_id>.md` を更新する
- 必要な entity / concept page を更新する
- `index.md` を更新する
- `log.md` に追記する

### 6.2 Query

query は page 種別ではなく workflow 名です。

- 会話結果を `Queries` 保存することは原則にしない
- 会話結果は次のいずれかへ戻す
  - 既存 page 更新
  - 新規恒久 page 作成
  - 非保存

会話起点の複数 page 更新は件数制約ではなく schema 規約で統制します。

- 更新対象ごとに必要性を明示する
- 既存 page 更新を優先する
- 波及更新では根拠 source と変更理由を対応づける
- 大きい更新では適用前に対象一覧を提示する

query 後の更新 recipe:

1. `index.md` と関連 page を先に確認する
2. 回答だけで十分なら保存しない
3. 更新が必要なら対象 page を明示する
4. 新規 page なら `write_node`
5. 既存 page の差し替えなら `edit_node` または `multi_edit_node`
6. 追記だけなら `append_node`
7. 更新後に `rebuild_index`
8. 必要なら `append-log --kind <freeform>`
9. 根拠は本文中リンク + `## Sources` で残す

### 6.3 Lint

lint は wiki の点検 workflow です。

- report は `/Wiki/lint/...` に保存する
- `log.md` に履歴を残す
- 常設 index カテゴリにはしない

## 7. 検索戦略

初期段階では検索 API は補助です。

探索手順:

1. `index.md` を読む
2. 関連する source summary / entity / concept page を開く
3. 必要なら `search_nodes` で補助検索する
4. 必要なら `## Sources` から raw source に飛ぶ

将来、retrieval を強化する余地は残しますが、raw source と wiki の二層分離は維持します。

## 8. 文書の役割分担

- `LLM_WIKI_PLAN.md`
  - wiki 運用規約の正本
- `FS_FIRST_CONTRACT.md`
  - FS API / path / sync の契約
- `FS_FIRST_PLAN.md`
  - FS-first 化の移行記録

repo 固有の wiki 運用はこの文書へ集約し、FS 文書へ再分散しません。
