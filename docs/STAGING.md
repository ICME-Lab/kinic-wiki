# Staging Environment

This document is the operator guide for updating the existing Kinic Wiki staging environment. It does not cover recreating the environment in a new Internet Computer or Cloudflare account.

## Environment

| Component | Value |
| --- | --- |
| Browser Worker | `https://kinic-wiki-browser-staging.hude.workers.dev` |
| Worker name | `kinic-wiki-browser-staging` |
| Wiki canister | `3ryrw-kyaaa-aaaaf-qgxpq-cai` |
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

The staging Browser Worker must be deployed only through `pnpm deploy:staging` from `wikibrowser/`. The staging MCP Worker must be deployed only through `pnpm deploy:staging` from `workers/wiki-mcp/`; use its separate `pnpm deploy:staging:v4-migration` command only for the one-time V3-to-V4 Durable Object migration. These commands fetch `origin/main`, refuse a HEAD that does not contain the fetched commit, reject unresolved conflicts, and verify the public-node publication files before Wrangler runs. A direct `wrangler deploy` bypasses these checks and must not be used for staging deployment.

## Isolation and Safety

Staging uses these dedicated Cloudflare resources:

- KV namespace binding `QUERY_ANSWER_RATE_LIMIT` with ID `dd821e7a3e4f4f908df20c2cb17abc2d`
- R2 bucket `kinic-wiki-link-preview-images-staging`
- Queue `kinic-wiki-generation-staging`

Do not replace them with production resource IDs or names. The staging Worker has no custom-domain route, and `KINIC_WIKI_GENERATOR_URL` remains empty so it cannot call the production generator. Do not add production tokens or secrets to the staging environment.

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

The page/Git-history rollout accepts filesystem schema `vfs_store:001_initial` or `vfs_store:002_publication_mutation_commits` and migrates it once to `vfs_store:003_node_history`. A database that already carries an earlier branch-local `vfs_store:003_node_history` marker is not repairable by this release and must be recreated before deployment. Confirm the migration canbench retains at least 30% instruction, Wasm heap, and stable-memory headroom before upgrading staging.

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

Inspect the resolved bindings without deploying:

```bash
CLOUDFLARE_ENV=staging pnpm wrangler deploy --dry-run
```

The dry run must show the staging canister, staging KV/R2/Queue resources, an empty generator URL, and no production custom-domain route. Deploy the same staging configuration:

```bash
pnpm deploy:staging
```

The command must print `staging Worker deploy source validated` before the build starts. By default it refuses any staged, unstaged, or untracked content because Wrangler deploys the complete current worktree. If an intentional staging-only change has not been committed, inspect `git status --short` and `git diff` first, then acknowledge that exact risk explicitly:

```bash
KINIC_STAGING_DEPLOY_ALLOW_DIRTY=1 pnpm deploy:staging
```

The dirty-worktree acknowledgement does not bypass the fetched `origin/main` ancestry check, unresolved-conflict check, or public-node regression check.

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

### Curator accuracy without deployment

Curator is implemented in `kinic-vfs-cli`; it does not add a canister schema or Candid API. Do not upgrade the staging canister merely to evaluate Curator accuracy. Use the branch CLI against an explicitly selected existing staging test database, keep that database read-only, and follow the private answer-masked labeling and cohort scoring workflow in [`validation/CURATOR_ACCURACY.md`](validation/CURATOR_ACCURACY.md). Test `curator apply --confirm` only in a separate disposable database after explicit approval of proposal IDs.

When a controlled retained corpus is needed, run `scripts/staging/seed_curator_accuracy.sh --database-id <id>` first as a write-free preflight. Add `--confirm` only after reviewing the seed manifest and batch statuses. The script writes solely below the seed-specific roots, rejects partial or conflicting namespaces, and verifies the full scan after insertion. This seeds test content; it is not a canister deploy and does not authorize `curator apply --confirm`.

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
