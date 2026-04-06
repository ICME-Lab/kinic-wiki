# Obsidian Plugin Plan

## 1. Goal

Obsidian desktop plugin で ICP 上の wiki を vault に mirror し、Obsidian 標準の UX をそのまま使えるようにする。

狙い:

- Graph View で wiki の形を把握できる
- Backlinks / Local graph / Search / Quick switcher をそのまま使える
- 正本は ICP 側に保ちつつ、vault を mirror / working copy として扱う

前提:

- plugin は desktop-only
- 正本は ICP 側
- Obsidian vault は `Wiki/` 配下への mirror / working copy
- 初期は pull 中心
- push は Phase 2

## 2. Core Model

責務分担:

- 正本: ICP canister
- mirror / working copy: Obsidian vault
- bridge: Obsidian plugin

この構成にする理由:

- Obsidian の graph/backlinks は vault 内ファイルと `[[wikilink]]` を前提にしている
- API 表示だけでは Graph View を自然に使えない
- mirror を置けば Obsidian の標準機能をそのまま活かせる

## 3. Plugin Scope

### 3.1 Platform

- `desktop-only`
- `manifest.json` の `isDesktopOnly` は `true`

理由:

- Electron / Node 前提で単純に実装できる
- mobile 制約を最初から背負わない
- 将来 CLI やローカル補助ツールとつなぎやすい

### 3.2 First Release Scope

Phase 1:

- vault への mirror
- `index.md` / `log.md` / page files の生成
- `pull` と `refresh`
- status 表示

Phase 2:

- current note の push
- changed wiki notes の push
- delete
- conflict note 生成

後回し:

- mobile 対応
- branch 相当の高度同期
- 3-way auto merge
- plugin 独自 graph view

## 4. Vault Layout

固定構成:

- `Wiki/index.md`
- `Wiki/log.md`
- `Wiki/pages/<slug>.md`
- `Wiki/conflicts/<slug>.conflict.md` (Phase 2)

ルール:

- `page_type` ごとのサブフォルダは作らない
- 全 page は最初は `Wiki/pages/` に flat に置く
- slug が mirror 側 file identity
- remote identity は常に `page_id`

理由:

- path を安定化したい
- link 解決を単純にしたい
- path 変更によるリンク破壊を避けたい

## 5. File Format

各 page mirror file は frontmatter + markdown 本文で持つ。

例:

```md
---
page_id: page_xxx
slug: alpha
page_type: concept
revision_id: revision_xxx
updated_at: 1700000000
mirror: true
---

# Alpha

...
```

frontmatter ルール:

- `page_id`: remote page identity
- `slug`: mirror file identity
- `page_type`: UI 表示と将来の整理用
- `revision_id`: sync 用
- `updated_at`: remote update timestamp
- `mirror: true`: plugin 管理対象であることを示す

本文ルール:

- canister から受けた markdown を mirror 用に正規化して保存
- wiki 内リンクは `[[slug]]` に統一する
- `index.md` / `log.md` でも可能な範囲で `[[slug]]` に寄せる

## 6. Link Normalization

mirror 側の内部リンクは必ず `[[slug]]` に正規化する。

方針:

- plugin が remote markdown を mirror に書く前にリンク変換する
- Graph View / Backlinks / Outgoing links が確実に効く形を優先する
- remote 側の page identity は `page_id` でも、mirror 側のリンク identity は `slug`

重要:

- Obsidian 標準の内部リンク体験を活かすには mirror が必要
- API 表示だけでは Obsidian コアのリンク解決に自然には載らない

## 7. Plugin Settings

最小設定:

- `adapterBaseUrl`
- `mirrorRoot`
  - 既定値: `Wiki`
- `autoPullOnStartup`
  - 既定値: `true`
- `openIndexAfterInitialSync`
  - 既定値: `true`

後回し:

- 複数 canister 接続
- 複雑な認証設定
- 高度な write policy

## 8. Commands

### Phase 1

- `Wiki: Initial Sync`
- `Wiki: Pull Updates`
- `Wiki: Open Index`
- `Wiki: Open Log`
- `Wiki: Show Wiki Status`

### Phase 2

- `Wiki: Push Current Note`
- `Wiki: Push All Changed Wiki Notes`
- `Wiki: Delete Current Wiki Page`
- `Wiki: Show Sync Conflicts`

## 9. Local Plugin State

保持する state:

- `lastSnapshotRevision`
- `lastSyncedAt`
- `adapterBaseUrl`
- `mirrorRoot`

保持しないもの:

- page ごとの独自検索 index
- リンクグラフの独自キャッシュ
- 独自 backlinks cache

理由:

- plugin を薄く保つ
- canister と Obsidian に責務を寄せる

## 10. API Usage

### Phase 1

使う API:

- `export_wiki_snapshot`
- `fetch_wiki_updates`
- `get_system_page("index.md")`
- `get_system_page("log.md")`
- `status`

