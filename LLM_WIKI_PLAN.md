# LLM Wiki 計画書

## 1. 目的

このプロジェクトの目的は、raw source を毎回 RAG するのではなく、LLM が継続的に保守する永続 wiki を ICP 上に構築することです。

初期段階では、以下を重視します。

- wiki の正本を安定して保持できること
- index.md と system pages を入口に中規模まで回ること
- 後から vector retrieval を追加できること
- full rebuild ではなく差分更新できること
- CLI や外部ツール互換ではなく、agent が使う wiki canister 自身の自然な API を先に固めること

## 2. 採用判断

まず app schema と system pages を完成させ、agent が `index.md` を入口に wiki を運用できる状態を優先します。

理由:

- この wiki は agent-first の運用を前提としており、最初に固定すべきなのは検索 API よりも wiki の正本構造と運用規約である
- `index.md` / `log.md` を入口にすれば、中規模までは専用検索エンジンなしでも十分に回せる
- `documents` のような検索 projection を先に入れると、正本と派生物の二重管理が増え、設計の重心が wiki から検索基盤へずれる
- vector retrieval は必要性が実測で出てから追加すればよく、初期からそれに引きずられる必要はない

結論:

- 正本: app 独自の wiki tables
- 入口: `index.md` / `log.md`
- 初期: agent が system pages と page 読み取り API を組み合わせて辿る
- 後期: 必要になった時点で wiki 向け retrieval を追加する

補足:

- QMD のような外部ツールは参考にするが、QMD 互換自体は目標にしない
- まずは canister の内部 service API を素直に設計し、その後に必要なら CLI / HTTP adapter を載せる
- API は collection 指向ではなく、wiki page / system page / search / source の責務で切る

## 3. 全体アーキテクチャ

3 層で構成します。

### 3.1 Raw Sources

不変の一次情報です。

- article
- paper
- transcript
- image metadata
- 外部メモ

raw source 自体は原則書き換えません。

### 3.2 Wiki

LLM が保守する markdown 的な知識層です。

- entity page
- concept page
- overview
- comparison
- query note
- system pages (`index.md`, `log.md`)

ユーザーは主にこの層を読みます。

### 3.3 Schema / Runtime Rules

LLM がどう wiki を更新するかを決める運用ルールです。

- ページ種別
- citation 規約
- ingest/query/lint の流れ
- page 更新ルール
- index/log の生成ルール

## 4. モジュール構成

初期構成は以下を想定します。

```text
workspace/
  crates/
    wiki_types/
    wiki_store/
    wiki_runtime/
    wiki_agent_schema/
```

### 4.1 `wiki_types`

純粋な型定義です。

- `Source`
- `SourceBody`
- `WikiPage`
- `WikiRevision`
- `WikiSection`
- `LogEvent`
- `SystemPage`

### 4.2 `wiki_store`

正本 DB を扱う層です。

役割:

- source 管理
- page/revision/section 管理
- system page render
- log 追記

### 4.3 `wiki_runtime`

ICP canister entrypoint です。

役割:

- query/update API の公開
- payload 制約の管理
- store と search の調停

### 4.4 `wiki_agent_schema`

LLM 用の運用規約をまとめる層です。
初期段階では独立 crate をまだ持たず、`AGENTS.md` と `LLM_WIKI_PLAN.md` で代替します。
将来的には専用 crate または専用規約ファイル群として切り出します。

役割:

- ingest 手順
- query 結果の file back ルール
- lint 観点
- page テンプレート

## 5. 正本スキーマ方針

検索用 `documents` を正本にしません。
正本は app tables に分離します。

最低限のテーブル:

- `wiki_pages`
- `wiki_revisions`
- `wiki_sections`
- `sources`
- `source_bodies`
- `log_events`
- `system_pages`

設計意図:

- `wiki_pages` は logical page の安定 ID を持つ
- `wiki_revisions` は履歴を持つ
- `wiki_sections` は差分更新と将来の retrieval の最小単位
- `source_bodies` は raw source 全文を 1 回だけ保持する
- `system_pages` は `index.md` / `log.md` の materialized view

