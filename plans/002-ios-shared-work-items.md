# Plan 002: iOS DB共有項目（WorkItem）

## Status

- **Priority**: P1
- **Risk**: HIGH（VFS上の文書契約とローカルSQLiteスキーマは、実データが入った後は変更コストが高い）
- **Planned at**: commit `0ce00a6e`, 2026-09-17
- **Status**: IN PROGRESS（Phase 1〜3 実装済み。Phase 3 はビルドとユニットテストのみ検証済みで、実機検証は未実施）
- **前提**: 下記「決定事項」D1〜D3が確定していること。Phase 3 の前提は W1〜W3 と D4〜D11（Phase 3 節）。

## Goal

DBごとに共有項目（WorkItem）を残し、同じDBを開いたメンバーが閲覧・コメントし、完了したら閉じる。日付・締切・担当者・ラベル・通知・自動スケジューリングは扱わない。文字・音声・記事共有・Wiki・Ask AI の各導線から1入力1件のWorkItemを作り、まず端末に保存し、通信可能なら送信し、その後AIで整える。

## 決定事項（この計画の前提）

### D1. 名称は `WorkItem`

- 正準ドメイン名: `WorkItem`（Swift型・VFSパス・metadataキー）
- VFS配置: `/WorkItems/<UUID>/`
- UI: 日本語「項目」、英語「Items」。フィルタは 未完了／完了／すべて（Open／Closed／All）
- 理由:
  - `Issue` は不具合報告とGitHub連番を強く連想させ、設計が明示的に排除した「連番」と衝突する。
  - `Task` は締切・担当者・スケジュールを期待させ、初期版の除外方針とUI期待がずれる。AIが1件の中に複数のチェックリストを入れる設計とも一致しない。
  - `WorkItem` は既存コードに衝突がなく、状態（open/closed）とコメントを持ち、日付を含意しない。
- 変更コスト: Phase 1 着手前なら一括置換のみ。`item.md` を実データで書き始めた後は全件移行になる。

### D2. 一覧は派生メタ文書方式（`meta.md`）

`/WorkItems/<UUID>/meta.md` を一覧専用の派生キャッシュとして持つ。

- 理由: `list_children` が返す `ChildNode`、`list_nodes` が返す `NodeEntry` は `path` と `updated_at` 程度しか返さない（`contracts/mainnet-vfs-83bbb0b6.did:488`）。`read_node` は本文ごと返すため、一覧のたびに全件の本文を転送することになる。
- 正本は常に `item.md`。`meta.md` は `item.md` ＋ `comments/` から再構築できる。食い違ったら `item.md` を優先する。
- 一覧は `list_children(/WorkItems)` → 各 `meta.md` を並列 `read_node`。**表示は活動順の上位100件**とし、並び順の正しさを優先して候補は全件読む（ディレクトリの `updatedAt` は作成時刻なので、候補を100件で打ち切ると古い項目への新規コメントが一覧から消える）。読み取りコストはローカルキャッシュの先行表示と30秒のスロットルで緩和する。

### D3. コメントは本体に触らない

- コメント投稿で `item.md` を書き換えない。
- 理由: `write_node` は既存ノードに `expected_etag` が必須で、`None` は「上書き」ではなく必ず `etag_conflict` になる（`crates/vfs_store/src/fs_store.rs:1949-1960`）。コメントのたびに本体を書くと同時コメント・同時Closeと正面衝突し、さらに「AI結果は入力時の版にだけ適用する」判定が他人のコメントで壊れる。
- 一覧の更新順は `max(item.md.updated_at, 最新コメント.updated_at)` として派生させる。

## 利用する既存API（canister側の変更なし）

| 用途 | メソッド | 確認済みの性質 |
|---|---|---|
| 一覧の子取得 | `list_children` | 件数上限なし。`path`/`updated_at`/`etag` のみ |
| 配下列挙 | `list_nodes` | `recursive` + `prefix`。上限100固定（`fs_store.rs:212-223`, `:1422`） |
| 詳細取得 | `read_node` | `content` と `metadata_json` を返す |
| 作成・状態変更 | `mutate_nodes_batch` | 1トランザクション。1件でも失敗したら全ロールバック（`fs_store.rs:354-375`, `:661-701`）。上限100 |
| フォルダ作成 | `Mkdir` mutation | **冪等**。既存フォルダなら `Ok(created: false)`（`fs_store.rs:810-822`） |
| 検索 | `search_nodes` | `prefix` で `/WorkItems/` に限定可能。**cursorなし・上限100** |

補足（実装上の制約として明記）:

- `write_node` は親フォルダが実在しないと `not_found`（`fs_store.rs:2070-2094`）。作成時は `Mkdir` を同一バッチに含める。
- `create_new_node` は `expected_etag` が `Some` だとエラー（`fs_store.rs:1845-1848`）。新規はetagを付けない。
- metadataだけを更新するmutationは存在しない（`Write` は `content` 必須、`Edit`/`MultiEdit` はmetadataを触らない、`Append` は既存ノードのmetadataを無視する `fs_store.rs:1900-1903`）。これが `meta.md` を分ける理由。

## 文書契約 v1（VFS）

```
/WorkItems/<UUID>/item.md              # 正本。本文Markdown
/WorkItems/<UUID>/meta.md              # 一覧用の派生キャッシュ。content は空
/WorkItems/<UUID>/comments/            # コメント格納フォルダ（作成時に一緒に作る）
/WorkItems/<UUID>/comments/<UUID>.md   # コメント。追記のみ
```

