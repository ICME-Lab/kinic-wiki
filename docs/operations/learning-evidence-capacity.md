# 学習証拠の容量と配送

`agent flush` とバックグラウンド配送は、1回あたり既定で32イベント・シリアライズ後1 MiBまで送信します。残りは次回の明示実行または通常の配送契機で処理されます。

共有保存に未対応の接続先では、旧形式で16 KiBを超えるhook記録は未送信のまま保留されます。保留だけが残っていても、後から追加された通常の小さい記録は配送できます。旧キューのID・本文は書き換えません。形式を判定できない大きいhookは、共有保存能力や例外フラグがあっても保留します。

`agent status` の `deferred_records`・`deferred_bytes`・`deferred_reasons` は、配送が検査して保存した保留情報です。`pending_records` に含まれる内数であり、配送済み・除外済み件数ではありません。未検査・一覧不完全の場合は不明を含みます。`agent flush` も `deferred`・`deferred_bytes`・`budget_exhausted` を返します。

旧記録を明示的に送る例外操作では、有限予算も指定します。これはサーバーの容量を増やす可能性があるため、移行前に自動実行しません。

```sh
kinic-vfs-cli agent flush --allow-legacy-evidence \
  --max-delivery-events 1 --max-delivery-bytes 1048576
```

共有保存能力のある接続先では旧記録も通常の有限予算内で送信できます。1件で指定バイト数を超えるイベントは `event_exceeds_delivery_budget` として保留されます。JSON化後の長さを使うため、会話ファイルの読み取り上限と同じ値とは限りません。

自動学習・自動公開・ジョブの状態はこの配送制御では変更しません。配送成功は学習成功や性能改善を意味しません。

共有保存を有効にしたDBでは、生の会話証拠はrun・ツール・時刻などの要約情報で検索します。会話全文の全文検索は行いません。通常のKnowledgeや案件文書の検索は維持します。元本文・履歴を取得するにはread-node/read-nodes/node-historyを使ってください。query-sqlのfs_nodes.contentは対象証拠について内部参照を返します。共有blob・manifest表は公開SQLから参照できません。

## 保守操作（本番実行前に対象と結果の確認が必要）

保守APIはcanisterのcontrollerだけが呼べます。WriterやDB Ownerだけでは実行できません。認証を自動変更する機能はありません。以下の `<...>` はプレビューや直前の結果を確認して指定します。この文書の例を自動実行しません。

```sh
kinic-vfs-cli database evidence-rebuild preview <db>
kinic-vfs-cli database evidence-rebuild begin <db> \
  --expected-source-mount <mount> --expected-schema vfs_store:005_evidence_storage
kinic-vfs-cli database evidence-rebuild step <db> \
  --migration-id <id> --expected-step <step> --max-rows 32 --max-bytes 262144
kinic-vfs-cli database evidence-rebuild verify <db> \
  --migration-id <id> --expected-step <step> --max-rows 32 --max-bytes 262144
kinic-vfs-cli database evidence-rebuild activate <db> \
  --migration-id <id> --expected-state-hash <hash>
kinic-vfs-cli database evidence-rebuild resume-writes <db> \
  --migration-id <id> --expected-state-hash <hash>
```

beginはDB残高0でも書き込みゲートを設定できます。元DBを読むことと補充は継続できます。コピーと照合は1コマンド1ステップです。結果のphaseとstepを確認して次へ進めます。既定256 KiBを超える行は拒否されます。調査して明示指定する場合だけ最大2 MiBまで増やせます。それを超える行は移行不可として停止し、原文を切り詰めません。

activateは全コピー・全照合が完了し、移行先の論理サイズが元の半分以下の場合だけ成功します。この段階でも書き込みは閉じたままです。読み戻しを確認してからresume-writesを明示実行します。これは通常のDB更新料金を課すAPIではありませんが、ICの実行cyclesと新しいstable memory領域は消費します。実測の予算と所要時間を確認してから本番を実施してください。

結果が不明な場合は同じ引数で照合・再送します。古いstate hashを新しい値に自動差し替えしません。書き込み再開前なら、次の操作で元DBへ戻して保守を中止できます。元DB・移行先の領域を削除する操作ではありません。

```sh
kinic-vfs-cli database evidence-rebuild rollback <db> \
  --migration-id <id> --expected-state-hash <hash>
```

resume-writes後はrollbackを拒否します。新しく書かれたデータを保全して別途復旧します。完了後に再度保守を始める場合は、現行mount（前回のtarget_mount）を指定してください。

表示するsource/target_logical_bytesは各SQLite画像の論理サイズ、retained_old_logical_bytesは保全した元画像の論理サイズです。canister全体のstable memoryが縮むことや、旧領域が物理回収されたことを表しません。新旧両領域を保持する期間の総消費も別に測ります。本番の完全なexport・デプロイ版・controller権限・必要予算を確認できない場合は、移行可能と判断しません。

## ローカル検証で確認した範囲

- 固定した20ツール操作のターンは、途中イベントの会話スナップショット0件・終了時1件を検証しました。配送の成功応答だけで同期済みとは扱わず、対象イベント／実行の配送確認から`pending_sync`を返します。保留・配送除外は配送確認に含めません。
- 旧版Wasmからの合成データ移行では、論理サイズ4,046,848 bytesから786,432 bytesへ減りました。途中upgrade、応答再送、切り替え後の読み取り専用状態からのrollback、書き込み再開後のrollback拒否を検証しました。
- この試験のstable memoryは17,170,432 bytesから33,947,648 bytesへ増加しました。元画像と中止した移行先も保持するためです。論理サイズの減少と物理領域の回収は別です。
- 現行の学習記録794件、213,522,181 bytesを元版・ハッシュと照合した読み取り専用監査では、共有マニフェスト33,959,796 bytes、固有レコード12,309,822 bytes、非対象本文634,981 bytes、合計46,904,599 bytesでした。これはcodecの本文量の試算です。履歴・削除済み記録・他の領域・索引・DBページの全量を含みません。本番DB全体の半減やcycles削減率は未確認です。
- 再構築は、リポジトリのマイグレーションから生成した既知の表定義・制約・トリガー・索引に一致する場合だけ許可します。既知の旧FTS形式・共有FTS形式・統計表以外の追加や変更は、データを黙って落とさず拒否します。`scripts/generate-evidence-rebuild-schema.py`が定義カタログを生成し、ネイティブ／pinned Wasmの試験で検査します。

これらはローカル実装の検証結果です。本番デプロイ、実DBの切り替え、既存証拠の削除を実行した結果ではありません。
