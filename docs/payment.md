# Payment

## 用語

- `KINIC`: 外部 ICRC ledger 上の支払い token。金額は e8s で扱う。
- `cycles`: DB ごとの内部残高。KINIC から換算された raw cycles を整数で保持する。
- `database_cycle_accounts`: DB ごとの cycles 残高、停止時刻、ストレージ課金カーソルを保持する。
- `database_cycle_ledger`: cycles 履歴の正本。購入、更新課金、ストレージ課金、停止を記録する。
- `database_cycle_pending_operations`: transfer 中、ledger 結果曖昧、または ledger 成功後 local apply 前の cycles 購入を保持する。

## 課金設定

`cycles_billing_config` は index DB に保存される。

| key | 意味 |
| --- | --- |
| `kinic_ledger_canister_id` | KINIC ledger canister。初期化時に固定される。 |
| `billing_authority_id` | 課金設定更新と cycles 履歴の全件閲覧権限 principal。初期化時に固定される。 |
| `cycles_per_kinic` | `1 KINIC` あたりの付与 cycles。 |
| `min_update_cycles` | metered update 開始に必要な最低 DB cycles 残高。 |

既定値は以下である。

| 項目 | 値 |
| --- | --- |
| `cycles_per_kinic` | `234_500_000_000` (`1 KINIC = 0.2345 Tcycle`) |
| `min_update_cycles` | `1_000_000` |
| KINIC ledger fee | `100_000 e8s` |
| KINIC decimals | `8` |

`update_cycles_billing_config` は認証済み caller のみ呼べる。caller が `billing_authority_id` と一致しない場合は拒否する。引数は `CyclesBillingConfigUpdate` record で、変更できる値は `cycles_per_kinic` と `min_update_cycles` のみである。

mainnet deploy script は `KINIC_LEDGER_CANISTER_ID` と `BILLING_AUTHORITY_ID` を明示必須にする。`kinic_ledger_canister_id` は支払い ledger canister の ID であり、billing authority でも rate 設定でもない。

設定値は次を満たす必要がある。

- `kinic_ledger_canister_id` と `billing_authority_id` は valid principal text かつ anonymous ではない。
- `cycles_per_kinic` と `min_update_cycles` は 0 ではなく、`i64` に収まる。

## DB 作成と残高初期状態

`create_database(display_name)` は generated `database_id`、owner membership、cycles account を作成する。DB は `pending` になり、stable-memory mount はまだ割り当てない。初期 `balance_cycles` は `0`、`suspended_at_ms` は作成時刻、`storage_charged_at_ms` は `NULL` である。

pending DB は、最初の cycles 購入が ledger 成功後にローカル反映まで完了した時点で active 化する。active 化では mount ID を割り当て、DB migration を実行し、`storage_charged_at_ms` を active 化時刻で初期化する。

古い pending DB は、同じ owner が新規 pending DB を作成する際に、作成から 24h 超過かつ pending cycles operation がない場合だけ purge 対象になる。owner ごとの未開始 pending DB 上限は 3 件である。

## 購入量計算

cycles は次の式で計算する。`10^KINIC_DECIMALS` は KINIC decimals 8 に由来する base-unit scale であり、現在は `100_000_000` である。小数は整数除算で切り捨てる。

```text
cycles = payment_amount_e8s * cycles_per_kinic / 10^KINIC_DECIMALS
```

購入実行時の現行 `cycles_per_kinic` で確定する。UI や CLI は同じ計算で見積 cycles を作り、`min_expected_cycles` として request に含める。ledger 転送前の再計算結果が `min_expected_cycles` 未満なら拒否する。

購入 request の公開型は `payment_amount_e8s: nat64` と `min_expected_cycles: nat64` だが、SQLite に保存する値は `i64` 範囲に制限する。購入は ledger 転送前に以下を拒否する。

- `payment_amount_e8s` が `0`
- `payment_amount_e8s` が `i64` に収まらない
- `cycles_per_kinic` が `0`
- 乗算結果が overflow する
- 換算後 cycles が `0`
- 換算後 cycles が `i64` に収まらない
- DB が存在しない
- DB status が `pending` / `active` 以外
- DB に owner が存在しない
- cycles account が存在しない
- pending DB に `cycles_purchase` pending operation が既にある
- 同一 caller の `cycles_purchase` pending operation が既にある
- 換算後 cycles が `min_expected_cycles` 未満
- 現在残高 + pending cycles + 購入 cycles が overflow する

## 購入実行