### `item.md`

- `content`: WorkItem本文（Markdown）
- `metadata_json`:

```json
{
  "version": 1,
  "captureId": "<UUID。再送の冪等判定に使う>",
  "title": "最初の非空行、またはAIが生成したタイトル",
  "state": "open",
  "createdBy": "<principal>",
  "createdAt": 1737000000000,
  "source": { "kind": "text|voice|share|wiki|ask_ai", "url": null, "path": null, "label": null }
}
```

`source` は元情報への導線。記事共有なら `url`、Wiki文書なら `path`、Ask AIなら出典URL。会話全体は入れない。

### `meta.md`

- `content`: `""`
- `metadata_json`:

```json
{ "version": 1, "title": "...", "state": "open", "commentCount": 3, "lastActivityAt": 1737000000000 }
```

### `comments/<UUID>.md`

- `content`: コメント本文
- `metadata_json`: `{ "version": 1, "author": "<principal>", "createdAt": 1737000000000 }`
- 投稿者情報は既存のDB権限（Writer）で管理される文書属性であり、改ざん防止の監査記録としては扱わない。初期版は追記のみ（編集・削除なし）。

### version の扱い

- 既知のversionは `1` のみ。**未知versionは推測して読み替えない。**
- `item.md` が未知version: 一覧には「この版では開けません」として表示し、詳細は本文のみ読み取り専用（編集・コメント・Close/Reopenを無効化）。
- `meta.md` が未知version: そのキャッシュを使わず、`item.md` を直接読んで `meta.md` を再構築する。

### 書き込みパターン

| 操作 | バッチ内容 | 競合 |
|---|---|---|
| 作成 | `Mkdir /WorkItems` → `Mkdir /WorkItems/<UUID>` → `Mkdir .../comments` → `Write item.md` → `Write meta.md` | 全て新規パスなので競合しない。全or無 |
| 本文・タイトル編集 | `Write item.md`(etag) → `Write meta.md`(etag) | 双方のetag一致時のみ成功。不一致は全体失敗＝正しい競合 |
| Close/Reopen | `Write item.md`(etag) → `Write meta.md`(etag) | 同上 |
| コメント投稿 | `Write comments/<UUID>.md`（etagなし・新規パス） | 競合しない。**`item.md` を触らない** |
| コメント後の `meta.md` | 単独 `Write meta.md`(etag)。read→writeをリトライ | 競合時はリトライ。諦めても一覧の件数・時刻が古いだけ（詳細表示時に再構築） |

## ローカル契約 v1（App Group SQLite）

- 置き場所: App Group（`Config/Kinic.xcconfig` の `APP_GROUP_ID`）配下の `kinic.sqlite`。
- 録音ファイル: App Group 配下 `audio/<captureId>.m4a`。
- 依存追加なし。`import SQLite3`（システム）に薄いラッパーを被せる。GRDB等は導入しない（AGENTS.md「不要な新規依存は追加しない」）。
- migrationは `schema_migrations` による明示的なversion管理。未適用のものだけを1回適用する。`IF NOT EXISTS` に依存しない。

```sql
-- migration v1
CREATE TABLE schema_migrations (
  version    INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
);

-- 端末に入った入力。principal と database_id で分離する
CREATE TABLE captures (
  capture_id           TEXT PRIMARY KEY,   -- WorkItem の UUID と同一
  principal            TEXT NOT NULL,
  database_id          TEXT,               -- NULL = 保存先未選択
  origin               TEXT NOT NULL,      -- text|voice|share|wiki|ask_ai
  raw_text             TEXT NOT NULL,      -- 元の入力（AI適用後も保持）
  provisional_title    TEXT NOT NULL,      -- 最初の非空行
  transcript           TEXT,               -- 文字起こし（永続化後に音声を削除）
  audio_relative_path  TEXT,
  audio_duration_ms    INTEGER,
  source_refs_json     TEXT NOT NULL DEFAULT '[]',
  state                TEXT NOT NULL,      -- local|sent|ai_running|ai_applied|ai_failed|rebase_required
  base_etag            TEXT,               -- AI結果を適用してよい版
  ai_suggestion_json   TEXT,               -- 人手編集で上書きできなかったAI結果（修正候補）
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,
  sent_at              INTEGER
);
CREATE INDEX captures_pending ON captures(principal, state, created_at);

-- 一覧キャッシュ（DB単位）
CREATE TABLE list_cache (
  principal    TEXT NOT NULL,
  database_id  TEXT NOT NULL,
  item_id      TEXT NOT NULL,
  title        TEXT NOT NULL,
  state        TEXT NOT NULL,
  comment_count INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (principal, database_id, item_id)
);

CREATE TABLE sync_state (
  principal       TEXT NOT NULL,
  database_id     TEXT NOT NULL,
  last_fetched_at INTEGER NOT NULL,
  PRIMARY KEY (principal, database_id)
);

-- オンライン確定操作の未送信分（編集・コメント・Close/Reopen）
CREATE TABLE pending_mutations (
  mutation_id  TEXT PRIMARY KEY,  -- UUID。冪等キー
  principal    TEXT NOT NULL,
  database_id  TEXT NOT NULL,
  item_id      TEXT NOT NULL,
  kind         TEXT NOT NULL,     -- edit|comment|close|reopen
  payload_json TEXT NOT NULL,
  created_at   INTEGER NOT NULL
);
```

