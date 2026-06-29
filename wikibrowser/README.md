# Wiki Browser

Dashboard for Kinic Wiki canister databases. The app is a lightweight knowledge IDE and debug UI, not the primary Store API surface.
Official mainnet uses canister `xis3j-paaaa-aaaai-axumq-cai`; use placeholders only for forks or local deployments.

## Local

```bash
pnpm install
cp .env.local.example .env.local
pnpm dev
```

Open a database with:

```text
http://localhost:3010/<database-id>/Knowledge
```

The dashboard can create databases after Internet Identity login. CLI setup is still useful for scripted local setup:

```bash
DB_ID="$(cargo run -p kinic-vfs-cli --bin kinic-vfs-cli -- --canister-id <canister-id> database create "<database-title>")"
cargo run -p kinic-vfs-cli --bin kinic-vfs-cli -- --canister-id <canister-id> database grant "$DB_ID" 2vxsx-fae reader
```

`database create <database-title>` creates a generated database ID and prints it on success. The Browser create dialog collects the database title and uses the shared four-store layout.
`NEXT_PUBLIC_WIKI_IC_HOST` controls the browser-side IC agent host. Internet Identity uses the mainnet provider `https://id.ai` by default. `NEXT_PUBLIC_KINIC_WIKI_CANISTER_ID` selects the fixed wiki canister:

```bash
# local icp network
NEXT_PUBLIC_WIKI_IC_HOST=http://127.0.0.1:8011
NEXT_PUBLIC_KINIC_WIKI_CANISTER_ID=<local-wiki-canister-id>

# mainnet / Cloudflare Workers
NEXT_PUBLIC_WIKI_IC_HOST=https://icp0.io
NEXT_PUBLIC_KINIC_WIKI_CANISTER_ID=xis3j-paaaa-aaaai-axumq-cai
```

Query Q&A uses `DEEPSEEK_API_KEY` only in the server runtime. Store it in `wikibrowser/.env.local` for local runs. For production, set it as a Cloudflare Worker secret:

```bash
pnpm exec wrangler secret put DEEPSEEK_API_KEY
pnpm exec wrangler kv namespace create QUERY_ANSWER_RATE_LIMIT
```

Copy the returned KV namespace id into the `QUERY_ANSWER_RATE_LIMIT` binding in `wrangler.jsonc` before deploy. Never expose the API key as `NEXT_PUBLIC_DEEPSEEK_API_KEY`.

Query Q&A rate limiting uses a Cloudflare KV minute bucket. KV is not an atomic counter, so the limit is a practical abuse throttle, not an exact quota under concurrent requests.

## Scope

- Browse `/Knowledge`, `/Memory`, `/Skills`, `/Sessions`, and `/Sources`
- Create databases and manage database access
- Edit Markdown notes when the selected node is editable
- Create web source captures under safe `/Sources/...` paths from the current database browser route
- Render Markdown preview and raw content
- Search by path or full text
- Show incoming backlinks and a lightweight graph view
- Show lightweight lint hints
- Inspect path, etag, update time, size, role, outgoing links, and inferred raw sources
- Expose Open Graph and X link preview images
- Share public databases on X through the Web Intent URL
- Read canister health and Store API metadata through the hand-written Candid subset
- Show route-level 404 and VFS not-found states

No full lint workflow is included.

## Source Capture

Open a database route and select the `source-capture` left-pane tab:

```text
/<database-id>/Knowledge?tab=source-capture
```

Submitting a web page snapshot writes immutable raw evidence to the same database:

```text
/Sources/...
```

Raw web evidence under `/Sources/...` is stored as `source`. Repeated captures never overwrite existing evidence; collisions use suffixed paths such as `stem-2.md`.

When `KINIC_WIKI_GENERATOR_URL` and the `KINIC_WIKI_WORKER_TOKEN` secret are set, `/api/source/run` checks the canister session ticket and configured canister id before forwarding `canisterId`, `databaseId`, `sourcePath`, `sourceEtag`, and `sessionNonce` to the generator Worker with bearer auth. Source run tickets are replayable within their TTL so `/api/source/run` can be retried after temporary Worker failures; duplicate source runs are handled by Worker/job idempotency.
The worker reads `/Sources/...`, then generates review-ready pages under `/Knowledge/conversations`. The generator Worker principal must have writer access to the target database. New databases include the default LLM writer service principal as a `writer` member so source generation can run immediately. Owners can revoke that member, but source generation will fail while the service principal lacks writer access.

## Public Access

Granting `reader` to the anonymous principal `2vxsx-fae` makes a database public readable. Public readable databases expose wiki content and the database member list to anonymous browser sessions. The public dashboard shows member principals and roles in read-only mode, including owner, collaborator, anonymous, and service principals such as the default LLM writer.

## Checks

```bash
pnpm test
pnpm lint
pnpm typecheck
pnpm build
```

Internet Identity for `localhost` uses the local II canisters prepared by the E2E setup script. The script deploys the local wiki, KINIC ledger, and pinned Internet Identity backend/frontend dev canisters with dummy auth, then writes `.env.e2e.local` with `NEXT_PUBLIC_ENABLE_LOCAL_II_E2E=1`. Copy that file to `.env.local` for manual browser testing on `localhost`; restart the dev server after copying so Next picks up the new public env values. Mainnet II (`https://id.ai`) is reserved for production or preview origins, not `localhost`. Override `II_RELEASE` only when intentionally updating the tested Internet Identity release.

