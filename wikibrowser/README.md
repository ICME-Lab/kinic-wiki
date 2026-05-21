# Wiki Browser

Dashboard for Kinic Wiki canister databases. The app is a lightweight knowledge IDE and debug UI, not the primary Agent Memory API surface.

## Local

```bash
pnpm install
cp .env.local.example .env.local
pnpm dev
```

Open a database with:

```text
http://localhost:3000/<database-id>/Wiki
```

The dashboard can create databases after Internet Identity login. CLI setup is still useful for scripted local setup:

```bash
DB_ID="$(cargo run -p kinic-vfs-cli --bin kinic-vfs-cli -- --canister-id <canister-id> database create "<database-name>")"
cargo run -p kinic-vfs-cli --bin kinic-vfs-cli -- --canister-id <canister-id> database grant "$DB_ID" 2vxsx-fae reader
```

`database create <database-name>` creates a generated database ID and prints it on success. `NEXT_PUBLIC_WIKI_IC_HOST` controls the browser-side IC agent host. `NEXT_PUBLIC_II_PROVIDER_URL` overrides the Internet Identity frontend URL for local II. `NEXT_PUBLIC_KINIC_WIKI_CANISTER_ID` selects the fixed wiki canister:

```bash
# local icp network
NEXT_PUBLIC_WIKI_IC_HOST=http://127.0.0.1:8001
NEXT_PUBLIC_II_PROVIDER_URL=http://id.ai.localhost:8001
NEXT_PUBLIC_KINIC_WIKI_CANISTER_ID=<local-wiki-canister-id>

# mainnet / Cloudflare Workers
NEXT_PUBLIC_WIKI_IC_HOST=https://icp0.io
NEXT_PUBLIC_II_PROVIDER_URL=https://id.ai
NEXT_PUBLIC_KINIC_WIKI_CANISTER_ID=<mainnet-wiki-canister-id>
```

Query Q&A uses `DEEPSEEK_API_KEY` only in the server runtime. Store it in `wikibrowser/.env.local` for local runs. For production, set it as a Cloudflare Worker secret:

```bash
pnpm exec wrangler secret put DEEPSEEK_API_KEY
pnpm exec wrangler kv namespace create QUERY_ANSWER_RATE_LIMIT
```

Copy the returned KV namespace id into the `QUERY_ANSWER_RATE_LIMIT` binding in `wrangler.jsonc` before deploy. Never expose the API key as `NEXT_PUBLIC_DEEPSEEK_API_KEY`.

Query Q&A rate limiting uses a Cloudflare KV minute bucket. KV is not an atomic counter, so the limit is a practical abuse throttle, not an exact quota under concurrent requests.

## Scope

- Browse `/Wiki` and `/Sources`
- Create databases and manage database access
- Edit Markdown nodes under `/Wiki`
- Create URL ingest requests under `/Sources/ingest-requests` from the current database browser route
- Render Markdown preview and raw content
- Search by path or full text
- Show recent nodes
- Show incoming backlinks and a lightweight graph view
- Show lightweight lint hints
- Inspect path, etag, update time, size, role, outgoing links, and inferred raw sources
- Expose Open Graph and X link preview images
- Share public databases on X through the Web Intent URL
- Read canister health and Agent Memory API metadata through the hand-written Candid subset
- Show route-level 404 and VFS not-found states

No full lint workflow is included.

## URL Ingest

Open a database route and select the `ingest` left-pane tab:

```text
/<database-id>/Wiki?tab=ingest
```

Submitting a URL writes one request node to the same database:

```text
/Sources/ingest-requests/<request-id>.md
```

Ingest request nodes are regular `file` nodes. Only fetched raw web evidence under `/Sources/raw/<id>/<id>.md` is stored as `source`.

When `KINIC_WIKI_GENERATOR_URL` and the `KINIC_WIKI_WORKER_TOKEN` secret are set, the browser asks the VFS canister to authorize a 30 minute session trigger ticket for the II caller, writes the request, then calls `/api/url-ingest/trigger`. That server route checks the canister session ticket and configured canister id before forwarding `canisterId`, `databaseId`, and `requestPath` to the generator Worker with bearer auth. The ticket is replayable within its TTL; duplicate jobs are handled by Worker/job idempotency and rate limits. Writer access is checked when the ticket is issued; revoking writer access does not immediately invalidate an already issued ticket before its TTL. `Origin` is only a CORS allowlist, not the authorization boundary.
The worker fetches supported `http` / `https` HTML or text URLs, writes the normalized source to `/Sources/raw/<id>/<id>.md`, then generates one review-ready draft under `/Wiki/conversations`.
The generator Worker principal must have writer access to the target database. New databases include the default LLM writer service principal as a `writer` member so URL ingest and draft generation can run immediately. Owners can revoke that member, but URL ingest sessions will fail while the service principal lacks writer access.

