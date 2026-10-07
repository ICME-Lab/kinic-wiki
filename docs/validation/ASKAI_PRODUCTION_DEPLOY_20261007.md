# Ask AI Worker本番反映（2026-10-07）

## 反映結果

- 対象: Cloudflare account `9029b5f9de5b2e820eaf4ed562bcb0e7`、profile `kinic-production`、Worker `kinic-wiki-assistant`。
- 反映時刻: 2026-10-07 15:32:57 JST。
- 新version: `462fa73e-b996-404c-bca6-9ee65a8220d5`。deployment: `ae9d9bbe-46ef-4852-88ba-8e0fc84182c4`。cfによるdeployment再取得で100%配信を確認。
- 戻し先: `d9a26632-9ef9-4fda-9edd-abf755293737`。実行直前の稼働versionを保存した。
- ブランチ: `fix/ios-askai-reliability`。ベースHEAD `061ceb682a1ec16d4bca89d001ab4b7d8584d4a4`に未コミットのAsk AI修正を加えた状態をビルド。今回コミットはしていない。
- ソースmanifest digest: `a2ef7465e214b2ee03f1485691f9a7cec8c497ab9e36a35126d2fb133b9f23f9`。Worker source、共有ii-server/jev-reranker、Worker設定・package・lockfileの37ファイルを記録。反映前後のhash一致を確認。
- 実行CLI: `cf 1.0.0-beta.2`。Secret保持用`node ../../scripts/cloudflare/deploy.mjs --mode production --profile kinic-production`経由でビルド・アップロードした。Secretファイルによる変更は無効化した。

既存の5 Secret名（`ASSISTANT_BILLING_KEY`、`ASSISTANT_KEY_ENCRYPTION_KEY`、`DEEPSEEK_API_KEY`、`OPENAI_API_KEY`、`TYPESAFE_API_KEY`）が保持されたことを確認した。値は取得していない。既存D1 bindingと毎分のscheduled triggerを保持。Canister更新、D1 SQL migration、DNS変更、料金プラン変更、Webフロントの配布、iOS配布は行っていない。

## 検証

反映直前のAssistant typecheckとproduction cf dry-runが成功。既に同じ修正内容でWorker 147テストが成功していた。

実際の本番入口`https://wiki.kinic.xyz/api/assistant/native/`に対して以下を確認した。

- `/status`: HTTP 200。
- 認証なしの`/active`、`/conversation`、`/history`: HTTP 401、`authentication_required`。
- 新しく生成したテスト鍵で署名し、query-only・本番Canister限定の委任を3回作成。各`/auth/start`はHTTP 200。存在しないランダムDBへの`/auth/complete`はすべてHTTP 403、`database_access_denied`。
- 拒否後のtokenで`/active`はすべてHTTP 401。拒否した委任がactiveにならないことを確認。
- 各テスト認証を`/logout`で解除。すべてHTTP 200。既存Wikiの内容・既存ユーザーの認証情報は読んでいない。

cf observabilityで新versionの19 invocationを確認し、`exceededCpu`および他の非ok outcomeは0件。署名付き委任を実際にCanisterへ問い合わせる認証完了経路のCPUは22、12、6ms。認証開始は36、54、8ms。10msを超えて成功した呼び出しもあり、この結果から無料枠での安定動作を保証することはできない。

## 認証済み本番E2Eの追試

ユーザーから「あなたが試して」と指示を受け、既存Kinic CLIの
`llm-wiki-mainnet`認証を使用して本番の検索・回答経路を試した。
秘密鍵はCLI subprocessからメモリ内で受け取り、出力・保存していない。
query-onlyかつ本番Canister限定の20分の子委任をWorkerに渡した。
対象は公開Hono資料を収録した既存`hono-docs` DB
(`db_23dhmsxlhukv`)。Wikiへの書き込み・権限変更は行っていない。

全3試行でauth開始・完了はHTTP 200、会話作成は201、WebSocket初回
snapshotと質問commandの202受理まで成功した。しかし、資料に基づく
本番回答の成功は確認できなかった。

