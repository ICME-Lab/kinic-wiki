# Public Smoke

Use this flow before publishing a Browser build with CLI setup instructions. The local target is `local-wiki`, matching `icp.yaml`.

## Local Canister

The local credits smoke prepares a project-local ICRC ledger when `KINIC_LEDGER_CANISTER_ID` is unset. Set `KINIC_LEDGER_WASM` if the ICRC ledger wasm is not in a known local cache path. `scripts/local/deploy_wiki.sh` defaults `SNS_GOVERNANCE_ID` to `icp identity principal` when it is not set.

```bash
icp network start -d -e local-wiki
ICP_ENVIRONMENT=local-wiki scripts/smoke/local_canister_archive_restore.sh
```

The smoke stores the generated ledger ID in `.icp/cache/local-kinic-ledger/local-wiki.id`, deploys the wiki with that ledger ID, approves the wiki canister on the ledger, performs smoke-only credit purchases through direct canister calls, and verifies archive/restore plus CLI reads and writes. Resolve the local wiki canister ID from `.icp/cache/mappings/local-wiki.ids.json`, or pass `CANISTER_ID` explicitly.
The wiki canister constructor requires `CreditsConfig`; no-arg fresh install and reinstall are unsupported.

## CLI and Browser Read Smoke

Create an active database, write one file, and grant anonymous reader access for Browser reads. Newly created databases are pending until the first browser wallet credit purchase completes.

```bash
CANISTER_ID=<local-wiki-canister-id>
REPLICA_HOST=http://127.0.0.1:8001
DB_NAME="${DB_NAME:-Public Smoke}"
DB_ID="$(cargo run -p kinic-vfs-cli --bin kinic-vfs-cli -- --allow-non-ii-identity --replica-host "$REPLICA_HOST" --canister-id "$CANISTER_ID" database create "$DB_NAME")"
# Complete the first credit purchase in the Browser wallet flow before write-node.
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
ICP_ENVIRONMENT=local-wiki scripts/smoke/local_canister_archive_restore.sh
```

That script runs the dedicated Rust archive/restore smoke and then verifies the public CLI commands:

- `database archive-export`
- `database archive-restore`
- `read-node`

The Rust smoke also verifies the deployed local canister path for archive/restore, upgrade persistence, FTS search, outgoing links, and isolation between two databases. The script targets the project-local replica with `--replica-host http://127.0.0.1:8001`.

## Post-upgrade Args Smoke

Run the constructor and upgrade argument smoke:

```bash
KINIC_LEDGER_CANISTER_ID=<local-ledger-or-test-principal> scripts/smoke/local_canister_post_upgrade.sh
```

This deploys with `CreditsConfig`, creates one pending DB, upgrades with the same config, then verifies `get_credits_config` and DB metadata persistence. It does not perform a ledger credit purchase.

## Public Deployment Smoke

After deploying the Browser, run:

```bash
pnpm --dir wikibrowser smoke:public \
  --base-url https://<deployment>.workers.dev \
  --database-id <database-id> \
  --path /Wiki/<existing-file>.md
```

The target database must grant `2vxsx-fae` the `reader` role.
