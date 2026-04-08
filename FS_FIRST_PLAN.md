# FS First Plan

## 目的

canister の正本モデルを wiki 固有の `page/revision/section/system page` から切り離し、agent が自然に使える filesystem-first なモデルへ移行する。

この移行では、FS を UI や adapter ではなく第一級の公開モデルとする。
保存は relational DB を使い続けるが、公開 API と内部モデルの中心は `node(path, content, kind, ...)` に置く。

## 前提

- 互換 shim は入れない。
- 旧 wiki schema の自動吸収はしない。
- 破壊的変更として明示的に切り替える。
- `index.md` / `log.md` のような system page の自動生成はやめる。
- 競合解決は section 単位ではなく file 単位にする。
- 検索は current content に対してのみ行い、履歴検索は初期版では扱わない。

## 実装結果

この計画は実装済みです。
現在の repo は FS-first を正本として動作し、旧 wiki 層は削除されています。

### 現在の保存モデル

中核テーブルは `fs_nodes` と `fs_nodes_fts` です。
計画初期の文言では `nodes` / `nodes_fts` と書いていたが、実装では FS-first の責務を明示するため `fs_` prefix を採用しています。

- `fs_nodes`
  - `path TEXT PRIMARY KEY`
  - `content TEXT NOT NULL`
  - `kind TEXT NOT NULL`
  - `created_at INTEGER NOT NULL`
  - `updated_at INTEGER NOT NULL`
  - `etag TEXT NOT NULL`
  - `deleted_at INTEGER NULL`
  - `metadata_json TEXT NOT NULL DEFAULT '{}'`
- `fs_nodes_fts`
  - current non-deleted node の FTS index
- `fs_snapshots`
- `fs_snapshot_nodes`

永続化される `kind` は次の 2 種類です。

- `file`
- `source`

`directory` は row として永続化せず、`list_nodes` の返り値でのみ仮想的に返します。

### 現在の公開 API

canister API は wiki API ではなく FS API に寄せる。

- `read_node(path) -> opt Node`
- `list_nodes(prefix, recursive, include_deleted) -> vec NodeEntry`
- `write_node(path, content, kind, expected_etag) -> WriteResult`
- `delete_node(path, expected_etag) -> DeleteResult`
- `search_nodes(query, prefix, top_k) -> vec SearchHit`
- `export_snapshot(prefix) -> Snapshot`
- `fetch_updates(known_snapshot_revision, prefix) -> Delta`

競合制御は `expected_etag` に一本化する。
現行の `expected_current_revision_id` は廃止する。

現時点では batch `write/delete` API は入れていません。
`commit_wiki_changes` を 1 対 1 で置き換えるのではなく、単発の `write_node` / `delete_node` を公開契約にしています。

### 現在の検索

検索は `fs_nodes` の current content に対する FTS です。

- FTS テーブル: `fs_nodes_fts`
- index 対象: `deleted_at IS NULL` の node
- write/delete と同じ transaction で更新

## 捨てるもの

以下は新モデルでは第一級概念として持たない。

- `wiki_pages`
- `wiki_revisions`
- `wiki_sections`
- `system_pages`
- `log_events`
- section 単位 diff
- revision 単位 history API
- system page 自動再生成

必要ならそれらは agent が普通の file として表現する。

## 置き換え結果

### API

- `get_page` は `read_node` に統合する
- `get_system_page` は廃止する
- `commit_wiki_changes` は廃止した
- `create_source` は廃止し、`kind=source` の `write_node` に統一した
- `search` は `search_nodes` に置き換える

### mirror / sync

Obsidian 側の `Wiki/` は remote nodes の working copy として扱う。

- pull: remote の node を path ベースで mirror する
- push: local file を path 単位で `write_node` / `delete_node` に反映する
- conflict: `etag` mismatch のみ扱う

mirror 管理 metadata は hidden sidecar file ではなく frontmatter で保持しています。
この点は初期案からの変更で、理由は managed file 単位で `path/kind/etag/updated_at` を閉じ込めた方が実装と運用が単純だったためです。

## 段階的移行の結果

### Phase 1: 型と API の確定

実施内容:

- `wiki_types` に FS-first の型を追加する
- `wiki.did` の新しい interface を定義する
- path ルール、etag ルール、delete semantics を固定する

結果:

- Rust 型
- Candid interface
- API 契約メモ

を揃えて完了。

### Phase 2: 新 store 実装

実施内容:

- `fs_nodes` schema migration を追加する
- `fs_nodes` の read/write/list/delete/search を実装する
- `fs_nodes_fts` を実装する

結果:

- store 単体テストで file 単位の read/write/delete/search が通ること
- etag mismatch の衝突が確認できること

を満たして完了。

### Phase 3: runtime / canister 差し替え

実施内容:

- `WikiService` を FS API 中心に差し替える
- canister entrypoint を FS API に置き換える
- `wiki.did` を更新する

結果:

- canister テストが新 API 前提で通ること
- migration 後に `read/list/write/search` が一貫して動くこと

を満たして完了。

### Phase 4: CLI / plugin 更新

実施内容:

- CLI を path ベース操作へ更新する
- plugin を node mirror に更新する
- pull/push/conflict を etag ベースに揃える

結果:

- local `Wiki/` と remote node の roundtrip が成立すること
- agent が file path ベースで自然に扱えること

を満たして完了。

### Phase 5: 旧実装削除

実施内容:

- wiki 固有 schema とコードを削除する
- README と計画書を FS-first 前提に更新する
- 不要テストを削除し、新モデルのテストに置き換える

結果:

- `page/revision/section/system page` 依存コードが残っていないこと

を満たして完了。

## 実装順

実装順は次の順で完了した。

1. `wiki_types` に新型を追加
2. `wiki.did` 新案を追加
3. `nodes` schema と migration を追加
4. store 実装と FTS 実装を追加
5. runtime を差し替え
6. canister を差し替え
7. CLI を更新
8. plugin を更新
9. 旧 wiki 実装を削除

## テスト方針

最低限必要なテストは実装済みです。

- write 後に read できる
- list が prefix ごとに正しく返る
- delete 後に read/search に出ない
- search が current content だけを見る
- stale etag の write/delete が失敗する
- snapshot/export/fetch_updates が path 単位で整合する
- CLI pull/push の roundtrip が崩れない

加えて plugin の `npm run check` と canister の Candid 一致テストも通しています。

## 主な設計判断

最終的に以下を採用しています。

- path は absolute-like な `/Wiki/...` 文字列
- rename は初期版では未対応
- binary は初期版では未対応
- delete は tombstone を残す
- search は全文検索のみ
- history は持たない
- index/log は agent が普通の file として管理する

初期案からの差分は次の通りです。

- テーブル名は `nodes` ではなく `fs_nodes`
- FTS テーブル名は `fs_nodes_fts`
- mirror metadata は hidden sidecar file ではなく frontmatter
- batch write/delete API は未採用

## リスク

### 失うもの

- revision 履歴の明示性
- section 単位の差分と競合解決
- system page の自動整合
- wiki 構造を DB が担保する仕組み

### 得るもの

- agent にとって自然な操作体系
- API の単純化
- local mirror と remote の対応の明確化
- wiki 以外の agent memory にも展開しやすい構造

## 判断

この移行は「wiki を薄くする」のではなく、プロダクトの中心を wiki model から agent filesystem model に置き換える判断である。

そのため、中途半端に両モデルを共存させず、FS-first を正本として一気に切り替える方が設計は安定する。
