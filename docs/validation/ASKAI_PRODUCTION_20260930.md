# AskAI production rollout, September 30, 2026

## Applied

The canister and Browser source is `c76b9dbd2c1c5a377f3545da0db231fc6338a9bd` on `feat/ios-shared-work-items`. The final Assistant source is `408aff4f537d3afce3f04dffb00fa8c2b98a80ba`.

- Browser Worker `kinic-wiki-browser`: version `9ff8e45f-6d6c-4db7-bd6b-57f8ea35a20e`. Both production domains serve the September 30 policy with DeepSeek disclosure and immediate effect for users accepting the updated consent.
- Wiki canister `6emaw-iyaaa-aaaay-aacka-cai`: upgraded with empty arguments, preserving existing billing configuration. Wasm SHA-256 is `9e5c14bdcff827fa9b8dcc213accf97ad56501bbdb03db50e052ce1c31504c69`. The deployed Candid matches the candidate except for a trailing empty line. The new `get_voice_rate` API responds with `voice billing not configured`, as expected before a rate is configured.
- Assistant D1 `51dcc15a-a8f9-4d00-93d9-5ad8e0684584`: migration `0002_charge_conversation.sql` applied; no pending migrations.
- Assistant Worker `kinic-wiki-assistant`: version `5ae30c2e-9b53-4ab4-a89a-912d9d8419ea`, retaining `ASSISTANT_ENABLED=false`. Required secret names are present. `/api/assistant/native/status` returns HTTP 503 with `assistant_disabled`. This includes the route-specific tool selection fix found by the live DeepSeek test.

## Verification and recovery

Live Candid compatibility and preservation of the billing configuration passed. The canister is running after upgrade. A pre-upgrade snapshot was saved locally under `.local/mainnet-snapshots/voice-upgrade-20260930.json`; preserve that file. Loading a snapshot would revert subsequent writes and requires a deliberate recovery decision. Do not use reinstall as recovery.

The prior Assistant version is `02bb54cc-15ee-4d80-bba6-3ad9a3314448`; the prior Browser version is `66e0b8e0-23d3-44a7-abde-811d6b86f7cf`. A Worker rollback does not reverse a D1 migration. Migration 0002 adds conversation ownership metadata to cleanup JSON.

Worker typecheck and production deployment dry-run passed. A real DeepSeek `deepseek-flash` request returned HTTP 200 and an answer, using a synthetic question without Wiki content. The independent Jev overview-routing live test passed. iOS app, extensions and test targets passed build-for-testing; nine AskAI authentication/history XCTest cases passed. The unsigned physical-device Release build also passed; it is not an uploadable signed archive. These checks do not establish physical-device authentication, real Wiki retrieval, microphone behavior, provider cleanup or billing acceptance.

The native DeepSeek synthetic overview initially failed with `tool_not_allowed`: a database overview advertised `wiki_query` despite the reader rejecting it for that route. The Assistant now advertises only route-permitted tools. The same live test then passed its Japanese answer, expected facts and exact citation checks. The updated Worker passed 140 unit, 30 runtime and two Node tests.

The current iOS build from `a232a214` was signed with the existing development identity and installed on the connected iPhone 15, Bundle ID `xyz.kinic.ios.KinicWiki`. This is a development install, not TestFlight distribution. No App Store Connect profile has been selected: `asc 5.8.0` is installed, and existing Keychain profiles `TAGGR` and `DreamVault` require identification of the Kinic-authorized profile before use.

The full 20-case OpenAI evaluation was started and remains pending at the time of this record. Its output is local at `/private/tmp/kinic-assistant-live-eval-20260930.log`; inspect its final result before claiming it passed. The separate native DeepSeek overview and Jev routing checks described above have completed successfully.

## Still required before activation and App Review

- Confirm the TypeSafe account permits production automated processing and configure the operational cleanup/billing notifications described in the Assistant README.
- Complete staging Internet Identity and access-boundary checks, representative question evaluation, and physical-device acceptance. Verify denied access, revocation, cancellation and cleanup.
- Enable production AskAI only after those checks. Voice remains unavailable without an explicitly chosen billing rate and database-owner policy; do not invent pricing for review.
- Resolve an authorized Kinic App Store Connect profile and inspect the current app version and latest uploaded build before selecting a build number. The local project proposes version 1.0.5; its App Store Connect availability has not yet been checked.
- Archive and export the current source, verify app and both extension identifiers/privacy manifests, upload once, and confirm Apple processing succeeds before TestFlight distribution.
- Check actual App Privacy declarations against DeepSeek/TypeSafe/OpenAI processing and retention. Prepare a populated database accessible to the reviewer and validate the review instructions. Keep review services accessible throughout review.
- Validate the complete App Store version, then submit the attached processed build. Upload, TestFlight availability, review submission and public release are separate outcomes. No upload or review submission has been performed in this rollout yet.

The local App Store metadata draft is `mobile/ios/Config/AppStoreMetadata.md`; it is not a record of App Store Connect state.
