# FS First Plan

## 目的

この文書は FS-first 化の移行完了メモです。  
wiki 運用や情報設計の正本は `LLM_WIKI_PLAN.md` とし、この文書は公開モデル差し替えの結果だけを記録します。

## 前提

- 互換 shim は入れない
- 旧 wiki schema の自動吸収はしない
- 破壊的変更として明示的に切り替える
- index/log は agent が普通の file として管理する
- system page 自動生成はやめる
- 競合解決は section 単位ではなく file 単位にする
- 検索は current content に対してのみ行い、履歴検索は初期版では扱わない

## 実装結果

この計画は実装済みです。  
現在の repo は FS-first を正本として動作し、旧 wiki 層は削除されています。

### 保存モデル

中核テーブルは `fs_nodes` と `fs_nodes_fts` です。

- `fs_nodes`
  - `path TEXT PRIMARY KEY`
  - `content TEXT NOT NULL`
  - `kind TEXT NOT NULL`
  - `created_at INTEGER NOT NULL`
  - `updated_at INTEGER NOT NULL`
  - `etag TEXT NOT NULL`
  - `metadata_json TEXT NOT NULL DEFAULT '{}'`
- `fs_nodes_fts`
  - current node の FTS index
- `fs_snapshots`
- `fs_snapshot_nodes`

永続化される `kind` は次の 2 種類です。

- `file`
- `source`

`directory` は row として永続化せず、`list_nodes` の返り値でのみ仮想的に返します。

### 公開 API

canister API は wiki 固有 API ではなく FS API に寄せました。

- `read_node`
- `list_nodes`
- `write_node`
- `append_node`
- `edit_node`
- `mkdir_node`
- `move_node`
- `delete_node`
- `glob_nodes`
- `recent_nodes`
- `multi_edit_node`
- `search_nodes`
- `export_snapshot`
- `fetch_updates`

競合制御は `expected_etag` に一本化しています。

### 検索

検索は `fs_nodes` の current content に対する FTS です。

- FTS テーブルは `fs_nodes_fts`
- index 対象は current node
- write/delete と同じ transaction で更新する

## 捨てたもの

新モデルでは次を第一級概念として持ちません。

- `wiki_pages`
- `wiki_revisions`
- `wiki_sections`
- `system_pages`
- `log_events`
- section 単位 diff
- revision 単位 history API
- system page 自動再生成

必要ならそれらは agent が普通の file として表現します。

## 置き換え結果

### API

- `get_page` は `read_node` に統合
- `get_system_page` は廃止
- `commit_wiki_changes` は廃止
- `create_source` は廃止し、`kind=source` の `write_node` に統一
- `search` は `search_nodes` に置き換え

### mirror / sync

Obsidian 側の `Wiki/` は remote nodes の working copy として扱います。

- pull は remote node を path ベースで mirror
- push は local file を path 単位で `write_node` / `delete_node` に反映
- conflict は `etag` mismatch のみ扱う

mirror 管理 metadata は hidden sidecar file ではなく frontmatter で保持します。

### ツール層

Rust CLI crate には ready-made tool 定義を追加済みです。

- `read`
- `write`
- `append`
- `edit`
- `ls`
- `mkdir`
- `rm`
- `search`
- `mv`
- `glob`
- `recent`
- `multi_edit`

## 実装順

実装順は次の通りで完了しました。

1. `wiki_types` に FS-first の型を追加
2. `wiki.did` 新案を追加
3. schema と migration を追加
4. store と FTS を実装
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

加えて plugin の `npm run check` と canister の Candid 一致テストを通しています。

## 文書の役割分担

- FS API / path / snapshot / sync 契約は `FS_FIRST_CONTRACT.md`
- wiki 運用規約は `LLM_WIKI_PLAN.md`
- この文書は FS-first 化の移行記録

raw source 配置、source summary、index first、`## Sources`、会話結果の反映規則などの wiki 運用はこの文書ではなく `LLM_WIKI_PLAN.md` を参照します。
