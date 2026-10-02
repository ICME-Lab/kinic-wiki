# Cloudflare CLI

Use the project-pinned `cf` CLI (`1.0.0-beta.2`) through `pnpm exec cf`.
Worker deployment configuration is `cloudflare.config.ts`; choose a named environment
with `--mode`. Always use the package's `deploy:*` scripts for guarded deployments.

```sh
pnpm exec cf auth whoami
pnpm exec cf auth login
pnpm exec cf cli search "describe the operation"
pnpm build:worker # WikiBrowser/Skill Registry
# For WikiBrowser staging (build and check only):
node ../scripts/cloudflare/deploy.mjs --mode staging --dry-run
```

Package scripts and CI call cf. Vite and Wrangler remain dependencies where cf delegates
build/dev or the Workers test pool requires them. The retained `wrangler*.jsonc` files
serve migration parity tests and preserve the original Durable Object migration history.
Worker runtime tests and deployment guards read the actual cf configuration. Runtime
tests use Vitest/Miniflare directly without the Wrangler configuration adapter; the
installed official test pool still includes Wrangler as an internal dependency.

| Project | Modes |
| --- | --- |
| wikibrowser | default/production, development, staging |
| skill-registry-web | default/production, development |
| wiki-generator | default/production, development, staging |
| wiki-assistant | default/production, staging |
| wiki-mcp | default/public, private, staging, private-v5-unbind, staging-v5-unbind |
| payment | default/dev, sandbox, production |

The Vite projects use the official `cf-vite` delegate to build and `cf deploy --prebuilt`
to upload. This avoids cf beta's TanStack mode-forwarding limitation and ensures every
build receives the selected mode's `VITE_*` values.

MCP declares live and retired Durable Object classes using cf's exports lifecycle.
Use `deploy:staging:v5-migration` or `deploy:private:v5-migration` for the two-phase V4
binding removal and V5 deployment. Both phases are built and checked before either is
uploaded. Existing v1–v5 history remains in the compatibility fixtures.

D1 migration commands require a database UUID, rather than a binding or database name:

```sh
pnpm exec cf d1 create --name <database-name>
pnpm exec cf d1 migrations list <database-id> --dir migrations
pnpm exec cf d1 migrations apply <database-id> --dir migrations
```

Record newly created resource IDs in the corresponding cf configuration. D1 creation
no longer rewrites configuration automatically.

## Secrets

This pinned cf version uploads secrets with `--secrets-file` during a deployment or
version upload. Prepare a JSON object mapping secret names to values in a private file
outside this repository. Restrict file permissions and remove it after use. Do not put
secret values in command arguments or committed configuration.

The guarded deployment scripts accept `CLOUDFLARE_SECRETS_FILE`. Deployment wrappers preserve all existing secret names in the built configuration before
upload, without reading values. A failed secret listing blocks deployment. Use these wrappers,
including for MCP V5 migrations; direct cf deploy bypasses preservation. Initial provisioning
requires creating the Worker first so its secret list can be read. Required-secret guards
combine the supplied names with existing Worker secret names. Complete files support
initial provisioning without querying a Worker that does not exist yet.

```sh
CLOUDFLARE_SECRETS_FILE=/absolute/path/outside-repo/staging-secrets.json pnpm deploy:staging
```

For payment production, first copy `cloudflare.production.example.ts` to the ignored
`cloudflare.production.ts` and fill resource placeholders. The price catalog and clean
branch guards still apply. A secrets file does not bypass them.

## Local state

Vite development explicitly retains `.wrangler/state`. Other cf local resource operations
default to `~/.config/cloudflare/state`; keep existing Wrangler state directories too.
Select an existing persisted-state path explicitly for cf commands that support local state.

Do not delete either state directory during migration. `cf-typegen` uses cf's generated
runtime declarations and resolves native bindings across supported modes into the checked-in
declarations. `cf-typecheck` verifies those declarations without modifying them.