状態の意味（設計の3区別に対応）:

- `local` = 端末に保存（未送信。共有済みとして表示しない）
- `sent` = DBに追加済み
- `ai_running` = AI整理中
- `ai_applied` / `ai_failed` / `rebase_required` = AI結果の適用結果と、人手編集により適用できなかった状態

不変条件:

- `captures.database_id` は作成後に変更しない（DB切替で送信先を変えない）。
- `pending_mutations` の再送は同一 `mutation_id` を使う。
- アカウント切替時、`list_cache` と `sync_state` はアカウント単位で保持し、ウィジェットの表示内容は消す。未送信 `captures` は保持し、別アカウントに紐付けない。

## 実装フェーズ

### Phase 1: 契約・ローカル保存・VFS接続・Homeの手動一覧/作成/詳細 — 実装済み

- `Models/WorkItem.swift`, `Models/WorkItemComment.swift`, `Models/WorkItemCapture.swift`, `Models/WorkItemMetadata.swift`（encode/decodeとversion判定）
- `Services/VFSClient.swift` に `mutateNodesBatch` を追加、`Services/VFSCandidTypes.swift` に `MutateNodesBatchRequest` / `NodeMutation` / `WriteNodeItem` / `Mkdir` を追加
- `Services/WorkItemRepository.swift`: `list()` / `load(id:)` / `create(capture:)` / `update(...)` / `setState(...)`。VFSの読み書きと `meta.md` 再構築はここに閉じる
- `Services/WorkItemStore.swift`: App Group SQLite、migration v1、`captures` / `list_cache` / `sync_state`
- `Views/WorkItemListView.swift`（Open/Closed/すべて・検索・新規）、`Views/WorkItemDetailView.swift`、`Views/WorkItemComposerView.swift`
- `Views/HomeView.swift`: Homeを一覧に変更し、既存の取り込みと履歴をツールバーへ移す
- `Models/WorkItemDeepLinkRequest.swift` と `ViewModels/AppModel.swift` への導線追加（既存 `BrowseDeepLinkRequest` と同じ作法）

完了条件: Owner/Writerが手動で作成・一覧・詳細を開ける。Readerは閲覧のみ。オフラインでも入力が `captures(state: local)` に残る。`meta.md` を削除しても一覧が `item.md` から再構築される。

### Phase 2: コメント・Close/Reopen・検索・競合・再送 — 実装済み

実装前にローカル canister で実測し、計画の誤りを1件修正した。

- コメント投稿は `[ Mkdir comments（冪等・自己修復）, Write comments/<UUID>.md（新規パス・etag なし） ]` の1バッチ。**`item.md` は触らない**ので同時コメントが互いを壊さない
- 投稿後に `comments/` の実件数から `meta.md` を再計算する（`refreshCommentProjection`）。etag 競合時は再読込して最大3回リトライし、それでも失敗したら古いままにする（詳細を開くと再計算されて自己修復する）
- コメント表示は `list_children(comments/)` → 各文書を read（並列度6）。**古い順**に並べ、上限100件。超過分は「古いコメントN件は表示していません」と明示
- Close/Reopen は `item.md` と `meta.md` を同一バッチで書き、双方の etag を要求する
- 検索: `search_nodes(prefix: "/WorkItems", topK: 100)`。**canister は prefix の末尾 `/` を拒否するため `/WorkItems` を使う（実測で確認）**。ヒットを itemId 単位に集約し、コメントの一致は親項目の件数としてまとめる。cursor が無いためページングは提供せず、100件到達を「絞り込んでください」と明示
- 送信再試行: 応答消失時は同一パスの read で自分の書き込みと一致すれば成功扱い（新規作成・コメントとも）
- 真の競合時: 上書きせず、シートで「最新版」と「自分の編集内容」を並べて選ばせる。最新版を読み込むか、自分の本文を保ったまま最新 etag で保存し直す
- オフライン時: 編集・コメント・Close/Reopen は自動再送せず、`pending_mutations` に保持して画面から手動送信する。送信が成功した種類の保留は自動で破棄する
- `Views/BrowseDocumentView.swift`: `/WorkItems/` 配下は**編集・公開・削除を無効化**し、「項目の詳細を開く」で Home の詳細へ誘導する。公開を許すと item 本文が DB 外に漏れ、削除を許すと項目そのものが失われるため

完了条件: 2アカウントでコメントとCloseが反映される。同時コメント・同時編集・Close競合で他者の変更を上書きしない。Readerの書き込みが拒否される。

レビュー対応（未コミット・実装済み）:

- 未送信編集の再送は `EditPayload.baseEtag` で保存し、最新版の etag で書き直さない。古い base なら競合として最新版と自分の内容を並べる
- 派生文書 `meta.md` だけが動いた競合は、`item.md` の etag が不変である限り投影の etag と件数を読み直して1回だけ再試行する（コメントが本文保存を誤って妨げない）
- 一覧は `list_cache` を先に描画し、30秒以内の再取得は省略する（`refresh(force:)`）。更新系の後と pull-to-refresh は強制取得
- 投影の再構築は `comments/` の実件数を書く（0 固定をやめる）
- 競合解決で最新版を選んだ場合、放棄した `.edit` の保留を破棄する

