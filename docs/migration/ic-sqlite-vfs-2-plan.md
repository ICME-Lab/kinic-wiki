# ic-sqlite-vfs 2.0.0 migration prep

## Scope

- 目的: 同じ canister ID を維持した `reinstall + logical import` の準備。
- 対象: active DB 13 件の metadata、members、nodes。
- 除外: pending DB 2 件、cycles balance、cycle ledger、suspended state、storage billing ledger。
- 禁止: `ic-sqlite-vfs 0.2.1` の v6 layout を `2.0.0` が読む前提の直接 upgrade。
- 本番の reinstall、canister snapshot 作成、import 実行はこの文書の対象外。

## Backup Artifacts

復元入力:

- `summary.json`
- `index-databases.json`
- `index-members.json`
- `index-audit.json`
- `backup-node-write-times.json`
- `<database_id>/nodes.jsonl`

監査のみ:

- `index-cycle-balances.json`

復元しない pending DB:

- `db_cqzxtadvjzkk`
- `db_tcskpbpkei6h`

## Import API

全 API は controller-only。

- `controller_import_database_metadata`
  - `index-databases.json` から `database_id`、`name`、`schema_version`、`created_at_ms`、`updated_at_ms` を投入。
  - `status` は `active` 固定。
  - `profile` が backup に無い場合は `Workspace`。
  - cycle account は作成しない。
- `controller_import_database_members`
  - `index-members.json` を正本として role と `created_at_ms` を保持。
  - member の `database_id` 不一致、principal 重複、member 上限超過は reject。
- `controller_import_nodes_chunk`
  - `<database_id>/nodes.jsonl` の `Node` を path 昇順、100 nodes/chunk で投入。
  - `created_at`、`updated_at`、`etag`、`metadata_json` を保持。
  - chunk 内 duplicate path と未ソート chunk は reject。
  - 通常 write API は使わない。
- `controller_finalize_import`
  - logical size を再計算し、verify 結果を返す。

raw database archive/restore は `ic-sqlite-vfs 2.0.0` 移行後の canister build では非対応。移行は logical import を正経路にする。

## Verify API

全 API は controller-only。

- `controller_verify_database(database_id)`
- `controller_verify_all_databases()`

返却値:

- DB count
- member count
- node count
- file count
- max node updated_at
- logical checksum
- SQLite `integrity_check`
- cycle account count

合格条件:

- active 13 DB が存在する。
- pending 2 DB が存在しない。
- DB 単位で node count、file count、max updated_at、logical checksum が backup 側期待値と一致する。
- SQLite `integrity_check = "ok"`。
- `cycle_account_count = 0`。

## Checksum

logical checksum は `etag` を除外する。

対象フィールド:

- `path`
- `kind`
- `content`
- `created_at`
- `updated_at`
- `metadata_json`

計算順:

- `fs_nodes ORDER BY path ASC`
- 各フィールドを length-prefixed で SHA-256 に投入

`etag` は復元するが、主判定には使わない。

## Local Smoke

1. fresh 2.0.0 state で index migration を実行。
2. active 13 DB の metadata を import。
3. active 13 DB の members を import。
4. 各 DB の `nodes.jsonl` を path 昇順、100 nodes/chunk で import。
5. 各 DB で `controller_finalize_import`。
6. `controller_verify_all_databases` を取得。
7. backup 側期待値と次を比較。
   - database count
   - member count
   - node count
   - file count
   - max node updated_at
   - logical checksum
   - `integrity_check`
   - cycle account count

## Tests

- unit:
  - metadata import が cycle account を作らない。
  - duplicate DB metadata import を reject。
  - members が role と `created_at_ms` を保持。
  - nodes が timestamp、metadata、content、etag を保持。
  - duplicate path / unsorted chunk を reject。
- wasm check:
  - `ic-sqlite-vfs 2.0.0` で canister build の型検査が通る。
- migration compatibility:
  - fresh 2.0.0 state で schema 初期化できる。
  - 旧 v6 layout の raw archive/restore 経路に依存しない。

## Preflight Checklist

- final logical export を取得。
- final index backup を取得。
- canister snapshot を作成/download。
- old wasm、candid、settings、controller 一覧を保存。
- backup artifact の SHA-256 と件数を記録。
- import 実行 identity が controller であることを確認。
- active 13 DB と pending 2 DB の一覧を固定。
- reinstall 前停止条件を確認。
  - final export 不一致。
  - snapshot 作成失敗。
  - old wasm/candid/settings 未保存。
  - controller identity 不一致。
- rollback 判定条件を確認。
  - import API 失敗。
  - verify count/checksum 不一致。
  - SQLite `integrity_check != "ok"`。
  - pending DB が復元されている。
  - cycle account が復元されている。

## Rollback Prep

canister snapshot は移行手段ではなく rollback 保険として扱う。

rollback に必要な保存物:

- canister snapshot id / download artifact
- old wasm
- old candid
- old settings
- controllers
- final logical backup
- final index backup
- verify 失敗時の canister 側結果
