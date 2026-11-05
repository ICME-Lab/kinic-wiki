# 学習証拠の容量と配送

`agent flush` とバックグラウンド配送は、1回あたり既定で32イベント・シリアライズ後1 MiBまで送信します。残りは次回の明示実行または通常の配送契機で処理されます。

共有保存に未対応の接続先では、旧形式で16 KiBを超えるhook記録は未送信のまま保留されます。保留だけが残っていても、後から追加された通常の小さい記録は配送できます。旧キューのID・本文は書き換えません。

`agent status` の `deferred_records`・`deferred_bytes`・`deferred_reasons` は、配送が検査して保存した保留情報です。`pending_records` に含まれる内数であり、配送済み・除外済み件数ではありません。未検査・一覧不完全の場合は不明を含みます。`agent flush` も `deferred`・`deferred_bytes`・`budget_exhausted` を返します。

旧記録を明示的に送る例外操作では、有限予算も指定します。これはサーバーの容量を増やす可能性があるため、移行前に自動実行しません。

```sh
kinic-vfs-cli agent flush --allow-legacy-evidence \
  --max-delivery-events 1 --max-delivery-bytes 1048576
```

共有保存能力のある接続先では旧記録も通常の有限予算内で送信できます。1件で指定バイト数を超えるイベントは `event_exceeds_delivery_budget` として保留されます。JSON化後の長さを使うため、会話ファイルの読み取り上限と同じ値とは限りません。

自動学習・自動公開・ジョブの状態はこの配送制御では変更しません。配送成功は学習成功や性能改善を意味しません。

共有保存を有効にしたDBでは、生の会話証拠はrun・ツール・時刻などの要約情報で検索します。会話全文の全文検索は行いません。通常のKnowledgeや案件文書の検索は維持します。元本文・履歴を取得するにはread-node/read-nodes/node-historyを使ってください。query-sqlのfs_nodes.contentは対象証拠について内部参照を返します。共有blob・manifest表は公開SQLから参照できません。
