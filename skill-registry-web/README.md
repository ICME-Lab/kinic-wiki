# Kinic Skill Registry Web

Skill Registry dashboard for skill status, snapshots, run evidence, and permissions.
This app is an independent verification and operations surface. The public product route is WikiBrowser's `/skills/<database-id>`.

## Local

```bash
pnpm install
pnpm dev
```

Open:

```text
http://localhost:3000/skills/<database-id>
```

If port 3000 is already in use, start this app on another port:

```bash
pnpm dev -- -p 3001
```

Required public environment:

```bash
VITE_WIKI_IC_HOST=https://icp0.io
VITE_KINIC_WIKI_CANISTER_ID=6emaw-iyaaa-aaaay-aacka-cai
```

## Checks

```bash
pnpm test
pnpm lint
pnpm typecheck
pnpm build
pnpm build:worker
```

This app runs on TanStack Start and can be deployed as an independent Cloudflare Worker with `wrangler.jsonc`. It intentionally has no production custom domain; WikiBrowser remains the public `/skills/<database-id>` surface.

`VITE_*` values are embedded into the browser bundle at build time. Wrangler `vars` remain available to Worker runtime code, but do not configure the client build. `pnpm build:worker` therefore supplies the production public IC host and canister ID explicitly, verifies that the canister ID is present in `dist/client`, and then runs Wrangler's dry-run deploy.