source 設計では、同じテキストを二重保持しません。
また、根拠の可視化は内部 metadata ではなく wiki 本文を優先します。

- raw source 全文は `source_bodies.body_text` に 1 回だけ保存する
- wiki の各ページや各主張の近くに、根拠 source と参照位置を明示的に書く
- 参照位置は行番号固定より、見出し名・引用・アンカー・節名のような人間可読な形を優先する

これにより、

- LLM には全文をそのまま読ませられる
- 根拠が wiki 上でそのまま読める
- agent と人間が同じ citation 表現を共有できる
- 内部専用の citation metadata を初期段階で増やさずに済む

## 6. ナビゲーション方針

初期段階では `documents` projection は持ちません。
agent はまず `index.md` を読み、必要な page を開いて辿る運用を基本にします。

役割分担:

- `index.md`: 最初に読むナビ
- `log.md`: 最近の更新と作業履歴を把握する入口
- `get_page(slug)`: 本文を読む主 API

必要になった場合のみ、後段で section 単位の retrieval を追加します。
その場合でも正本は app tables のままです。

## 7. 将来の retrieval 拡張方針

専用検索エンジンは後段の任意拡張とします。

追加条件:

- `index.md` と page 読み取りだけでは探索コストが高くなった
- section 単位検索が回答品質に明確に効く
- vector retrieval の価値が実測で確認できた

追加する場合の原則:

- 正本は app tables に置いたままにする
- raw source 全量の埋め込みは行わない
- current wiki sections のみを候補にする
- まず lexical、その後に必要なら vector/hybrid を追加する

## 8. index.md / log.md 方針

### 8.1 index.md

`index.md` は手編集しません。
`wiki_pages` から render して `system_pages` に保存します。

初期は 1 枚で運用し、規模が増えたら shard します。

候補:

- `index.md`
- `index/entities.md`
- `index/concepts.md`
- `index/sources.md`
- `index/queries.md`

役割は「最初に読むナビ」です。

### 8.2 log.md

`log.md` も正本ではなく render view とします。

正本:

- `log_events`

render 形式:

```text
## [2026-04-06] ingest | Article Title
## [2026-04-06] query | comparison of x and y
## [2026-04-06] lint | orphan pages
```

## 9. 検索戦略

### Phase 1

vector は使いません。

検索手順:

1. `index.md` または shard を読む
2. exact title / slug / tag match
3. 必要なら page title / summary / section text に対する単純検索を使う
4. top page の current revision を読む
5. 必要なら citation から raw source に飛ぶ

この段階では検索 API は補助です。
主要な探索導線は `index.md` と page 読み取りです。

### Phase 2

必要になったら current wiki sections だけを対象に retrieval を追加します。

方針:

- raw docs 全量 embedding はやらない
- `index.md` を置き換えず、その補助として使う
- 最初の lexical retrieval は app DB 内の FTS5/BM25 を使う
- FTS は `wiki_sections` の正本そのものではなく、current sections から作る派生 index とする
- hybrid は lexical shortlist の補助として使う

### Phase 3

必要なら raw の summary 系だけ補助投入します。

- source summary
- canonical digest

ここでも raw chunks 全量 vector 化は避けます。

## 10. 差分更新方針

差分単位は section hash です。

```text
content_hash = sha256(normalized_section_text)
```

revision 更新時の流れ:

1. markdown を section 分割
2. 各 section の `content_hash` を計算
3. 旧 current sections と比較
4. unchanged は何もしない
5. changed/new を `wiki_sections` に反映する
6. `index.md` / `log.md` を再描画する
7. lexical retrieval を導入した段階では、changed/new だけ FTS index を更新し、removed は FTS から削除する
8. embedding を導入する段階になったら changed/new だけ再計算する

full rebuild はしません。
FTS index を持つ場合も、正本更新と同じ transaction で更新してアトミックに保ちます。

