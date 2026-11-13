# Kinic Wiki

Kinic Wiki is a canister-backed four-store interface for coding agents.
It stores durable knowledge nodes in an Internet Computer canister and exposes them through a browser UI, `kinic-vfs-cli`, a remote MCP server, an iOS app, a Chrome extension, agent plugins, and agent-readable APIs.

- Browser: https://wiki.kinic.xyz
- CLI guide: https://wiki.kinic.xyz/docs/cli
- Public MCP: `https://wiki-mcp.kinic.xyz/mcp` (anonymous, read-only)
- Private MCP: `https://wiki-private-mcp.kinic.xyz/mcp` (OAuth with Internet Identity)

## Why Kinic Wiki

Vector databases are useful for retrieving nearby text fragments from large corpora. Agent memory has a different shape. Agents need stable places for current decisions, source evidence, open questions, operating procedures, and relationships between notes.

Kinic Wiki uses a canister-backed file system as that store layer. Organized knowledge lives under `/Knowledge/...`; raw evidence lives under `/Sources/<provider>/...`. Agents can search it, follow paths and links, and update notes with `etag` guarded writes.

For many medium-sized agent workflows, structured file-system search is often more useful than embedding-only retrieval. A result is not just a similar chunk; it is a named, linked, updateable knowledge node.

## What It Provides

- Path-based reads, writes, search, and link graph inspection over a per-database VFS
- `etag` guarded edits and atomic batch writes for safer agent and operator workflows
- Four stores (memory, knowledge, skill, session) plus a shared source evidence root
- Database access control with owner, writer, and reader roles, including anonymous public reads
- Skill store packages for discovering, evaluating, and improving agent skills
- Continual learning for Codex, DeepSeek Harness, and Claude Code, with skill-run capture for Hermes
- Evidence capture from the web, AI chat exports, GitHub, and iOS share sheets, with LLM generation of review-ready wiki pages
- Public node publication, database cycles billing, and a marketplace for paid read access
- Read-only Store API methods for direct canister clients

## Four Stores

Every database uses the same roots and the same physical VFS schema.

- `memory`: short facts, preferences, and active context under `/Memory/...`, recalled through `query_context`.
- `knowledge`: long-term notes under `/Knowledge/...`, connected by wiki links.
- `skill`: reusable `SKILL.md` packages under `/Skills/...`, with manifests, snapshots, status, and run evidence.
- `session`: agent session state under `/Sessions/...`; session transcript evidence is stored under `/Sources/sessions/...`.

`/Sources/<provider>/...` is the shared source evidence root that knowledge nodes cite through `source_evidence`.

Context Pack is not a fifth store. It is an OKF handoff artifact generated from store content.
Curator is not a store. It is a future maintenance workflow for skill and knowledge stale/archive/promote decisions.

## Surfaces

| Surface | What it does | Guide |
| --- | --- | --- |
| Browser ([wikibrowser](wikibrowser/)) | Browse, search, and edit databases; manage members, cycles, and publication; Skill Registry at `/skills/<database-id>`; marketplace at `/marketplace`; published nodes at `/p/<public-id>` | [wikibrowser/README.md](wikibrowser/README.md) |
| CLI (`kinic-vfs-cli`) | Scripted node, database, skill store, Context Pack, GitHub ingest, and agent learning operations | [docs/CLI.md](docs/CLI.md) |
| Remote MCP ([workers/wiki-mcp](workers/wiki-mcp/)) | Public: seven anonymous read tools. Private: the same reads plus eight atomic mutation tools behind OAuth | [docs/mcp.md](docs/mcp.md) |
| Chrome extension ([wiki-clipper](extensions/wiki-clipper/)) | Saves ChatGPT, Claude, and Gemini conversations and active-tab snapshots as evidence, and creates wiki pages from them | [extensions/wiki-clipper/README.md](extensions/wiki-clipper/README.md) |
| iOS app ([mobile/ios](mobile/ios/)) | Share Sheet URL capture, work items and widget, database browsing and editing, Ask AI, and App Store database credits | [mobile/ios/README.md](mobile/ios/README.md) |
| Agent plugins ([plugins](plugins/)) | Codex, Claude Code, DeepSeek Harness, and Hermes adapters for recall, run evidence, and session capture | [docs/AGENT_CONFIGURATION.md](docs/AGENT_CONFIGURATION.md) |
| Agent skills ([skills](skills/)) | Workflow skills for wiki query, ingest, edit, lint, maintenance, MCP use, Skill Registry, and Context Pack | [skills/](skills/) |
| Store API | Read-only canister queries such as `memory_manifest`, `query_context`, `source_evidence`, `export_snapshot`, and `fetch_updates` | [docs/STORE_API.md](docs/STORE_API.md) |
| Agent Tool Calling | Embedded OpenAI-compatible and Anthropic-compatible tool schemas from the shared Rust library | [docs/AGENT_TOOL_CALLING.md](docs/AGENT_TOOL_CALLING.md) |

