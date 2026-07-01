# Kinic Wiki

Kinic Wiki is a canister-backed four-store interface for coding agents.
It stores durable knowledge nodes in an Internet Computer canister and exposes them through a browser UI, `kinic-vfs-cli`, and agent-readable APIs.

## Why Kinic Wiki

Vector databases are useful for retrieving nearby text fragments from large corpora. Agent memory has a different shape. Agents need stable places for current decisions, source evidence, open questions, operating procedures, and relationships between notes.

Kinic Wiki uses a canister-backed file system as that store layer. Organized knowledge lives under `/Knowledge/...`; raw evidence lives under `/Sources/<provider>/...`. Agents can search it, follow paths and links, and update notes with `etag` guarded writes.

For many medium-sized agent workflows, structured file-system search is often more useful than embedding-only retrieval. A result is not just a similar chunk; it is a named, linked, updateable knowledge node.

## What It Provides

- Browser access for public and private wiki databases
- Path-based reads, writes, search, and link graph inspection
- `etag` guarded edits for safer agent and operator workflows
- Four stores: memory, knowledge, skill, and session
- Skill store packages for discovering, evaluating, and improving agent skills
- Read-only Store API methods for direct canister clients

## Four Stores

- `memory`: short facts, preferences, and active context recalled through `query_context`.
- `knowledge`: long-term notes under `/Knowledge/...`, connected by wiki links and raw evidence under `/Sources/<provider>/...`.
- `skill`: reusable `SKILL.md` packages under `/Skills/...`, with manifests, snapshots, status, and run evidence.
- `session`: agent session state under `/Sessions/...` and session transcript evidence under `/Sources/sessions/...`; resumable summaries are a later workflow.

Context Pack is not a fifth store. It is an OKF handoff artifact generated from store content.
Curator is not a store. It is a future maintenance workflow for skill and knowledge stale/archive/promote decisions.

The public browser entry point is:

https://wiki.kinic.xyz

The official Kinic Wiki database is:

https://wiki.kinic.xyz/db/db_kva4v2twg6jv/Knowledge

Database ID:

```text
db_kva4v2twg6jv
```

The canonical CLI guide is:

https://wiki.kinic.xyz/cli

## Install The CLI

```bash
npm install -g kinic-vfs-cli
kinic-vfs-cli --help
```

The npm package downloads a release binary and verifies its SHA-256 checksum.
Current npm binaries support macOS arm64 and Linux x64.

## Basic CLI Use

Most commands need a database id. Pass it per command, link it once for a workspace, or set `VFS_DATABASE_ID`.

```bash
kinic-vfs-cli database create "My agent memory"
kinic-vfs-cli --database-id <database-id> status --json
kinic-vfs-cli database link <database-id>
VFS_DATABASE_ID=<database-id> kinic-vfs-cli search-remote "query text" --prefix /Knowledge --json
```

Every database uses the same four-store roots and the same physical VFS schema.

Read exact nodes when a path is known:

```bash
kinic-vfs-cli read-node --path /Knowledge/page.md --json
kinic-vfs-cli read-node-context --path /Knowledge/page.md --json
```

For writes, read first, keep the returned `etag`, then mutate with an expected etag:

```bash
kinic-vfs-cli edit-node --path /Knowledge/page.md --old-text before --new-text after --expected-etag <etag> --json
```

Public databases can be read anonymously only when the database grants reader access to the anonymous principal.
Writes, database grants, archive operations, and private skill store writes require an authenticated identity.

## Skill Store

Skill store commands use the same CLI:

```bash
kinic-vfs-cli skill find "contract review" --json
kinic-vfs-cli skill inspect legal-review --json
kinic-vfs-cli skill record-run legal-review --task "review contract" --outcome success --notes-file ./notes.md --json
```

Agents should discover relevant skills, inspect the package, use the instructions, then record run evidence when the workflow produces useful feedback.

## Main Surfaces

- Browser: browse, search, edit, and manage database access
- CLI: scripted database operations and skill store workflows
- Chrome extension: ChatGPT export and active-tab source capture
- Store API: direct read-only canister queries such as `memory_manifest`, `query_context`, and `source_evidence`
- Agent Tool Calling: embedded OpenAI-compatible and Anthropic-compatible tool schemas

The Chrome extension connects browser work to Kinic Wiki. It saves recent ChatGPT conversations and active web page snapshots as raw knowledge evidence under `/Sources/<provider>/...`. The browser is the capture surface, the stores are the structured memory layer, and the CLI is the operator automation layer.

Developer and operator guides:

- CLI setup and database operations: [docs/CLI.md](docs/CLI.md)
- OKF Context Pack export and verification: [docs/Context Pack.md](docs/Context%20Pack.md)
- Skill Registry workflows: [docs/SKILL_REGISTRY.md](docs/SKILL_REGISTRY.md)
- Canister Store API: [docs/STORE_API.md](docs/STORE_API.md)
- Shared Rust library tool calling: [docs/AGENT_TOOL_CALLING.md](docs/AGENT_TOOL_CALLING.md)
- VFS validation and benchmarks: [docs/validation/VFS_VALIDATION_PLAN.md](docs/validation/VFS_VALIDATION_PLAN.md)
- Public CLI guide: https://wiki.kinic.xyz/cli