## 11. ICP canister API 方針

canister は wiki application service として切ります。
特定の retrieval runtime をそのまま app 本体にはしません。

HTTP 公開を行う場合も、まず canister 内の service API を安定化させてから薄い transport adapter を載せます。
先に CLI 互換や外部ツール互換を固定せず、ICP の `query` / `update` と `http_request` の両方に載せやすい DTO を優先します。

### Phase 1 の読み取り API 優先順位

初期段階で優先する読み取り API は以下です。

- `get_page(slug)`
- `get_system_page(slug)`
- `get_recent_log(limit)`
- `status()`

理由:

- `index.md` / `log.md` を読む導線を最初から成立させたい
- page 取得と system pages だけで中規模まで運用する方針に合う
- `status()` は query 系の主機能ではないが、canister の整合確認と運用確認に有用
- 専用検索 API や batch 取得より、system page と log の参照を先に固める方がこの wiki の利用モデルに合う

### query

- `get_page(slug)`
- `get_system_page(slug)`
- `get_recent_log(limit)`
- `search(req)`

### update

- `create_source(input)`
- `commit_page_revision(input)`

初期段階の source ingest は `create_source(input)` で source 全文を 1 回保存する単純モデルにします。
大きい raw docs の transport chunk upload は後段で専用レイヤとして追加します。

論理的な citation は、まず wiki 本文に書かれた根拠表現を正本とします。
raw source 側は、その確認用に保持します。

## 12. GitHub 風運用への発展

最終的には「ローカル編集者が push し、閲覧者が CLI/MCP で読む」モデルに発展させます。

ただし初期段階では、まず wiki canister 単体を完成させます。

順序:

1. ICP 上の wiki 正本と system pages を成立させる
2. revision / system pages の更新を安定化する
3. その後で push/pull 相当の同期モデルを設計する

理由:

- 先に GitHub 風同期を作ると、正本モデルが固まる前に外部契約が固まってしまう
- まずは単一 canister 内で整合した wiki runtime を作る方が安全

### 12.1 目指す利用モデル

最終形は Git / GitHub に近い役割分担を目指します。

- ローカル: 編集、差分確認、レビュー前の作業コピー
- canister: 共有用の正本、履歴、検索、配布元

利用イメージ:

1. `clone` で canister の current wiki をローカルに取得する
2. ローカルで markdown を編集する
3. `diff` でローカル変更と canister 側 current を比較する
4. `push` で changed pages / sections だけを送る
5. canister 側で revision 化し、system pages を更新する

ここで重要なのは、
「ローカル作業コピーがあり、共有先へ安全に差分同期できる」操作感を作ることです。

### 12.2 ローカル作業コピーの扱い

ローカル clone は bare mirror ではなく、wiki 編集に特化した working copy とします。

最低限必要なローカル状態:

- page markdown files
- `index.md` などの system pages の読み取り専用コピー
- clone 時点の remote revision 情報
- page / section ごとの stable id と hash を保持する manifest

manifest の役割:

- ローカル diff を高速に出す
- push 時に changed / removed sections を判定する
- optimistic concurrency の比較元に使う

重要なのは、ローカルで人間が読む markdown と、
同期のための機械向け metadata を分離することです。

### 12.3 Source Ingest の考え方

source ingest では、以下の 2 つを明確に分けます。

- transport chunk
- source body

### transport chunk

ICP の payload 制限を避けるための upload 単位です。

- byte ベース
- 目安は 1.9MB 未満
- canister に source を送るためだけに使う

これは保存上の都合であり、wiki 作成や citation の論理単位にはしません。
初期実装ではこのレイヤはまだ導入せず、後段の API 追加として扱います。

### source body

LLM やユーザーが読む raw source の本体です。

- `source_bodies.body_text`
- source 全文を 1 回だけ保持する
- wiki 作成時は基本的にこれを読む

初期実装:

- `create_source(input)` に `body_text` を含めて一発登録する
- DB には transport chunk を残さない

