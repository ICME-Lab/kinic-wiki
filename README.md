# llm-wiki

remote wiki を正本にし、Obsidian vault 内の `Wiki/` を working copy として使う構成のメモリ基盤です。

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
- `init` / `post_upgrade` では migration を走らせ、`index.md` / `log.md` が欠けているときだけ system page を生成

公開 API:

- `status`
- `search`
- `get_page`
- `get_system_page`
- `export_wiki_snapshot`
- `fetch_wiki_updates`
- `adopt_draft_page`
- `create_source`
- `commit_wiki_changes`

Candid は [crates/wiki_canister/wiki.did](/Users/0xhude/Desktop/work/llm-wiki/crates/wiki_canister/wiki.did) にあります。

## Search

検索実装は 1 つだけです。

- 実装: [crates/wiki_store/src/search.rs](/Users/0xhude/Desktop/work/llm-wiki/crates/wiki_store/src/search.rs)
- backend: SQLite FTS
- canister の `search` はこの既存実装をそのまま公開

別の検索実装や canister 専用検索は置いていません。

## Working Copy

Obsidian vault 内の `Wiki/` を working copy として使います。

主な mirror 仕様:

- `Wiki/pages/<slug>.md`
- `Wiki/index.md`
- `Wiki/log.md`
- `Wiki/conflicts/<slug>.conflict.md`

tracked local mirror page の frontmatter:

- `page_id`
- `slug`
- `page_type`
- `revision_id`
- `updated_at`
- `mirror: true`

draft page の review metadata:

- `slug`
- `title`
- `page_type`
- `draft: true`

## CLI

agent 用 CLI は [crates/wiki_cli](/Users/0xhude/Desktop/work/llm-wiki/crates/wiki_cli) にあります。

主なコマンド:

- `search-remote`
- `get-page`
- `get-system-page`
- `status`
- `lint`
- `lint-local`
- `pull`
- `ingest-source`
- `source-to-draft`
- `generate-draft`
- `query-to-page`
- `adopt-draft`
- `push`

役割:

- remote の page / system page / search を読む
- remote wiki の health report を読む
- local `Wiki/` working copy の構造を点検する
- local markdown を raw source として remote に保存する
- source material から review-ready local draft をまとめて作る
- local markdown から page map ベースの draft を作る
- query や比較の結果を local draft page に戻す
- vault 内 `Wiki/` へ pull する
- review 後の local draft を tracked local mirror page として採用する
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
