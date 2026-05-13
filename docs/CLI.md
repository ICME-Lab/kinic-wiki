# CLI

`vfs-cli` is the shell interface for the canister-backed VFS.

The canister also exposes read-only Agent Memory API methods such as `memory_manifest`, `query_context`, and `source_evidence`.
Those are direct canister/client methods, not CLI commands in this document.
Use the CLI commands below for shell workflows against the remote VFS.

## Connection

Use `--canister-id` to select a canister explicitly. DB-backed VFS commands require an explicit database selection from `--database-id`, `VFS_DATABASE_ID`, `.kinic/config.toml`, or user config. No production `default` database is created implicitly.
This is a breaking change for older single-DB clients that omitted `database_id`.

```bash
cargo run -p vfs-cli --bin vfs-cli -- --canister-id <canister-id> --database-id <database-id> status
```

Use `--local` for the local replica host.

```bash
cargo run -p vfs-cli --bin vfs-cli -- --local --database-id <database-id> status
```

`--database-id` takes precedence over `VFS_DATABASE_ID`.

List, search, recent, and graph commands default to the VFS root `/`.
Pass `--prefix /Wiki` or `--path /Wiki` when the human-facing wiki tree is the intended scope.

Without `--canister-id`, the CLI reads configuration from:

- `VFS_CANISTER_ID`
- `.kinic/config.toml`
- `~/.config/vfs-cli/config.toml`
- `~/.vfs-cli.toml`

Link a workspace once to avoid repeating `--database-id`:

```bash
cargo run -p vfs-cli --bin vfs-cli -- --canister-id <canister-id> database link <database-id>
cargo run -p vfs-cli --bin vfs-cli -- database current
cargo run -p vfs-cli --bin vfs-cli -- skill find "contract review"
```

Resolution priority is CLI flag, env, `.kinic/config.toml`, user config, then host default. Use `database unlink` to remove the workspace DB link.

Create a database before reading or writing:

```bash
cargo run -p vfs-cli --bin vfs-cli -- --canister-id <canister-id> database top-up-principal <amount-e8s>
cargo run -p vfs-cli --bin vfs-cli -- --canister-id <canister-id> database create --display-name "Team Wiki" --initial-deposit-e8s 1000000
cargo run -p vfs-cli --bin vfs-cli -- --canister-id <canister-id> database list
cargo run -p vfs-cli --bin vfs-cli -- --canister-id <canister-id> database grant <database-id> <principal> reader
cargo run -p vfs-cli --bin vfs-cli -- --canister-id <canister-id> database link <database-id>
cargo run -p vfs-cli --bin vfs-cli -- write-node --path /Wiki/file.md --input file.md
cargo run -p vfs-cli --bin vfs-cli -- search-remote "budget" --prefix /Wiki --top-k 10 --json
```

Before `database top-up-principal`, the caller wallet must approve the VFS canister on the KINIC ICRC-2 ledger. `database create` debits the caller principal balance and prints the generated database ID. `database list` prints databases attached to the caller principal, including display name, billing balance, and suspension state.
The WikiBrowser dashboard exposes the same minimal flow after Internet Identity login: principal top-up/withdraw, DB create with display name and initial deposit, DB allocate/withdraw, rename, and billing history.

Billing operations:

```bash
cargo run -p vfs-cli --bin vfs-cli -- --canister-id <canister-id> database rename <database-id> "New name"
cargo run -p vfs-cli --bin vfs-cli -- --canister-id <canister-id> database principal-billing
cargo run -p vfs-cli --bin vfs-cli -- --canister-id <canister-id> database top-up <database-id> <amount-e8s>
cargo run -p vfs-cli --bin vfs-cli -- --canister-id <canister-id> database withdraw <database-id> <amount-e8s>
cargo run -p vfs-cli --bin vfs-cli -- --canister-id <canister-id> database billing-entries <database-id>
cargo run -p vfs-cli --bin vfs-cli -- --canister-id <canister-id> database billing-config
```

`database top-up` moves caller principal balance into a DB balance. It does not require DB membership. `database withdraw` moves DB balance back to the owner principal balance and is owner-only. External KINIC ledger withdraw uses:

```bash
cargo run -p vfs-cli --bin vfs-cli -- --canister-id <canister-id> database withdraw-principal <amount-e8s> <to-principal>
```

For mainnet fresh installs, use the guarded deploy wrapper:

```bash
KINIC_LEDGER_CANISTER_ID=<kinic-ledger> SNS_GOVERNANCE_ID=<sns-governance> scripts/mainnet/deploy_wiki.sh
```

The wrapper rejects unset, empty, or anonymous principal values before passing billing init args to `icp deploy`.
For local installs, use `scripts/local/deploy_wiki.sh` so anonymous placeholder billing principals stay local-only.

For public browser reads, grant anonymous reader access explicitly:

```bash
cargo run -p vfs-cli --bin vfs-cli -- --canister-id <canister-id> database grant <database-id> 2vxsx-fae reader
```

Archive and restore are low-level canister APIs for snapshot bytes. The CLI does not yet persist archive bytes for you. See [`DB_LIFECYCLE.md`](DB_LIFECYCLE.md) for status, slot reuse, and restore validation details.

## Search

Full-text search uses `search-remote`.

```bash
cargo run -p vfs-cli --bin vfs-cli -- search-remote "budget" --prefix /Wiki --top-k 10 --json
```

Path search uses `search-path-remote`.

```bash
cargo run -p vfs-cli --bin vfs-cli -- search-path-remote "meeting" --prefix /Wiki --top-k 10 --json
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
cargo run -p vfs-cli --bin vfs-cli -- search-path-remote "meeting" --prefix /Wiki --preview-mode content-start --json
cargo run -p vfs-cli --bin vfs-cli -- search-remote "budget" --prefix /Wiki --preview-mode content-start --json
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
cargo run -p vfs-cli --bin vfs-cli -- read-node-context --path /Wiki/file.md --link-limit 20 --json
```

Use graph commands for explicit link inspection.

```bash
cargo run -p vfs-cli --bin vfs-cli -- graph-neighborhood --center-path /Wiki/file.md --depth 1 --limit 100 --json
cargo run -p vfs-cli --bin vfs-cli -- graph-links --prefix /Wiki --limit 100 --json
cargo run -p vfs-cli --bin vfs-cli -- incoming-links --path /Wiki/file.md --limit 20 --json
cargo run -p vfs-cli --bin vfs-cli -- outgoing-links --path /Wiki/file.md --limit 20 --json
```