将来拡張:

- `begin_source_upload`
- `append_source_chunk`
- `finalize_source_upload`

のような upload 専用 API を別レイヤとして追加し、
`finalize` 時に chunk を結合して `source_bodies.body_text` へ 1 回だけ保存します。
この時も wiki の正本は `source_bodies` の全文であり、chunk 自体は永続正本にしません。

### root citation の書き方

根拠は wiki に直接書きます。

基本方針:

- 各ページや各主張の近くに source を書く
- 可能なら該当 section 名や見出し名を書く
- 必要なら短い引用を添える
- 行番号固定より、人間が見て辿れる記述を優先する

例:

```text
Sources:
- [source: Article A, section "Results"]
- [source: Paper B, heading "Discussion", quote: "..." ]
```

初期段階では、この可視的な citation を正本とします。
厳密な offset や span ID は後から必要になった場合のみ追加します。

### 12.4 同期単位

同期の最小単位は page ではなく section を基本にします。

理由:

- 小さい変更で再送量を減らせる
- embedding 再計算範囲を最小化できる

ただし commit 単位の整合性は page revision で管理します。

つまり:

- 転送差分は section basis
- 正本の履歴確定は page revision basis

この二層に分けると、転送効率と履歴の単純さを両立しやすいです。

### 12.5 `clone / fetch / diff / push` の対応

将来的な同期 API は以下の責務に分けるのが自然です。

`clone`

- current wiki pages
- system pages
- remote manifest
- clone 基準 revision

`fetch`

- remote 側で更新された page revisions
- changed system pages
- remote manifest の更新分

`diff`

- local file vs local manifest
- 必要なら local base vs remote head

`push`

- changed pages の candidate revision を送る
- base revision が一致した場合のみ commit する
- 成功時に page revision / section hash / system pages を返す

実質的には `push` より `compare-and-commit` に近い API になります。
Git の fast-forward 制約に相当するものを、page revision の一致確認で表現します。

### 12.6 競合モデル

初期は単純な衝突検出を優先します。

基本方針:

- push 時に `base_revision_id` を必須にする
- remote head が変わっていたら reject する
- 利用者は `fetch` して再 diff する

理由:

- markdown wiki は衝突時に人間か LLM が再編集した方が安全
- canister 側の責務を同期判定と revision 確定に絞れる

### 12.7 設計原則

同期モデルでは以下を採用します。

- `clone/fetch/diff/push` の操作語彙
- content hash ベースの差分判定
- local base と remote head の比較
- manifest による同期状態の管理
- `base_revision_id` を使った compare-and-commit

### 12.8 導入順

同期モデルは以下の順で導入するのが安全です。

1. canister 内の revision / system page 更新を安定化する
2. export API を作り、`clone` 相当を成立させる
3. local manifest を定義し、`diff` を成立させる
4. `base_revision_id` 付き `push` を入れる
5. 同期後の revision / system page 更新結果をローカルへ反映する

この順なら、途中段階でも「読む」「ローカルで編集する」「安全に push する」が成立します。

### 12.9 canister sync API 案

同期専用 API は、通常の page API とは分けて定義します。

最小構成:

- `export_wiki_snapshot(req)`
- `fetch_wiki_updates(req)`
- `commit_wiki_changes(req)`

`clone` は `export_wiki_snapshot`、
`fetch` は `fetch_wiki_updates`、
`push` は `commit_wiki_changes` に対応させます。

### 12.10 `export_wiki_snapshot`

用途:

- 初回 clone
- ローカル working copy の再構築

request:

```text
{
  include_system_pages: bool,
  page_slugs: Option<Vec<String>>,
}
```

response:

```text
{
  snapshot_revision: String,
  pages: Vec<WikiPageSnapshot>,
  system_pages: Vec<SystemPageSnapshot>,
  manifest: WikiSyncManifest,
}
```

`WikiPageSnapshot`:

```text
{
  page_id: String,
  slug: String,
  title: String,
  revision_id: String,
  markdown: String,
  section_hashes: Vec<SectionHashEntry>,
}
```

意図:

- ローカルで人間が読む markdown を直接持てること
- clone 直後に diff と push の基準情報を揃えられること

### 12.11 `fetch_wiki_updates`

用途:

- clone 後の remote 更新追従
- push 前の base 確認

request:

```text
{
  known_snapshot_revision: String,
  known_page_revisions: Vec<KnownPageRevision>,
  include_system_pages: bool,
}
```

response:

```text
{
  snapshot_revision: String,
  changed_pages: Vec<WikiPageSnapshot>,
  removed_page_ids: Vec<String>,
  system_pages: Vec<SystemPageSnapshot>,
  manifest_delta: WikiSyncManifestDelta,
}
```

`known_page_revisions` は、
ローカルが持っている `page_id -> revision_id` の組です。

意図:

- remote 全量を毎回取り直さないこと
- local base と remote head の差を API で明示できること

### 12.12 `commit_wiki_changes`

用途:

- local diff を remote revision として確定する

request:

```text
{
  base_snapshot_revision: String,
  page_changes: Vec<PageChangeInput>,
}
```

`PageChangeInput`:

```text
{
  page_id: String,
  base_revision_id: String,
  new_markdown: String,
}
```

response:

```text
{
  committed_pages: Vec<CommittedPageResult>,
  rejected_pages: Vec<RejectedPageResult>,
  snapshot_revision: String,
  system_pages: Vec<SystemPageSnapshot>,
  manifest_delta: WikiSyncManifestDelta,
}
```

`CommittedPageResult`:

```text
{
  page_id: String,
  revision_id: String,
  section_hashes: Vec<SectionHashEntry>,
}
```

`RejectedPageResult`:

```text
{
  page_id: String,
  current_revision_id: String,
  reason: String,
}
```

基本動作:

1. `base_revision_id` が current と一致する page だけ commit する
2. canister 側で markdown を section 分割し、hash を再計算する
3. page revision 確定後に system pages を更新する
4. 成功した page の新しい revision と manifest 差分を返す

### 12.13 manifest の最小項目

manifest は local diff と optimistic concurrency のための機械向け index です。

最小項目:

```text
{
  snapshot_revision: String,
  pages: Vec<ManifestPageEntry>,
}
```

`ManifestPageEntry`:

```text
{
  page_id: String,
  slug: String,
  revision_id: String,
  content_hash: String,
  section_hashes: Vec<SectionHashEntry>,
}
```

`SectionHashEntry`:

```text
{
  section_path: String,
  content_hash: String,
}
```

役割:

- local file の変更有無を即座に判定する
- push 対象 page を絞る
- push 成功後に local manifest を更新する

### 12.14 ローカル CLI の責務

CLI 側は以下だけを担当します。

- clone 時に snapshot と manifest を保存する
- local markdown から page ごとの差分を作る
- push 前に `fetch_wiki_updates` を呼んで競合を確認する
- `commit_wiki_changes` の結果で local manifest を更新する

canister 側に持たせない責務:

- ローカルファイル監視
- 汎用 merge
- diff 表示 UI

この分離で、canister は正本と同期判定に集中できます。

## 13. 実装フェーズ

### Phase A: 正本と system pages

やること:

- app schema 実装
- page revision / section split
- `index.md` render
- `log.md` render
- `index.md` 主導のナビ
- exact title / slug / tag lookup
- query note file back

完了条件:

- index/log が自動更新される
- page revision 更新で system pages が追随する
- agent が `index.md` から relevant pages を辿れる

### Phase B: optional retrieval layer

やること:

- page title / summary / section text に対する単純検索
- current wiki sections を対象にした lexical retrieval
- 検索条件と ranking の最小 API 設計

完了条件:

- `index.md` を補助する検索 API が追加される
- retrieval を入れても正本モデルが崩れない

### Phase C: wiki-only embeddings

