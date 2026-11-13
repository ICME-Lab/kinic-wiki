# OpenAI Private App Review

This runbook prepares the authenticated Kinic Wiki app for review. It never stores reviewer credentials in the repository.

## Publication checks

Publish `docs/legal/privacy-policy.md` at `https://wiki.kinic.xyz/privacy-policy` and confirm that the submission portal points to it. Verify that the published tool disclosures match the portal's Scan Tools results, including nested metadata and conflict responses.

Before publication, verify production Cloudflare logging destinations. The policy's seven-day limit covers Workers Logs; any independently configured log exports need their own recipient and retention disclosure.

## Fixed review contract

- Production MCP endpoint: `https://wiki-private-mcp.kinic.xyz/mcp`
- Review database name: `openai-review-fixture`
- Stable evidence pages:
  - `/Knowledge/review/release-checklist.md`
  - `/Knowledge/review/rollback-rule.md`
- Writable test boundary: `/OpenAIReview/scratch/`
- Required consent: `Actions & questions`

The review login is a dedicated username-and-password path on the normal OAuth authorization page. It maps to an Ed25519 service identity stored as a Cloudflare Secret; it does not mock MCP tool results or fixture data. The Worker permits that identity to write only to the configured review database ID at `/OpenAIReview/scratch` or its descendants. It rejects non-canonical paths and checks both paths of a move before calling the canister. The service principal must additionally have only `writer` access to `openai-review-fixture` and no access to user databases.

Set `MCP_REVIEW_IDENTITY_KEY`, `MCP_REVIEW_IDENTITY_PRINCIPAL`, `MCP_REVIEW_USERNAME_HASH`, `MCP_REVIEW_PASSWORD_HASH`, and `MCP_REVIEW_DATABASE_ID` with `CLOUDFLARE_SECRETS_FILE` on the guarded deploy commands (see [Cloudflare CLI](CLOUDFLARE_CLI.md)) for each environment. Use the exact ID returned for the single `openai-review-fixture` database; staging and production IDs are different. Keep the plaintext password only in the OpenAI submission portal and an operator password manager. The checked-in configuration contains the enable flag, access-version label, and `MCP_REVIEW_WRITE_PREFIX=/OpenAIReview/scratch`; deployments fail closed when either boundary setting is absent or invalid. Incrementing `MCP_REVIEW_ACCESS_VERSION` invalidates existing reviewer authorization codes, access tokens, and refresh tokens after credential rotation; never reuse an earlier access-version value.

For portals that require two reviewer accounts, the same login flow also accepts an optional second pair: `MCP_REVIEW_SECONDARY_USERNAME_HASH` and `MCP_REVIEW_SECONDARY_PASSWORD_HASH`. Supply both as SHA-256 base64url hashes through the guarded deployment's secret file, or omit both. A missing or malformed half-pair makes an enabled review login fail closed. Each username is checked together with its own password; passwords cannot be mixed between pairs. Both accounts use the same configured synthetic-fixture service principal and database, with separate OAuth sessions. They are not independent end-user identities and cannot validate cross-principal data isolation. Use distinct reviewer usernames/passwords and never reuse a previous provider's credentials. The optional pair does not enable review login by itself.

To disable reviewer sign-in, set `MCP_REVIEW_LOGIN_ENABLED=false` and choose a new, never-used `MCP_REVIEW_ACCESS_VERSION` before deploying. The reviewer form is hidden, new reviewer logins are rejected, and existing reviewer authorization codes, access tokens, and refresh tokens are invalidated by the version change. Internet Identity sessions are unaffected. To enable reviewer sign-in, set the flag to `true` with complete credentials and a new access version.

To rotate the service identity, grant the replacement principal `writer`, deploy and verify the replacement Secret and expected principal, then revoke the old principal. Never grant the reviewer service identity `owner`.

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

Confirm seeding succeeds, all smoke runs pass, and no test scratch nodes remain. If an obsolete fixture conflicts with a stable evidence page, explicitly recreate the dedicated review database rather than overwriting that page. For leftover scratch nodes, read their current content and etags, verify they belong to the failed test, then remove only those nodes.

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

HTTP-only smoke tests do not enforce browser Content Security Policy. Verify a fresh browser OAuth connection through the callback and token exchange, including a failed reviewer password followed by a successful retry and the normal Internet Identity flow. Also complete the portal's Scan Tools OAuth flow: ChatGPT redirects again to OpenAI Platform. The authorization page permits form redirects to its own origin, Internet Identity, and the current session's validated callback origin; only ChatGPT callbacks additionally permit the OpenAI Platform relay.

For both ChatGPT web and mobile:

1. Use a clean browser profile or mobile device.
2. Start a new conversation with only the Private Kinic Wiki app enabled.
3. Choose `OpenAI reviewer sign in` and enter only the submitted username and password. No account creation, passkey, or 2FA is allowed.
4. Run every positive prompt defined in `workers/wiki-mcp/chatgpt-app-submission.json` once.
5. Confirm every write case creates only random paths below `/OpenAIReview/scratch/` and cleans them up.
6. Run every negative prompt defined in the same JSON and confirm Kinic Wiki is not invoked.
7. Record the result from that clean conversation and reconnect once only if routing or cached descriptors look stale.

Record the date, client, prompt number, invoked tool sequence, pass/fail result, and any leftover scratch path. Remove leftovers only after reading their current etags. Do not put credentials, service keys, OAuth tokens, delegations, principals, or private node bodies in the record.

## Submission gate

Submit only when the checked-in JSON validates, authenticated production smoke passes three consecutive runs, all web and mobile cases pass consistently, and the portal contains working reviewer credentials and concise login instructions.
