# Staging Environment

This document is the operator guide for updating the existing Kinic Wiki staging environment. It does not cover recreating the environment in a new Internet Computer or Cloudflare account.

## Environment

| Component | Value |
| --- | --- |
| Browser Worker | `https://kinic-wiki-browser-staging.hude.workers.dev` |
| Worker name | `kinic-wiki-browser-staging` |
| Generator Worker | `https://kinic-wiki-generator-staging.hude.workers.dev` |
| Generator name | `kinic-wiki-generator-staging` |
| Wiki canister | `3ryrw-kyaaa-aaaaf-qgxpq-cai` |
| Source Capture database | `jev-source-capture-staging` (`db_nuzrspghca5q`) |
| Staging Clipper ID | `kdildjebipiaccglghfdhjifgknlpffg` |
| ICP environment | `staging` |
| IC host | `https://icp0.io` |
| Internet Identity derivation origin | `https://3ryrw-kyaaa-aaaaf-qgxpq-cai.icp0.io` |
| Deploy identity alias | `llm-wiki-mainnet` |

The deploy identity must resolve to the default controller principal:

```text
r75h6-lqd7b-5jack-at55d-vvti2-lg5qy-ly73a-5ezve-odnkc-kagu3-nae
```

The expected controllers are the default principal above and the production recovery principal:

```text
lqfvd-m7ihy-e5dvc-gngvr-blzbt-pupeq-6t7ua-r7v4p-bvqjw-ea7gl-4qe
```

The authoritative canister mapping is `.icp/data/mappings/staging.ids.json`. The Worker configuration is `wikibrowser/wrangler.jsonc`, and the canister initialization and deploy guard are in `scripts/staging/deploy_wiki.sh`.

The staging Browser Worker must be deployed only through `pnpm deploy:staging` from `wikibrowser/`, and the staging Generator only through the same command in `workers/wiki-generator/`. Both commands verify the fixed Source Capture database boundary and required secrets before a dry run and deployment. The staging MCP Worker must be deployed only through `pnpm deploy:staging` from `workers/wiki-mcp/`; use its separate `pnpm deploy:staging:v4-migration` command only for the one-time V3-to-V4 Durable Object migration. These commands fetch `origin/main`, refuse a HEAD that does not contain the fetched commit, reject unresolved conflicts, and verify the public-node publication files before Wrangler runs. A direct `wrangler deploy` bypasses these checks and must not be used for staging deployment.

## Isolation and Safety

Staging uses these dedicated Cloudflare resources:

- KV namespace binding `QUERY_ANSWER_RATE_LIMIT` with ID `dd821e7a3e4f4f908df20c2cb17abc2d`
- R2 bucket `kinic-wiki-link-preview-images-staging`
- Queue `kinic-wiki-generation-staging`
- DLQ `kinic-wiki-generation-failures-staging`
- D1 database `kinic-wiki-generator-staging` (`0fb15a11-05da-4afd-b306-e3b5b0af582a`)

Do not replace them with production resource IDs or names. Both staging Workers have no custom-domain route. Browser staging forwards Source Capture only to `https://kinic-wiki-generator-staging.hude.workers.dev`; both Workers enforce `KINIC_WIKI_ALLOWED_DATABASE_ID=db_nuzrspghca5q`. They share a staging-only `KINIC_WIKI_WORKER_TOKEN`, distinct from production. Generator staging uses the dedicated service principal `fixxw-aflgo-bm2zb-lyb4h-fqesi-f3nd7-s7ndo-tsvni-g3rsa-y36ys-aqe`, which has writer access only to that Source Capture database. Provider API keys may be shared with production, but must remain Cloudflare Secrets and must never enter Browser, iOS, or Clipper artifacts.

Automatic canister top-up is disabled. Check the live cycles balance before and after every canister deployment instead of recording a balance in this document.

## Pre-deploy Checks

Run the repository checks before changing either runtime:

```bash
./.local/check.sh
```

Confirm the deploy identity and fixed canister target:

```bash
icp identity principal --identity llm-wiki-mainnet
icp canister status wiki -e staging --identity llm-wiki-mainnet
```

The principal, canister ID, and two-controller set must match the values above. Record the current module hash and cycles balance for comparison after the upgrade.

Validate the staging deploy wrapper without changing the canister:

