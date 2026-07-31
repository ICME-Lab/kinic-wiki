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

The staging Worker must be deployed only through `pnpm deploy:staging` from `wikibrowser/`. That command fetches `origin/main`, refuses a HEAD that does not contain the fetched commit, rejects unresolved conflicts, and verifies the public-node publication files before Wrangler runs. A direct `wrangler deploy` bypasses these checks and must not be used for staging deployment.

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

For routine updates, deploy the canister before the Worker. This order lets the existing Worker continue to use the older response shape while ensuring that a new Worker never expects a Candid field that the deployed canister does not yet return.

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
