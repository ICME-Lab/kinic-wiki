# CLI

`kinic-vfs-cli` is the shell interface for the canister-backed VFS.
This document covers wiki/database operator operations: connection, database management, node reads and writes, search, links, and archive/restore.
Skill Registry commands use the same binary under `kinic-vfs-cli skill ...`; their source of truth is [`SKILL_REGISTRY.md`](SKILL_REGISTRY.md).

The canister also exposes read-only Agent Memory API methods such as `memory_manifest`, `query_context`, and `source_evidence`.
Those are direct canister/client methods, not CLI commands in this document.
Use the CLI commands below for shell workflows against the remote VFS.

## Build

During development, examples use `cargo run` so they always execute the current checkout.
For operator use, build the binary once:

```bash
cargo build -p kinic-vfs-cli --bin kinic-vfs-cli --release
target/release/kinic-vfs-cli --help
target/release/kinic-vfs-cli --canister-id <canister-id> database current
```

GitHub Actions also produces unsigned `kinic-vfs-cli` artifacts with SHA-256 checksums. See [`RELEASE.md`](RELEASE.md).

Authenticated commands require `icp-cli` on `PATH`. The CLI signs with the identity selected by `icp identity default`.
Internet Identity-backed identities are the default authenticated path. Non-II `icp-cli` identities are rejected unless `--allow-non-ii-identity` is passed.

## Connection

Mainnet commands default to the Kinic VFS canister. Use `--canister-id` only to select a different canister explicitly. DB-backed VFS commands require an explicit database selection from `--database-id`, `VFS_DATABASE_ID`, `.kinic/config.toml`, or user config. No production `default` database is created implicitly.
This is a breaking change for older single-DB clients that omitted `database_id`.

```bash
cargo run -p kinic-vfs-cli --bin kinic-vfs-cli -- --canister-id <canister-id> --database-id <database-id> status
```

Use `--local` for the default local replica host, or `--replica-host` for a project-local network on a custom port.

```bash
cargo run -p kinic-vfs-cli --bin kinic-vfs-cli -- --local --database-id <database-id> status
cargo run -p kinic-vfs-cli --bin kinic-vfs-cli -- --replica-host http://127.0.0.1:8001 --database-id <database-id> status
```

`--replica-host` takes precedence over configured hosts. `--database-id` takes precedence over `VFS_DATABASE_ID`.

List, search, recent, and graph commands default to the VFS root `/`.
Pass `--prefix /Wiki` or `--path /Wiki` when the human-facing wiki tree is the intended scope.

Without `--canister-id`, the CLI reads configuration from:

- `VFS_CANISTER_ID`
- `.kinic/config.toml`
- `~/.config/kinic-vfs-cli/config.toml`
- `~/.kinic-vfs-cli.toml`
- mainnet default `xis3j-paaaa-aaaai-axumq-cai` when the replica host is `https://icp0.io`

Link a workspace once to avoid repeating `--database-id`:

```bash
cargo run -p kinic-vfs-cli --bin kinic-vfs-cli -- --canister-id <canister-id> database link <database-id>
cargo run -p kinic-vfs-cli --bin kinic-vfs-cli -- database current
cargo run -p kinic-vfs-cli --bin kinic-vfs-cli -- status
```

Resolution priority is CLI flag, env, `.kinic/config.toml`, user config, then host default. Use `database unlink` to remove the workspace DB link.

## Identity Mode

`--identity-mode auto` is the default. Mutating and owner commands always use the selected `icp identity`. Read-only DB commands first check anonymous access; if the selected identity is a DB member, the command still uses identity. Public DB reads use anonymous only when the selected identity is not a member.

```bash
cargo run -p kinic-vfs-cli --bin kinic-vfs-cli -- --identity-mode identity --database-id <database-id> read-node --path /Wiki/index.md
cargo run -p kinic-vfs-cli --bin kinic-vfs-cli -- --identity-mode anonymous --database-id <public-database-id> read-node --path /Wiki/index.md
```

`--identity-mode anonymous` rejects write, owner, archive, and restore commands.

Create a database before reading or writing:

```bash
cargo run -p kinic-vfs-cli --bin kinic-vfs-cli -- --canister-id <canister-id> billing config
# Approve the VFS canister on the listed KINIC ICRC-2 ledger before CLI top-up. The allowance must cover the DB credit amount plus ledger transfer fee.
DB_ID="$(cargo run -p kinic-vfs-cli --bin kinic-vfs-cli -- --canister-id <canister-id> database create "<database-name>")"
cargo run -p kinic-vfs-cli --bin kinic-vfs-cli -- --canister-id <canister-id> database list
cargo run -p kinic-vfs-cli --bin kinic-vfs-cli -- --canister-id <canister-id> database top-up "$DB_ID" 500000
cargo run -p kinic-vfs-cli --bin kinic-vfs-cli -- --canister-id <canister-id> database deposit "$DB_ID" 500000
cargo run -p kinic-vfs-cli --bin kinic-vfs-cli -- --canister-id <canister-id> database withdraw "$DB_ID" 100000 --to-principal <principal>
cargo run -p kinic-vfs-cli --bin kinic-vfs-cli -- --canister-id <canister-id> database billing-history "$DB_ID"
cargo run -p kinic-vfs-cli --bin kinic-vfs-cli -- --canister-id <canister-id> database billing-pending "$DB_ID"
cargo run -p kinic-vfs-cli --bin kinic-vfs-cli -- --canister-id <canister-id> database grant "$DB_ID" <principal> reader
cargo run -p kinic-vfs-cli --bin kinic-vfs-cli -- --canister-id <canister-id> database link "$DB_ID"
cargo run -p kinic-vfs-cli --bin kinic-vfs-cli -- write-node --path /Wiki/file.md --input file.md
cargo run -p kinic-vfs-cli --bin kinic-vfs-cli -- search-remote "budget" --prefix /Wiki --top-k 10 --json
```

