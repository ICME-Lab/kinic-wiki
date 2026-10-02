# Wiki Browser

Dashboard for Kinic Wiki canister databases. The app is a lightweight knowledge IDE and debug UI, not the primary Store API surface.
Official mainnet uses canister `6emaw-iyaaa-aaaay-aacka-cai`; use placeholders only for forks or local deployments.

## Local

```bash
pnpm install
cp .env.local.example .env.local
pnpm dev
```

Open a database with:

```text
http://localhost:3010/db/<database-id>/Knowledge
```

The dashboard can create databases after Internet Identity login. CLI setup is still useful for scripted local setup:

```bash
DB_ID="$(cargo run -p kinic-vfs-cli --bin kinic-vfs-cli -- --canister-id <canister-id> database create "<database-name>")"
cargo run -p kinic-vfs-cli --bin kinic-vfs-cli -- --canister-id <canister-id> database grant "$DB_ID" 2vxsx-fae reader
```

`database create <database-name>` creates a generated database ID and prints it on success. The Browser create dialog collects the database name and uses the shared four-store layout.
`VITE_WIKI_IC_HOST` controls the browser-side IC agent host. Internet Identity uses the mainnet provider `https://id.ai` by default. `VITE_KINIC_WIKI_CANISTER_ID` selects the fixed wiki canister:

```bash
# local icp network
VITE_WIKI_IC_HOST=http://127.0.0.1:8011
VITE_KINIC_WIKI_CANISTER_ID=<local-wiki-canister-id>

# mainnet / Cloudflare Workers
VITE_WIKI_IC_HOST=https://icp0.io
VITE_KINIC_WIKI_CANISTER_ID=6emaw-iyaaa-aaaay-aacka-cai
```

Query Q&A uses `DEEPSEEK_API_KEY` only in the server runtime. Store it in `wikibrowser/.env.local` for local runs. For production, set it as a Cloudflare Worker secret:

```bash
pnpm exec wrangler secret put DEEPSEEK_API_KEY
pnpm exec wrangler kv namespace create QUERY_ANSWER_RATE_LIMIT
```

Copy the returned KV namespace id into the `QUERY_ANSWER_RATE_LIMIT` binding in `wrangler.jsonc` before deploy. Never expose the API key through a `VITE_*` variable.

Query Q&A rate limiting uses a Cloudflare KV minute bucket. KV is not an atomic counter, so the limit is a practical abuse throttle, not an exact quota under concurrent requests.

## Scope

- Browse `/Knowledge`, `/Memory`, `/Skills`, `/Sessions`, and `/Sources`
- Create databases and manage database access
- Edit Markdown notes when the selected node is editable
- Import individual Markdown/PDF files or a local folder into the selected wiki folder
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

## Local Import

Use the Explorer action menu to import either selected `.md` / `.pdf` files or one local folder. Individual files are written directly into the selected wiki folder; folder imports preserve the selected folder name and its nested paths. PDF text is extracted locally and stored as Markdown, while the original PDF is not uploaded or retained. PDFs that require OCR or a password are not supported.

## Source Capture

Open a database route and select the `source-capture` left-pane tab:

```text
/db/<database-id>/Knowledge?tab=source-capture
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
npm run lint
pnpm typecheck
pnpm build
```

Internet Identity for `localhost` uses the local II canisters prepared by the E2E setup script. The script deploys the local wiki, KINIC ledger, and pinned Internet Identity backend/frontend dev canisters with dummy auth, then writes `.env.e2e.local` with `VITE_ENABLE_LOCAL_II_E2E=1`. Copy that file to `.env.local` for manual browser testing on `localhost`; restart the Vite dev server after copying. Mainnet II (`https://id.ai`) is reserved for production or preview origins, not `localhost`. Override `II_RELEASE` only when intentionally updating the tested Internet Identity release.

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

For production and preview deployments, leave `VITE_ENABLE_LOCAL_II_E2E` unset so auth uses `https://id.ai` with the production derivation origin. Do not add `localhost` or `127.0.0.1` to the production `ii-alternative-origins`; Internet Identity also rejects alternative-origin lists with more than 10 entries.

The wiki canister constructor requires cycles billing config; use the deploy wrapper instead of no-arg `icp deploy`.

TanStack Router generates `src/routeTree.gen.ts` from `src/routes`; it is committed and excluded from Oxlint. `pnpm typecheck` uses TypeScript 7 directly.

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

`@kinic/vfs-candid` exposes the shared browser IDL generated at `packages/vfs-candid/index.ts` from the checked-in VFS canister Candid at `crates/vfs_canister/vfs.did`.
Run `pnpm --dir packages/vfs-candid generate` after canister interface changes, then run the browser tests so the drift check verifies the generated subset.

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

