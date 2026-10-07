# Ask AI デプロイ計画（2026-10-07）

この文書は計画。リモートへの反映は実施していない。

## 対象と現在地

- ブランチ: `fix/ios-askai-reliability`。現在のベースHEAD: `061ceb682a1ec16d4bca89d001ab4b7d8584d4a4`。修正は未コミットなので、このHEADだけでは配布内容を特定できない。
- Cloudflare CLI: プロジェクト固定 `cf 1.0.0-beta.2`。
- 前回確認したアカウント: `9029b5f9de5b2e820eaf4ed562bcb0e7`、profile `kinic-production`。実行直前に再確認する。
- 本番Worker: `kinic-wiki-assistant`。本番D1: `51dcc15a-a8f9-4d00-93d9-5ad8e0684584`。入口: `https://wiki.kinic.xyz/api/assistant/native/`。
- staging Worker: `kinic-wiki-assistant-staging`。D1: `81d9a64a-6f68-4cb5-a91d-5513fa9cf57d`。入口: `https://kinic-wiki-browser-staging.hude.workers.dev/api/assistant/native/`。対象Canisterも本番と異なる。
- ローカル検証済み: Worker 147件、関連typecheckとproduction dry-run。停止修正後のiOSテスト90件、動的パラメータを含む94実行が成功。

## 1. 配布するソースを固定する

Ask AI関連のWorker、`packages/ii-server`、iOSサービス・モデル・回帰テスト・検証記録をレビューしてコミットする。UI、法務、デモ動画など他作業の未コミット変更を配布に混ぜない。iOS配布ビルドも固定したソースから作る。隔離checkoutが必要ならCodex管理worktreeを使う。

Workerの変更はネイティブ応答署名検証の省略、署名付き要求と権限制御の維持、読み取り時のD1書き換え抑制、履歴のページ取得など。iOSの変更は接続待機・ポーリング頻度・履歴キャッシュ・停止処理。Wiki取得をiOSへ移す設計変更は今回に含めない。

固定した内容で検証済み内容との差分を確認し、変更で影響を受けた検証を再実行する。staging用dry-runも確認する。

## 2. リモート反映前の確認

`cf auth whoami`で対象アカウントを確認し、stagingと本番の現在のdeployment/version IDを保存する。前回観測した本番versionは`d9a26632-9ef9-4fda-9edd-abf755293737`だが、戻し先は実行直前の稼働versionを使用する。

各Workerに必要なSecret名が存在することを確認する: `OPENAI_API_KEY`、`DEEPSEEK_API_KEY`、`TYPESAFE_API_KEY`、`ASSISTANT_KEY_ENCRYPTION_KEY`。値は出力しない。暗号化キーを変更しない。

今回の変更にはD1 SQL migrationはない。D1スキーマ、Canister、DNS、Webフロント、料金プラン、Secretの更新を実行範囲に含めない。Assistant Workerの新versionとdeploymentを作成する。既存のスケジュール・バインディングを保持する。Web版も同じWorkerを使うため回帰確認対象に含める。

各環境の反映直前に、固定したコミット、対象、反映内容、戻し先を提示して承認を得る。

## 3. stagingで先に確認

staging用の認証可能なテスト利用者と、内容が既知のテストDBを用意できることを確認する。環境が異なるため、本番DBや本番向けdelegationを使い回さない。この準備ができない場合、認証済みE2Eを検証済みとは扱わず、代替検証と残る不確実性を示して本番反映の判断を行う。

リポジトリのSecret保持処理を使う。以下は`workers/wiki-assistant`を作業ディレクトリとする計画コマンド。profileは事前確認したものを指定する。

```sh
node ../../scripts/cloudflare/deploy.mjs --mode staging --profile kinic-production
```

検証内容:

- native認証開始・delegation受理・会話作成・WebSocket初回snapshot。
- DB概要と特定ノート検索、それぞれの回答と引用元。質問を少なくとも3回連続実行する。
- 履歴再取得、画面を開き直した際の継続、接続切断後の復帰、接続待機中の停止、送信済み質問の取消。
- 権限のないDBでは取得・回答を拒否する。ログに本文・トークン・delegation秘密鍵を記録しない。
- Web版の認証・検索・履歴も確認する。

HTTP結果、レイテンシ、Worker CPU、例外、`exceededCpu`、`connection_already_active`を記録する。status HTTP 200だけで完了判定しない。

## 4. 本番Worker反映と受入確認

staging結果と本番の旧versionを提示し、承認後に同じ固定ソースを反映する。

```sh
node ../../scripts/cloudflare/deploy.mjs --mode production --profile kinic-production
```

このスクリプトは既存Secret名を取得してバインディングを保持し、ビルド成果物のWorker名を確認してからcfで反映する。直接の`cf deploy`でこの保持処理を省かない。

新versionが配信対象になったこと、入口とバインディングを確認する。まず既存iOSで認証から回答までを確認し、更新iOSビルドでも同じ検索・停止・復帰・履歴シナリオを実行する。初回と再接続後を含む連続質問10回、15分以上の操作・ログ観測を初期受入条件とする。監視中の認証済み経路でCPU制限による失敗がないこと、既知DBの検索・引用・取消が成功することを確認する。

無料枠での安定性は未確定。ローカルの署名検証省略実験でもCPUが10msを超える例がある。CPU制限による失敗が残る場合、今回の改修だけで解決したとは扱わずiOS配布を止める。計測結果からWiki取得のiOS移行または別の実行構成を検討する。料金プランはこの計画では変更しない。

## 5. iOS配布

本番受入後、固定ソースから署名付きRelease archiveを作り、本番接続設定とバージョン/build番号を確認する。まずTestFlightへ配布して実機で認証、複数質問、バックグラウンド復帰、接続待ちの停止、再質問、履歴を確認する。既存の配布スクリプトとApp Store手順を実行前に確認する。

TestFlightアップロードとApp Store提出・公開はそれぞれ対象とbuild番号を示して判断する。本番Workerの反映だけで停止ボタンやポーリングなどのiOS修正が既存アプリに入るわけではない。

## 戻し方と中止条件

認証失敗増加、CPU制限による失敗の継続、履歴不整合、引用先の不整合、Web版の回帰があれば配布を止め、必要なら保存した旧versionへWorkerの配信を戻す。旧版にも既知のCPU問題があるため、戻すだけでAsk AIが正常化するとは限らない。D1データは巻き戻さず、問題がデータ更新に由来する場合は影響を別途調査する。

インストール済みcfのヘルプで確認済みの切替方法:

```sh
pnpm exec cf workers deployments create --worker kinic-wiki-assistant --strategy percentage --versions @rollback-versions.json --profile kinic-production
```

`rollback-versions.json`は実行直前に保存したversion IDを`version_id`に入れた`[{"version_id":"保存した旧version ID","percentage":100}]`。stagingを戻す場合はstaging Worker名とその旧versionを使う。`--force`は使わない。戻した後に配信version・認証・検索・履歴を再確認する。

iOSは配布中のbuildを差し替えられないため、問題のあるTestFlight buildの配布停止や修正版buildで対処する。App Store公開前に実機検証を完了する。