検証: ローカル canister（`icp network start -e local-wiki -d`）でバッチの原子性・Mkdir の冪等性・空 `comments/` の一覧・検索 prefix を実測。`xcodebuild test` 全342件（32 suites）成功、レビュー対応後は同352件が成功。

### Phase 3: ウィジェット・記事共有・Wiki/Ask AIからの作成 — 実装済み（実機検証は未実施）

計画時点の worktree は Phase 1〜2 が実装済み・未コミットだった。この節のコード参照は原則シンボル名とし、
行番号は安定しているファイルにだけ付ける。実装時に参照シンボル（`WorkItemModel.create(title:body:source:)`、
`cacheList`、`send`、`refreshRemote(force:)`、`WorkItemRuntimeProviding`、`AppModel.requestedWorkItemDetail`、
`AppModel.openURLDestination`、`AppModel.signOut`、`AppModel.appDidBecomeActive`）を Phase 2 最終状態で確認した。

確定済みの範囲:

- **W1**: ウィジェット拡張は `KinicWorkItemsWidget` を新規に独立追加する。未マージの PR #103
  （`feat/ios-dictation-widget` の `KinicVoiceWidget`）には依存しない。両者は共存を許容する。
- **W2**: Phase 3 は**文字導線のみ**。ウィジェットに音声ボタンは置かず、録音と専用録音画面は Phase 4 に残す。
- **W3**: この節が Phase 3 の実行可能な計画。Phase 3 固有の決定事項は D4〜D11 としてここに置く。

#### D4. ウィジェット拡張（新規・独立）

- `mobile/ios/project.yml` に target `KinicWorkItemsWidget`（`type: app-extension`, platform iOS, iOS 18）を追加する。
  - `PRODUCT_BUNDLE_IDENTIFIER: $(KINIC_WIDGET_BUNDLE_ID)`、`APPLICATION_EXTENSION_API_ONLY: YES`、
    `SKIP_INSTALL: YES`、`INFOPLIST_FILE: KinicWorkItemsWidget/Info.plist`、
    `CODE_SIGN_ENTITLEMENTS: KinicWorkItemsWidget/KinicWorkItemsWidget.entitlements`。
  - アプリ target の dependencies に `- target: KinicWorkItemsWidget` と `embed: true` を追加する
    （`KinicShareExtension` と同じ書式。`project.yml` の `- target: KinicShareExtension` / `embed: true` の組）。
  - sources は widget ディレクトリに加え、アプリ側の共有ファイルを**共有拡張と同じ方式**（同じファイルを両 target に列挙）で入れる。
    - `KinicApp/Models/WorkItemWidgetSnapshot.swift`（新規。WidgetKit 非依存の Codable）
    - `KinicApp/Services/WorkItemWidgetSnapshotStore.swift`（新規。App Group JSON の読み書き）
    - `KinicApp/Utilities/WorkItemUniversalLink.swift`（新規。リンク生成・解析の唯一の契約）
    - `KinicApp/Utilities/Bundle+Configuration.swift`（既存。`optionalString` で `APP_GROUP_ID` を読む）
  - entitlements は application-groups のみ。keychain と associated domains は付けない。
  - widget では `SharedDefaultsStore`（UserDefaults）を使わない。PrivacyInfo に required-reason API を持ち込まないため。
- `Config/Kinic.xcconfig` に `KINIC_WIDGET_BUNDLE_ID = xyz.kinic.ios.KinicWiki.WorkItemsWidget` を追加し、
  widget の `Info.plist` に `APP_GROUP_ID = $(APP_GROUP_ID)` を追加する。
- `KinicWorkItemsWidget/Info.plist`: `NSExtension.NSExtensionPointIdentifier = com.apple.widgetkit-extension`、
  `CFBundleDisplayName = Kinic Items`。
- `AppIntentConfiguration(kind: "KinicWorkItemsWidget", intent: WorkItemsWidgetIntent.self, provider:)` を使い、
  **ウィジェットインスタンスごとに DB を選ぶ**。
  - `WorkItemsWidgetIntent: AppIntent & WidgetConfigurationIntent` に
    `@Parameter(title: "Database") var database: WidgetDatabaseEntity?` を持たせる。
  - `WidgetDatabaseEntity: AppEntity` と `EntityQuery` の情報源は**スナップショットの `databases` だけ**。
    canister・Keychain・SQLite には触れない。解決できない DB id は「利用できません」表示にする。
- family は `.systemSmall`（最新 Open 1件）と `.systemMedium`（Open 最大3件）のみ。
  accessory family は Phase 4 以降（音声導線と対になるため）。
- タップ: 項目 → `ios-work-item` リンク、`+` → `ios-work-items?compose=1` リンク。ウィジェット内の Close は置かない。
- 表示状態を4つ定義する。
  1. スナップショット無し／`principal` 無し →「サインインしてください」
  2. `databases` が空 →「データベースを選んでください」
  3. 設定 DB が `isAvailable == false` または消失 →「このデータベースは利用できません」（項目タイトルを出さない）
  4. Open 0件 →「未完了の項目はありません」＋`+`
- タイムラインは `.never`。更新はアプリの `WidgetCenter.shared.reloadAllTimelines()` のみ。
  鮮度は `Text(writtenAt, style: .relative)` で表示する。
