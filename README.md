# llm-wiki

remote node store を正本にし、Obsidian vault 内の `Wiki/` を working copy として使う FS-first のメモリ基盤です。

## 現在の構成

- **正本**: IC canister 上の SQLite
- **人間向け入口**: Obsidian plugin
- **agent 向け入口**: Rust CLI
- **ローカル working copy**: Obsidian vault 内の `Wiki/`

canister は `wiki_store` / `wiki_runtime` をそのまま使う構成で、検索も sync も同じ SQLite を正本にしています。

## Canister

canister 実装は [crates/wiki_canister/src/lib.rs](/Users/0xhude/Desktop/work/llm-wiki/crates/wiki_canister/src/lib.rs) にあります。

- `WikiService` 直結
- SQLite は WASI 上で開く
- build は `wasm32-wasip1` + `wasi2ic`
- `init` / `post_upgrade` では FS migration のみを走らせる

公開 API:

- `status`
- `read_node`
- `list_nodes`
- `write_node`
- `delete_node`
- `search_nodes`
- `export_snapshot`
- `fetch_updates`

Candid は [crates/wiki_canister/wiki.did](/Users/0xhude/Desktop/work/llm-wiki/crates/wiki_canister/wiki.did) にあります。

## Search

検索実装は 1 つだけです。

- 実装: [crates/wiki_store/src/fs_store.rs](/Users/0xhude/Desktop/work/llm-wiki/crates/wiki_store/src/fs_store.rs)
- backend: SQLite FTS
- canister の `search_nodes` はこの既存実装をそのまま公開

別の検索実装や canister 専用検索は置いていません。

## Working Copy

Obsidian vault 内の `Wiki/` を working copy として使います。

主な mirror 仕様:

- remote `/Wiki/foo.md` -> local `Wiki/foo.md`
- remote `/Wiki/nested/bar.md` -> local `Wiki/nested/bar.md`
- conflict file -> `Wiki/conflicts/<basename>.conflict.md`

tracked local mirror file の frontmatter:

- `path`
- `kind`
- `etag`
- `updated_at`
- `mirror: true`

## CLI

agent 用 CLI は [crates/wiki_cli](/Users/0xhude/Desktop/work/llm-wiki/crates/wiki_cli) にあります。

主なコマンド:

- `read-node`
- `list-nodes`
- `write-node`
- `delete-node`
- `search-remote`
- `status`
- `lint-local`
- `pull`
- `push`

役割:

- remote の node / search を読む
- local `Wiki/` working copy の構造を点検する
- vault 内 `Wiki/` へ pull する
- local 変更を remote に push する

## Obsidian Plugin

plugin は [plugins/kinic-wiki](/Users/0xhude/Desktop/work/llm-wiki/plugins/kinic-wiki) にあります。

役割:

- human が `Wiki/` mirror を確認する
- pull / push / delete / conflict note を Obsidian UI から実行する
- canister を直接 call する

plugin の詳細は [plugins/kinic-wiki/README.md](/Users/0xhude/Desktop/work/llm-wiki/plugins/kinic-wiki/README.md) を参照してください。

## Build

canister build は [scripts/build-wiki-canister.sh](/Users/0xhude/Desktop/work/llm-wiki/scripts/build-wiki-canister.sh) で行います。

流れ:

1. `cargo build --target wasm32-wasip1 -p wiki-canister`
2. `wasi2ic`
3. `ic-wasm` で `candid:service` metadata を埋め込む

`icp.yaml` は custom build でこの script を呼びます。[icp.yaml](/Users/0xhude/Desktop/work/llm-wiki/icp.yaml)

## 開発時の主な確認

Rust:

```bash
cargo test
cargo build --target wasm32-wasip1 -p wiki-canister
ICP_WASM_OUTPUT_PATH=/tmp/wiki_canister_test.wasm bash scripts/build-wiki-canister.sh
```

plugin:

```bash
cd plugins/kinic-wiki
npm run check
```
