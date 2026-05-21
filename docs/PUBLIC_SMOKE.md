# Public Smoke

Use this flow before publishing a Browser build with CLI setup instructions. The local target is `local-wiki`, matching `icp.yaml`.

## Local Canister

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
DB_ID="$(cargo run -p kinic-vfs-cli --bin kinic-vfs-cli -- --replica-host "$REPLICA_HOST" --canister-id "$CANISTER_ID" database create "$DB_NAME")"
printf '# Public Smoke\n\nalpha browser smoke\n' > /tmp/llm-wiki-smoke.md
cargo run -p kinic-vfs-cli --bin kinic-vfs-cli -- --replica-host "$REPLICA_HOST" --canister-id "$CANISTER_ID" --database-id "$DB_ID" \
  write-node --path /Wiki/smoke.md --input /tmp/llm-wiki-smoke.md
cargo run -p kinic-vfs-cli --bin kinic-vfs-cli -- --replica-host "$REPLICA_HOST" --canister-id "$CANISTER_ID" \
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