- 配置: `KinicWorkItemsWidget/{KinicWorkItemsWidget.swift, WorkItemsWidgetIntent.swift, WorkItemsWidgetEntries.swift, WorkItemsWidgetViews.swift, Info.plist, KinicWorkItemsWidget.entitlements, PrivacyInfo.xcprivacy}`。
- widget target に置かないもの: ネットワーク、canister クライアント、SQLite、Keychain、`KinicDesign`。

#### D5. スナップショット契約 v1（App Group JSON）

- 置き場所: `<AppGroup>/WorkItems/widget-snapshot.v1.json`（既存 SQLite と同じ `WorkItems/` 配下）。
  atomic write（temp へ書いて `replaceItemAt`）とし、`isExcludedFromBackup = true` を付ける。
  ファイル名で version を持ち、旧 schema の吸収ロジックは入れない。
- 内容:

```json
{
  "version": 1,
  "writtenAt": 1737000000000,
  "principal": "<principal>",
  "selectedDatabaseId": "db_1",
  "databases": [
    {
      "id": "db_1",
      "title": "Team Wiki",
      "canWrite": true,
      "isAvailable": true,
      "updatedAt": 1737000000000,
      "items": [
        { "id": "<uuid>", "title": "...", "state": "open", "commentCount": 2, "updatedAt": 1737000000000 }
      ]
    }
  ]
}
```

- 規則:
  - `version != 1` は「無し」として扱う（推測して読み替えない）。
  - `items` は DB ごとに `updatedAt` 降順で最大5件（state は問わず、フィルタはウィジェット側）。`databases` は最大20件。
    ファイルは 50KB 未満に収める。
  - `principal` は**現在のアカウント1つのみ**。サインアウト／アカウント切替でファイルを削除する。
  - device-only の `captures(state: local)` は**入れない**（未共有の入力を共有済みに見せないという不変条件）。
  - `isAvailable` は「直近の readable/writable DB 一覧に存在すること」を真とする。
- 書き込み点（**アプリ側のみ**。`WorkItemWidgetSnapshotStore` を `WorkItemModel` に注入し、
  `WorkItemRuntimeProviding` に `workItemReadableDatabases: [DatabaseSummary]` を追加する。
  `WorkItemModel.init(runtime:repository:store:)` に `snapshotStore:` を追加し、テストからは temp ディレクトリを渡す）:
  - 一覧取得成功（`WorkItemModel.refreshRemote` → 既存 `cacheList` の直後）で該当 DB エントリと `selectedDatabaseId` を更新する。
  - `create` / `update` / `changeState` / `postComment` の成功時に該当項目を反映する。
  - DB 一覧更新（`readableDatabases` の変化）で `databases` メタデータと `isAvailable` を更新する。
  - `AppModel.signOut()`（および principal 変化）でスナップショットを削除する。
  - いずれの書き込み後も `WidgetCenter.shared.reloadAllTimelines()` を呼ぶ。

#### D6. ディープリンク契約（universal link）

- `https://wiki.kinic.xyz/ios-work-item?databaseId=<id>&itemId=<uuid>` → 該当 DB に切替えて項目詳細を push。
- `https://wiki.kinic.xyz/ios-work-items?databaseId=<id>&compose=1` → 該当 DB に切替えて入力画面を表示。
- `AppOpenURLDestination` に `.workItem(databaseId:itemId:)` と `.workItemsCompose(databaseId:)` を追加し、
  生成・解析は共有の `WorkItemUniversalLink` に集約する（`openURLDestination(for:callbackDomain:)` は
  `nonisolated static` のまま委譲。既存の `decodedPathSegments` は query を見ないため、query は `URLComponents` で解析する）。
- 欠落・不正パラメータは既存の `.home(message:)` へフォールバックして理由を出す。未知 DB は
  `readableDatabases` に無ければ「このデータベースを開けません」を表示する（黙って無視しない）。
- `kinic://` 独自スキームは追加しない。AASA（`wikibrowser/app/.well-known/apple-app-site-association/route.ts`）が
  `/*` で任意パスを許可済みなので universal link 1契約に統一する。

#### D7. 共有拡張: 「Wikiへ取り込み／項目を作成」

- 既存の DB 選択 UI の前に2択を追加する。既定は既存動作の「Wikiへ取り込み」。
- 「項目を作成」は**常に App Group のファイルキューへ保存**する（VFS へ直接書かない）。
  理由: WorkItems 契約の書き手をアプリ1つに保ち、共有拡張に repository / VFS バッチのコードを足さない。
  結果文言は「項目を保存しました。KinicWiki を開くとデータベースに共有されます。」
  - タイトル: x.com の投稿は `XPostMetadataFetcher` の取得タイトル、それ以外は URL host ＋ 最終パス要素（120字上限）。
  - 本文: URL 1行＋任意の一言（1行）。**記事本文の取得は待たない**。
  - `source = { "kind": "share", "url": <url>, "label": <title> }`。
  - サインインセッションが無い場合はモードを無効化して「サインインしてください」を出す。
  - DB は既存の writable ピッカーで選び、`captures.database_id` 不変条件に合わせて選んだ DB をキューに固定する。
  - `NSExtensionActivationSupportsWebURLWithMaxCount = 1` は据え置く（文字共有・WebPage 共有は Phase 3 の非対象）。