```bash
KINIC_VFS_STAGING_II_ORIGIN=https://kinic-wiki-browser-staging.hude.workers.dev \
  scripts/staging/deploy_wiki.sh --dry-run
```

## Deploy

For routine backward-compatible updates, deploy the canister before the Worker. The structured node-mutation error release is an explicit exception: it replaces mutation `Err : text` with `Err : NodeMutationError`. Old mutation decoders are incompatible with the new Candid result type.

The staging canister is used directly by the staging Wiki Browser and staging MCP Worker. Deploy those three runtimes together. Do not deploy the production-only Skill Registry, Wiki Generator, iOS app, or Wiki Clipper as part of this staging rollout; they remain pinned to the production canister. A Rust CLI or another Candid client can target staging explicitly, so use a binary built from this branch and confirm that no known operator is using an older build against the staging canister.

For this breaking rollout, first build the canister and both staging Workers from the same revision and stop mutation smoke traffic. Upgrade the staging canister, deploy the staging Wiki Browser, deploy the staging MCP Worker, then run the exact 10-tool contract and write smoke checks with the matching CLI/client build. Resume staging writes only after those checks pass.

Before promoting the same Candid change to the production canister, complete the coordinated production checklist in [`RELEASE.md`](RELEASE.md). That checklist includes the Wiki Clipper, which also decodes node-mutation results, plus externally maintained Candid clients that cannot be discovered from this repository.

Upgrade the existing canister:

```bash
KINIC_VFS_STAGING_II_ORIGIN=https://kinic-wiki-browser-staging.hude.workers.dev \
  scripts/staging/deploy_wiki.sh --mode upgrade
```

Recheck the status immediately:

```bash
icp canister status wiki -e staging --identity llm-wiki-mainnet
```

The canister must be running, the module hash must have changed to the intended build, the controllers must remain unchanged, and the cycles balance must remain sufficient.

Build the staging Worker from `wikibrowser/`:

```bash
cd wikibrowser
VITE_WIKI_IC_HOST=https://icp0.io \
VITE_KINIC_WIKI_CANISTER_ID=3ryrw-kyaaa-aaaaf-qgxpq-cai \
VITE_II_DERIVATION_ORIGIN=https://3ryrw-kyaaa-aaaaf-qgxpq-cai.icp0.io \
VITE_ENABLE_LOCAL_II_E2E= \
VITE_II_PROVIDER_URL= \
CLOUDFLARE_ENV=staging \
  pnpm build
```

Apply the three Generator migrations once when creating the environment:

```bash
cd workers/wiki-generator
pnpm wrangler d1 migrations apply DB --env staging --remote
```

Inspect the resolved Browser bindings without deploying:

```bash
CLOUDFLARE_ENV=staging pnpm wrangler deploy --dry-run
```

The dry run must show the staging canister, staging KV/R2/Queue resources, the staging Generator URL and dedicated database boundary, and no production custom-domain route. Deploy the same staging configuration:

```bash
pnpm deploy:staging
```

The command must print `staging Worker deploy source validated` before the build starts. By default it refuses any staged, unstaged, or untracked content because Wrangler deploys the complete current worktree. If an intentional staging-only change has not been committed, inspect `git status --short` and `git diff` first, then acknowledge that exact risk explicitly:

```bash
KINIC_STAGING_DEPLOY_ALLOW_DIRTY=1 pnpm deploy:staging
```

The dirty-worktree acknowledgement does not bypass the fetched `origin/main` ancestry check, unresolved-conflict check, or public-node regression check.

Deploy Generator staging before Browser staging so the Browser never opens an unavailable route:

```bash
cd workers/wiki-generator
KINIC_STAGING_DEPLOY_ALLOW_DIRTY=1 pnpm deploy:staging
```

The Generator guard requires `DEEPSEEK_API_KEY`, `TYPESAFE_API_KEY`, `KINIC_WIKI_WORKER_TOKEN`, and `KINIC_WIKI_WORKER_IDENTITY_PEM` in the staging environment. The Browser guard requires the matching staging-only Worker token. Candidate and selection counts stay fixed at 20 and 5; Queue retries stay fixed at 5.

Build the separate developer Clipper without changing the production `manifest.json` or `dist/`:

```bash
pnpm --dir extensions/wiki-clipper build:staging
```

