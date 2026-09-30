# AskAI production rollout, September 30, 2026

## Applied

The canister and Browser source is `c76b9dbd2c1c5a377f3545da0db231fc6338a9bd` on `feat/ios-shared-work-items`. The final Assistant source is `408aff4f537d3afce3f04dffb00fa8c2b98a80ba`.

- Browser Worker `kinic-wiki-browser`: version `9ff8e45f-6d6c-4db7-bd6b-57f8ea35a20e`. Both production domains serve the September 30 policy with DeepSeek disclosure and immediate effect for users accepting the updated consent.
- Wiki canister `6emaw-iyaaa-aaaay-aacka-cai`: upgraded with empty arguments, preserving existing billing configuration. Wasm SHA-256 is `9e5c14bdcff827fa9b8dcc213accf97ad56501bbdb03db50e052ce1c31504c69`. The deployed Candid matches the candidate except for a trailing empty line. Immediately after upgrade, `get_voice_rate` responded with `voice billing not configured`; the initial production rate was subsequently configured as recorded below.
- Assistant D1 `51dcc15a-a8f9-4d00-93d9-5ad8e0684584`: migration `0002_charge_conversation.sql` applied; no pending migrations.
- Assistant Worker `kinic-wiki-assistant`: version `2c5c88d3-67ed-4219-93f1-6af3bc52013a`, with `ASSISTANT_ENABLED=true` and the dedicated production billing key. Required secret names are present. `/api/assistant/native/status` returns HTTP 200 with `available: true`. This includes the route-specific tool selection fix found by the live DeepSeek test. Older Worker versions contain an older billing secret; do not roll back that secret while the canister expects the current authority. To disable AskAI, deploy the current code and billing secret with `ASSISTANT_ENABLED=false`.
- Voice rate: version `1`, `30_000_000_000` cycles per minute, matching staging's existing price. Authority `kmqpa-lot3e-g653h-qjxst-7yrph-6jo2i-iyjbh-c7png-qhxvu-p3vtr-rae` matches the newly generated production Worker key. The user explicitly approved both the rate and dedicated key registration. The key was passed directly from memory to `ASSISTANT_BILLING_KEY`; only its public principal was saved locally. No database policy or budget was changed. `configure_voice_rate` returned `Ok`, and `get_voice_rate` returned the exact rate, version and authority. Rates are immutable records; a future price change requires a higher version.

## Verification and recovery

Live Candid compatibility and preservation of the billing configuration passed. The canister is running after upgrade. A pre-upgrade snapshot was saved locally under `.local/mainnet-snapshots/voice-upgrade-20260930.json`; preserve that file. Loading a snapshot would revert subsequent writes and requires a deliberate recovery decision. Do not use reinstall as recovery.

The prior Assistant version is `02bb54cc-15ee-4d80-bba6-3ad9a3314448`; the prior Browser version is `66e0b8e0-23d3-44a7-abde-811d6b86f7cf`. A Worker rollback does not reverse a D1 migration. Migration 0002 adds conversation ownership metadata to cleanup JSON.

Worker typecheck and production deployment dry-run passed. A real DeepSeek `deepseek-flash` request returned HTTP 200 and an answer, using a synthetic question without Wiki content. The independent Jev overview-routing live test passed. iOS app, extensions and test targets passed build-for-testing; nine AskAI authentication/history XCTest cases passed. The unsigned physical-device Release build also passed; it is not an uploadable signed archive. These checks do not establish physical-device authentication, real Wiki retrieval, microphone behavior, provider cleanup or billing acceptance.

The native DeepSeek synthetic overview initially failed with `tool_not_allowed`: a database overview advertised `wiki_query` despite the reader rejecting it for that route. The Assistant now advertises only route-permitted tools. The same live test then passed its Japanese answer, expected facts and exact citation checks. The updated Worker passed 140 unit, 30 runtime and two Node tests.

The current iOS build from `a232a214` was signed with the existing development identity and installed on the connected iPhone 15, Bundle ID `xyz.kinic.ios.KinicWiki`. This is a development install, not TestFlight distribution. No App Store Connect profile has been selected: `asc 5.8.0` is installed, and existing Keychain profiles `TAGGR` and `DreamVault` require identification of the Kinic-authorized profile before use.

The OpenAI live suite finished with 18 passed and four failed tests (20 retrieval cases plus two additional checks). Three failures concerned provider session cleanup and one concerned a model request with an incorrect scope. The three named synthetic sessions were successfully deleted on retry. The original suite result remains failed; the scope failure is unresolved. Its output is local at `/private/tmp/kinic-assistant-live-eval-20260930.log`. The separate native DeepSeek overview and Jev routing checks completed successfully. Do not report the OpenAI suite as passed or treat text activation as voice acceptance.

## Still required for acceptance and App Review

- Confirm the TypeSafe account permits production automated processing and configure the operational cleanup/billing notifications described in the Assistant README.
- Complete staging Internet Identity and access-boundary checks, representative question evaluation, and physical-device acceptance. Verify denied access, revocation, cancellation and cleanup.
- Production typed AskAI was explicitly enabled before those outstanding acceptance checks were completed. Availability was verified, but actual user login and end-to-end question acceptance remain unverified. Voice pricing is configured; voice still requires an enabled database-owner policy, sufficient credits and user consent. Physical-device voice and settlement acceptance remain unverified.
- Resolve an authorized Kinic App Store Connect profile and inspect the current app version and latest uploaded build before selecting a build number. The local project proposes version 1.0.5; its App Store Connect availability has not yet been checked.
- Archive and export the current source, verify app and both extension identifiers/privacy manifests, upload once, and confirm Apple processing succeeds before TestFlight distribution.
- Check actual App Privacy declarations against DeepSeek/TypeSafe/OpenAI processing and retention. Prepare a populated database accessible to the reviewer and validate the review instructions. Keep review services accessible throughout review.
- Validate the complete App Store version, then submit the attached processed build. Upload, TestFlight availability, review submission and public release are separate outcomes. No upload or review submission has been performed in this rollout yet.

The local App Store metadata draft is `mobile/ios/Config/AppStoreMetadata.md`; it is not a record of App Store Connect state.
