# Kinic Wiki — Muse Connector Review Package

Status: **Submitted on 2026-11-09; review requirements incomplete; not approved or published.**

The browser now shows submission `724a1604-909e-4f83-8819-9a44fc501d51`. The controller did not click Submit or accept the final attestations. Business verification, data processing questionnaire, and technical details remain Not started (0/3).

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

Observed in the authenticated submission form on 2026-11-09: Overview → Technical specs → Review. The draft reached the final Review screen; no authorization or Terms checkbox was selected and Submit for review was not pressed.

| Field | Prepared value or required input |
| --- | --- |
| Connector name | Kinic Wiki |
| Company or developer | Entered by the operator in the live draft; confirm authority and consistency with product terms before submission |
| Product website | https://wiki.kinic.xyz |
| Example prompts | Use the examples above, with a dedicated fixture database for review |
| Connector icon | Existing `wikibrowser/public/kinic-logo-large.png`, 952×952; uploaded to the draft and confirmed resized to 512×512 by the portal |
| Payments | “My connector does not accept payments” selected; no payment tools are exposed. Disclose underlying service charges separately |
| Your name | Entered by the operator in the live draft; ID matching is the submitter's attestation, not independently verified |
| Work email | Entered by the operator in the live draft; confirm it satisfies Meta's work-email requirement |
| Support email or URL | Existing published contact: https://x.com/kinic_app; verify acceptance in the portal |
| Privacy policy | https://wiki.kinic.xyz/privacy-policy; live page verified in Chrome, dated September 30, 2026; deployed settings still require review before final attestation |
| Terms of service | Candidate https://www.kinic.io/terms-of-service, found on the official site and added to the draft. Dated May 28, 2025, it focuses on the Chrome extension and names Kinic, Inc.; applicability to Wiki/Muse and consistency with the submitted developer identity require authorized confirmation |
| Anything else | Private Wiki content CRUD via OAuth-protected remote MCP; no payment, account administration, or publication tools |

Do not fill unknown legal/business facts with placeholders in the live portal. The maintainer must verify business authority, support ownership, and product terms before submission.

Technical specs fields: Existing MCP; production endpoint `https://wiki-private-mcp.kinic.xyz/mcp`; API/MCP documentation `https://github.com/ICME-Lab/kinic-wiki/blob/main/docs/mcp.md` (repository verified public); access requirements describe II, read/write scopes, database roles, exclusions, and securely supplied review fixture credentials. The form does not request credentials at this step. Final Review requires attestations of brand/submission authority, understanding approval/promotion limits, and agreement to Muse Connector Terms. Do not accept these on the operator's behalf without action-time confirmation.

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

**Post-patch staging result:** Commit `bf01b78a` was deployed using the guarded `deploy:staging` script and the `kinic-production` Cloudflare profile. Version `81042f80-5ebb-4d27-810f-6de92a35e91b` is serving 100% of staging traffic; the previous version is `09149e79-9655-4269-a434-6b1a65875478`. Retrying Muse Connect passed automatic registration and reached Internet Identity. After the operator configured trust and explicitly authorized use of their ordinary Identity (accepting possible replacement of its earlier MCP grant), Questions only consent completed with a 30-day duration. Muse displayed “Kinic Wiki に接続できました.” The fresh browser authorization request confirmed the exact callback, S256, resource, and `mcp:read offline_access` scopes. Wiki contents were not read or changed. Tool discovery/model visibility, refresh, CRUD, and production deployment still require verification. Use synthetic fixture data for subsequent tests.

Check actual tool discovery before submission. The shared Private endpoint currently registers seven reads, eight content mutations, and one OpenAI app-only `get_profile`. Do not claim that Muse hides the profile until observed. If it appears to the model, isolate Muse discovery on a separate route without changing the existing ChatGPT contract.

**Authenticated tool discovery blocker:** Muse reported HTTP 403 followed by two 45-second timeouts for tools/list, without obtaining tool names or invoking tools/call. A scoped staging Worker log query confirmed registration 201 and code exchange 200, with `clientSupportsRefresh`, `refreshIssued`, and `offlineAccessGranted` all true. No corresponding POST `/mcp` invocation appeared in that window. A credential-free local initialize POST returned the expected 401 challenge, while Muse's GET returned 405. Determine the actual 403 response origin before changing server authentication, Origin handling, or transport. Refresh-token issuance is verified; refresh rotation from Muse and end-to-end tool use are not.