Load `extensions/wiki-clipper/tmp/staging-unpacked` as an unpacked extension. Its fixed ID is `kdildjebipiaccglghfdhjifgknlpffg`, it uses separate Chrome storage, and it contains only the staging canister and Browser trigger endpoint. Install the iOS sandbox build with `mobile/ios/scripts/install-device.sh --sandbox`; because the Bundle ID is unchanged, it replaces the production build on that device.

The staging wiki canister's certified `/.well-known/ii-alternative-origins` must include both `https://kinic-wiki-browser-staging.hude.workers.dev` and `chrome-extension://kdildjebipiaccglghfdhjifgknlpffg`. The production origin list must not contain either staging origin.

Deploy the staging MCP Worker from `workers/wiki-mcp/`. For an environment still bound to `McpAuthStateV3`, run the migration command exactly once:

```bash
cd workers/wiki-mcp
KINIC_STAGING_DEPLOY_ALLOW_DIRTY=1 pnpm deploy:staging:v4-migration
```

The command dry-runs both configurations, deploys a transitional version without the `MCP_AUTH_STATE` binding, and immediately deploys V4. Authenticated MCP requests can return `503` during that short interval, and all V3 OAuth sessions become invalid. If the final phase fails, do not roll back to V3; fix forward with the retry command printed by the script.

After V4 exists, use only the normal one-phase command:

```bash
cd workers/wiki-mcp
KINIC_STAGING_DEPLOY_ALLOW_DIRTY=1 pnpm deploy:staging
```

## Post-deploy Verification

Confirm the certified Internet Identity alternative origins:

```bash
curl -sS \
  https://3ryrw-kyaaa-aaaaf-qgxpq-cai.icp0.io/.well-known/ii-alternative-origins
```

The response must contain `https://kinic-wiki-browser-staging.hude.workers.dev`.

Confirm that staging is excluded from search indexing:

```bash
curl -I https://kinic-wiki-browser-staging.hude.workers.dev/dashboard
curl -I https://kinic-wiki-browser-staging.hude.workers.dev/robots.txt
curl -sS https://kinic-wiki-browser-staging.hude.workers.dev/robots.txt
curl -I https://kinic-wiki-browser-staging.hude.workers.dev/sitemap.xml
curl -sS https://kinic-wiki-browser-staging.hude.workers.dev/sitemap.xml
```

The three header responses must include `X-Robots-Tag: noindex, nofollow`. `robots.txt` must contain `Disallow: /` and must not advertise a sitemap. `sitemap.xml` must be a valid empty `<urlset>` and must not contain a `<url>` entry.

Use a test database and verify the browser workflow:

1. Sign in with Internet Identity.
2. Open a lowercase `.md` node and publish it from the document header.
3. Confirm the Explorer shows the non-interactive published icon without reloading.
4. Copy the public link and open it in an anonymous browser session.
5. Edit the source node and confirm the public page reflects the change.
6. Stop publication and confirm the old public URL returns Not Found.
7. Repeat with rename, move, and delete as needed to confirm old URLs stay invalid.
8. Confirm another node, child listing, search result, and link graph remain unavailable anonymously.
9. From the staging Clipper and iOS Share Extension, save at least one source each into `db_nuzrspghca5q` and confirm generation completes.
10. Confirm `generated_context_paths` contains at most five entries and the correct evidence path.
11. Confirm the Generator logs contain only workflow, counts, timing, input length, and HTTP status—not questions, source bodies, paths, or secrets.
12. Confirm production Worker, Queue, D1, R2, and canister activity remain unchanged.

Check the deployed Worker version:

```bash
cd wikibrowser
pnpm wrangler deployments list --env staging
```

## Rollback

Cloudflare Worker deployments are versioned. If the Worker fails after deployment, select the last known-good staging version and roll it back:

```bash
cd wikibrowser
pnpm wrangler rollback --env staging <version-id>
```

Do not roll the canister back to an older Wasm after a schema migration. Migrations are forward-only in this repository, and an older module may not understand the upgraded stable state. Fix forward and deploy a new compatible Wasm instead.

For Source Capture rollback, first deploy a Browser staging configuration with `KINIC_WIKI_GENERATOR_URL` unset to close new ingress, then remove or pause the `kinic-wiki-generation-staging` consumer and roll both Workers back to their last known-good versions. Do not reverse the D1 migrations.