## Public Access

Granting `reader` to the anonymous principal `2vxsx-fae` makes a database public readable. Public readable databases expose wiki content and the database member list to anonymous browser sessions. The public dashboard shows member principals and roles in read-only mode, including owner, collaborator, anonymous, and service principals such as the default LLM writer.

## Checks

```bash
pnpm test
pnpm lint
pnpm typecheck
pnpm build
```

Internet Identity E2E requires a local wiki canister and the E2E setup script. The script deploys the pinned Internet Identity backend/frontend dev canisters with dummy auth and writes `.env.e2e.local`. Override `II_RELEASE` only when intentionally updating the tested Internet Identity release.

```bash
icp network start -d -e local-wiki
icp deploy -e local-wiki
pnpm e2e:ii:setup
pnpm e2e:ii
```

`next-env.d.ts` is generated by Next and is intentionally ignored. `pnpm typecheck` runs `next typegen` before `tsc` so clean checkouts do not need to commit that file.

## Smoke

Start the dev server first:

```bash
pnpm dev
```

Run the browser smoke against an existing file node:

```bash
pnpm smoke -- --url http://127.0.0.1:3000/<database-id>/Wiki/<existing-file>.md
```

The URL must point to a readable file node. Directory paths and missing files intentionally fail.

Run error-state smoke:

```bash
pnpm smoke:errors -- --database-id <database-id>
```

Optional base URL:

```bash
pnpm smoke:errors -- --base-url http://127.0.0.1:3000 --database-id <database-id>
```

## Candid Surface

`lib/vfs-idl.ts` is a small hand-written subset of `crates/vfs_canister/vfs.did`.
Run `pnpm test` whenever the canister interface changes.

Covered methods:

- `canister_health`
- `read_node`
- `list_children`
- `incoming_links`
- `outgoing_links`
- `graph_links`
- `graph_neighborhood`
- `read_node_context`
- `memory_manifest`
- `query_context`
- `source_evidence`
- `recent_nodes`
- `search_node_paths`
- `search_nodes`

## Public MVP

Initial deployment target is Cloudflare Workers with `NEXT_PUBLIC_WIKI_IC_HOST=https://icp0.io` and `NEXT_PUBLIC_KINIC_WIKI_CANISTER_ID=<mainnet-wiki-canister-id>`.
The app is public read-only and accepts database IDs for the fixed canister. The target DB must grant reader access to anonymous principal `2vxsx-fae`. Anonymous public access also includes read-only member list visibility.
Canister unreachable / API failures are shown as browser errors and are not treated as not-found states.
The `/<database-id>/...` and `/dashboard/<database-id>` URLs are App Router dynamic routes. Read and authenticated calls go directly from the browser to the configured IC gateway.

## Troubleshooting

- Local canister not found: `NEXT_PUBLIC_KINIC_WIKI_CANISTER_ID` does not exist on `NEXT_PUBLIC_WIKI_IC_HOST`. For `http://127.0.0.1:8000`, start the local replica / icp local network and deploy the wiki canister into that state.
- Mainnet canister not found: confirm that `NEXT_PUBLIC_KINIC_WIKI_CANISTER_ID` exists on `https://icp0.io`.
- Method missing / wrong canister: use a Kinic Wiki canister that exposes the VFS, health, and Agent Memory methods covered by `lib/vfs-idl.ts`.
- Host unreachable: confirm `NEXT_PUBLIC_WIKI_IC_HOST` and network access to the local replica or IC gateway.

## Cloudflare Workers Deploy

Use this repository as a monorepo project and set the Workers build root to `wikibrowser`.

Cloudflare settings:

- Framework Preset: Next.js
- Root Directory: `wikibrowser`
- Install Command: `pnpm install --frozen-lockfile`
- Build Command: `pnpm deploy`
- Build Variables: `NEXT_PUBLIC_WIKI_IC_HOST=https://icp0.io` and `NEXT_PUBLIC_KINIC_WIKI_CANISTER_ID=<mainnet-wiki-canister-id>` for Preview and Production
- Runtime: Cloudflare Workers via `@opennextjs/cloudflare`

Both variables are public browser bundle values. Set them as Cloudflare build variables, not only runtime Worker variables, because Next.js inlines `NEXT_PUBLIC_*` values into the client bundle during build.

CLI deploy from this directory:

```bash
pnpm wrangler whoami
pnpm deploy
```

Pre-deploy checklist:

```bash
pnpm test
pnpm lint
pnpm typecheck
pnpm build
pnpm build:worker
pnpm preview
```

Post-deploy public smoke:

```bash
pnpm smoke:public -- --base-url https://<deployment>.workers.dev --database-id <database-id> --path /Wiki/<existing-file>.md
```

`--path` must point to an existing file node on the mainnet canister.