- 新規ファイル: `KinicApp/Models/PendingWorkItemCapture.swift`、
  `KinicApp/Services/PendingWorkItemCaptureQueue.swift`（`ShareInbox` と同じディレクトリ方式。
  `pending-work-items.v1/<captureId>.json` に
  `{version, captureId, principal, databaseId, title, body, source, createdAt}` を書く）。
  両ファイルを `project.yml` の `KinicShareExtension.sources` に追加する。
- アプリ側: `AppModel.appDidBecomeActive()` と `WorkItemModel.refresh()` で、
  **現在の principal と一致する**キュー項目だけを `WorkItemStore.captures` に `state: .local` で取り込み、
  SQLite 投入成功後にキューのファイルを削除して既存の `send()` に載せる
  （既存の「On this device」表示・再送・破棄 UI をそのまま使う）。他 principal のレコードは触らない。

#### D8. Wiki 文書からの作成（Browse）

- `BrowseDocumentView.documentMenu` に Section「Work item」→「項目を作成」を追加する。
  編集中・保存中は無効。`/WorkItems/` 配下と読み取り専用 DB では出さない（既存の保護と整合）。
- 事前入力: 本文 = ノード本文（10,000字上限。超過は入力画面に注記）、タイトル = ページ名から導出。
  `source = { "kind": "wiki", "path": <path>, "url": AppConfiguration.databaseNodeURL(databaseId:path), "label": <title> }`。
- 導線: `AppModel` に `requestedWorkItemDraft: WorkItemComposeDraft?` と `workItemComposeRequestID` を追加する
  （既存 `requestedWorkItemDetail` / `workItemNavigationRequestID` と同じ作法）。
  `HomeView` は request を検知して `.home` タブへ切替え、`WorkItemListView` が `WorkItemComposerView` を
  prefill 付きで表示して request を consume する。
- `WorkItemComposerView` に任意のタイトル欄を追加する（Wiki / Ask AI では prefill、手動の新規は空）。
  `WorkItemModel.create` を `create(title: String?, body: String, source: WorkItemSource?)` に拡張する
  （空なら既存の暫定タイトル導出に落とす。`WorkItemCreateDraft.title` は既にあるため repository は変更不要）。

#### D9. Ask AI からの作成

- `.complete` かつ本文が非空のアシスタント回答の下に「項目を作成」ボタンを追加する
  （generating / insufficient / failed では出さない）。plumbing は
  `AskAIMessageView`（新 closure）→ `AskAIConversationView` → `AskAIWorkspaceView` → `AskAIView` が
  `AppModel.requestWorkItemDraft` を渡す。
- 内容: 本文 = 回答 Markdown。`source = { "kind": "ask_ai", "path": 最初の出典 path,
  "url": その path の databaseNodeURL, "label": 最初の出典表示名 }`。
  出典が無い場合は url / path / label を null にし、kind だけで来歴を残す。会話全体は添付しない。

#### D10. 権限喪失と source リンク

- ウィジェット: `isAvailable == false`（直近の readable 一覧に無い、またはアプリの一覧取得失敗）なら
  タイトルを出さず「このデータベースは利用できません」を表示する。
- `WorkItemDetailView.sourcePanel`: Wiki / Ask AI の `path` は DB が readable ならアプリ内 Browse を開く。
  権限喪失・削除済みなら「このページを開けません（権限がないか削除されています）」を表示し、死んだリンクにしない。
  外部 URL は従来どおり Safari で開く。本文は元記事が消えても常に読める。

#### D11. 梱包・プライバシー

- `KinicWorkItemsWidget/PrivacyInfo.xcprivacy` を追加する（required-reason API なし、
  `NSPrivacyTracking = false`、収集データは空）。
- `mobile/ios/scripts/testflight-upload.sh` のアーカイブ検査に widget の PrivacyInfo 存在チェックを追加する
  （`PlugIns/KinicWorkItemsWidget.appex/PrivacyInfo.xcprivacy`。既存の app / Share Extension の検査と同じ書式）。
- `mobile/ios/README.md` に widget の bundle id、widget target の App Group ケイパビリティ、
  xcodegen 再生成、What to Test を追記する。
- Apple Developer / App Store Connect で widget の bundle id と App Group を登録する（外部前提。
  未登録のままでは実機 / TestFlight 検証を完了扱いにしない）。

#### Phase 3 のテスト計画

- 単体（`KinicTests`。widget target の View / Intent は `KinicTests` から見えないため、
  選択ロジックはアプリ側の共有コードに純関数として置き、widget は表示だけにする）:
  - `WorkItemWidgetSnapshotTests`: round-trip、version 不一致は無視、5件上限と並び、DB 20件上限、`isAvailable` の伝播。
    ストア（atomic write、欠損読み、サインアウト時の削除、別 principal での上書き）と射影のテストも同じファイルに置く。
  - `WorkItemUniversalLinkTests`: 生成と解析、`databaseId` / `itemId` の percent-encoding、他ホストの無視、
    `AppModel.openURLDestination` との連携（既存の `ShareInboxTests` の URL 分類テストはそのまま維持する）。
  - `PendingWorkItemCaptureQueueTests`: round-trip、他 principal を drain しない、同一 captureId の冪等、
    壊れた JSON・未知 version の無視、title/body の導出。
  - 本文10,000字切詰めのテストは `WorkItemUniversalLinkTests` に置く（`WorkItemComposeRequest` の契約として検証する）。
  - `WorkItemBrowseProtectionTests`: `/WorkItems/` 配下では作成導線を出さない。
