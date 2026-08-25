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

The review account must be a dedicated Internet Identity with no valuable data or access outside this fixture. Configure an Internet Identity recovery phrase for it. Store the identity reference and recovery phrase only in the submission portal; never put them in this repository, command arguments, shell history, test output, screenshots, or the acceptance record.

The reviewer login instructions in the portal must direct the reviewer to the `id.ai` recovery flow. From a clean device, the reviewer recovers the dedicated identity with the supplied phrase, registers a local passkey when prompted, and completes MCP consent with `Actions & questions`. This flow must work without email, SMS, MFA, a private network, or assistance from the developer. The MCP Worker continues to use its normal Internet Identity OAuth flow; there is no review bypass.

Keep the recovery phrase valid until the review is closed. After approval or final rejection, revoke the dedicated identity's staging and production fixture access first, remove passkeys added during review, and retire that identity. Replacing only the recovery phrase is insufficient because a reviewer-added passkey remains an authentication method. Create and verify a new dedicated identity and phrase before any later submission.

## Prepare staging

1. Sign in as the dedicated review identity and create a database named exactly `openai-review-fixture` in the staging environment.
2. Register the staging MCP URL as a trusted connector and grant `Actions & questions`.
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

Use the same dedicated Internet Identity to create a separate database named `openai-review-fixture` in production, then repeat fixture seeding and the three-run smoke against `https://wiki-private-mcp.kinic.xyz/mcp`. Staging and production derive access for different target environments; their OAuth state and fixture data do not carry over.

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

1. Use a clean browser profile or a device without the dedicated identity's existing passkey.
2. Start a new conversation with only the Private Kinic Wiki app enabled.
3. Recover the dedicated identity using only the portal instructions, register the device passkey, and complete OAuth with `Actions & questions`.
4. Run all five positive prompts from `workers/wiki-mcp/chatgpt-app-submission.json` twice.
5. Confirm the two write cases create only random paths below `/OpenAIReview/scratch/` and clean them up.
6. Run all three negative prompts and confirm Kinic Wiki is not invoked.
7. Start another new conversation and repeat once to detect cached routing or stale tool descriptors.

Record the date, client, prompt number, invoked tool sequence, pass/fail result, and any leftover scratch path. Remove leftovers only after reading their current etags. Do not put credentials, OAuth tokens, delegations, or private node bodies in the record.

## Submission gate

Submit only when the checked-in JSON validates, authenticated production smoke passes three consecutive runs, all web and mobile cases pass consistently, and the portal contains working reviewer credentials and concise login instructions.
