# Kinic Skill Registry Web

Skill Registry dashboard for skill status, run evidence, proposals, jobs, and permissions.
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

If WikiBrowser is already running on port 3000, start this app on another port:

```bash
pnpm dev -- -p 3001
```

Required public environment:

```bash
NEXT_PUBLIC_WIKI_IC_HOST=https://icp0.io
NEXT_PUBLIC_KINIC_WIKI_CANISTER_ID=xis3j-paaaa-aaaai-axumq-cai
```

## Checks

```bash
pnpm test
pnpm typecheck
pnpm build
```
