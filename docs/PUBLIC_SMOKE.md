# Public Smoke

Use this flow before publishing a Browser build with CLI setup instructions. The local target is `local-wiki`, matching `icp.yaml`.

## Local Canister

The local cycles smoke prepares a project-local ICRC ledger when `KINIC_LEDGER_CANISTER_ID` is unset. Set `KINIC_LEDGER_WASM` if the ICRC ledger wasm is not in a known local cache path. `scripts/local/deploy_wiki.sh` defaults `BILLING_AUTHORITY_ID` to `icp identity principal` when it is not set.

```bash
icp network start -d -e local-wiki
ICP_ENVIRONMENT=local-wiki scripts/smoke/local_canister_archive_restore.sh
```

The smoke stores the generated ledger ID in `.icp/cache/local-kinic-ledger/local-wiki.id`, deploys the wiki with that ledger ID, approves the wiki canister on the ledger, and verifies archive/restore plus CLI cycle purchase. Resolve the local wiki canister ID from `.icp/cache/mappings/local-wiki.ids.json`, or pass `CANISTER_ID` explicitly.

## CLI and Browser Read Smoke

Create a database, write one file, and grant anonymous reader access for Browser reads:

```bash
CANISTER_ID=<local-wiki-canister-id>
REPLICA_HOST=http://127.0.0.1:8011
KINIC_LEDGER_CANISTER_ID="$(cat .icp/cache/local-kinic-ledger/local-wiki.id)"
DB_NAME="${DB_NAME:-Public Smoke}"
DB_ID="$(cargo run -p kinic-vfs-cli --bin kinic-vfs-cli -- --allow-non-ii-identity --replica-host "$REPLICA_HOST" --canister-id "$CANISTER_ID" database create "$DB_NAME")"
icp canister call "${KINIC_LEDGER_CANISTER_ID}" icrc2_approve \
  "(record { spender = record { owner = principal \"${CANISTER_ID}\"; subaccount = null }; amount = 200000000 : nat; expected_allowance = null; expires_at = null; fee = null; memo = null; from_subaccount = null; created_at_time = null })" \
  -e local-wiki -o candid
cargo run -p kinic-vfs-cli --bin kinic-vfs-cli -- --allow-non-ii-identity --replica-host "$REPLICA_HOST" --canister-id "$CANISTER_ID" \
  database purchase-cycles "$DB_ID" 1
printf '# Public Smoke\n\nalpha browser smoke\n' > /tmp/llm-wiki-smoke.md
cargo run -p kinic-vfs-cli --bin kinic-vfs-cli -- --allow-non-ii-identity --replica-host "$REPLICA_HOST" --canister-id "$CANISTER_ID" --database-id "$DB_ID" \
  write-node --path /Wiki/smoke.md --input /tmp/llm-wiki-smoke.md
cargo run -p kinic-vfs-cli --bin kinic-vfs-cli -- --allow-non-ii-identity --replica-host "$REPLICA_HOST" --canister-id "$CANISTER_ID" \
  database grant "$DB_ID" 2vxsx-fae reader
```

Start the Browser with local env values:

```bash
cd wikibrowser
NEXT_PUBLIC_WIKI_IC_HOST=http://127.0.0.1:8011 \
NEXT_PUBLIC_KINIC_WIKI_CANISTER_ID="$CANISTER_ID" \
pnpm dev
```

In another shell:

```bash
pnpm --dir wikibrowser smoke -- --url "http://127.0.0.1:3000/${DB_ID}/Wiki/smoke.md"
pnpm --dir wikibrowser smoke:errors -- --base-url http://127.0.0.1:3000 --database-id "$DB_ID"
```

## Archive/Restore Smoke

Run the combined canister and CLI archive smoke:

```bash
ICP_ENVIRONMENT=local-wiki scripts/smoke/local_canister_archive_restore.sh
```

That script runs the dedicated Rust archive/restore smoke and then verifies the public CLI commands:

- `database purchase-cycles`
- `database archive-export`
- `database archive-restore`
- `read-node`

The Rust smoke also verifies the deployed local canister path for archive/restore, upgrade persistence, FTS search, outgoing links, and isolation between two databases. The script targets the project-local replica from `icp network status`.

## Public Deployment Smoke

After deploying the Browser, run:

```bash
pnpm --dir wikibrowser smoke:public \
  --base-url https://<deployment>.workers.dev \
  --database-id <database-id> \
  --path /Wiki/<existing-file>.md
```

The target database must grant `2vxsx-fae` the `reader` role.
