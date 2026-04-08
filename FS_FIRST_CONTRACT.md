# FS First Contract

## 目的

この文書は FS-first 契約の固定メモです。
現在の実装はこの文書をベースに差し替え済みで、後続の変更でも同じ前提を維持します。

## 公開モデル

公開面の第一級概念は `Node` のみです。
wiki 固有の `page`、`revision`、`section`、`system page` は公開契約から外します。

`Node` の必須フィールド:

- `path`
- `kind`
- `content`
- `created_at`
- `updated_at`
- `etag`
- `deleted_at`
- `metadata_json`

`Node.kind` は次の 2 種類だけを扱います。

- `file`
- `source`

`NodeEntry.kind` は次の 3 種類を扱います。

- `directory`
- `file`
- `source`

`directory` は list result 専用の仮想 entry です。
永続化せず、`read_node` / `write_node` / `delete_node` / `search_nodes` / `export_snapshot` / `fetch_updates.changed_nodes` の対象にもなりません。

実装上の SQLite テーブル名は `nodes` ではなく `fs_nodes` です。
これは責務を明示するための命名であり、契約上の意味は変わりません。

## Path 契約

- path は常に `/` から始まる absolute-like 文字列
- 初期運用の正規空間は `/Wiki/...`
- root `/` は list の起点としてのみ扱い、read/write/delete 対象にしない
- 大文字小文字は区別する
- rename はこの段階では定義しない

不正 path:

- `//` を含む
- 末尾が `/`
- `.` セグメントを含む
- `..` セグメントを含む
- 空文字列

## ETag と競合制御

競合制御は revision id ではなく file 単位の `etag` で行います。

- `write_node` と `delete_node` は `expected_etag` を受ける
- 新規作成時は `expected_etag = None` のみ許可する
- 既存 node の更新時は current `etag` と一致しない限り失敗する
- delete も同じルールに従う

`etag` は current state の決定的ハッシュです。
少なくとも次を入力に含めます。

- `path`
- `kind`
- `content`
- `metadata_json`
- `deleted_at`

`updated_at` の差だけでは `etag` を変えません。

## Delete 契約

delete は physical delete ではなく tombstone です。

- delete 時は row を消さず `deleted_at` を設定する
- `read_node` は tombstone を `None` として返す
- `list_nodes` は `include_deleted = true` のときだけ tombstone を返す
- `export_snapshot` は `include_deleted = true` のときだけ tombstone を返す
- `fetch_updates` は `removed_paths` で削除を返す
- `search_nodes` は tombstone を検索対象に含めない
- 同 path の再作成は tombstone row の upsert として扱う

## List 契約

- 非再帰 list では prefix 直下の実ノードに加えて、prefix 直下に visible descendant を持つ仮想 directory entry を返す
- 実ノードと仮想 directory が同じ path を共有する場合は実ノード 1 件だけ返し、`has_children = true` にする
- 仮想 directory の `etag` は空文字列
- 仮想 directory の `deleted_at` は常に `None`
- recursive list は引き続き実ノードだけを返す

## Snapshot 契約

Phase 1 の同期は `snapshot_revision` と node 単位差分だけに絞ります。
section hash や manifest は持ちません。

- `snapshot_revision` は prefix 配下の current non-deleted state から導出する決定的ハッシュ
- `known_snapshot_revision` が一致する場合、`fetch_updates` は空差分を返す
- 不一致の場合、`fetch_updates` は `changed_nodes` と `removed_paths` を返す
- `removed_paths` は tombstone node 本体ではなく path のみ返す
- `known_snapshot_revision` が未登録でも error にはせず、full refresh と同じ返し方をする

## 検索契約

- 検索対象は current non-deleted node の `content`
- `prefix` が指定された場合はその prefix 配下に限定する
- `kind=source` も通常 node と同じ検索契約に従う
- 履歴検索は扱わない

## 初期版の前提

- text node のみ扱う
- binary は扱わない
- `metadata_json` は plain JSON string として保持し、Phase 1 では schema validation しない
- `index.md` と `log.md` は通常 file として扱う
- directory は永続化しない
- batch write/delete API は採用しない
- mirror 管理 metadata は hidden sidecar file ではなく frontmatter で持つ