- 実機（完了条件）: ウィジェットごとの DB 指定、項目タップと `+` の遷移、VoiceOver、文字拡大（`accessibility3`）、
  サインアウト／アカウント切替でスナップショットが消えること、権限喪失、古い `writtenAt` の表示、通信断。
- 回帰: 既存の Wiki 取り込み（共有拡張）、Browse の編集・公開、Ask AI。
- コマンド: `mobile/ios/scripts/ensure-xcodegen-project.sh` →
  `xcodebuild build -project mobile/ios/Kinic.xcodeproj -scheme Kinic -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO` →
  `build-for-testing` → `xcodebuild test`。実機は `ios-device-install` skill を使う（AGENTS.md の実機優先）。

完了条件: ウィジェットのDB指定・リンク遷移・VoiceOver・文字拡大・権限喪失・サインアウト時のクリアを実機で確認する。
共有拡張で作成した項目がアプリ起動後に重複なくデータベースへ共有される。既存のWiki取り込み・Browse編集・Ask AIに回帰がない。

#### Phase 3 の実装メモ（実装時に確定した内容）

- 追加ファイル: `KinicApp/Models/{WorkItemWidgetSnapshot,WorkItemComposeRequest,PendingWorkItemCapture}.swift`、
  `KinicApp/Services/{WorkItemWidgetSnapshotStore,WorkItemWidgetProjection,PendingWorkItemCaptureQueue}.swift`、
  `KinicApp/Utilities/WorkItemUniversalLink.swift`、`KinicWorkItemsWidget/`（target 一式）。
  変更: `WorkItemModel`、`AppModel`、`HomeView`、`WorkItemListView`、`WorkItemComposerView`、`WorkItemDetailView`、
  `BrowseDocumentView`、`AskAI{Message,Conversation,Workspace,ScreenshotPreview}View`、`ShareViewController`、
  `project.yml`、`Config/Kinic.xcconfig`、`scripts/testflight-upload.sh`、`README.md`。
- `WorkItemModel` は `WorkItemWidgetSnapshotWriting`（`AppModel` が実装）と `PendingWorkItemCaptureQueue` を
  注入で受け取る。既存のユニットテストは既定 `nil` のままで通る。
- 一覧キャッシュが新鮮なときもスナップショットを書き直す（DB 一覧メタデータの更新を兼ねる）。
- 一覧取得に失敗した DB は `isAvailable=false` にし、その DB の項目タイトルもスナップショットから消す。
- 共有拡張は常にキュー経由。`enqueue` は未知 version を拒否し、同一 `captureId` の再送は自分のレコードを
  置き換える（`moveItem` の衝突で失敗させない）。アプリは現在の principal のレコードだけを取り込み、
  `state: .local` として既存の送信・再送 UI に載せる。
- ウィジェットの DB 既定値はスナップショットの `selectedDatabaseId`。解決できない DB id は「利用できません」。
- コールドスタートのウィジェットリンクは DB 一覧が未読込でも受け付け、一覧が判明して対象が無い場合だけ拒否する。
- Browse の作成可否は `AppModel.canCreateWorkItemFromBrowseDocument(_:)` に集約し、テストから検証する。
- 検証: `scripts/ensure-xcodegen-project.sh` → `xcodebuild build-for-testing`（iPhone 18 Pro シミュレータ、
  `CODE_SIGNING_ALLOWED=NO`）成功 → `xcodebuild test-without-building -only-testing:KinicTests` 全429件成功（失敗0）。
- 未実施（Phase 5 で扱う）: 実機でのウィジェット family・リンク遷移・VoiceOver・文字拡大・権限喪失の確認、
  widget bundle id と App Group の Apple Developer / App Store Connect 登録、TestFlight 準備。

### Phase 4: AI整形・専用録音画面・再開処理

- `Services/WorkItemStructuring.swift`: 既存の `AskAICompleting`（`https://api.kinic.io/chat`）を再利用し、専用デコーダーで `title` とMarkdown `body` を検証する。モデルに保存権限は渡さない。Jevは導入しない
- 適用規則: 入力時の `item.md` のetagを `base_etag` として保存し、適用時に一致する場合のみ書き込む。人手編集で不一致なら上書きせず `ai_suggestion_json` に残し、UIでは「修正候補」として提示する
- AI処理中も画面を閉じられる。失敗時は原文のWorkItemがそのまま使え、明示的に再試行できる
- 専用録音画面 `Views/VoiceCaptureView.swift`: 明示操作で開始、停止後に保存、1件60秒まで。`Info.plist` に `NSSpeechRecognitionUsageDescription` を追加。バックグラウンド移行で停止し、録音済み部分を保護する
- Apple Speech: `supportsOnDeviceRecognition` が真なら端末内処理。偽なら許可と通信が必要。失敗時は録音を残して再試行可能。文字起こしの永続化後に録音を削除する
- AVAudioSession の排他: 既存の WebRTC Voice Preview と競合するため、録音開始時に Voice Preview を停止する（`Info.plist` は既に `UIBackgroundModes: audio`）
- 再開処理: `captures.state` と `pending_mutations` を永続化し、アプリ再開時に `local` の送信と `ai_running` のポーリングを再開する。アプリ終了中の完了は保証しない