Initial deployment target is Cloudflare Workers with `VITE_WIKI_IC_HOST=https://icp0.io` and `VITE_KINIC_WIKI_CANISTER_ID=6emaw-iyaaa-aaaay-aacka-cai`.
The app is public read-only and accepts database IDs for the fixed canister. The target DB must grant reader access to anonymous principal `2vxsx-fae`. Anonymous public access also includes read-only member list visibility and restricted database-scoped `sql:` queries.
`sql:` in the Query panel calls `query_database_sql_json` against the current DB only. It accepts a restricted JSON `SELECT` from `fs_nodes` or `fs_links`, requires SQL `LIMIT 1..100`, allows only one-column `ORDER BY` followed by `LIMIT`, rejects `OFFSET`, and expects exactly one result column containing valid JSON object TEXT.
The CLI exposes the same database-scoped API as `query-sql`; both surfaces can query only DBs the caller can already read, including owned/member DBs, marketplace-entitled DBs, and public-readable DBs.
The `/metrics` page calls public unauthenticated `wiki_metrics` and `wiki_metrics_series(days)` telemetry. It exposes aggregate user and database counts, paid user totals, charged KINIC totals in e8s, and `last_activity_at_ms`; series `days` is clamped to `1..7`.
Controller metrics use `query_index_sql_json`; that method stays controller-only and is not exposed as user input.
Canister unreachable / API failures are shown as browser errors and are not treated as not-found states.
The `/db/<database-id>/...` and `/dashboard/project/<database-id>` URLs are TanStack Router routes. Read and authenticated calls go directly from the browser to the configured IC gateway.

## Troubleshooting

- Local canister not found: `VITE_KINIC_WIKI_CANISTER_ID` does not exist on `VITE_WIKI_IC_HOST`. For `http://127.0.0.1:8000`, start the local replica / icp local network and deploy the wiki canister into that state.
- Mainnet canister not found: confirm that `VITE_KINIC_WIKI_CANISTER_ID` exists on `https://icp0.io`.
- Method missing / wrong canister: use a Kinic Wiki canister that exposes the VFS, health, and Memory Recall methods covered by `@kinic/vfs-candid`.
- Host unreachable: confirm `VITE_WIKI_IC_HOST` and network access to the local replica or IC gateway.

## Cloudflare Workers Deploy

Use this repository as a monorepo project and set the Workers build root to `wikibrowser`.
For the isolated staging environment, fixed resource identifiers, deployment order, and verification procedure, use [`../docs/STAGING.md`](../docs/STAGING.md) instead of the production commands below.

Cloudflare settings:

- Framework Preset: None
- Root Directory: `wikibrowser`
- Install Command: `pnpm install --frozen-lockfile`
- Build Command: `pnpm deploy:production`
- Build Variables: `VITE_WIKI_IC_HOST=https://icp0.io` and `VITE_KINIC_WIKI_CANISTER_ID=6emaw-iyaaa-aaaay-aacka-cai` for Preview and Production
- Runtime: TanStack Start on Cloudflare Workers via `@cloudflare/vite-plugin`

Both variables are public browser bundle values. Set them as Cloudflare build variables because Vite embeds `VITE_*` values in the client bundle. Server-only secrets remain Worker secrets or bindings.

CLI deploy from this directory:

```bash
pnpm wrangler whoami
pnpm deploy:production
```

Pre-deploy checklist:

```bash
pnpm test
npm run lint
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

## Wiki article CPU validation

The `/db/` SEO document uses a bounded text excerpt, while the interactive Wiki browser
continues to render Markdown. SEO parsing examines at most 16,000 input characters;
the body is limited to 8,000 characters and folder navigation to 100 entries. The
loader serializes this summary instead of the complete VFS node. The database route
renders only the SEO document and a loading placeholder on the server. `ClientWikiBrowser`
uses TanStack `ClientOnly` and React `lazy` so the interactive browser/editor mounts
after hydration; its controls keep the same client behavior. Sitemap and published-note
loaders also import the ICP SDK on demand, avoiding crypto initialization on unrelated
article requests. HTML and node content
are not cached between requests, and `/db/` responses use `Cache-Control: no-store`.
SEO reads use the verifying `https://<canister>.icp0.io/api/wiki-seo/<database>/<path>`
HTTP gateway. The SSR Worker does not use HttpAgent or verify ICP query signatures
for these reads; authenticated and browser-side VFS operations remain unchanged.
Titles, canonical URLs, OGP metadata, and
folder links remain in the initial HTML; body Markdown links and formatting do not.

Local Miniflare/workerd verification uses the installed Wrangler runtime:

```bash
node scripts/check-wiki-miniflare.mjs
# Build the actual Worker with the intended public canister, then include live reads:
VITE_WIKI_IC_HOST=https://icp0.io \
VITE_KINIC_WIKI_CANISTER_ID=6emaw-iyaaa-aaaay-aacka-cai \
VITE_II_DERIVATION_ORIGIN=https://6emaw-iyaaa-aaaay-aacka-cai.icp0.io \
pnpm exec vite build
node scripts/check-wiki-miniflare.mjs --gateway-fixture
# After the matching Canister endpoint has been deployed:
node scripts/check-wiki-miniflare.mjs --live
```