| 試行 | 質問 | 結果 |
|---|---|---|
| 1 | Honoでapp.requestを使うHTTPハンドラーのテスト方法を資料から説明して | 約9.9秒で検索対象の確認文が返った。`kind=clarification`経路に入り、資料検索・引用付き回答には進まなかった |
| 2 | このDBの内容を教えて | 本番historyに`deepseek_request_failed`が記録され、回答なしで終了 |
| 3 | このDB内のHonoドキュメントを検索して、app.requestによるHTTPハンドラーのテスト方法を教えて。引用元も示して。 | 約30秒後にWebSocketが1011で切断。続くconversationはHTTP 401 `authentication_required`。Workerログに`assistant_control_failure` / `connection_failed` |

各試行のテスト認証はlogout HTTP 200で解除した。試行1・2の会話は
end HTTP 200で終了。試行3は既に認証失効していたためendも401で、
明示的なend成功とは扱わない。logoutは成功した。

試行1・2のログ27イベント、試行3のログ19イベントの取得範囲で
`exceededCpu`は0件。したがって今回再現した失敗をCPU killとは断定
しない。WebSocket invocationの累積CPUが185ms・408msでokになった
例があり、これも各処理が無料枠で安定することの証明にはならない。

DeepSeek側の切り分けとして、同じ要求コードと同じHono資料をローカル
から実行すると、3ラウンドで引用4件付きの概要回答が成功した。
架空資料の既存liveテストは一度`insufficient_note`という余分なキーを
返して最終回答のstrict schemaで失敗し、別の試行では成功した。
本番の`deepseek_request_failed`はネットワーク例外・JSON/schema解析
例外を共通コードにする実装のため、現行ログだけでは個別原因を
確定できない。ローカルの余分なキーの事象を本番エラーの原因と
断定しない。

**初回試験時点の結論: Worker反映は完了したが、Ask AIはまだ未解決。**
残る調査対象は質問の経路判定、DeepSeek応答処理、本番の接続維持と
認証失効の発生理由。ユーザーのiOS実機による確認は依然未実施だが、
同じnative HTTP/WebSocket経路での失敗はこちらで再現済み。

## ローカル実行記録

- `/private/tmp/askai-production-deploy.log`
- `/private/tmp/askai-deployed-source-manifest.json`
- `/private/tmp/askai-predeploy-deployments.json`
- `/private/tmp/askai-rollback-versions.json`
- `/private/tmp/askai-production-native-probe-results.json`
- `/private/tmp/askai-postdeploy-telemetry-summary.json`
- `/private/tmp/askai-production-e2e-first-attempt.json`
- `/private/tmp/askai-production-e2e-second-attempt.json`
- `/private/tmp/askai-production-e2e-results.json`（試行3）
- `/private/tmp/askai-e2e-final-telemetry-summary.json`
- `/private/tmp/askai-e2e-third-telemetry-summary.json`
- `/private/tmp/askai-hono-deepseek-diagnostic.log`

初回デプロイ時のrollback候補は保存済みの旧version。後述の接続用Durable Object導入後は、同じクラス宣言を保持する版を優先し、導入前への単純切替が可能だとは扱わない。D1データの巻き戻しは行わない。


## 追加調査・修復（2026-10-07 16:09 JST）

最終Worker version: `891b8ec7-fb1e-4590-ae21-116c9af232bf`。
Deployment: `9d2a0363-795e-4ed5-8da3-f1ad8727b855`、100%反映をcfで確認。
対象account、Worker、Canister、D1は初回と同じ。既存5つのSecret名を保持し、
Secret値・Canister・D1 schema・料金プランは変更していない。

### 原因の実証

- 本番のDB概要質問で、`deepseek_failure / stage=fetch / kind=subrequest_limit`を確認。
  CPU killやAPIキー不備ではなく、次のDeepSeek送信前に外部通信回数が尽きていた。
