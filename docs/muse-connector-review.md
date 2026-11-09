# Kinic Wiki — Muse Connector Review Package

Status: **Preparation in progress; not submitted or published.**

Target: Meta's personal Muse app, not Muse Code. Requirements reference:
[Connector guidelines](https://platform.muse.ai/docs), checked 2026-11-09.
Execution progress is maintained in Kinic workflow `42b3e09b-e38d-4ea3-b21d-c10a8b5e5cc5`.

## Listing copy

**Name:** Kinic Wiki

**Short description:** Search and update your private Wiki from Muse.

**Description:** Kinic Wiki connects Muse to Wiki databases available to your signed-in Internet Identity. Find relevant notes, read source evidence, save new pages, and edit, organize, or delete existing content. Database permissions and OAuth scopes restrict access. Existing-content changes use etags to detect concurrent edits, and supported batches apply atomically. You can authorize read-only access instead of editing access.

**Value beyond browsing:** Retrieve task-focused knowledge and exact supporting pages from private databases, then save or revise notes directly through structured tools. The connector returns actual operation results and conflict information instead of handing users a list of website links.

**Example prompts:**

- Search my Wiki for the release checklist and explain the rollback rule with supporting page paths.
- Save this meeting summary as a new page in my selected Wiki database, then read it back to confirm.
- Find the deployment note, show me the proposed correction, and apply it after I approve.
- Move my approved test note into the review folder, then verify its new path.

Accounts and restrictions: Internet Identity and access to an existing Kinic Wiki database are required. Editing also requires a writable database role and write consent. Database creation, billing, membership management, marketplace purchases, publication, and database archival are outside this connector. Disclose current Kinic service limits and any Muse account/region restrictions in the portal once verified; do not promise worldwide availability or free use.

## Portal fields and assets

Observed in the authenticated submission form on 2026-11-09: Overview → Technical specs → Review. Only Overview has been inspected so far; later steps are not yet verified.

| Field | Prepared value or required input |
| --- | --- |
| Connector name | Kinic Wiki |
| Company or developer | Kinic is the existing product brand; authorized submitter must verify the exact business/developer name |
| Product website | https://wiki.kinic.xyz |
| Example prompts | Use the examples above, with a dedicated fixture database for review |
| Connector icon | Existing `wikibrowser/public/kinic-logo-large.png`, 952×952; uploaded to the draft and confirmed resized to 512×512 by the portal |
| Payments | “My connector does not accept payments” selected; no payment tools are exposed. Disclose underlying service charges separately |
| Your name | Authorized submitter's first and last name, matching their ID; not inferred from a username or chat greeting |
| Work email | Authorized submitter's company email; not inferred from Git configuration |
| Support email or URL | Existing published contact: https://x.com/kinic_app; verify acceptance in the portal |
| Privacy policy | https://wiki.kinic.xyz/privacy-policy; live page verified in Chrome, dated September 30, 2026; deployed settings still require review before final attestation |
| Terms of service | A verified public product terms URL is required; no such document was found in the inspected repository legal/store-listing materials |
| Anything else | Private Wiki content CRUD via OAuth-protected remote MCP; no payment, account administration, or publication tools |

Do not fill unknown legal/business facts with placeholders in the live portal. The maintainer must verify business authority, support ownership, and product terms before submission.

## Technical connection contract

Production MCP: `https://wiki-private-mcp.kinic.xyz/mcp`.
Staging MCP: `https://wiki-mcp-staging.kinic.xyz/mcp`.
Transport: stateless MCP over POST `/mcp`; GET `/mcp` returns 405.

Each Private origin exposes:

- `/.well-known/oauth-protected-resource/mcp`
- `/.well-known/oauth-authorization-server`
- `/oauth/register` for dynamic client registration
- `/oauth/authorize` for authorization code with S256 PKCE
- `/oauth/token` for code exchange and supported refresh grants

Read scope: `mcp:read`. Editing additionally requires `mcp:write` and Internet Identity **Actions & questions**. **Questions only** removes write scope. An account connection does not grant permission for unrelated operations. Never weaken PKCE, audience validation, scope checks, or database authorization for Muse compatibility.

**Observed Muse preparation:** Muse displayed `mcp:read offline_access`, S256 PKCE, `token_endpoint_auth_method=none`, and RFC 7591 registration for the staging endpoint. Clicking Connect produced: “The provider rejected automatic app registration” (Japanese UI). Muse then inspected its connection configuration and reported the exact callback `https://agent.meta.ai/api/hatch/oauth/callback`. Actual DCR `grant_types` could not be inspected. These are values reported by Muse's setup/diagnosis, not a captured wire request. A regression test using the reported callback reproduced HTTP 400 `invalid_redirect_uri`; the patch adds that exact callback without permitting other Meta URLs. No authorization page was reached in the pre-patch live test and no Wiki contents were fetched. Live post-deployment verification remains required.

**Post-patch staging result:** Commit `bf01b78a` was deployed using the guarded `deploy:staging` script and the `kinic-production` Cloudflare profile. Version `81042f80-5ebb-4d27-810f-6de92a35e91b` is serving 100% of staging traffic; the previous version is `09149e79-9655-4269-a434-6b1a65875478`. Retrying Muse Connect passed automatic registration and reached Internet Identity. II displayed “This MCP server isn't trusted yet.” The ordinary user's trust setting was not changed; testing is waiting for a separate test Identity with the exact staging endpoint trusted. No Wiki content was read or changed. Tool discovery, consent completion, refresh, CRUD, and production deployment remain unverified.

Check actual tool discovery before submission. The shared Private endpoint currently registers seven reads, eight content mutations, and one OpenAI app-only `get_profile`. Do not claim that Muse hides the profile until observed. If it appears to the model, isolate Muse discovery on a separate route without changing the existing ChatGPT contract.

## Tool inventory and permissions

Full input/output schemas, limits, and conflict envelopes are defined by MCP `tools/list` and [the MCP contract](mcp.md). Export the actual reviewed deployment's descriptors into the submission materials after connection works. All operations remain subject to the authenticated principal's database permissions.

| Tool | Purpose and relevant behavior | Proposed Muse classification |
| --- | --- | --- |
| `find_databases` | Discover databases visible to the signed-in user | Read |
| `search` | Search one accessible database; return paths, previews, and fetchable IDs | Read |
| `fetch_many` | Read 1–10 exact search IDs or Wiki URLs; inspect per-item errors | Read |
| `read_paths` | Read 1–10 known paths; return content, metadata, and etags | Read |
| `list` | List paths and node metadata under a prefix | Read |
| `memory_manifest` | Read roots, roles, capabilities, limits, and write policy | Read |
| `context` | Retrieve task-focused context and supporting evidence | Read |
| `write_nodes` | Create or fully replace nodes; explicit content and metadata; atomic batch | Sensitive write: the same tool can fully replace existing content |
| `append_nodes` | Append text and optionally update metadata/kind atomically | Write |
| `edit_nodes` | Exact text replacement with etag checks; ambiguous matches fail unless explicitly allowed | Write |
| `multi_edit_nodes` | Ordered exact replacements, with etag checks | Write |
| `create_folders` | Create folders; existing folders remain unchanged | Write |
| `move_nodes` | Move/rename nodes; explicit overwrite can replace target content | Sensitive write: overwrite is destructive |
| `delete_nodes` | Delete explicitly selected nodes with etag protection | Sensitive write |
| `mutate_nodes_batch` | Atomic mixed create, append, edit, folder, move, and delete operations | Sensitive write: can delete or fully replace content |

These are submission classifications, subject to Meta review. Require per-use approval for sensitive tools; do not claim MCP annotations alone enforce Muse approval. Inspect requested paths/content and explain consequences before an approved destructive action. Denied approval must result in no tool execution.

## Data processing answers

Use the current [privacy policy source](legal/privacy-policy.md) as the basis, then verify deployed settings and the published policy before submission.

- **Data accessed:** OAuth connection metadata, principal/delegation information, tool arguments, selected database and paths, requested Wiki content/metadata, etags, and operation results. Access is limited by the user's scopes and canister permissions.
- **Purpose:** Fulfill the user's requested Wiki retrieval or content operation. No advertising, unrelated profiling, or training use is introduced by this connector.
- **Recipients:** Meta/Muse receives the requested tool results; Cloudflare processes MCP traffic and authentication state; Internet Identity handles authentication/delegation; the Internet Computer stores Wiki state. Do not silently route MCP content through unrelated generation providers. Disclose the actual retrieval/reranking behavior of the submitted build.
- **Security:** TLS; encrypted authentication key/delegation material in Durable Objects; hashed tokens; scope/audience checks; database role authorization. Log safe stages, status codes, and trace IDs without credentials, Wiki text, raw principals, or tool arguments.
- **Retention:** Wiki content persists until an authorized deletion. Existing policy describes up to seven days of Workers Logs and up to 30 days of Durable Object recovery history. Verify actual log exports/retention before attesting to these limits. Authentication and review sessions have their own expiry; backups do not extend valid access.
- **Disconnect/deletion:** Disconnecting stops client use; withdrawing the Internet Identity grant revokes future delegations. Existing short-lived delegation cache may last up to five minutes. This does not erase stored Wiki content or copies already delivered to Muse; users manage these separately.
- **User rights/support:** Existing published contact is https://x.com/kinic_app. Establish the responsible support/security contact for the submission and incident process.

No credentials, OAuth state/code/token, private principal, or real user Wiki content belong in this document, screenshots, logs, or submitted demo data.

## Dedicated review account and fixture

Prepare a separate database named `muse-review-fixture` with synthetic evidence pages under `/Knowledge/review/` and disposable writes under `/MuseReview/scratch/`. Use a dedicated reviewer identity, separate staging/production credentials, and no access to ordinary user databases. Do not reuse or reopen the OpenAI reviewer credential set.

The existing review login supports one configured service identity per Worker. Do not overwrite an active review configuration to add Muse. Provision Muse access only after confirming the current review state; preserve other provider access if active. New review identities receive `writer`, never `owner`; enforce the fixture database and scratch path boundary before every mutation, including both sides of a move.

Deliver credentials only through the portal's secure mechanism. Keep the account available throughout review. Record review access version, fixture ID, and secret names in operator records without secret values. Revoke reviewer access after review, invalidate its sessions, and verify ordinary II connections still work.

## Acceptance and demo script

Use unique test paths and a dedicated II identity. Before destructive steps, obtain the required Muse approval. Record date, environment, client, actual invoked tools, pass/fail, safe errors, and any remaining fixture path. A scripted HTTP test alone does not prove Muse routing or browser consent.

1. Connect staging with read-only consent. Find the fixture, search a distinctive release-checklist term, fetch its evidence, and answer with exact paths. Verify no `get_profile` model capability appears.
2. Request a write from the read-only connection. It must fail or require explicit scope escalation without changing data. Validate denial separately from successful write consent.
3. With write consent, create a unique note, read it back, append text, apply an exact edit and ordered edits, create a folder, move the note, and verify the final path/content. Exercise both same-kind and heterogeneous atomic batches.
4. Propose full replacement, move-overwrite, and deletion. Deny one request and verify no mutation; approve subsequent fixture-only actions and verify exact results. Do not infer approval behavior from a successful API call.
5. Submit a stale etag and a mixed batch containing a failing operation. Confirm the conflict is surfaced and the atomic batch leaves no partial changes.
6. Test access to a second fixture unavailable to the test principal. No private contents or mutation results may leak.
7. Simulate an uncertain write response. Read the original unique path before any retry; avoid duplicate append/create and clean up only nodes whose marker and current etag match.
8. Verify token renewal, expiry, disconnect/revocation, and reconnect. Do not invalidate this II test grant with another connection during the renewal test.
9. Re-run existing ChatGPT OAuth/discovery behavior. Run package tests/typecheck and staging/private build checks on the exact patch.
10. After staging passes, deploy with guarded cf scripts, verify production against its own fixture, and record rollback version. Complete a fresh Muse connection after approval and verify directory discovery.

## Submission and release record

- Submission ID/date: not submitted.
- Confirmed endpoint/callback/client-registration requirements: exact reported callback implemented; live staging DCR reached Internet Identity; wire-level grant types/refresh support still unverified.
- Review account and per-tool demo: not provisioned / not run.
- Muse policy/business verification and Terms acceptance: pending authorized submitter.
- Production compatibility deployment: not performed.
- Meta review decision and directory listing: pending.

Local validation for the callback patch: 111 Node tests, 328 regular Vitest tests, and 92 Worker tests passed; typecheck and staging/private cf dry-run builds passed. Existing dependency sourcemap warnings remain. A separate read-only reviewer found no actionable patch issues; live interoperability and legal/business facts were explicitly outside that review's evidence.

Keep the portal receipt and review status in the workflow record. Address each requested change against a reproducible case. A submitted connector, a working custom connector, an approved connector, and a published listing are separate milestones.