`purchase_database_cycles(DatabaseCyclesPurchaseRequest)` は update で、anonymous caller は拒否される。DB role は不要であり、認証済み caller なら既存 DB に cycles を購入できる。

request は以下を含む。

- `database_id`
- `payment_amount_e8s`
- `min_expected_cycles`

検証通過後、canister は現行 config で cycles を計算し、`database_cycle_pending_operations` に `kind = "cycles_purchase"`、`operation_status = "in_flight"` の行を作成する。pending operation には payer、cycles、支払い e8s、ledger fee、ledger created_at_time、from/to account、ledger 成功後の block index を保存する。

ledger 転送は KINIC ledger の `icrc2_transfer_from` を使う。

- from: caller principal
- to: canister principal
- amount: request の `payment_amount_e8s`
- fee: 固定 `ledger_fee_e8s`
- memo: `kvfs:cp:{operation_id}`
- created_at_time: purchase 開始時刻
- spender: canister principal

ledger が `Duplicate` error を返し、`duplicate_of` が `u64` に変換できる場合は成功扱いで進む。ledger が成功した場合、pending operation を `completed` にし、ledger block index を保存する。その後、対象 DB が pending なら mount 割当と DB migration を実行し、cycles 残高へ反映する。反映成功時は `database_cycle_ledger` に以下を記録し、pending operation を削除する。

| column | 値 |
| --- | --- |
| `kind` | `cycles_purchase` |
| `amount_cycles` | 購入 cycles |
| `balance_after_cycles` | 反映後 DB cycles 残高 |
| `payment_amount_e8s` | 支払い e8s |
| `caller` | payer |
| `method` | `purchase_database_cycles` |
| `ledger_block_index` | ledger transfer block index、または `Duplicate.duplicate_of` |

ledger が `BadFee` error を返し、`expected_fee` が `u64` に変換できる場合、canister は pending operation 削除を試行し、`icrc2_transfer_from failed: BadFee expected fee ...; re-approve with the current ledger fee and retry` を返す。その他の明示的 ledger error でも pending operation 削除を試行し、caller へ ledger error を返す。この場合 cycles ledger は増えず、DB 予約と cycles account は維持される。

ledger call、response decode、または結果判定が曖昧な場合、canister は `operation_status = "ambiguous"` の pending operation と DB reservation を保持する。cycles ledger は増えない。caller には operation ID を含む billing authority review required error を返す。v1 では repair / cancel API は提供しない。

ledger 成功後に pending DB activation、migration、または cycles 残高反映が失敗した場合、`completed` pending operation と DB 予約を残す。cycles ledger は増えず、cycles 残高も増えない。caller には operation ID と ledger block index を含む local apply error を返す。v1 では retry API は提供しない。

browser `/cycles` は approve 後の purchase failure でも通常の error 表示だけを行う。復旧パネルやブラウザ保存は行わない。

## Wallet UI

`/cycles` route は canister ID を URL から受け取らない。`NEXT_PUBLIC_KINIC_WIKI_CANISTER_ID` を canister ID として使う。query から読む値は以下だけである。

- `database_id` または `databaseId`
- `kinic`

`database_id` は必須で、`[a-zA-Z0-9_-]+` のみ許可される。`kinic` は初期入力値であり、購入額は UI 上で編集できる。未指定時の初期入力は `1`。

KINIC 入力は正の数だけ許可する。小数は最大 8 桁、URL/UI parser 上の e8s 換算値は `u64::MAX` 以下でなければならない。購入直前の wallet flow は canister 実効上限として `payment_amount_e8s <= i64::MAX` と `amount_cycles <= i64::MAX` も確認する。

OISY と Plug の wallet flow は、購入直前に canister config を取得する。承認 allowance は次である。

```text
approved_allowance_e8s = payment_amount_e8s + ledger_fee_e8s
```

approve の transaction fee は wallet 残高から別途支払われる。approve は現在 allowance を `expected_allowance` として渡し、30 分後に expire する。approve 後に purchase が失敗した場合、UI は approval が expire まで残る旨を error に含める。

UI は `NEXT_PUBLIC_KINIC_WIKI_CANISTER_ID` と request canister ID が一致しない場合に拒否する。Plug は VFS canister と KINIC ledger canister を whitelist して接続する。OISY は接続確認後に signer popup を閉じ、購入時に再度 signer を開いて同じ owner であることを確認する。OISY は ICRC wallet の call-canister 結果 certificate を検証し、method、canister、arg、reply を照合する。

## ICRC-21 consent

`icrc21_canister_call_consent_message` は `purchase_database_cycles` だけ対応する。他 method は unsupported になる。

