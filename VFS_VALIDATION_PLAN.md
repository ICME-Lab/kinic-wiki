# VFS Validation Plan

## 目的

この repo の検証は次の順番で進める。

1. まず `VFS` を検証する
2. `VFS` が十分と判断できたら `llm-wiki` を検証する

この切り分けを優先する理由は、現状の `llm-wiki` がまず `FS-first substrate` として成立しているかを固める段階だからです。
wiki としての品質評価を先に混ぜると、保存・同期・検索・競合制御の問題と、知識ベース運用の問題が混線しやすくなります。

## VFS 検証方針

repo 内テスト、`canbench`、deployed canister bench を役割ごとに分けて扱う。

### 1. Repo 内テスト

まず correctness の土台として、既存の Rust テストと plugin check を通す。

### 2. `canbench` / deployed canister bench

実際に benchmark で追う API は次を対象にする。

- `write_node`
- `append_node`
- `edit_node`
- `move_node`
- `delete_node`
- `list_nodes`
- `glob_nodes`
- `search_nodes`
- `export_snapshot`
- `fetch_updates`

## VFS で必ず測るシナリオ

### 正常系

- 1KB, 4KB, 16KB, 64KB の markdown を新規作成する
- 既存 node に小さな追記を行う
- 既存 node に plain-text edit を行う
- rename を行い、新 path が見え、旧 path が消えることを確認する
- physical delete 後に同 path 再作成ができることを確認する

### 競合制御

- `etag` 一致時の更新
- `etag` 不一致時の更新失敗
- delete 時の `etag` 不一致失敗

### 探索と検索

- 1,000 / 10,000 node 下での `list_nodes`
- 深い階層での `glob_nodes("**/*.md")`
- FTS ありでの `search_nodes`

### 同期

- `fetch_updates` の空差分
- `fetch_updates` の小差分
- rename 後に `removed_paths + changed_nodes` が期待通り返ること
- delete を含む場合の `removed_paths` 差分が崩れないこと

## VFS の合格条件

### 正しさ

- CRUD、move、search、sync 差分が壊れない
- `etag` 衝突が期待通り失敗する
- physical delete と同 path 再作成が一貫する

### 性能

- node 数が増えても `list_nodes` / `search_nodes` / `fetch_updates` が急に崩れない
- 小変更時に full refresh に逃げず差分同期できる
- 単発更新で transaction コストが許容範囲に収まる

### 運用性

- mirror で conflict が観測できる
- Obsidian 側で pull / push / delete が安定する

## VFS の次に行う llm-wiki 検証

VFS が終わったら、ここからは「知識ベースとして成立しているか」を見る。

- `index.md` を入口に辿れるか
- source から page 更新までの運用が回るか
- citation が本文近くに残るか
- orphan page を検出できるか
- search が navigation の補助として十分か
- 人間編集と agent 編集が破綻しないか

## おすすめの実施順

1. 既存の Rust テストを土台に VFS correctness を拡張する
2. `canbench` と deployed canister bench で VFS workload を確認する
3. VFS 合格後に `llm-wiki` の運用シナリオ試験へ進む

## 実行手順

VFS 段階の最小実行セットは次の通り。

```bash
cargo test --workspace
cd plugins/kinic-wiki && npm run check
bash scripts/build-wiki-canister-canbench.sh
```

`canbench` 実行環境がある場合は追加で次を使う。

```bash
bash scripts/run_canbench_guard.sh
```

チェック項目と未カバー一覧は `VFS_CORRECTNESS_CHECKLIST.md` を参照する。
deployed canister bench の契約は `VFS_DEPLOYED_CANISTER_BENCHMARKS.md` を参照する。
