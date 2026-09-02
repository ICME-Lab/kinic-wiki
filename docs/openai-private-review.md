# OpenAI Private App Review

This runbook prepares the authenticated Kinic Wiki app for review. It never stores reviewer credentials in the repository.

## Fixed review contract

- Production MCP endpoint: `https://wiki-private-mcp.kinic.xyz/mcp`
- Review database name: `openai-review-fixture`
- Stable evidence pages:
  - `/Knowledge/review/release-checklist.md`
  - `/Knowledge/review/rollback-rule.md`
- Writable test boundary: `/OpenAIReview/scratch/`
- Required consent: `Actions & questions`

The review login is a dedicated username-and-password path on the normal OAuth authorization page. It maps to an Ed25519 service identity stored as a Cloudflare Secret; it does not mock MCP tool results or fixture data. The Worker permits that identity to write only to the configured review database ID at `/OpenAIReview/scratch` or its descendants. It rejects non-canonical paths and checks both paths of a move before calling the canister. The service principal must additionally have only `writer` access to `openai-review-fixture` and no access to user databases.

Set `MCP_REVIEW_IDENTITY_KEY`, `MCP_REVIEW_IDENTITY_PRINCIPAL`, `MCP_REVIEW_USERNAME_HASH`, `MCP_REVIEW_PASSWORD_HASH`, and `MCP_REVIEW_DATABASE_ID` with `wrangler secret put` for each environment. Use the exact ID returned for the single `openai-review-fixture` database; staging and production IDs are different. Keep the plaintext password only in the OpenAI submission portal and an operator password manager. The checked-in configuration contains the enable flag, access-version label, and `MCP_REVIEW_WRITE_PREFIX=/OpenAIReview/scratch`; deployments fail closed when either boundary setting is absent or invalid. Incrementing `MCP_REVIEW_ACCESS_VERSION` invalidates existing reviewer authorization codes, access tokens, and refresh tokens after credential rotation; never reuse an earlier access-version value.

Keep the credentials valid after approval because OpenAI may perform continuing safety and quality tests. To rotate the service identity, grant the replacement principal `writer`, deploy and verify the replacement Secret and expected principal, then revoke the old principal. Never grant the reviewer service identity `owner`.

## Prepare staging

1. Generate a staging-only service identity and configure both its private key and expected principal as Secrets. Resolve the staging fixture's exact database ID and set it as the `MCP_REVIEW_DATABASE_ID` Secret before deploying the Worker.
2. As the existing fixture owner, grant that service principal `writer` on the single database named exactly `openai-review-fixture`.
3. Seed the fixed fixture through the authenticated MCP session:

```bash
pnpm --dir workers/wiki-mcp review:seed -- \
  --server-url https://wiki-mcp-staging.kinic.xyz/mcp \
  --open \
  --reset-auth
```

4. Run the submitted tool sequences and invalid-call checks:

```bash
pnpm --dir workers/wiki-mcp review:smoke -- \
  --mcp-url https://wiki-mcp-staging.kinic.xyz/mcp \
  --repeats 3 \
  --open
```

The seeder is idempotent for matching content and metadata, refuses truncated inventory, and refuses to overwrite a conflicting stable page. If an obsolete fixture already occupies either stable path, recreate the dedicated review database explicitly instead of silently migrating it. The smoke test uses random scratch names, verifies exact expected evidence, and removes each owned node with its current etag. If a write response is lost, cleanup rereads the path and deletes it only when its content exactly matches the recorded marker.

## Prepare production

Generate a separate production service identity, set the production fixture's exact database ID as the production `MCP_REVIEW_DATABASE_ID` Secret, grant the identity `writer` on that `openai-review-fixture`, then repeat fixture seeding and the three-run smoke against `https://wiki-private-mcp.kinic.xyz/mcp`. Staging and production credentials, database IDs, OAuth state, and fixture access do not carry over.

Use an isolated production cache when switching endpoints:

```bash
pnpm --dir workers/wiki-mcp review:seed -- \
  --server-url https://wiki-private-mcp.kinic.xyz/mcp \
  --auth-cache "$HOME/.local/state/kinic-wiki/mcp-review-production-oauth.json" \
  --open \
  --reset-auth
```

## Web and mobile acceptance

For both ChatGPT web and mobile:

1. Use a clean browser profile or mobile device.
2. Start a new conversation with only the Private Kinic Wiki app enabled.
3. Choose `OpenAI reviewer sign in` and enter only the submitted username and password. No account creation, passkey, or 2FA is allowed.
4. Run all five positive prompts from `workers/wiki-mcp/chatgpt-app-submission.json` once.
5. Confirm the two write cases create only random paths below `/OpenAIReview/scratch/` and clean them up.
6. Run all three negative prompts and confirm Kinic Wiki is not invoked.
7. Record the result from that clean conversation and reconnect once only if routing or cached descriptors look stale.

Record the date, client, prompt number, invoked tool sequence, pass/fail result, and any leftover scratch path. Remove leftovers only after reading their current etags. Do not put credentials, service keys, OAuth tokens, delegations, principals, or private node bodies in the record.

## Submission gate

Submit only when the checked-in JSON validates, authenticated production smoke passes three consecutive runs, all web and mobile cases pass consistently, and the portal contains working reviewer credentials and concise login instructions.

Use this credential text in the submission portal, substituting only the password:

```text
Dedicated demo account containing sample data only.

Username: openai-review
Password: <production review password>

Connect Kinic Wiki, choose "OpenAI reviewer sign in", and enter the credentials above.
Login provides immediate access to the pre-populated openai-review-fixture database.
No account creation, passkey, or two-factor authentication is required.
```