The default test bundles the actual page loader, SEO helpers, and React document into
a fixture Worker, replacing only HTTP payload reads with synthetic data. It checks seven
cases with 20 sequential requests and 20 requests in batches of five, then tests
public-access revocation and browser-only routes. This fixture does not test ICP
transport or the application router. `--gateway-fixture` also checks the complete
application router and SSR with synthetic HTTP responses and rejects ICP query
subrequests. `--live` runs the complete built
application against public canister data through the verifying gateway,
and checks 40 article requests plus missing-database and browser-only responses.
It writes `outputs/wiki-cpu/miniflare/report.json` and `live.cpuprofile` at the repository
root. Miniflare needs local listening ports; live reads also need internet access
and inspector port 9235. Reported elapsed times and sampled profiles are diagnostics,
not hosted Workers CPU measurements or proof of meeting the 10ms free-plan limit.

The Canister regenerates each public JSON payload from canonical storage and always
checks anonymous reader access. It retains at most 256 URL certification entries
(hashes, not bodies); authorized node mutations and changes to database metadata/access remove only
that database's entries before state can change. Rejected authorization, other
databases' edits and unrelated billing/voice timers preserve proofs. Account deletion
invalidates owned databases, and ledger/IAP activation invalidates the affected database.
Updates that pass authorization but later fail may conservatively invalidate the target;
they never evict unrelated databases.
Initialization and upgrades restore the static HTTP root; page proofs start empty.
An uncatalogued response requests a gateway update call to register its current hash.
Subsequent queries return a version-2 HTTP witness. Updates may therefore add latency
and Canister execution costs to the first request, including after proof invalidation.
The response contains at most 16,000 Unicode characters of node content, selected
SEO metadata fields encoded as valid JSON, 100 child links, and 128,000 JSON bytes.
Text is bounded by its escaped JSON byte size. Child links keep their full paths;
links that do not fit the remaining byte budget are omitted with `childrenTruncated`.
Size pressure shortens the response instead of producing a 404. Both payload and HTML
use `no-store`.

Deploy the Canister endpoint before deploying this Worker. The Worker deliberately
does not fall back to unverified responses or the old SDK fetch path. An unavailable
gateway or an old Canister version produces the browser shell without SEO article
content, so rollout must verify article presence before proceeding. The initial
response registers a proof via consensus; warm responses are verified by the HTTP
gateway. This moves verification out of the Worker rather than disabling it globally.

After building the production-configured Worker above, install the existing
`pocketic-tests` dependencies and run its `test:public-http` script with
`POCKET_IC_BIN` pointing to a compatible PocketIC binary. The isolated integration
test installs the actual Wasm, exercises cold and certified warm HTTP responses,
passes 40 requests through the complete Miniflare Worker and real local gateway,
and verifies content updates, an upgrade preserving canonical storage, anonymous
access revocation, and account deletion. It advances the real Wasm timer past 60 seconds
and checks that denied writes and another database's activation/rename preserve warm
certificates. A folder with 100 long Japanese names exercises the byte budget through
the gateway and complete Worker. It independently checks the BLS certificate, certified root,
URL expression path and response hash, and rejects modified bodies, witnesses and
the wrong Canister ID. It creates no remote databases and does not touch an existing
local network. `POCKETIC_TEST_RESOLVE_FROM` can point to a package manifest when
the test dependencies are installed in a separate directory.

Before production rollout, use an anonymous-readable **staging** database with cases
covering an ordinary article, a long article, tables/links, a folder with over 100
children, a missing node, and a non-public database. Use only synthetic public data.
Do not make an existing private database public for this test. The missing/private
cases should specify `expectArticle: false` only if they produce no article under
the existing route behavior; a missing node in a listed database can still show a
database heading.

Create a local cases JSON file with 1–6 cases:

```json
[
  { "name": "ordinary", "path": "/db/TEST_DB/Knowledge/note.md", "expectArticle": true, "status": 200 },
  { "name": "private", "path": "/db/PRIVATE_TEST_DB/Knowledge/note.md", "expectArticle": false, "status": 200 }
]
```

With authenticated `cf` and Workers invocation logging enabled, run from this directory:

```bash
node scripts/check-wiki-cpu.mjs \
  --origin https://kinic-wiki-browser-staging.hude.workers.dev \
  --worker kinic-wiki-browser-staging \
  --cases /absolute/path/to/cases.json > /absolute/path/to/cpu-report.json
```

Each case receives 20 sequential requests and 20 requests in batches of five. The
gate requires all invocation logs without sampling, the expected HTML/status,
`no-store`, CPU p95 below 8ms, and no non-`ok` outcomes. CPU comes from Workers Logs,
not HTTP elapsed time. Missing telemetry fails the gate; `--report-only` emits a
baseline report without enforcing its exit status. Readable probe markers avoid
opaque query values being redacted in logs.

Keep production rollout on hold if this gate fails. Profile remaining costs with
the local Worker inspector without disabling signature verification. After rollout,
compare a complete 24-hour window with the preceding window: CPU exceedance count,
exceedance rate per invocation, and 503 count. Target at least a 90% reduction in
the CPU exceedance rate. Local renderer benchmarks alone do not meet this gate.