- `wiki_inventory`は最大32フォルダとrootの一覧取得に加え、代表20文書を本文先読みしていた。
  これだけで最大53回のCanister queryになり、認証確認やAI呼び出しの分も必要になる。
  [Workers Freeの外部subrequest上限は1 invocationあたり50回](https://developers.cloudflare.com/workers/platform/limits/)。
- 通常Workerが長時間WebSocketを保持しており、同じ接続の後続質問やheartbeatも累積する構成だった。
  [Durable ObjectsはWebSocketの長期接続を扱える](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)。
- `tick()`は例外の種別を問わず`endOwned()`を実行し、結果としてD1の認証レコードも削除していた。
  一時的な接続障害が401への連鎖を起こす実装をコードで確認した。
- 接続移行後には、最終回答のschema検証エラーも本番で観測した。
  ローカルでは`insufficient_note`という余分なキーで失敗した例を確認済み。
  本番ログは値を保存していないため、本番の余分なキー名までは断定しない。
- さらに概要質問で、AIが本文取得上限4件を超えて`overview_read_limit`を要求し、
  それまでの根拠が取得済みでも質問全体を中断する問題を再現した。

### 修正内容

- 接続専用の`AssistantConnection` Durable Object（SQLite class）と
  `ASSISTANT_CONNECTION` bindingを同じWorkerに追加。`/events`のみを内部転送する。
  外側Workerでの本人認証後に、上書きしたprincipal/auth-idヘッダーで転送し、
  DO内でも会話所有者・Canister権限を確認する。会話・認証・停止要求・leaseは既存D1に保存する。
  他のHTTP API・iOSのAPI形式は維持した。
- inventoryは最大16フォルダ＋rootの一覧取得へ制限し、20文書の本文先読みを削除。
  代表パスは最大20件、本文は`wiki_read`から取得し、切り詰めは`truncated`で明示する。
- DeepSeekに[JSON Output](https://api-docs.deepseek.com/guides/json_mode/)を指定。
  最終回答の未知のtop-levelキーだけを破棄し、必須フィールド・引用の構造・引用ID・
  引用文の完全一致・当該ターンの根拠チェックは維持する。本人認証schemaは緩和しない。
- 概要で4件取得した後は次のAI要求からツールを外して最終回答を要求する。
  同一ツールbatch内の追加取得には上限を知らせる結果を返し、追加本文は読まない。
- 一時的な認証確認例外は5秒後の再確認へ回し、会話と認証を保持。
  HTTP 401/403、kill switch、idle/reconnect expiryは引き続き終了する。
- 秘密情報や資料本文を含めない固定エラーカテゴリの診断ログを追加。
  providerの通信段階・JSON/schema失敗を区別できるようにした。

### 検証

- Worker全テスト153件成功（unit 122、workerd/Miniflare 29、Node 2）。
- Miniflareの実Durable ObjectでWebSocket upgrade、snapshot、heartbeat往復を確認。
  native delegationの署名付きquery・Canister拒否時の権限制御テストも成功。
- 型検査・cf production dry-run・対象ファイルのdiff whitespace検査成功。
- 架空資料のみを使うDeepSeek実APIテスト1件成功。JSON指定とツール連携を確認。
- 最終本番試験は、CLI identityからquery-only delegationを作り、iOSと同じnative
  HTTP/WebSocket経路で`db_23dhmsxlhukv`（Hono-docs）を利用。Wiki書込や権限変更なし。
  概要質問では当該DBで読める代表文書も対象となるため、DB内の全内容を公開資料だとは扱わない。
- 同じ接続で概要質問は約33.6秒・引用4件、検索質問は約40.6秒・引用4件で成功。
  いずれも`insufficient=false`。65秒待機後、同じ接続でJSON POSTのテスト方法を
  再質問し、約41.6秒・引用3件・`insufficient=false`で成功。試験全体は約189秒。
  3問とも質問受付202、メタデータ200、引用付き最終回答を確認。
  試験用の会話終了・logoutはともにHTTP 200で完了。
- 最終試験期間の本番ログ46イベントを取得。outcome付き36イベントはすべて`ok`、
  回答イベント3件を確認。取得範囲の`exceededCpu`・subrequest制限・接続失敗イベントは0件。

### 反映ソース・復旧方針

反映対象はAssistant Worker、共通II server／Jev read関連ソース。
同時に変更されているwikibrowserのUIはこのWorker buildの対象ではない。
反映ソースmanifestは28ファイル、SHA-256:
`51a5287390620d2aac641b3aeca1fdd041055b51f81461b44933eb016d953e75`。

戻す場合は、同じ`AssistantConnection`クラスがある直前version
`181fd5ba-df08-44de-b961-550a1f7a7c06`を候補とする。ただしこの版には
概要取得上限時の失敗が残る。DO導入前の版へ戻す場合はcfのclass宣言・migrationを
確認し、既存クラスを保持して旧アプリ処理を再デプロイする手順を検討する。
DO namespaceを削除したりD1を巻き戻したりする操作はこの作業に含まない。

追加のローカル記録:

- `/private/tmp/askai-final-budget-deploy.log`
- `/private/tmp/askai-final-budget-source-manifest.json`
- `/private/tmp/askai-final-budget-tests.log`
- `/private/tmp/askai-final-budget-dry-run.log`
- `/private/tmp/askai-final-synthetic-live.log`
- `/private/tmp/askai-final-budget-e2e.log`
- `/private/tmp/askai-final-budget-e2e-results.json`
- `/private/tmp/askai-final-budget-telemetry.json`


**最終結果: 修正を本番へ反映し、native APIで概要・検索・待機後の再質問3件が成功。**

iOS実機の画面操作は未実施。この確認は、iOSと同じ認証・HTTP・WebSocket経路を
こちらで実行した結果であり、全ユーザー・全DBでの成功や無料枠全体の安定保証ではない。
今回の追加修復はWorker内で完結し、iOS再配布はこのAPI修復の前提ではない。


## 16:33 JST追加修復: iOS逐次受信で再現した履歴競合

ユーザーから `-1005` / `domain error` の報告があり、上記API成功だけでは
実際のiOS受信処理を検証できていなかったため、受信モデルを合わせて再試験した。
`NSURLErrorDomain -1005` は接続喪失であり、iOSコードは履歴取得例外でも
WebSocketを閉じ、未完了のコマンドに `networkConnectionLost` を返す。
ユーザー端末の詳細ログ・失敗時刻は未取得のため、その個別発生との同一性は未確定。

### 再現と追加変更

- iOSはWebSocket通知を順番に処理し、snapshot通知のたびにメタデータと
  revision指定の履歴ページを取得する。履歴409は3回再試行し、それでも失敗すると
  receive loopを終了する。以前のNode試験は通知を即時処理しており、この経路を検証していなかった。
- 質問受付返信より先にsnapshotを送っていたため、受付結果も履歴取得に巻き込まれる。
  command.resultを先に送り、その後に最新snapshotを送るよう変更。
- 実行中の無変更tickは保存ではなく次回確認時刻だけを更新するよう変更。
- 上記だけを反映したversion `f4bf5fa9-6921-437f-8226-e4a82328900b` でも、
  逐次受信試験では履歴409が3回連続し、receive loopの終了を再現。
  実際の検索チェックポイントによるD1 revisionの更新も原因だった。
- native会話に公開状態の `viewRevision` / `viewFingerprint` を追加。
  質問・回答・引用・エラー・status・generationが変わったときだけ公開版を更新する。
  内部retrieval/recovery保存は従来のD1 revisionとfenced leaseで管理し、
  進捗のみの保存では公開履歴の版を変更しない。
- 履歴取得後に最新metadataを照合し、回答変更・conversation変更・終了要求が
  ある場合は従来どおり409を返す。異なる回答版のページを混ぜて返さない。
  内部保存だけなら同じ公開版のページを返せることをMiniflare/D1で確認。
- 進捗だけの通知は同じ公開版になるため、既存iOSのrevision比較では細かな
  tool進捗が省略される。質問受付・最終回答・エラー・接続状態の変更は更新される。

### 最終反映

- Worker: `kinic-wiki-assistant`、同じaccount・route・Secret・D1・DO binding。
- version: `df3e4b68-93c9-4f03-a3f6-b2f3c82bd380`、100%配信。
- deployment: `c49c2039-4bd5-42cf-9a50-ecfdb5dcac67`、
  `2026-10-07T07:33:24.014491Z`（16:33:24 JST）。
- Worker全テスト155件（unit 124、Miniflare/workerd 29、Node 2）、型検査、
  cf production dry-run成功。Secret値・DNS・D1スキーマ・Canister・iOS binary変更なし。
- ソースmanifest 28ファイル、SHA-256:
  `135e06e7d29e1110e09ebf9667274c91d854b4586f07615e024ca65dad4856e0`。
- ロールバック候補は同じDO classがある `891b8ec7-fb1e-4590-ae21-116c9af232bf`。
  ただし同版には今回の履歴競合が残る。DO/D1の削除や巻き戻しは不要。

本番逐次受信試験には既存iOSの `AssistantContracts.swift` の型定義を
そのまま抽出・Swiftでコンパイルしたdecoderを使用。履歴通知を処理している間は
次のWebSocketメッセージを処理せず、同じ3回の履歴再試行・30秒liveness判定を行う。
これは実機画面・AppleのURLSession/WebSocket transport自体の試験ではない。


### 最終逐次受信試験の結果

- 同一native認証・WebSocket接続で2問成功。検索約46.0秒・引用5件、
  概要約36.1秒・引用4件、両方 `insufficient=false`。全試験約92.6秒。
- 質問受付202がworking snapshotより先に届くことを2問とも確認。
  内部checkpointの通知は同じ公開revisionを維持し、最終回答で更新された。
- metadata/historyの実ペイロード計10件が実Swift型でデコード成功。
  HTTP 200が14件、conversation作成201が1件、409・逐次受信失敗は0件。
- 試験会話のendとlogoutはHTTP 200。試験用接続はその後に終了。
- 試験期間の本番ログ25件を照合。outcome付き19件はすべて`ok`、
  検索と概要の回答イベント2件を確認。取得範囲にWorker失敗イベントなし。
  定期回復処理の`assistant_recovery_pending`は1件あり、回答を阻害しなかった。
- ローカル記録: `/private/tmp/askai-ios-view-deploy.log`、
  `/private/tmp/askai-ios-view-tests.log`、`/private/tmp/askai-ios-view-e2e.log`、
  `/private/tmp/askai-ios-sequential-e2e-results.json`、
  `/private/tmp/askai-ios-view-source-manifest.json`、
  `/private/tmp/askai-ios-view-telemetry.json`。

**追加修復結果: iOSの受信順序で再現した履歴競合をWorkerで修正し、
同じ受信モデル・Swiftデコードで本番検索／概要2問の完了を確認。**
実機画面での再試行は未実施。ユーザーの端末・回線固有の切断まで解消したという
確認ではなく、今回再現できたサーバー起因の履歴競合を検証した結果である。


## iOS実機でのユーザー確認と追加復旧対策

2026-10-07、ユーザーから「テストしたら上手く動いている」と報告を受領。
本番Worker最終版を配信後、既存iOSアプリでの成功をユーザーも確認した。
以下のiOSコード変更は、このユーザー試験には含まれておらず、ローカル修正のみ。
アプリのアップロード・配布は行っていない。

- `AssistantConversationModel` はsnapshot通知からの履歴取得を受信loopと分離。
  取得中もheartbeat／command.resultを処理する。通知は最大revisionへまとめ、
  409や一時的なHTTP失敗は同じsocketを維持して3秒後に再試行する。
- 会話終了・background・再接続時には履歴取得taskをcancelし、epochと会話IDを
  検査して終了した会話や別DBに遅い応答を適用しない。
- 質問受付のWebSocket replyを通信切断で失った場合、同じrequestIdとpayloadを
  既存HTTP questions APIへ送る。サーバーのdedupで二重質問を防ぎ、認証失効・
  DB切替・task cancel時は再送しない。初回のcontrol接続待機は従来どおり。
- `AssistantControlSocket` の注入を追加し、履歴を意図的に止めたまま受付replyが
  消費されること、reply喪失後の同一ID復旧、認証401での終了、409後の復旧と
  通知のcoalescing、DB切替後の再送防止を実モデルで検証。
- Swift 6 / iOS Simulator build-for-testing成功。対象回帰テスト96件
  （XCTest 33、AskAIModelのSwift Testing 63）すべて成功。
  共用Simulator `297B1DC2-EF16-4159-AC37-33BF4F9A5FE7` を使用し、
  lifecycle scope終了時に新たな起動残存はなし。
- 結果: `/private/tmp/askai-ios-recovery-final-tests.xcresult`、
  `/private/tmp/askai-ios-recovery-final-tests.log`。

現在の障害解消は配信済みWorker修正によるもの。追加のiOS復旧対策は、
次回アプリbuildへの反映候補として保存した変更であり、現在配布済みbinaryにはない。