```bash
cd ..
icp network start -d -e local-wiki
cd wikibrowser
pnpm e2e:ii:setup
cp .env.e2e.local .env.local
pnpm dev
```

Run E2E in another terminal from `wikibrowser/` while the dev server is running:

```bash
pnpm e2e:ii
```

For production and preview deployments, leave `NEXT_PUBLIC_ENABLE_LOCAL_II_E2E` unset so auth uses `https://id.ai` with the production derivation origin. Do not add `localhost` or `127.0.0.1` to the production `ii-alternative-origins`; Internet Identity also rejects alternative-origin lists with more than 10 entries.

The wiki canister constructor requires cycles billing config; use the deploy wrapper instead of no-arg `icp deploy`.

`next-env.d.ts` is generated by Next and is intentionally ignored. `pnpm typecheck` runs `next typegen` before `tsc` so clean checkouts do not need to commit that file.

## Smoke

Start the dev server first:

```bash
pnpm dev
```

Run the browser smoke against an existing file node:

```bash
pnpm smoke -- --url http://127.0.0.1:3010/<database-id>/Knowledge/<existing-file>.md
```

The URL must point to a readable file node. Directory paths and missing files intentionally fail.

Run error-state smoke:

```bash
pnpm smoke:errors -- --database-id <database-id>
```

Optional base URL:

```bash
pnpm smoke:errors -- --base-url http://127.0.0.1:3010 --database-id <database-id>
```

## Candid Surface

`lib/vfs-idl.ts` is a small generated subset of the checked-in VFS canister Candid at `crates/vfs_canister/vfs.did`.
Run `pnpm test` after canister interface changes so the drift check verifies the generated subset.

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
- `query_database_sql_json`
- `query_index_sql_json`
- `source_evidence`
- `search_node_paths`
- `search_nodes`

## Public MVP

Initial deployment target is Cloudflare Workers with `NEXT_PUBLIC_WIKI_IC_HOST=https://icp0.io` and `NEXT_PUBLIC_KINIC_WIKI_CANISTER_ID=xis3j-paaaa-aaaai-axumq-cai`.
The app is public read-only and accepts database IDs for the fixed canister. The target DB must grant reader access to anonymous principal `2vxsx-fae`. Anonymous public access also includes read-only member list visibility and restricted database-scoped `sql:` queries.
`sql:` in the Query panel calls `query_database_sql_json` against the current DB only. It accepts a restricted JSON `SELECT` from `fs_nodes` or `fs_links`, requires SQL `LIMIT 1..100`, allows only one-column `ORDER BY` followed by `LIMIT`, rejects `OFFSET`, and expects exactly one result column containing valid JSON object TEXT.
The CLI exposes the same database-scoped API as `query-sql`; both surfaces can query only DBs the caller can already read, including owned/member DBs, marketplace-entitled DBs, and public-readable DBs.
The `/metrics` page calls public unauthenticated `wiki_metrics` and `wiki_metrics_series(days)` telemetry. It exposes aggregate user and database counts, paid user totals, charged KINIC totals in e8s, and `last_activity_at_ms`; series `days` is clamped to `1..7`.
Controller metrics use `query_index_sql_json`; that method stays controller-only and is not exposed as user input.
Canister unreachable / API failures are shown as browser errors and are not treated as not-found states.
The `/<database-id>/...` and `/dashboard/<database-id>` URLs are App Router dynamic routes. Read and authenticated calls go directly from the browser to the configured IC gateway.

## Troubleshooting

- Local canister not found: `NEXT_PUBLIC_KINIC_WIKI_CANISTER_ID` does not exist on `NEXT_PUBLIC_WIKI_IC_HOST`. For `http://127.0.0.1:8000`, start the local replica / icp local network and deploy the wiki canister into that state.
- Mainnet canister not found: confirm that `NEXT_PUBLIC_KINIC_WIKI_CANISTER_ID` exists on `https://icp0.io`.
- Method missing / wrong canister: use a Kinic Wiki canister that exposes the VFS, health, and Memory Recall methods covered by `lib/vfs-idl.ts`.
- Host unreachable: confirm `NEXT_PUBLIC_WIKI_IC_HOST` and network access to the local replica or IC gateway.

## Cloudflare Workers Deploy

Use this repository as a monorepo project and set the Workers build root to `wikibrowser`.

Cloudflare settings:

- Framework Preset: Next.js
- Root Directory: `wikibrowser`
- Install Command: `pnpm install --frozen-lockfile`
- Build Command: `pnpm deploy:production`
- Build Variables: `NEXT_PUBLIC_WIKI_IC_HOST=https://icp0.io` and `NEXT_PUBLIC_KINIC_WIKI_CANISTER_ID=xis3j-paaaa-aaaai-axumq-cai` for Preview and Production
- Runtime: Cloudflare Workers via `@opennextjs/cloudflare`

Both variables are public browser bundle values. Set them as Cloudflare build variables, not only runtime Worker variables, because Next.js inlines `NEXT_PUBLIC_*` values into the client bundle during build.

CLI deploy from this directory:

```bash
pnpm wrangler whoami
pnpm deploy:production
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
pnpm smoke:public -- --base-url https://<deployment>.workers.dev --database-id <database-id> --path /Knowledge/<existing-file>.md
```

`--path` must point to an existing file node on the mainnet canister.
