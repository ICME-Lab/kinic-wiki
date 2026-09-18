# Plan 002: iOS DB共有項目（WorkItem）

## Status

- **Priority**: P1
- **Risk**: HIGH（VFS上の文書契約とローカルSQLiteスキーマは、実データが入った後は変更コストが高い）
- **Planned at**: commit `0ce00a6e`, 2026-09-17
- **Status**: TODO
- **前提**: 下記「決定事項」D1〜D3が確定していること。確定後、Phase 1 から順に実行する。

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
- 一覧は `list_children(/WorkItems)` → 各 `meta.md` を並列 `read_node`。件数上限はVFS側の100（`crates/vfs_store/src/fs_store.rs:61`）で割り切る。

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

### Phase 1: 契約・ローカル保存・VFS接続・Homeの手動一覧/作成/詳細

- `Models/WorkItem.swift`, `Models/WorkItemComment.swift`, `Models/WorkItemCapture.swift`, `Models/WorkItemMetadata.swift`（encode/decodeとversion判定）
- `Services/VFSClient.swift` に `mutateNodesBatch` を追加、`Services/VFSCandidTypes.swift` に `MutateNodesBatchRequest` / `NodeMutation` / `WriteNodeItem` / `Mkdir` を追加
- `Services/WorkItemRepository.swift`: `list()` / `load(id:)` / `create(capture:)` / `update(...)` / `setState(...)`。VFSの読み書きと `meta.md` 再構築はここに閉じる
- `Services/WorkItemStore.swift`: App Group SQLite、migration v1、`captures` / `list_cache` / `sync_state`
- `Views/WorkItemListView.swift`（Open/Closed/すべて・検索・新規）、`Views/WorkItemDetailView.swift`、`Views/WorkItemComposerView.swift`
- `Views/HomeView.swift`: Homeを一覧に変更し、既存の取り込みと履歴をツールバーへ移す
- `Models/WorkItemDeepLinkRequest.swift` と `ViewModels/AppModel.swift` への導線追加（既存 `BrowseDeepLinkRequest` と同じ作法）

完了条件: Owner/Writerが手動で作成・一覧・詳細を開ける。Readerは閲覧のみ。オフラインでも入力が `captures(state: local)` に残る。`meta.md` を削除しても一覧が `item.md` から再構築される。

### Phase 2: コメント・Close/Reopen・検索・競合・再送

- コメント投稿（`comments/<UUID>.md` を新規パスで書き、`meta.md` をベストエフォート更新）
- Close/Reopen を `item.md` の `state` 変更として実装
- 検索: `search_nodes(prefix: "/WorkItems/", topK: 100)`。ヒットを itemId 単位に集約し、コメントの一致も親項目にまとめる。**cursorが無いためページングは提供せず、100件上限と「絞り込んでください」を明示**
- 送信再試行: バッチのレスポンス消失時は `item.md` を read し、`metadata.captureId` が自分のものであれば成功扱い（`etag_conflict` を競合UIに直結させない）
- 真の競合時: 上書きせず「最新版」と「自分の編集内容」を並べて再編集（既存 `BrowseDocumentMutationCoordinator` の作法を踏襲）
- オフライン時: 編集・コメント・Close/Reopen は `pending_mutations` に保持し、オンライン確定のみ
- `Views/BrowseDocumentView.swift`: `/WorkItems/` 配下を開いたらWorkItem詳細へ誘導し、汎用編集を無効化

完了条件: 2アカウントでコメントとCloseが反映される。同時コメント・同時編集・Close競合で他者の変更を上書きしない。Readerの書き込みが拒否される。

### Phase 3: ウィジェット・記事共有・Wiki/Ask AIからの作成

- `project.yml` に Widget Extension ターゲットを追加（entitlements、App Group ID、bundle id、scheme）。iOS 18以降を維持
- ウィジェットは **App Group内のJSONスナップショットのみ**を読む（SQLiteやcanisterへは触らない）。アプリは一覧取得・変更成功のたびにスナップショットと `last_fetched_at` を書く
- ウィジェットごとにDB選択（`AppIntentConfiguration`）。小=最新Open 1件、中=3件。文字/音声ボタンはアプリの入力画面を開く。項目タップは詳細を開く。ウィジェット内のCloseは初期版に含めない
- ログアウト・アカウント切替でスナップショットを消す。権限喪失を検出したDBはキャッシュ表示と送信を止める
- Share Extension: 「Wikiへ取り込み／項目を作成」を追加。項目作成はURL・取得済みタイトル・任意の一言だけを保存し、記事本文の取得を待たない。`project.yml` の `KinicShareExtension.sources` への追加を忘れない
- Ask AI の回答とWiki文書に「項目を作成」を追加。本文を選択内容から作り、WikiのDB・パスや回答の出典を `source` に残す。会話全体は添付しない
- 元記事の削除・Wiki権限喪失でも本文は読める。リンク先を開けない場合は理由を表示

完了条件: ウィジェットのDB指定・リンク遷移・VoiceOver・文字拡大を実機で確認。既存のWiki取り込み・Browse編集・Ask AIに回帰がない。

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
| ウィジェットのDB指定・アカウント切替・リンク遷移・VoiceOver・文字拡大（実機） | 3 |
| 既存のWiki取り込み・Browse編集・Ask AIの回帰がない | 3 |
| `list_children` 100件上限での一覧挙動と、検索100件上限の明示 | 1, 2 |

## 停止条件

- D1〜D3が未確定のまま Phase 1 に着手しない。
- 実機で2アカウントの権限検証ができない場合、Phase 2 を完了扱いにしない。
- canister側の変更（専用API・Issue用テーブル）が必要になった時点で停止し、設計制約を再確認する。
- 100件上限やcursor不在が受け入れられないと判明した時点で停止し、一覧の設計をやり直す。

## 検討して却下した案

- **`item.md` の metadata だけで一覧を作る**: metadata更新に `content` の再書き込みが必要で、etagがコメントのたびに動く。AIの版判定と競合モデルが壊れるため却下。
- **コメントを `item.md` に `Append` する**: `Append` も既存ノードでは etag 照合を通り（`fs_store.rs:1882-1893`）、既存ノードの `metadata_json` は無視される（`fs_store.rs:1900-1903`）。競合回避にならず、本体のetagを汚すため却下。
- **`/WorkItems/_index.md` を1枚持つ**: 1回の読みで済むが、全書き込みが単一etagに集中し、同時作業で必ず衝突するため却下。
- **タイトルや状態をパスに埋める**（`/WorkItems/Open/<slug>`）: `list_children` だけで一覧が作れるが、CloseがMoveになり、タイトル変更でパスが動き、コメントの安定パスが失われる。UUID固定の設計とも矛盾するため却下。
- **ウィジェットがSQLiteを直接読む**: プロセス間のWAL競合とmigration二重管理を招く。書き出し済みJSONスナップショットを読む方式にした。
- **GRDB等の導入**: AGENTS.mdの方針に反するため、システムの `SQLite3` を使う。

## 非対象

- 専用Canister API、WorkItem用サーバーテーブル、GitHub形式の連番
- 削除、締切、担当者、ラベル、通知、自動スケジューリング、ウィジェット内Close
- コメントの編集・削除
- 本番デプロイ
