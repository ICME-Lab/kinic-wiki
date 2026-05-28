# Public Smoke

Use this flow before publishing a Browser build with CLI setup instructions. The local target is `local-wiki`, matching `icp.yaml`.

## Local Canister

The local credits smoke expects an ICRC ledger installed at `KINIC_LEDGER_CANISTER_ID` and enough local KINIC balance on the current `icp identity` for DB credit purchases plus ledger fees. `scripts/local/deploy_wiki.sh` defaults `SNS_GOVERNANCE_ID` to `icp identity principal` when it is not set.

```bash
icp network start -d -e local-wiki
ICP_ENVIRONMENT=local-wiki bash scripts/local/deploy_wiki.sh
```

Resolve the local wiki canister ID from `.icp/cache/mappings/local-wiki.ids.json`, or pass `CANISTER_ID` explicitly.

## CLI and Browser Read Smoke

Create a database, write one file, and grant anonymous reader access for Browser reads:

```bash
CANISTER_ID=<local-wiki-canister-id>
REPLICA_HOST=http://127.0.0.1:8001
DB_NAME="${DB_NAME:-Public Smoke}"
DB_ID="$(cargo run -p kinic-vfs-cli --bin kinic-vfs-cli -- --allow-non-ii-identity --replica-host "$REPLICA_HOST" --canister-id "$CANISTER_ID" database create "$DB_NAME")"
icp canister call "${KINIC_LEDGER_CANISTER_ID:-73mez-iiaaa-aaaaq-aaasq-cai}" icrc2_approve \
  "(record { spender = record { owner = principal \"${CANISTER_ID}\"; subaccount = null }; amount = 200000000 : nat; expected_allowance = null; expires_at = null; fee = null; memo = null; from_subaccount = null; created_at_time = null })" \
  -e local-wiki -o candid
cargo run -p kinic-vfs-cli --bin kinic-vfs-cli -- --allow-non-ii-identity --replica-host "$REPLICA_HOST" --canister-id "$CANISTER_ID" \
  database purchase-credits "$DB_ID" 100000000
printf '# Public Smoke\n\nalpha browser smoke\n' > /tmp/llm-wiki-smoke.md
cargo run -p kinic-vfs-cli --bin kinic-vfs-cli -- --allow-non-ii-identity --replica-host "$REPLICA_HOST" --canister-id "$CANISTER_ID" --database-id "$DB_ID" \
  write-node --path /Wiki/smoke.md --input /tmp/llm-wiki-smoke.md
cargo run -p kinic-vfs-cli --bin kinic-vfs-cli -- --allow-non-ii-identity --replica-host "$REPLICA_HOST" --canister-id "$CANISTER_ID" \
  database grant "$DB_ID" 2vxsx-fae reader
```

Start the Browser with local env values:

```bash
cd wikibrowser
NEXT_PUBLIC_WIKI_IC_HOST=http://127.0.0.1:8001 \
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
CANISTER_ID=<local-wiki-canister-id> scripts/smoke/local_canister_archive_restore.sh
```

That script runs the dedicated Rust archive/restore smoke and then verifies the public CLI commands:

- `database purchase-credits`
- `database archive-export`
- `database archive-restore`
- `read-node`

The Rust smoke also verifies the deployed local canister path for archive/restore, upgrade persistence, FTS search, outgoing links, and isolation between two databases. The script targets the project-local replica with `--replica-host http://127.0.0.1:8001`.

## Public Deployment Smoke

After deploying the Browser, run:

```bash
pnpm --dir wikibrowser smoke:public \
  --base-url https://<deployment>.workers.dev \
  --database-id <database-id> \
  --path /Wiki/<existing-file>.md
```

The target database must grant `2vxsx-fae` the `reader` role.
