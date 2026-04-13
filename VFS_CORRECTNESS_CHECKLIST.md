# VFS Correctness Checklist

## 目的

この文書は、現行の FS-first 契約に対して

- 既に検証済みの項目
- 今回の追加で埋める項目
- まだ未カバーとして残す項目

を明示するためのチェックリストです。

## 契約マトリクス

| 契約 | 主な確認場所 | 状態 |
| --- | --- | --- |
| create / update / delete then recreate | `fs_store_basic`, `fs_store_scale`, `wiki_canister` | 検証済み |
| `etag` 競合 | `fs_store_basic`, `fs_store_vfs`, `wiki_canister` | 検証済み |
| physical delete / removed paths | `fs_store_basic`, `fs_store_sync`, `tests_sync_contract` | 検証済み |
| `append_node` | `fs_store_vfs`, `fs_store_scale`, `wiki_canister` | 検証済み |
| `edit_node` | `fs_store_vfs`, `fs_store_scale`, `wiki_canister` | 検証済み |
| `move_node` / overwrite | `fs_store_vfs`, `fs_store_sync`, `wiki_canister` | 検証済み |
| `list_nodes` shallow / recursive / virtual directory | `fs_store_basic`, `fs_store_scale`, `wiki_canister` | 検証済み |
| 深い階層の `glob_nodes("**/*.md")` | `fs_store_vfs`, `fs_store_scale` | 検証済み |
| `recent_nodes` | `fs_store_vfs`, `wiki_canister` | 検証済み |
| `search_nodes` prefix / deleted node 非表示 | `fs_store_basic`, `fs_store_scale`, `tests_sync_contract` | 検証済み |
| `export_snapshot` 安定性 | `fs_store_basic`, `fs_store_sync`, `wiki_canister` | 検証済み |
| `fetch_updates` empty delta | `fs_store_sync`, `wiki_canister` | 検証済み |
| `fetch_updates` 小差分 | `fs_store_sync`, `fs_store_scale` | 検証済み |
| `fetch_updates` rename 差分 | `fs_store_sync` | 検証済み |
| `fetch_updates` removed paths | `fs_store_sync`, `tests_sync_contract` | 検証済み |
| `fetch_updates` prefix scope change | `fs_store_sync`, `tests_sync_contract` | 検証済み |
| mirror tracked state 更新 | `commands_fs_tests`, `commands_sync_tests` | 検証済み |
| conflict note 生成 | `commands_sync_tests` | 検証済み |

## 今回追加した重点ケース

- 1KB / 4KB / 16KB / 64KB の markdown を使う `write_node` / `append_node` / `edit_node`
- 1,000 node 規模の `list_nodes`
- 深い階層を前提にした `glob_nodes("**/*.md")`
- prefix 制限つき `search_nodes` と deleted node 非表示
- 大きい snapshot に対する小差分 `fetch_updates`
- canister 境界での removed paths / prefix scope change
- CLI mirror での conflict note 生成と tracked state 更新

## 既知の未カバー

- wall-clock ベースの store-level benchmark
- Obsidian 実ランタイム込みの UI 操作テスト
- 長時間運用を前提にした大規模 DB 成長試験

## 実行コマンド

```bash
cargo test --workspace
cd plugins/kinic-wiki && npm run check
bash scripts/build-wiki-canister-canbench.sh
```

`canbench` 実行環境がある場合は、追加で次を使う。

```bash
bash scripts/run_canbench_guard.sh
```
