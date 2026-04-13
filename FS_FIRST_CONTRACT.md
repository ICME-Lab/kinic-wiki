# FS First Contract

## 目的

この文書は FS-first 契約の固定メモです。
現在の実装はこの文書をベースに差し替え済みで、後続の変更でも同じ前提を維持します。

## 公開モデル

公開面の第一級概念は `Node` のみです。
wiki 固有の `page`、`revision`、`section`、`system page` は公開契約から外します。

現状の空間は single-tenant です。
wire shape に tenant id は入れず、`/Wiki/...` を単一の公開ルートとして扱います。
将来 multi-tenant にする場合は path prefix か canister 境界で分離します。

`Node` の必須フィールド:

- `path`
- `kind`
- `content`
- `created_at`
- `updated_at`
- `etag`
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
- `move_node` による 1 node 単位の rename を扱う

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

`updated_at` の差だけでは `etag` を変えません。

## 最小 VFS API

公開 API は次の最小 VFS を含みます。

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

追加 API の契約:

- `append_node`
  - node がなければ新規作成する
  - node があれば末尾に追記する
  - 新規作成時は `expected_etag = None` のみ許可する
  - 更新時は current `etag` 一致が必須
- `edit_node`
  - plain string の find-and-replace のみ扱う
  - `replace_all = false` では一致が 1 件だけのときだけ成功する
  - 一致なし、または複数一致で `replace_all = false` の場合は失敗する
- `mkdir_node`
  - DB row は作らない
  - valid path を確認する no-op success API として扱う
  - 成功時は常に `created = true` を返す
- `move_node`
  - 1 node 単位の rename として扱う
  - copy でも delete+create でもない
  - `from_path` は existing node 必須
  - `overwrite = false` で既存 target があれば失敗する
- `glob_nodes`
  - shell-style の `*` / `**` / `?` を扱う
  - 実ノードと仮想 directory の両方を返せる
- `recent_nodes`
  - 実ノードだけを `updated_at DESC` で返す
- `multi_edit_node`
  - plain string の全件置換を複数順番に適用する
  - atomic で、途中 1 件でも失敗したら全体を rollback する

## Delete 契約

delete は physical delete です。

- delete 時は row を削除する
- `read_node` は `None` を返す
- `list_nodes` / `export_snapshot` / `recent_nodes` / `search_nodes` には出ない
- `fetch_updates` は `removed_paths` で削除を返す
- 同 path の再作成は通常の新規作成として扱う

## List 契約

- 非再帰 list では prefix 直下の実ノードに加えて、prefix 直下に visible descendant を持つ仮想 directory entry を返す
- 実ノードと仮想 directory が同じ path を共有する場合は実ノード 1 件だけ返し、`has_children = true` にする
- 仮想 directory の `etag` は空文字列
- recursive list は引き続き実ノードだけを返す
- `glob_nodes` はこの仮想 directory 合成結果も検索対象に含められる

## Snapshot 契約

Phase 1 の同期は `snapshot_revision` と node 単位差分だけに絞ります。
section hash や manifest は持ちません。

- `snapshot_revision` は prefix 配下の current state から導出する決定的ハッシュ
- `known_snapshot_revision` が一致する場合、`fetch_updates` は空差分を返す
- 不一致の場合、`fetch_updates` は `changed_nodes` と `removed_paths` を返す
- `removed_paths` は削除済み node 本体ではなく path のみ返す
- `fetch_updates` は差分専用であり、full refresh は返さない
- `known_snapshot_revision` が不正、scope 不一致、または current revision より未来の場合は error を返す
- change log は SQLite storage の実上限まで保持し、古い valid revision でも差分取得を試行する
- 既存 DB で過去の change log が欠損している場合、取得可能範囲より古い revision は error を返す
- 初回同期と scope 変更は `export_snapshot` で snapshot を取得してから `fetch_updates` に移行する
- `move_node` のような物理 rename では旧 path を `removed_paths` に、新 path を `changed_nodes` に返す

## 検索契約

- 検索対象は current node の `content`
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
- `tag` API は採用しない