やること:

- changed sections のみ embedding enqueue
- hybrid retrieval
- lexical shortlist + vector shortlist + fusion
- large source upload 用 transport API の追加

完了条件:

- vector 導入後も raw docs 全量埋め込みなしで運用できる
- changed section だけ再埋め込みされる
- 大きい raw source も `source_bodies` 正本を崩さず取り込める

### Phase D: lint / health check

やること:

- contradiction tracking
- stale claim detection
- orphan page detection
- unsupported claim detection

完了条件:

- wiki の保守作業を LLM が継続的に提案できる

### Phase E: local sync

やること:

- clone/export API
- local manifest format
- local diff
- `base_revision_id` 付き push
- conflict reject と再同期フロー

完了条件:

- canister からローカル working copy を作れる
- changed pages / sections だけを push できる
- remote 競合時に安全に reject される

## 14. やらないこと

初期にやらないことを明確に固定します。

- `documents` を wiki 正本にする
- 初期段階で `documents` projection を作る
- raw chunks 全量を最初から vector 化する
- old revisions を検索対象にする
- page 単位で毎回再埋め込みする
- `index.md` を手で保守する
- queue/worker を search engine 側に押し込む

## 15. 直近の実装順

最初の着手順は以下です。

1. `wiki_types` の型を固定する
2. app schema を migration として定義する
3. `commit_page_revision` の入出力を固定する
4. markdown -> sections 変換と `content_hash` を実装する
5. `system_pages` の render を入れる
6. `index.md` 主導の読み取り導線を固める
7. 必要になった時点で retrieval を追加する

## 16. 将来の retrieval 追加計画

ここでは、規模拡大後に retrieval が必要になった場合の追加方針だけを定義します。

### 16.2 変更対象

対象は後段で確定します。

候補:

- app DB 上の単純検索追加
- 外部 retrieval engine の導入

### 16.3 ステップ 1: 型拡張

目的:

- 最小限の検索要求と検索結果を API 契約に出す

追加候補:

- `SearchRequest.query_text`
- `SearchRequest.tags`
- `SearchRequest.page_types`
- `SearchRequest.top_k`
- `SearchHit.slug`
- `SearchHit.section_path`
- `SearchHit.score`

検索エンジン固有の型は、この段階では持ち込みません。

### 16.4 ステップ 2: migration 追加

目的:

- retrieval に必要な最小インデックスだけを追加する

内容の例:

- `wiki_pages.slug` の検索補助 index
- `wiki_sections.page_id, is_current, ordinal` の見直し
- `wiki_sections` current view に対する FTS5 virtual table の追加
- `title`, `slug`, `section_path`, `text` を検索対象に含める

どの方式にするかは、実測のボトルネックが出てから決めます。
初回の lexical retrieval は、外部検索基盤ではなく app DB 内の FTS5/BM25 を優先します。

### 16.5 ステップ 3: 検索実装の追加

目的:

- `index.md` 主導の運用を壊さない検索だけを足す
- agent が使いやすい小さい API にとどめる
- 正本と検索 index を同じ SQLite transaction で更新できる構成にする

候補:

- `find_pages(req)`
- `search_sections(req)`
- `search_hybrid(req)`

初期の lexical retrieval 方針:

- `wiki_sections_fts` のような FTS5 テーブルを app DB 内に持つ
- これは正本ではなく `wiki_sections` current rows から作る派生 index とする
- `MATCH` + `bm25()` で section 単位の順位付けを行う
- return は `slug`, `title`, `section_path`, `snippet`, `score` を最小とする
- `wiki_sections` の差分結果から、FTS の upsert/delete 対象も自動決定する

### 16.6 ステップ 4: テスト追加

最低限の追加テスト:

- section 更新後に検索結果が current revision を指す
- old revision が検索対象に残らない
- retrieval がなくても `index.md` だけで主要導線が成立する
- vector 追加後も raw source 全量は対象に入らない

### 16.7 実装順

