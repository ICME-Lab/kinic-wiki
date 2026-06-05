# Marketplace Plan

Kinic Wiki に DB 閲覧権マーケットプレイスを追加するための計画。

目的は、複雑な金融商品ではなく「価値ある private DB を、購入者だけが読める」状態を最小実装で作ること。

## 結論

最初は「DB 全体の永続 Reader 相当閲覧権」を販売する。

- 売るもの: DB の閲覧権
- 売らないもの: Writer 権、Owner 権、DB 所有権、二次流通権
- 購入前に見せるもの: title、description、LLM summary、sample excerpts、node count、最終更新日、tags、price
- 購入後に許可するもの: read、list、search、graph
- 権限正本: `database_members` ではなく `market_entitlements`
- API 名: `market_` prefix
- 購入権: 永続。active 判定は `status = 'active'` のみ。
- DB delete/archive: owner 権限を維持し、禁止しない。UI/CLI で購入者影響を警告する。
- 決済: ユーザー別 KINIC balance を正本にし、購入時は外部 ledger を呼ばない。
- cashout: MVP では実装しない。seller 売上は内部 balance までに留める。

## なぜこの形にするか

`database_members` に reader を直接追加すると、owner が後から revoke できる。
購入者から見ると「買った権利が消える」ため、販売契約として弱い。

購入権は `market_entitlements` に分離する。
通常 ACL と購入権を分けることで、手動 grant、owner 管理、paid access、期限管理を混ぜずに扱える。

決済は buyer から seller への direct transfer ではなく、deposit 済み残高で処理する。
閲覧権購入時に ledger call を行うと、ledger await と entitlement 付与が同じ update に混在し、曖昧結果、重複実行、local apply failure の復旧分岐が増える。
購入は canister 内の SQLite transaction だけで buyer debit、seller credit、entitlement grant を確定する。

## 決済前提

- deposit は `approve + icrc2_transfer_from` で buyer account から canister account へ KINIC を移す。
- 閲覧権購入時は外部 ledger を呼ばず、内部 balance transaction だけで確定する。
- deposit の ledger 曖昧結果は `kinic_pending_operations` で扱う。

## MVP Scope

MVP で作るもの:

- DB owner が listing を作成できる。
- listing は DB 全体に紐付く。
- listing は公開 metadata を持つ。
- buyer は KINIC を deposit して内部 balance を持つ。
- buyer は内部 balance で閲覧権を購入する。
- purchase 成功後、buyer に active entitlement を付与する。
- seller 売上は seller の内部 balance に credit する。
- read 系認可は `database_members` または active `market_entitlements` を許可する。
- active entitlement が残る DB の delete/archive は許可し、UI/CLI で警告する。
- listing 検索は本文検索と分離する。
- delete/archive 前に active entitlement count を返す query を提供する。

MVP で作らないもの:

- Writer / Owner 権限販売
- prefix 単位販売
- snapshot 固定販売
- platform fee split
- refund
- resale
- ZKP
- 購入者ごとの LLM 要約生成
- 複数 token
- seller withdraw
- kinic pending operation repair/cancel

## Buyer Experience

購入者は Marketplace 一覧から listing を探す。
詳細画面では本文全体ではなく、購入判断材料だけを見る。

表示するもの:

- title
- description
- LLM summary
- sample excerpts
- sample questions
- topics / tags
- node count
- logical size
- last updated
- seller
- price

購入前に balance が不足する場合、deposit 画面へ誘導する。
購入後は My purchases に DB が表示され、通常の WikiBrowser と同じ read/search/graph UI で読む。

## Seller Experience

seller は既存 DB 管理画面から「Sell this DB」を押す。
公開情報を入力し、必要なら LLM summary を生成する。

seller が入力するもの:

- title
- description
- tags
- price
- sample excerpts

LLM summary は任意。
生成する場合も listing publish 時だけ実行し、閲覧ごとには生成しない。
summary には `summary_snapshot_revision` を持たせる。
DB 更新で listing snapshot と current snapshot がズレた場合、購入は止めずに stale 警告を表示する。

## Value Signals

DB 本文は購入前に全面公開しない。
価値証明は暗号ではなく、購入判断材料として提示する。

