# CLI

`kinic-vfs-cli` is the shell interface for the canister-backed VFS.
This document covers wiki/database operator operations: connection, database management, node reads and writes, search, links, and archive/restore.
Skill Registry commands use the same binary under `kinic-vfs-cli skill ...`; their source of truth is [`SKILL_REGISTRY.md`](SKILL_REGISTRY.md).

The canister also exposes read-only Agent Memory API methods such as `memory_manifest`, `query_context`, and `source_evidence`; see [`AGENT_MEMORY_API.md`](AGENT_MEMORY_API.md).
Those are direct canister/client methods, not CLI commands in this document.
Use the CLI commands below for shell workflows against the remote VFS.
For embedded agent tool calling, use the shared Rust library described in [`AGENT_TOOL_CALLING.md`](AGENT_TOOL_CALLING.md).

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

List, search, glob, and graph commands default to the VFS root `/`.
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

## Database Setup

`--identity-mode auto` is the default. Mutating and owner commands always use the selected `icp identity`. Read-only DB commands first check anonymous access; if the selected identity is a DB member, the command still uses identity. Public DB reads use anonymous only when the selected identity is not a member.

```bash
cargo run -p kinic-vfs-cli --bin kinic-vfs-cli -- --identity-mode identity --database-id <database-id> read-node --path /Wiki/index.md
cargo run -p kinic-vfs-cli --bin kinic-vfs-cli -- --identity-mode anonymous --database-id <public-database-id> read-node --path /Wiki/index.md
```

`--identity-mode anonymous` rejects write, owner, archive, and restore commands.

Create a database before reading or writing:

```bash
cargo run -p kinic-vfs-cli --bin kinic-vfs-cli -- --canister-id <canister-id> cycles config
# Approve the VFS canister on the listed KINIC ICRC-2 ledger before CLI cycle purchase. The allowance must cover the KINIC amount plus ledger transfer fee.
DB_ID="$(cargo run -p kinic-vfs-cli --bin kinic-vfs-cli -- --canister-id <canister-id> database create "<database-name>")"
cargo run -p kinic-vfs-cli --bin kinic-vfs-cli -- --canister-id <canister-id> database list
cargo run -p kinic-vfs-cli --bin kinic-vfs-cli -- --canister-id <canister-id> database purchase-cycles "$DB_ID" 1.25
cargo run -p kinic-vfs-cli --bin kinic-vfs-cli -- --canister-id <canister-id> database cycles "$DB_ID" 1.25
cargo run -p kinic-vfs-cli --bin kinic-vfs-cli -- --canister-id <canister-id> database cycles-history "$DB_ID"
cargo run -p kinic-vfs-cli --bin kinic-vfs-cli -- --canister-id <canister-id> database cycles-pending "$DB_ID"
cargo run -p kinic-vfs-cli --bin kinic-vfs-cli -- --canister-id <canister-id> database grant "$DB_ID" <principal> reader
cargo run -p kinic-vfs-cli --bin kinic-vfs-cli -- --canister-id <canister-id> database link "$DB_ID"
cargo run -p kinic-vfs-cli --bin kinic-vfs-cli -- write-node --path /Wiki/file.md --input file.md
cargo run -p kinic-vfs-cli --bin kinic-vfs-cli -- search-remote "budget" --prefix /Wiki --top-k 10 --json
```

`cycles config` prints the KINIC ledger canister, billing authority principal, `cycles_per_kinic`, `min_update_cycles`, and fixed ledger transfer fee `10_000 e8s`.
`database create <database-name>` creates a generated pending database ID with zero DB cycles balance and prints it on success. It does not allocate a DB mount until the first successful cycle purchase.
`database purchase-cycles <database-id> <kinic>` previews the purchase, then pulls the previewed KINIC payment from the caller through the ledger allowance already approved outside the CLI and adds raw cycles to the DB cycles balance. Any authenticated payer can purchase cycles for an existing DB. The allowance must include the previewed ledger transfer fee.
`database cycles <database-id> <kinic>` opens `https://wiki.kinic.xyz/cycles?...` for wallet-based OISY or Plug funding. This command does not use the CLI identity. The browser flow is limited to the configured canonical wiki canister, previews the DB cycle purchase before approve, approves `preview.payment_amount_e8s + preview.ledger_fee_e8s` with a 30 minute expiry, and passes the previewed expected cycles/config version to purchase. The wallet also pays the approve transaction fee from its balance. The first successful purchase activates a pending DB.
`database cycles-history <database-id> [--json]` lists DB cycles ledger entries. Reader and writer principals see payer/caller principals as `redacted`; DB owner and billing authority see full details.
`database cycles-pending <database-id> [--json]` lists pending cycle operations. DB owner and billing authority can read it.
`database repair-cycles-purchase-complete <database-id> <operation-id> <ledger-block-index>` resolves a pending cycle purchase after the canister verifies the ledger block against the pending operation. Any authenticated caller may run it.
`database repair-cycles-purchase-cancel <database-id> <operation-id>` is accepted only from the configured `billing_authority_id` principal. Use cancel only after the operator has verified that the original ledger transfer did not execute.
`database list` prints databases attached to the caller principal, including DB cycles balance and suspension time.
Successful DB updates consume DB cycles balance. Browser write surfaces disable writes when the DB is suspended, below `min_update_cycles`, or cycles config cannot be loaded. URL ingest and query-answer sessions are checked again before external Worker or DeepSeek execution, so a session issued before suspension can still fail after DB cycles balance changes.

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
Restore imports that snapshot into an `archived` database and returns it to `active`.
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

If restore fails after it begins, the CLI attempts to cancel the restore automatically so the database returns to its previous `archived` state. Manual cancel is available for an interrupted restore:

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
- `list-nodes --prefix /Wiki --recursive --json`
- `write-node --path /Wiki/file.md --input file.md`
- `write-nodes --input nodes.json --json`
- `append-node --path /Wiki/file.md --input append.md`
- `edit-node --path /Wiki/file.md --old-text before --new-text after`
- `delete-node --path /Wiki/file.md`
- `delete-tree --path /Wiki/obsolete-scope --json`
- `move-node --from-path /Wiki/a.md --to-path /Wiki/b.md`
- `glob-nodes "**/*.md" --path /Wiki --json`

Use `list-children` for one-level tree views and UI-style navigation.
Use `list-nodes --prefix <path> --recursive --json` for bulk repair, lint, inventory, and destructive operation review.
Use `write-nodes` for one atomic batch write when the full node bodies are already prepared:

```json
[
  {
    "path": "/Wiki/a.md",
    "kind": "file",
    "content": "body",
    "metadata_json": "{}",
    "expected_etag": "optional-etag"
  }
]
```

`kind` is `file` or `source`. `metadata_json` and `expected_etag` may be omitted. Source nodes must use canonical source paths such as `/Sources/raw/<provider>/<id>.md`; legacy one-segment raw source paths are rejected and must be migrated explicitly before regeneration or purge operations.
`delete-node` deletes one node path. `delete-tree` deletes real node paths under a prefix, deepest-first; inspect the target first with `list-nodes --prefix <path> --recursive --json`.

Maintenance and database lifecycle operations live in their own command groups:

- `rebuild-index`
- `rebuild-scope-index`
- `status`
- `database archive-export`
- `database archive-restore`
- `database archive-cancel`
- `database restore-cancel`

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