A subsequent single direct curl POST from Muse, without Authorization or the connector helper, timed out after 15 seconds with zero origin-response bytes. Only the proxy's `HTTP/1.1 200 Connection Established` was available; no origin HTTP status, Server, CF-Ray, Content-Type, or body was received. The earlier helper discarded the 403 headers/body, so that response's origin cannot be determined retrospectively. Do not label this a proven Kinic authorization failure or a proven Meta outage. Resolve the transport path before claiming successful end-to-end operation. The operator subsequently authorized a reviewed production Worker rollout and a dedicated production fixture as an alternative to restoring staging. Network approvals were one-time only; no domain-wide permanent allowance was enabled.

**Staging canister blocker:** After the operator explicitly authorized the separate staging administration context, `list_databases` was rejected with replica error `IC0207`: canister `3ryrw-kyaaa-aaaaf-qgxpq-cai` is frozen. Management status and snapshot inventory were also rejected, with a reported minimum top-up of approximately 45.82 billion execution cycles. No fixture was created. Staging restoration was superseded by the operator-approved production fixture approach; no top-up is authorized. Cycles held in a cycles-ledger account are a separate balance. This error does not establish the cause of Muse's credential-free POST transport timeout. The Muse settings page still lists Kinic Wiki as linked; do not repeatedly reconnect in response to the earlier stale authentication question.

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

## Production test and icon review update

The operator authorized review, fixes, and a test using the existing production canister. Do not upgrade the canister or transfer cycles. The CLI created `muse-review-fixture` (`db_ifvclcexmagf`) without any payment, but the DB is pending with zero internal cycles: the administrator already used its initial free grant. No synthetic pages or CRUD tests have run. Activation requires a separately authorized billing decision; do not silently use an ordinary database instead.

Use the already-authorized ordinary Internet Identity for interactive connection tests. Its access is broader than the fixture: always select the exact fixture DB and unique scratch paths; this is an operational test boundary, not server-side isolation. A later reviewer credential must have access only to the dedicated DB and must not reuse OpenAI credentials. Reviewer login stays disabled during ordinary II tests.

The icon patch adds Kinic Wiki title and the existing 128×128 PNG as embedded MCP serverInfo metadata, avoiding an external asset fetch. An independent reviewer found no actionable issues. Initialization checks verify exact icon bytes; all 111 Node, 329 regular Vitest, and 92 Worker tests pass (532 total), as do typecheck and private cf dry-run build. Existing dependency sourcemap warnings remain. Muse reported that its supported custom connector.yaml fields do not include an icon URL. Therefore MCP metadata does not establish that the custom connector list icon is fixed. The submission artwork was uploaded separately.

Production Worker rollback version before rollout: `bfe09af4-e7ef-414a-9189-14756746608c`. Existing production canister is Running; its module hash was recorded before the test.

Worker rollout: commit `00bb4e2f` deployed through the guarded private script as version `0205c02f-4a0e-4fb6-85fc-8c3f8db7da19`. Canary is the existing private endpoint; no canister code/settings or funds changed. Muse created a separate Kinic Wiki Production custom connector with read-only scopes.

The portal requires an unauthenticated host verification file at its exact `/.well-known/muse-challenge/<64-hex-token>` URL. Added a configured exact GET response (plain text, no-store) on the production Worker only; no OAuth bypass. RED404 then GREEN126 index tests, typecheck and private dry-run passed; independent review found no actionable issues. Verification with the portal checker remains pending.

Latest observed state (supersedes older rollout/submission prerequisites above): ownership-file commit `12f9a5a1` is deployed as `4a626371-c62e-4d9a-a30f-e98f96d29c9c`. A credential-free GET returned HTTP 200, text/plain, no redirect, and exact required body. Two Muse Verify attempts returned “We couldn’t confirm what happened” and a cooldown, with Next disabled. In the scoped Worker log window, the sole challenge GET matched the local check; a Muse verifier request was not identified. Do not assert a proven cause or successful ownership verification. Challenge expires 2026-11-10 13:40 JST; replace/remove the public challenge after review as appropriate.