使う signal:

- LLM summary
- seller description
- sample excerpts
- sample questions
- node count
- prefix stats
- last updated
- provenance
- purchase count
- report count

ZKP は使わない。
「内容が有益」という性質は暗号で証明しにくい。
最初は preview、sample、統計、評判で判断させる。

## Entitlement Model

`market_entitlements` を追加する。

```sql
CREATE TABLE market_entitlements (
  database_id TEXT NOT NULL,
  buyer_principal TEXT NOT NULL,
  listing_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  purchased_at_ms INTEGER NOT NULL,
  status TEXT NOT NULL,
  PRIMARY KEY (database_id, buyer_principal, listing_id)
);
```

DB 全体閲覧権販売なので、同じ DB を relist しても二重購入させない。

```sql
CREATE UNIQUE INDEX market_entitlements_database_buyer_idx
  ON market_entitlements(database_id, buyer_principal)
  WHERE status = 'active';
```

認可判定:

```text
can_read = database_members has reader/writer/owner
        OR market_entitlements has active entitlement
```

Writer 系 update は entitlement では許可しない。
owner revoke は entitlement に影響しない。
`list_database_members`、cycles history、Owner/Writer update は entitlement を見ない。

実装では `load_member_role` と `role_allows` を変更しない。
`require_database_read_access` などの新規 helper を作り、member role が通る場合は許可し、明示した read surface だけ active entitlement を許可する。

active entitlement 判定:

```sql
status = 'active'
```

anonymous principal は entitlement 対象外にする。

購入済み entitlement で許可する read surface は以下に限定する。

- `read_node`
- `list_children`
- `list_nodes`
- `search_nodes`
- `search_node_paths`
- `incoming_links`
- `outgoing_links`
- `graph_links`
- `graph_neighborhood`
- `read_node_context`

`export_snapshot`、`fetch_updates`、source generation、URL ingest、write/update 系、member/cycles 管理系は entitlement では許可しない。

## Payment Model

KINIC は marketplace 内部 balance に deposit してから使う。

購入時に外部 ledger は呼ばない。
購入 transaction は index DB だけを更新する。

MVP invariant:

- deposit は既存 cycles purchase と同じく `approve + icrc2_transfer_from` で canister account に入れる。
- deposit の ledger await は購入処理と分離する。
- seller 売上の withdraw は実装しない。

deposit は buyer から canister default account への `transfer_from` として扱う。
既に `database_cycle_pending_operations` が ledger await と曖昧結果を扱う設計を持つため、KINIC deposit も同じ pattern の pending table を持つ。

### Deposit Flow

1. wallet が KINIC ledger で canister を spender に `icrc2_approve` する。
2. buyer が `market_deposit_balance(amount_e8s, expected_fee_e8s)` を呼ぶ。
3. canister が `kinic_pending_operations` に `deposit` を作成する。
4. canister が `icrc2_transfer_from` で buyer account から canister account へ KINIC を移す。
5. ledger success または `Duplicate` success なら buyer internal balance に credit する。
6. `kinic_ledger` に `deposit` を記録し、pending operation を削除する。

同一 caller の deposit は guard で直列化する。
ledger 明示 error では pending operation を削除し、内部 balance は更新しない。
ledger 結果曖昧、または ledger success 後 local apply 前に失敗した場合は pending operation を残す。
MVP では deposit repair/cancel API は作らず、既存 cycles purchase と同じく caller と billing authority が pending 状態を確認して運用する。

### Internal Balance

`kinic_accounts` を追加する。
これは marketplace 専用ではなく、将来ほかの KINIC 利用でも参照できる canister 内部 account である。

```sql
CREATE TABLE kinic_accounts (
  principal TEXT PRIMARY KEY,
  balance_e8s INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
```

`kinic_ledger` を内部 balance の正本履歴にする。
履歴の `source` で marketplace 由来か別用途由来かを区別する。