`billing config` prints the KINIC ledger canister, SNS governance principal, minimum update balance, update charge rate, and current ledger transfer fee from `icrc1_fee`.
If the ledger fee query fails, `billing config` fails without printing a partial config.
`database create <database-name>` creates a generated database ID with zero DB balance and prints it on success. Updates remain suspended until the DB balance is funded.
`database top-up <database-id> <e8s>` pulls KINIC from the caller through the ledger allowance already approved outside the CLI and credits the DB balance. The allowance must include the transfer fee returned by the ledger `icrc1_fee`.
`database deposit <database-id> <e8s>` opens `https://wiki.kinic.xyz/deposit?...` for wallet-based OISY or Plug funding. This command does not use the CLI identity. The browser flow is limited to the configured canonical wiki canister, previews the DB top-up before approve, approves `e8s + ledger transfer fee` with a 30 minute expiry, and the wallet also pays the approve transaction fee from its balance.
`database withdraw <database-id> <e8s> --to-principal <principal> [--to-subaccount-hex <hex>]` transfers DB balance to an external ICRC account and requires the DB owner identity.
`database billing-history <database-id> [--json]` lists DB billing ledger entries. Reader and writer principals see payer/caller principals as `redacted`; DB owner and SNS governance see full details.
`database billing-pending <database-id> [--json]` lists pending billing operations. DB owner and SNS governance can read it.
`database repair-*` commands resolve ambiguous pending operations and are accepted only from the configured SNS governance principal.
`database list` prints databases attached to the caller principal, including DB billing balance and suspension time.
Successful DB updates consume DB balance. Browser write surfaces disable writes when the DB is suspended, below `min_update_balance_e8s`, or billing config cannot be loaded. URL ingest and query-answer sessions are checked again before external Worker or DeepSeek execution, so a session issued before suspension can still fail after DB balance changes.

Database names are a breaking index-schema change. Existing local or canister index databases from older builds must be recreated; no automatic backfill is provided.

For public browser reads, grant anonymous reader access explicitly:

```bash
cargo run -p kinic-vfs-cli --bin kinic-vfs-cli -- --canister-id <canister-id> database grant <database-id> 2vxsx-fae reader
```

## Identity Mode

Authenticated CLI calls depend on `icp-cli`.
`kinic-vfs-cli` shells out to `icp identity default`, `icp identity export <name>`, and expects an Internet Identity delegation created by `icp identity link ii` / refreshed by `icp identity login`.
Install an `icp` version that supports II linking:

```bash
icp identity link ii --help
```

The CLI uses the default `icp identity` for mutating and owner operations.
Read-only DB commands default to `--identity-mode auto`: private databases use the selected `icp identity`; public databases use the selected identity when it is a DB member, otherwise anonymous.
The auto check calls `status` as anonymous once. If anonymous can read, it checks `list_databases` with the selected identity so owner/writer/reader context is preserved for public DBs owned by the caller.
By default, the selected identity must be an Internet Identity identity. Pass `--allow-non-ii-identity` only for explicit operator workflows that need PEM or other non-II `icp-cli` identities.

```bash
icp identity link ii kinic-ii --host https://<wiki-canister-id>.icp0.io
icp identity default kinic-ii
cargo run -p kinic-vfs-cli --bin kinic-vfs-cli -- --database-id <database-id> read-node --path /Wiki/index.md
```

`--host` must point at the wiki canister origin, not the Cloudflare browser host. The canister serves `/.well-known/ic-cli-login` and `/login`, so Internet Identity derives the same principal used by browser flows that pin the wiki canister as `derivationOrigin`.
If Internet Identity asks for an identity number during this flow, that is the II account selector, not a Kinic DB index or VFS path. II needs it to choose the user identity before it can issue a delegation to the local `icp` session key.
The browser posts the delegation to the loopback callback URL opened by `icp-cli`. That local callback must answer CORS preflight with `Access-Control-Allow-Origin`, `Access-Control-Allow-Methods: POST, OPTIONS`, and `Access-Control-Allow-Headers: content-type`. Its `POST` response must also include `Access-Control-Allow-Origin`. If the callback URL carries a state or nonce query, the local CLI must verify it as one-time data before accepting the delegation.

Refresh expired II delegations before running private DB commands:

```bash
icp identity login kinic-ii
```

Use explicit modes when automation must avoid auto selection:

```bash
cargo run -p kinic-vfs-cli --bin kinic-vfs-cli -- --identity-mode identity --database-id <database-id> read-node --path /Wiki/index.md
cargo run -p kinic-vfs-cli --bin kinic-vfs-cli -- --identity-mode anonymous --database-id <public-database-id> read-node --path /Wiki/index.md
cargo run -p kinic-vfs-cli --bin kinic-vfs-cli -- --allow-non-ii-identity --identity-mode identity --database-id <database-id> status
```

`--identity-mode anonymous` is valid only for read-only public operations.
Writes, database grants, archive operations, private Skill Registry writes, and owner commands require `--identity-mode identity` or `auto`.

## Archive and Restore

Archive exports one database as SQLite snapshot bytes and then finalizes the database into `archived` status.
Restore imports that snapshot into an `archived` or `deleted` database and returns it to `hot`.
The canister verifies the SHA-256 digest during both flows.

```bash
cargo run -p kinic-vfs-cli --bin kinic-vfs-cli -- --canister-id <canister-id> \
  database archive-export <database-id> --output ./database.sqlite --json

cargo run -p kinic-vfs-cli --bin kinic-vfs-cli -- --canister-id <canister-id> \
  database archive-restore <database-id> --input ./database.sqlite --json
```

Chunks default to 1 MiB, the canister limit. Use a smaller chunk size for local testing:

```bash
cargo run -p kinic-vfs-cli --bin kinic-vfs-cli -- --canister-id <canister-id> \
  database archive-export <database-id> --output ./database.sqlite --chunk-size 65536
```

If an export fails before finalization, the CLI attempts `database archive-cancel <database-id>`.
Manual cancel is available when a database is left in `archiving`:

```bash
cargo run -p kinic-vfs-cli --bin kinic-vfs-cli -- --canister-id <canister-id> database archive-cancel <database-id>
```

If restore fails after it begins, the CLI attempts to cancel the restore automatically so the database returns to its previous `archived` or `deleted` state. Manual cancel is available for an interrupted restore:

```bash
cargo run -p kinic-vfs-cli --bin kinic-vfs-cli -- --canister-id <canister-id> database restore-cancel <database-id>
```

See [`DB_LIFECYCLE.md`](DB_LIFECYCLE.md) for status, slot reuse, and restore validation details.

## Search

Full-text search uses `search-remote`.

```bash
cargo run -p kinic-vfs-cli --bin kinic-vfs-cli -- search-remote "budget" --prefix /Wiki --top-k 10 --json
```

Path search uses `search-path-remote`.

```bash
cargo run -p kinic-vfs-cli --bin kinic-vfs-cli -- search-path-remote "meeting" --prefix /Wiki --top-k 10 --json
```

`--preview-mode` is optional. If omitted, canister defaults are preserved:

- `search-remote`: light match preview
- `search-path-remote`: no preview

Available preview modes:

- `none`: no `SearchNodeHit.preview`
- `light`: match-oriented preview
- `content-start`: body-start preview in `SearchNodeHit.preview.excerpt`

Use `content-start` when the caller needs the first 200 normalized body characters without an extra `read-node` call.

```bash
cargo run -p kinic-vfs-cli --bin kinic-vfs-cli -- search-path-remote "meeting" --prefix /Wiki --preview-mode content-start --json
cargo run -p kinic-vfs-cli --bin kinic-vfs-cli -- search-remote "budget" --prefix /Wiki --preview-mode content-start --json
```

## Node Operations

Common read and write commands:

- `read-node --path /Wiki/file.md`
- `read-node-context --path /Wiki/file.md --link-limit 20 --json`
- `list-children --path /Wiki --json`
- `write-node --path /Wiki/file.md --input file.md`
- `append-node --path /Wiki/file.md --input append.md`
- `edit-node --path /Wiki/file.md --old-text before --new-text after`
- `delete-node --path /Wiki/file.md`
- `move-node --from-path /Wiki/a.md --to-path /Wiki/b.md`
- `glob-nodes "**/*.md" --path /Wiki --json`
- `recent-nodes 20 --path /Wiki --json`

## Link Graph

Use `read-node-context` when the caller needs a node plus incoming and outgoing links in one response.

```bash
cargo run -p kinic-vfs-cli --bin kinic-vfs-cli -- read-node-context --path /Wiki/file.md --link-limit 20 --json
```

Use graph commands for explicit link inspection.

```bash
cargo run -p kinic-vfs-cli --bin kinic-vfs-cli -- graph-neighborhood --center-path /Wiki/file.md --depth 1 --limit 100 --json
cargo run -p kinic-vfs-cli --bin kinic-vfs-cli -- graph-links --prefix /Wiki --limit 100 --json
cargo run -p kinic-vfs-cli --bin kinic-vfs-cli -- incoming-links --path /Wiki/file.md --limit 20 --json
cargo run -p kinic-vfs-cli --bin kinic-vfs-cli -- outgoing-links --path /Wiki/file.md --limit 20 --json
```
