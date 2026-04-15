# FS First Contract

## 目的

この文書は FS-first 契約の固定メモです。  
対象は VFS / FS API / path / snapshot / sync 契約に限定します。  
wiki 運用規約の正本は `LLM_WIKI_PLAN.md` とします。

## 公開モデル

公開面の第一級概念は `Node` のみです。

- `path`
- `kind`
- `content`
- `created_at`
- `updated_at`
- `etag`
- `metadata_json`

`Node.kind` は次の 2 種類を扱います。

- `file`
- `source`

`NodeEntry.kind` は次の 3 種類を扱います。

- `directory`
- `file`
- `source`

`directory` は list result 専用の仮想 entry です。  
永続化せず、`read_node` / `write_node` / `delete_node` / `search_nodes` / `export_snapshot` / `fetch_updates.changed_nodes` の対象にもなりません。

## Path 契約

- path は常に `/` から始まる absolute-like 文字列
- 初期運用の正規空間は `/Wiki/...` と `/Sources/...`
- root `/` は list の起点としてのみ扱う
- 大文字小文字は区別する
- `move_node` による 1 node 単位 rename を扱う

不正 path:

- `//` を含む
- 末尾が `/`
- `.` セグメントを含む
- `..` セグメントを含む
- 空文字列

raw source の canonical 例:

```text
/Sources/raw/openai-api/openai-api.md
/Sources/raw/openai-api/figure-1.png
```

`kind=source` は raw source 用の node に使います。  
wiki 運用上の source summary page は通常の `kind=file` として `/Wiki/...` に置きます。

## ETag と競合制御

競合制御は file 単位の `etag` で行います。

- `write_node` と `delete_node` は `expected_etag` を受ける
- 新規作成時は `expected_etag = None` のみ許可する
- 既存 node 更新時は current `etag` 一致が必須
- delete も同じルールに従う

`etag` は current state の決定的ハッシュです。  
少なくとも次を入力に含めます。

- `path`
- `kind`
- `content`
- `metadata_json`

## 最小 VFS API

公開 API は次を含みます。

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

補足契約:

- `append_node`
  - 新規作成時は `expected_etag = None` のみ許可
  - 更新時は current `etag` 一致が必須
- `edit_node`
  - plain string の find-and-replace のみ
  - `replace_all = false` では 1 件一致だけ成功
- `mkdir_node`
  - DB row は作らない
  - valid path を確認する no-op success API
- `move_node`
  - 1 node 単位 rename
  - copy でも delete+create でもない
- `glob_nodes`
  - shell-style の `*` / `**` / `?` を扱う
- `recent_nodes`
  - 実 node だけを `updated_at DESC` で返す
- `multi_edit_node`
  - atomic な全件置換を複数順番に適用する

## Delete / List / Snapshot / Search

### Delete

- delete は physical delete
- `fetch_updates` は削除を `removed_paths` で返す
- 同 path の再作成は通常の新規作成として扱う

### List

- 非再帰 list では実 node に加えて仮想 directory entry を返せる
- recursive list は実 node のみ
- 仮想 directory の `etag` は空文字列

### Snapshot

- Phase 1 の同期は `snapshot_revision` と node 単位差分に絞る
- `export_snapshot` / `fetch_updates` は `limit` / `cursor` でページングする
- `export_snapshot` は session 永続のため update call
- `fetch_updates` は query call
- `removed_paths` は削除済み node 本体ではなく path のみ返す

### Search

- 検索対象は current node の `content`
- `prefix` 指定時はその prefix 配下に限定する
- `kind=source` も通常 node と同じ検索契約に従う
- 履歴検索は扱わない

## 初期版の前提

- text node のみ扱う
- binary は扱わない
- `metadata_json` は plain JSON string として保持する
- `index.md` と `log.md` は通常 file として扱う
- directory は永続化しない
- batch write/delete API は採用しない
- mirror 管理 metadata は hidden sidecar file ではなく frontmatter で持つ

wiki 運用規約、ページ分類、provenance 表現、query 結果反映規則、`## Sources` 規約は `LLM_WIKI_PLAN.md` を参照します。