```sql
CREATE TABLE kinic_ledger (
  entry_id INTEGER PRIMARY KEY AUTOINCREMENT,
  principal TEXT NOT NULL,
  source TEXT NOT NULL,
  kind TEXT NOT NULL,
  amount_e8s INTEGER NOT NULL,
  balance_after_e8s INTEGER NOT NULL,
  counterparty TEXT,
  listing_id TEXT,
  order_id TEXT,
  external_block_index INTEGER,
  created_at_ms INTEGER NOT NULL
);
```

`kind` は MVP では `deposit`, `purchase`, `sale` だけにする。

### Purchase Flow

`market_purchase_access(listing_id, price_e8s, expected_revision)` は ledger を呼ばない。

1. caller 認証。anonymous は拒否。
2. listing が active で、price と revision が一致することを確認。
3. buyer balance が price 以上であることを確認。
4. buyer から price を debit。
5. seller に price を credit。
6. `market_orders` と buyer/seller の `kinic_ledger` を記録。
7. `market_entitlements` を付与。

全手順を 1 SQLite transaction で行う。
同じ buyer が同じ listing を再購入した場合は拒否する。

### Future Withdraw

MVP では withdraw を実装しない。
理由は、canister から外部 ledger へ outgoing transfer する場合、fee、ambiguous transfer repair、同一 TransferArg retry が同時に必要になるためである。

withdraw は別 PR とし、fee、created_at_time、`Duplicate` 成功扱い、同一 TransferArg retry、repair/cancel API を同時に設計する。

## Listing Model

`market_listings` を追加する。

```sql
CREATE TABLE market_listings (
  listing_id TEXT PRIMARY KEY,
  seller_principal TEXT NOT NULL,
  database_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  llm_summary TEXT,
  summary_snapshot_revision TEXT,
  sample_excerpts_json TEXT NOT NULL,
  sample_questions_json TEXT NOT NULL,
  tags_json TEXT NOT NULL,
  price_e8s INTEGER NOT NULL,
  status TEXT NOT NULL,
  revision INTEGER NOT NULL,
  purchase_count INTEGER NOT NULL,
  report_count INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
```

制約:

- seller は対象 DB の owner だけ。
- `price_e8s > 0`。
- `status` は `draft`, `active`, `paused`。
- active listing の公開 metadata / price 変更は revision を進める。

## Order Model

`market_orders` を追加する。

```sql
CREATE TABLE market_orders (
  order_id TEXT PRIMARY KEY,
  listing_id TEXT NOT NULL,
  database_id TEXT NOT NULL,
  buyer_principal TEXT NOT NULL,
  seller_principal TEXT NOT NULL,
  price_e8s INTEGER NOT NULL,
  listing_revision INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL
);
```

`order_id` は canister 側生成にする。
購入 API が ledger を呼ばないため、重複購入は entitlement existence で判定する。

## Pending Operations

MVP では `kinic_pending_operations` を deposit の曖昧結果に使う。
purchase は外部 ledger を呼ばないため pending operation を持たない。

構造は既存 `database_cycle_pending_operations` と同じ考え方にする。
既存 table は DB cycles 専用であり、KINIC 内部 balance には流用しない。

```sql
CREATE TABLE kinic_pending_operations (
  operation_id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  caller TEXT NOT NULL,
  amount_e8s INTEGER NOT NULL,
  from_owner TEXT,
  from_subaccount BLOB,
  to_owner TEXT,
  to_subaccount BLOB,
  ledger_fee_e8s INTEGER,
  operation_status TEXT NOT NULL,
  external_block_index INTEGER,
  ledger_created_at_time_ns INTEGER,
  created_at_ms INTEGER NOT NULL
);
```

`operation_status` は `in_flight`, `ambiguous`, `completed`。
MVP では repair/cancel method は作らず、caller と billing authority が pending 状態を確認できる query を用意する。
withdraw PR では repair/cancel method も同時に実装する。

## API

すべて `market_` prefix を付ける。

MVP:

- `market_get_balance`
- `market_deposit_balance`
- `market_create_listing`
- `market_update_listing`
- `market_publish_listing`
- `market_pause_listing`
- `market_list_listings`
- `market_list_database_listings`
- `market_get_listing`
- `market_preview_purchase`
- `market_purchase_access`
- `market_list_entitlements`
- `market_list_orders`
- `market_count_active_entitlements`
- `market_list_pending_operations`