ライブラリ修正の具体的な順序:

1. 実測で探索上のボトルネックを確認する
2. app DB 上の最小検索を追加する
3. それでも不足する場合のみ外部 retrieval engine を検討する
4. vector/hybrid は最後に追加する

## 17. API 契約

実装前に、wiki 側の API 契約を固定しておくべきです。

理由:

- section 差分更新の入出力がここで決まる
- canister/query/update の責務分離がここで固まる

結論:

- `commit_page_revision`
- `get_page`
- `get_system_page`

この 3 つは先に固定した方がよいです。

### 17.1 `commit_page_revision`

役割:

- 新しい page revision を登録する
- markdown を section 分割する
- current revision を切り替える
- `index.md` / `log.md` を再描画する
- 必要なら embedding job を積む

初版契約:

```rust
pub struct CommitPageRevisionInput {
    pub page_id: String,
    pub expected_current_revision_id: Option<String>,
    pub title: String,
    pub markdown: String,
    pub change_reason: String,
    pub author_type: String,
    pub tags: Vec<String>,
    pub updated_at: i64,
}
```

制約:

- `page_id` は既存 page を指す
- `markdown` は空不可
- `expected_current_revision_id` が不一致なら競合で失敗
- 根拠 source と参照位置は markdown 本文に含める

出力契約:

```rust
pub struct CommitPageRevisionOutput {
    pub revision_id: String,
    pub revision_no: u64,
    pub section_count: u32,
    pub unchanged_section_count: u32,
    pub changed_section_paths: Vec<String>,
    pub removed_section_paths: Vec<String>,
    pub rendered_system_pages: Vec<String>,
}
```

処理契約:

1. page 存在確認
2. revision 作成
3. markdown を section 分割
4. `content_hash` 計算
5. 旧 current sections と比較
6. `wiki_sections` 更新
7. `index.md` / `log.md` 再描画

### 17.2 `search(req)`

役割:

- `index.md` 主導の運用を補助する検索 API

初版契約:

```rust
pub struct SearchRequest {
    pub query_text: String,
    pub page_types: Vec<WikiPageType>,
    pub top_k: u32,
}
```

出力契約:

```rust
pub struct SearchHit {
    pub slug: String,
    pub title: String,
    pub page_type: WikiPageType,
    pub section_path: Option<String>,
    pub snippet: String,
    pub score: f32,
    pub match_reasons: Vec<String>,
}
```

挙動:

- `index.md` を置き換えるものではなく補助とする
- exact title / slug match を優先してよい
- 実装方式は後段で選ぶ
- 対象は current wiki pages / current wiki sections のみとする

### 17.3 `get_page`

検索結果の着地点として、この API も早めに固定してよいです。

初版契約:

```rust
pub struct GetPageRequest {
    pub slug: String,
}
```

出力契約:

```rust
pub struct PageBundle {
    pub page_id: String,
    pub slug: String,
    pub title: String,
    pub page_type: String,
    pub current_revision_id: String,
    pub markdown: String,
    pub sections: Vec<PageSectionView>,
    pub updated_at: i64,
}
```

## 18. 未決事項

着手前にまだ決める必要がある点です。

- `page_type` の列挙
- `section_path` の正規化ルール
- citation の markdown 表現をどう統一するか
- query note を通常 page に昇格させる基準
- 1 canister に載せるサイズ上限をどう見るか
- 将来の push model で conflict をどう扱うか
- retrieval を導入する閾値をどう決めるか

## 19. 現時点の結論

現時点の採用方針は以下です。

- 正本は app tables に置く
- 初期は `documents` projection を持たない
- `index.md` / `log.md` を agent の主入口にする
- 初期は page 読み取り中心で運用する
- retrieval は必要になった時点で追加する
- 後で wiki-only embeddings
- raw docs embedding は最後まで避ける
- 差分更新は section hash 単位

この方針で進めるのが、wiki を主役に保ちつつ、必要な時だけ検索を足すという意味で最も自然です。