Production read-only OAuth reached the trusted II Questions only screen, 30 days, and is waiting for user passkey authentication. No data calls were performed. Data questionnaire pages 1–2 were saved (software organisation: none of the listed regulated organisations; connector exposes none of the licensed financial/legal actions). Page 3 onward remains unanswered; business verification remains untouched.

## Resolved initialize 403 (2026-11-09)

The header-preserving Muse diagnostic returned Cloudflare HTTP403/error1010, CF-Ray `a57a71029e455907-SEA`, with a browser-signature rejection. The client had sent its urllib default `Python-urllib/3.12`. The zone's Browser Integrity Check is on; bot/AI-agent protection is disabled, and no custom configuration ruleset was present. No Cloudflare security setting was changed.

A controlled, credential-free local comparison reproduced403/error1010 with Python-urllib and returned401/unauthorized after changing only User-Agent to `Kinic-Wiki-Muse/1.0`. An invalid token with the descriptive User-Agent still returned401/invalid_token. In Muse, changing only User-Agent produced authenticated initialize200 and successful tools/list, with corresponding POST200 Worker logs. ServerInfo title is Kinic Wiki and icons contains one entry. No Wiki tool calls or content mutations were performed.

Muse returned all16 registered tools and considered get_profile model-callable; provider-specific profile filtering remains required before publication. This discovery result supersedes the earlier unknown visibility status. The current403 is resolved by client identification; it was not caused by the canister, token scopes, or callback allowlist. Normal-client persistence and fresh-process verification are recorded separately when complete.

Persistence verified in Muse: `~/workspace/custom-connectors/custom.kinic-wiki-production/bin/client.py` now defines USER_AGENT next to PROVIDER/ENDPOINT and uses it in request headers. Its CONNECTOR.md records the requirement and regeneration behavior. The scaffolder preserves existing connector files; overwriting client.py from a fresh common template requires reapplying the header. Common templates and the staging client were left unchanged. A new process using the normal client again returned initialize200 and all16 tool descriptors. This fixes the current personal Muse custom connector; it is not a platform-wide fix for independently generated clients.

## Muse connection-profile compatibility fix

The observed exposure was the get_profile tool descriptor (name, description, empty input and id/nickname output schema), not a returned principal value. The diagnostic did not call it. It returns only the already-authenticated account principal and a shortened label, not credentials, tokens or Wiki content; read scope is sufficient. Muse ignored app-only visibility metadata, so the patch omits the tool entirely for sessions authenticated with the exact Muse callback saved in the session. No new route is needed; authenticated-client selection avoids changing resource audiences or requiring reconnection. ChatGPT and public descriptor contracts remain unchanged.

Regression: real Worker/DO test failed while Muse still saw get_profile, then passed after registration was omitted. It compares all remaining descriptors with ChatGPT, verifies guessed profile calls produce no principal/profile data, preserves ChatGPT profile access, and repeats discovery after refresh. User-Agent spoofing does not affect selection. Full validation and live result follow below.

Profile-fix validation: 111 Node +330 regular Vitest +93 Worker tests pass (534total); typecheck and private cf dry-run build pass. Existing SDK sourcemap warnings remain. Independent read-only review found no actionable findings. Live discovery/direct-call check remains required after rollout.

Deployment: profile fix29489570 is live as caae5089-b613-43ad-b29e-8a80e0641724, previous rollback4a626371-c62e-4d9a-a30f-e98f96d29c9c. Fresh-process Muse raw tools/list returned exactly15 tools with no get_profile. The first negative-call test used an incorrect result nesting assumption and did not retain the result, so its outcome was not claimed. A corrected result-shape check and one additional negative test were requested.

Live acceptance completed: corrected negative-result parser was checked locally against tool errors, JSON-RPC errors, successful profile shapes and empty output. A single additional direct call through the normal client returned isError=true, no structuredContent and no profile value. The client file SHA256 was unchanged before/after this test; User-Agent and authorization were preserved. Together with fresh-process raw list15, the profile compatibility fix is verified in personal Muse. No Wiki content read/write or new OAuth grant occurred.