Supporting Cloudflare Workers:

- [workers/wiki-generator](workers/wiki-generator/): turns captured evidence sources into review-ready wiki pages with DeepSeek.
- [workers/wiki-assistant](workers/wiki-assistant/): backs iOS Ask AI with routed, citation-checked answers over authorized wiki content.
- [workers/payment](workers/payment/): fulfills iOS App Store purchases as database cycles.

The browser and extensions are capture and review surfaces, the stores are the structured memory layer, and the CLI is the operator automation layer.

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

Read exact nodes when a path is known:

```bash
kinic-vfs-cli read-node --path /Knowledge/page.md --json
kinic-vfs-cli read-node-context --path /Knowledge/page.md --json
```

For writes, read first, keep the returned `etag`, then mutate with an expected etag:

```bash
kinic-vfs-cli edit-node --path /Knowledge/page.md --old-text before --new-text after --expected-etag <etag> --json
```

`write-nodes` applies several writes atomically from a JSON array. Graph commands (`graph-neighborhood`, `graph-links`, `incoming-links`, `outgoing-links`) inspect wiki links, and `publish-node` exposes one node at a public id.

Public databases can be read anonymously only when the database grants reader access to the anonymous principal.
Writes, database grants, cycles purchases, publication, and private skill store writes require an authenticated identity.

## Databases, Access, And Billing

- `database grant`, `revoke`, and `members` manage owner, writer, and reader roles.
- Databases consume cycles. Owners can buy cycles with KINIC (`database purchase-cycles`) or through the iOS App Store, and inspect them with `database cycles-history`.
- Owners can list a database on the marketplace to sell reader access. `market entitlements` lists access the current identity has purchased.

See [docs/DB_LIFECYCLE.md](docs/DB_LIFECYCLE.md) for creation, suspension, and deletion.

## Continual Learning

The CLI can connect Codex, DeepSeek Harness, and Claude Code to versioned context receipts, durable run evidence, isolated evaluation and guarded lesson revision. Each prompt recalls lessons from your database, each turn is recorded as evidence, and revisions are published only after they improve results on your own validation tasks.

Start with the [continual learning quickstart](docs/LEARNING_QUICKSTART.md), which takes one project from setup to recorded proposals, with example runner and validation files in [examples/learning](examples/learning/). The reference documents are [portable project setup](docs/PORTABLE_LEARNING.md), [continual learning](docs/CONTINUAL_LEARNING.md), and [agent configuration](docs/AGENT_CONFIGURATION.md).

`kinic-vfs-cli claude setup` retains the existing recorder installation entry point; automatic learning still requires explicit project setup. `kinic-vfs-cli hermes setup` installs the skill-run recorder. Claude Code owned runs require CLI version 2.1.286 or newer and API/provider credentials; ordinary interactive session hooks can use the existing subscription login. See the [Claude Code setup guide](docs/AGENT_CONFIGURATION.md#claude-code).

## Skill Store

Skill store commands use the same CLI:

```bash
kinic-vfs-cli skill find "contract review" --json
kinic-vfs-cli skill inspect legal-review --json
kinic-vfs-cli skill record-run legal-review --task "review contract" --outcome success --notes-file ./notes.md --json
```

Agents should discover relevant skills, inspect the package, use the instructions, then record run evidence when the workflow produces useful feedback. Packages move through `draft`, `reviewed`, `promoted`, and `deprecated` with `skill set-status`, and `skill rollback` restores a previous version.

## Developer And Operator Guides

- Docs index: [docs/README.md](docs/README.md)
- CLI setup and database operations: [docs/CLI.md](docs/CLI.md)
- Remote MCP: [docs/mcp.md](docs/mcp.md)
- Staging environment and deployment: [docs/STAGING.md](docs/STAGING.md)
- Release procedure: [docs/RELEASE.md](docs/RELEASE.md)
- OKF Context Pack export and verification: [docs/Context Pack.md](docs/Context%20Pack.md)
- Skill Registry workflows: [docs/SKILL_REGISTRY.md](docs/SKILL_REGISTRY.md)
- Canister Store API: [docs/STORE_API.md](docs/STORE_API.md)
- Shared Rust library tool calling: [docs/AGENT_TOOL_CALLING.md](docs/AGENT_TOOL_CALLING.md)
- VFS validation and benchmarks: [docs/validation/VFS_VALIDATION_PLAN.md](docs/validation/VFS_VALIDATION_PLAN.md)