完了条件: AIの失敗・不正出力・遅延中の手動編集で原文と編集内容が失われない。マイク拒否・音声認識失敗・録音中断でも保存済み内容が残る。

### Phase 5: 実機・ステージング検証とTestFlight準備

- 実機優先（AGENTS.md）。シミュレーターは署名不可・再現補助が必要な場合のみ
- 必須の検証を通す（下記）
- 計測: 保存時間、AI修正率、元情報への遷移成功率を実機試用で測る。処理ログには本文・音声を記録せず、結果・所要時間・競合件数だけを残す
- `PrivacyInfo.xcprivacy` の更新（SQLite導入に伴う FileTimestamp / DiskSpace の理由コード、音声・本文の取り扱い）、App Store プライバシー表示の更新
- TestFlight配布準備。**本番デプロイはこの計画に含めない**

## 必須の検証

| 検証 | 主なフェーズ |
|---|---|
| 2アカウントで同じDBの作成・コメント・Closeが反映され、Readerの書き込みは拒否される | 2 |
| オフライン保存 → アプリ終了 → 再起動 → 通信復帰で入力が失われず、項目が重複しない | 2 |
| AIの失敗・不正出力・遅延中の手動編集で原文や編集内容が失われない | 4 |
| 同時編集・同時コメント・Closeとの競合で他者の変更を上書きしない | 2 |
| マイク拒否・音声認識失敗・録音中断でも保存済み内容が残る | 4 |
| ウィジェットのDB指定・アカウント切替・リンク遷移・VoiceOver・文字拡大・権限喪失（実機） | 3 |
| 共有拡張で作成した項目がアプリ起動後に重複なく共有され、オフラインでも失われない | 3 |
| 既存のWiki取り込み・Browse編集・Ask AIの回帰がない | 3 |
| `list_children` 100件上限での一覧挙動と、検索100件上限の明示 | 1, 2 |

## 停止条件

- D1〜D3が未確定のまま Phase 1 に着手しない。
- 実機で2アカウントの権限検証ができない場合、Phase 2 を完了扱いにしない。
- canister側の変更（専用API・Issue用テーブル）が必要になった時点で停止し、設計制約を再確認する。
- 100件上限やcursor不在が受け入れられないと判明した時点で停止し、一覧の設計をやり直す。
- Phase 3 で canister 側の変更（一覧用の投影 API など）が必要になった時点で停止する。Phase 3 は canister 変更なしが前提。
- App Group スナップショットの private DB タイトル表示がプライバシー方針・審査で受け入れられないと判明した時点で停止し、表示範囲を再設計する。
- PR #103 がマージされて `KinicVoiceWidget` が入った場合、拡張は2つ共存させる。1つの WidgetBundle へ統合する判断は再計画として扱う。
- SQLite のプロセス間アクセスが必要になった時点で停止する（Phase 1 で却下済み）。

## 検討して却下した案

- **`item.md` の metadata だけで一覧を作る**: metadata更新に `content` の再書き込みが必要で、etagがコメントのたびに動く。AIの版判定と競合モデルが壊れるため却下。
- **コメントを `item.md` に `Append` する**: `Append` も既存ノードでは etag 照合を通り（`fs_store.rs:1882-1893`）、既存ノードの `metadata_json` は無視される（`fs_store.rs:1900-1903`）。競合回避にならず、本体のetagを汚すため却下。
- **`/WorkItems/_index.md` を1枚持つ**: 1回の読みで済むが、全書き込みが単一etagに集中し、同時作業で必ず衝突するため却下。
- **タイトルや状態をパスに埋める**（`/WorkItems/Open/<slug>`）: `list_children` だけで一覧が作れるが、CloseがMoveになり、タイトル変更でパスが動き、コメントの安定パスが失われる。UUID固定の設計とも矛盾するため却下。
- **ウィジェットがSQLiteを直接読む**: プロセス間のWAL競合とmigration二重管理を招く。書き出し済みJSONスナップショットを読む方式にした。
- **共有拡張が WorkItem を VFS へ直接書く**: WorkItems 契約の書き手が2つになり、repository / バッチ mutation を拡張にも複製することになる。App Group のファイルキューに保存し、取り込みはアプリに一本化した。
- **ウィジェットに未送信（`captures(state: local)`）の項目を出す**: 端末内だけの入力を共有済みに見せることになる。ウィジェットは DB の項目だけを表示する。
- **`kinic://` 独自スキーム**: スキーム登録が増え、AASA が `/*` で任意パスを許可しているため universal link 1契約に統一した。
- **PR #103 のウィジェット拡張に相乗りする**: Phase 3 が未マージ PR のマージ状況にブロックされるため却下（W1）。
- **GRDB等の導入**: AGENTS.mdの方針に反するため、システムの `SQLite3` を使う。

## 非対象

- 専用Canister API、WorkItem用サーバーテーブル、GitHub形式の連番
- 削除、締切、担当者、ラベル、通知、自動スケジューリング、ウィジェット内Close
- コメントの編集・削除
- Phase 3 では音声録音・専用録音画面・AI整形（Phase 4）、ウィジェットの accessory family、
  文字共有・WebPage 共有の受け入れ（現行の URL 共有のみ）
- 本番デプロイ