consent 生成時は request arg を `DatabaseCyclesPurchaseRequest` として decode し、現行 config で cycles を計算する。計算結果が `min_expected_cycles` 未満、または DB や支払額が購入条件を満たさない場合は unsupported になる。

表示内容は database ID、cycles、payment KINIC、allowance に含める ledger fee、spender canister を含む。

## 更新課金

metered update は実行前に `prepare_metered_update` で認可と残高確認を行う。順序は次である。

1. DB status を読み、caller の DB role を読む。
2. required role を満たさない場合は拒否する。
3. `cycles_billing_config` を読む。
4. cycles account の `suspended_at_ms` が `Some` なら拒否する。
5. `balance_cycles < min_update_cycles` なら拒否する。

`check_database_write_cycles(database_id)` は anonymous caller を明示的に拒否し、writer 以上の role と cycles 利用可能状態を確認する。

`grant_database_access` は owner role を要求する metered update である。suspended または `min_update_cycles` 未満の DB では grant も拒否される。成功時の charge ledger は `method = "grant_database_access"` を記録する。

canister の metered update wrapper は、更新前後の `performance_counter(InstructionCounter)` 差分に metered DB billing base charge `20_000_000 cycles` を加えた値を `cycles_delta` として計算する。IC の 13-node execution fee model は `5_000_000 cycles + 1 cycle per executed Wasm instruction` だが、DB billing は `5_000_000` cycles の execution base と `15_000_000` cycles の internal accounting overhead を合わせて請求する。overhead は local canister 実測で `charge_database_update` 後の index DB 書込をカバーする目的である。これは実際の canister 残高差分ではなく、DB 内部請求値である。`canister_cycle_balance` は同一 message 内の実行課金確定前の残高を返すため、update 本体の課金計測には使わない。更新関数が `Ok` を返した場合だけ、`charge_database_update` を実行する。

wrapper 経由の成功 update では `cycles_delta` に base fee が含まれるため、通常 0 にはならない。`charge_database_update` に直接 `cycles_delta = 0` を渡した場合だけ、残高更新も ledger 記録も行わない。`cycles_delta` が `i64` に収まらない場合は `cycle charge exceeds i64 limit` になる。

`charge_database_update` は現在残高より請求額が大きい場合、残高を全徴収して `balance_after_cycles = 0` にし、DB を suspended にする。ledger の `amount_cycles` は実際に徴収した cycles、`cycles_delta` は metered DB billing base charge と instruction 差分から計算した請求額を記録する。

課金成功時は残高から実徴収額を引く。更新後残高が `min_update_cycles` 未満なら `suspended_at_ms` を課金時刻に設定し、それ以上なら `NULL` にする。ledger には以下を記録する。

| column | 値 |
| --- | --- |
| `kind` | `charge` |
| `amount_cycles` | 実徴収額 `paid_cycles` の負数 |
| `balance_after_cycles` | 課金後残高 |
| `caller` | update caller |
| `method` | update method name |
| `cycles_delta` | `cycles_delta` |
| `cycles_per_kinic` | 課金時 config の `cycles_per_kinic` |

残高ぴったりの請求は成功し、残高は `0` になり suspended になる。

## ストレージ課金

ストレージ課金は active DB だけ対象である。canister timer は 24h ごとに `settle_database_storage_charges` を呼ぶ。controller は同じ entrypoint を手動実行できる。

各 active DB について現在の DB size を測定し、`logical_size_bytes` を更新する。`storage_charged_at_ms` が `NULL` の場合は課金せず、課金カーソルを現在時刻に設定する。

前回課金時刻から 24h 未満の場合は何もしない。24h 以上経過した場合、次の式で課金 cycles を計算する。

```text
storage_cycles = logical_size_bytes * elapsed_seconds * 127_000 / 2^30
```

`elapsed_seconds` は `elapsed_ms / 1000` の整数除算である。`logical_size_bytes == 0` または `elapsed_ms <= 0` の場合、課金 cycles は `0` になる。課金 cycles が `0` の場合、ledger は記録せず、課金カーソルだけ現在時刻に更新する。

残高が不足する場合、支払える分だけ `paid_cycles = max(min(balance_cycles, charge_cycles), 0)` として徴収する。未払い分は debt として追跡せず、v1 subsidy/suspension policy として残高超過分を forgive する。課金後残高が `min_update_cycles` 未満、または `paid_cycles < charge_cycles` の場合は suspended になる。既に suspended の場合は元の `suspended_at_ms` を維持する。次回 settle は更新済み cursor から再計算する。storage debt 実装は別 PR の follow-up とする。

