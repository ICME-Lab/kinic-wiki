# Kinic Skill Registry Web

Skill Registry dashboard for skill status, run evidence, proposals, jobs, and permissions.

## Local

```bash
pnpm install
pnpm dev
```

Open:

```text
http://localhost:3000/skills/<database-id>
```

Required public environment:

```bash
NEXT_PUBLIC_WIKI_IC_HOST=https://icp0.io
NEXT_PUBLIC_II_PROVIDER_URL=https://id.ai
NEXT_PUBLIC_KINIC_WIKI_CANISTER_ID=<wiki-canister-id>
```

## Checks

```bash
pnpm test
pnpm typecheck
pnpm build
```