### Phase 2

使う API:

- `commit_wiki_changes`

補助:

- conflict payload
- delete
- `snapshot_was_stale`

## 11. Initial Sync Algorithm

1. `export_wiki_snapshot(include_system_pages=true)` を呼ぶ
2. `Wiki/` と `Wiki/pages/` を作る
3. `Wiki/index.md` と `Wiki/log.md` を書く
4. 各 page を `Wiki/pages/<slug>.md` に書く
5. markdown 内リンクを `[[slug]]` に正規化する
6. remote にない古い mirror file は削除する
7. `lastSnapshotRevision` を保存する
8. 必要なら `Wiki/index.md` を開く

注意:

- `Wiki/` 配下以外は触らない
- plugin 管理対象は frontmatter の `mirror: true` を持つものに限定する

## 12. Pull Updates Algorithm

1. `Wiki/pages/*.md` の frontmatter から `page_id`, `revision_id` を集める
2. `fetch_wiki_updates(known_snapshot_revision, known_page_revisions, include_system_pages=true)` を呼ぶ
3. `changed_pages` を `Wiki/pages/<slug>.md` に上書きする
4. `removed_page_ids` に対応する local file を削除する
5. `index.md` / `log.md` を更新する
6. `lastSnapshotRevision` を更新する

削除ルール:

- local file の frontmatter にある `page_id` と `removed_page_ids` を対応づける
- slug ではなく `page_id` を正とする

## 13. Push Current Note Algorithm

Phase 2 で有効化する。

1. 現在ノートが `Wiki/pages/*.md` 配下か確認する
2. frontmatter から `page_id`, `revision_id`, `slug` を読む
3. 本文を取得する
4. `commit_wiki_changes` に `change_type=update` で送る
5. 成功なら返ってきた `revision_id` で frontmatter を更新する
6. `system_pages` が返れば `index.md`, `log.md` も更新する
7. `snapshot_was_stale=true` なら notice で「remote は進んでいたが今回の更新は適用済み」と示す
8. reject なら conflict note を生成する

## 14. Delete Algorithm

Phase 2 で有効化する。

削除はファイルの直接削除ではなく明示コマンドにする。

理由:

- 誤削除を避ける
- remote delete を明示操作にしたい

手順:

1. 現在ノートの `page_id`, `revision_id` を読む
2. `commit_wiki_changes` に `change_type=delete` で送る
3. 成功なら local file を削除する
4. `index.md` / `log.md` を更新する
5. `manifest_delta.removed_page_ids` を state に反映する

## 15. Conflict UX

push 失敗時は元ノートをそのまま残し、別ファイルで conflict を出す。

配置:

- `Wiki/conflicts/<slug>.conflict.md`

内容:

- `conflict_markdown` をそのまま保存する
- `<<<<<<< LOCAL / ======= / >>>>>>> REMOTE` を含む

補助情報:

- `conflicting_section_paths`
- `local_changed_section_paths`
- `remote_changed_section_paths`

UX 方針:

- 元ノートは壊さない
- conflict は別 note で確認させる
- notice で conflict 発生を知らせる

## 16. Sync Semantics

現行前提:

- branch 機能はない
- conflict は Git 的 merge というより stale write 防止に近い

したがって plugin は:

- 高度な branch merge は前提にしない
- `base_revision_id` ベースの optimistic concurrency を前提にする
- `snapshot_was_stale` は remote が進んでいたことのヒントとして扱う
- `base_snapshot_revision` は request 全体の hard gate ではない

## 17. Module Structure

最小構成:

- `main.ts`
  - plugin entry
- `settings.ts`
  - 設定 UI と state 保存
- `client.ts`
  - ICP API 呼び出し
- `mirror.ts`
  - path 解決、frontmatter 読み書き、file write/delete
- `sync.ts`
  - initial sync / pull / push / delete
- `links.ts`
  - markdown 内リンク正規化

## 18. Acceptance Criteria

### Phase 1

- `Initial Sync` で `Wiki/` 配下に page / `index.md` / `log.md` が生成される
- mirror file の内部リンクが `[[slug]]` で解決される
- Graph View にページ間関係が出る
- Backlinks / Local graph / Search / Quick switcher がそのまま使える
- `Pull Updates` で changed / removed が mirror に反映される

### Phase 2

- `Push Current Note` が成功する
- stale snapshot でも非衝突 page は push できる
- conflict 時に `Wiki/conflicts/` に conflict note ができる
- `Delete Current Wiki Page` で remote/local の両方が削除される

## 19. Explicit Decisions

- plugin は desktop-only
- mirror は `Wiki/` 配下に書く
- page file は `Wiki/pages/<slug>.md`
- remote identity は `page_id`
- mirror identity は `slug`
- link は `[[slug]]` に正規化する
- 初期は pull-first
- push は Phase 2
- delete は explicit command
- conflict は別 note で出す
- branch 風 merge はやらない