`paid_cycles > 0` の場合、ledger に `kind = "storage_charge"` を記録する。新たに suspended になった場合は続けて `kind = "suspend"` を記録する。`suspend` の `amount_cycles` は `0` である。

1 GiB を 24h 保持した場合の課金は `10_972_800_000 cycles`。10 MiB を 24h 保持した場合の課金は `107_156_250 cycles`。

## 履歴と権限

`list_database_cycle_entries(database_id, cursor, limit)` は cycles ledger を entry ID 昇順で返す。`limit` は `1..=100` に clamp される。`next_cursor` は取得件数が limit を超えた場合に返る。

閲覧権限は以下である。

| caller | 結果 |
| --- | --- |
| billing authority | DB member でなくても全履歴を閲覧できる。caller は redacted されない。 |
| owner | 全履歴を閲覧できる。caller は redacted されない。 |
| writer | 履歴を閲覧できる。各 entry の `caller` は `redacted`。 |
| reader | 履歴を閲覧できる。各 entry の `caller` は `redacted`。 |
| member ではない caller | 拒否される。 |

Pending cycles purchase は owner、billing authority、payer が `list_database_cycles_pending_purchases(database_id)` または CLI `database cycles-pending <database-id>` で確認できる。返却値は `operation_id`、`database_id`、`status`、`amount_cycles`、`payment_amount_e8s`、`ledger_block_index`、`created_at_ms`、`required_action` を含む。無関係 caller は拒否される。

`required_action` は `status` から決まる。

| `status` | `required_action` |
| --- | --- |
| `in_flight` | `wait_for_ledger_result` |
| `ambiguous` | `billing_authority_review` |
| `completed` | `billing_authority_review` |
| その他 | `billing_authority_review` |

## Ledger 結果と no-credit

`purchase_database_cycles` は `icrc2_transfer_from` が `Ok(block_index)` を返し、local activation/apply も完了した場合だけ内部 cycles 残高へ credit する。明確な ledger error は pending operation を削除し、残高と ledger entry を変更しない。pending DB で明確な ledger error が起きた場合も、DB 予約は残り、再 approve / retry できる。

inter-canister call 失敗や response decode 失敗など ledger 結果が曖昧な場合、canister は `ambiguous` pending operation と DB reservation を保持し、cycles ledger と cycles 残高は更新しない。pending は確認専用であり、v1 では repair / cancel API はない。

ledger transfer 成功後に pending DB activation や cycles apply が失敗した場合は、`completed` pending operation と DB reservation を残す。`database_cycle_ledger` と cycles 残高は更新しない。pending は確認専用であり、v1 では retry API はない。

## 削除

`delete_database(DeleteDatabaseRequest)` は owner のみ実行できる。DB status は `pending` または `active` でなければならない。

削除前に pending cycles operation が 1 件でも存在する場合は拒否する。拒否 error は最初の該当 operation の `operation_id`、`status`、`required_action` を含む。ledger 成功後の local apply 失敗では `completed` pending operation が残るため、この状態が解消されるまで削除できない。

削除成功時は DB file を削除できる環境では削除し、index DB から以下を削除する。

- `database_cycle_pending_operations`
- `database_cycle_ledger`
- `database_cycle_accounts`
- `database_members`
- `database_restore_chunks`
- `database_restore_sessions`
- `url_ingest_trigger_sessions`
- `ops_answer_sessions`
- `source_run_sessions`
- `databases`

残った cycles balance は返金されず破棄される。

## 実装根拠

- `crates/vfs_runtime/src/lib.rs`: cycles 設定、pending operation、残高反映、更新課金、ストレージ課金、履歴権限、削除条件。
- `crates/vfs_canister/src/lib.rs`: canister entrypoint、認証、ICRC ledger call、ICRC-21 consent、metered update wrapper。
- `crates/vfs_types/src/fs.rs`: 公開 Candid/serde 型。
- `crates/vfs_types/src/lib.rs`: fixed KINIC ledger fee。
- `wikibrowser/lib/cycles-wallet.ts`: OISY/Plug approve と purchase flow。
- `wikibrowser/lib/cycles-url.ts`: `/cycles` の database ID と KINIC 入力 validation。
- `wikibrowser/app/cycles/page.tsx`: canister ID を環境変数から固定する route 挙動。
- `crates/vfs_runtime/tests/database_service.rs`: 購入、履歴 redaction、pending operation 表示、更新課金、削除の期待挙動。