`market_list_pending_operations` は `kinic_pending_operations` のうち marketplace deposit に関係する pending だけを返す。

MVP では作らない:

- `market_withdraw_balance`
- `market_repair_withdraw_complete`
- `market_repair_withdraw_cancel`
- `market_refund_purchase`

後続候補:

- `market_list_seller_listings`
- `market_report_listing`
- `market_update_summary`
- platform fee 設定

## UI

最初の画面は 4 つにする。

- Marketplace: listing 一覧
- Listing detail: preview と purchase
- My purchases: 購入済み DB 一覧
- Market wallet: deposit、balance、履歴

seller 操作は既存 DB 管理画面に追加する。

- Sell this DB
- Edit listing
- Publish listing
- Pause listing
- Delete/archive warning

## Delete And Archive Rule

active entitlement がある DB でも owner は delete/archive できる。

理由:

- 著作権と DB 管理権は作者・owner 側に残す。
- marketplace entitlement は Reader 相当の閲覧権であり、owner 権限を奪わない。
- refund や escrow は MVP に入れない。

UI/CLI は delete/archive 前に active entitlement 数を表示し、購入者が影響を受けることを警告する。
canister API は既存 owner 権限を維持する。

DB delete 後は listing と entitlement rows を削除する。
market_orders は購入履歴・監査ログとして残す。

Marketplace write operation は DB storage metering ではなく KINIC internal account と listing metadata の管理面 write として扱い、`with_unmetered_update` のままにする。
listing metadata は validator のサイズ上限を持ち、seller は DB owner に限定する。

## Abuse Controls

MVP は DB owner が listing を作成できる。
seller 制限 table は作らない。

必要な後続管理操作:

- listing pause
- abusive listing delist
- report count display

## Open Questions

- price は seller 入力か、初期は固定価格か。
- purchase count と report count を公開するか。
- LLM summary generation は Worker 経由か、seller 手書きだけで始めるか。
- active entitlement が残る DB の rename は許可するか。
- seller cashout を後続で入れる場合の outgoing transfer repair 方式。
- seller cashout を入れる前に seller 内部 balance を何に使えるようにするか。

## Implementation Order

1. `market_` public types を `vfs_types` に追加する。
2. index schema に `kinic_accounts`、`kinic_ledger`、`kinic_pending_operations`、listing、order、entitlement を追加する。
3. canister runtime に deposit transfer_from、balance credit、listing CRUD を追加する。
4. purchase なしで entitlement seed helper を作り、read surface の認可テストを追加する。
5. read/list/search/graph 認可に entitlement 判定を追加する。
6. market purchase transaction を追加する。
7. delete/archive の UI/CLI warning を追加する。canister guard は追加しない。
8. CLI に最小 market commands を追加する。
9. WikiBrowser に Marketplace、Listing detail、My purchases、Market wallet を追加する。
10. IDL generator、hand-written TS IDL、Rust client、candid shape tests を同期する。
11. unit tests と e2e smoke を追加する。

## Verification

最低限の検証:

- DB owner は listing 作成可能。
- DB owner 以外は listing 作成不可。
- listing publish 後、anonymous は preview だけ読める。
- 未購入 buyer は DB 本文を読めない。
- `market_deposit_balance` は pending operation を作り、ledger success 後だけ buyer balance を credit する。
- ledger `Duplicate` は同一 pending operation の success として扱う。
- deposit の ambiguous / completed pending は repair API なしで caller と billing authority が確認する。
- purchase は外部 ledger を呼ばず、buyer balance を debit し seller balance を credit する。
- purchase 成功後、buyer は read/list/search/graph できる。
- purchase entitlement では write できない。
- owner revoke は entitlement に影響しない。
- 永続 entitlement は期限切れしない。
- DB 更新後、listing は stale 警告を表示するが購入可能。
- sample excerpt は listing metadata から返り、DB 本文 API を匿名に開かない。
- `export_snapshot` と `fetch_updates` は entitlement では拒否される。
- seller が対象 DB owner であることは create/update/publish/purchase 時に再確認される。
- active entitlement があっても owner は delete/archive できる。
- UI/CLI は delete/archive 前に購入者影響を警告する。
