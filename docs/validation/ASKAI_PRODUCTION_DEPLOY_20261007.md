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

## 未確認事項

ユーザーのiOS認証済み会話での検索・AI回答成功はまだ未確認。確認期間には本番の質問送信・WebSocket会話の実行が観測されていない。iOSで「このDBの内容を教えて」を実行した結果の確認を依頼済み。拒否経路の成功を、検索・AI回答のE2E成功として扱わない。

## ローカル実行記録

- `/private/tmp/askai-production-deploy.log`
- `/private/tmp/askai-deployed-source-manifest.json`
- `/private/tmp/askai-predeploy-deployments.json`
- `/private/tmp/askai-rollback-versions.json`
- `/private/tmp/askai-production-native-probe-results.json`
- `/private/tmp/askai-postdeploy-telemetry-summary.json`

戻す場合はcfのWorker deployment切替で保存した旧versionを100%指定する。D1データの巻き戻しは行わない。旧versionには既知のCPU問題があるため、旧版への切替だけで問題が解消するとは限らない。
