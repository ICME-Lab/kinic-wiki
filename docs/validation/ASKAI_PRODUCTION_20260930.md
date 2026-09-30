# AskAI production rollout, September 30, 2026

## Applied

The deployed backend source is `c76b9dbd2c1c5a377f3545da0db231fc6338a9bd` on `feat/ios-shared-work-items`.

- Browser Worker `kinic-wiki-browser`: version `9ff8e45f-6d6c-4db7-bd6b-57f8ea35a20e`. Both production domains serve the September 30 policy with DeepSeek disclosure and immediate effect for users accepting the updated consent.
- Wiki canister `6emaw-iyaaa-aaaay-aacka-cai`: upgraded with empty arguments, preserving existing billing configuration. Wasm SHA-256 is `9e5c14bdcff827fa9b8dcc213accf97ad56501bbdb03db50e052ce1c31504c69`. The deployed Candid matches the candidate except for a trailing empty line. The new `get_voice_rate` API responds with `voice billing not configured`, as expected before a rate is configured.
- Assistant D1 `51dcc15a-a8f9-4d00-93d9-5ad8e0684584`: migration `0002_charge_conversation.sql` applied; no pending migrations.
- Assistant Worker `kinic-wiki-assistant`: version `b3c7be01-49e3-4c9a-b89b-6ffc95850d8a`, retaining `ASSISTANT_ENABLED=false`. Required secret names are present. `/api/assistant/native/status` returns HTTP 503 with `assistant_disabled`.

## Verification and recovery

Live Candid compatibility and preservation of the billing configuration passed. The canister is running after upgrade. A pre-upgrade snapshot was saved locally under `.local/mainnet-snapshots/voice-upgrade-20260930.json`; preserve that file. Loading a snapshot would revert subsequent writes and requires a deliberate recovery decision. Do not use reinstall as recovery.

The prior Assistant version is `02bb54cc-15ee-4d80-bba6-3ad9a3314448`; the prior Browser version is `66e0b8e0-23d3-44a7-abde-811d6b86f7cf`. A Worker rollback does not reverse a D1 migration. Migration 0002 adds conversation ownership metadata to cleanup JSON.

Worker typecheck and production deployment dry-run passed. A real DeepSeek `deepseek-flash` request returned HTTP 200 and an answer, using a synthetic question without Wiki content. The independent Jev overview-routing live test passed. iOS app, extensions and test targets passed build-for-testing; nine AskAI authentication/history XCTest cases passed. The unsigned physical-device Release build also passed; it is not an uploadable signed archive. These checks do not establish physical-device authentication, real Wiki retrieval, microphone behavior, provider cleanup or billing acceptance.

## Still required before activation and App Review

- Confirm the TypeSafe account permits production automated processing and configure the operational cleanup/billing notifications described in the Assistant README.
- Complete staging Internet Identity and access-boundary checks, representative question evaluation, and physical-device acceptance. Verify denied access, revocation, cancellation and cleanup.
- Enable production AskAI only after those checks. Voice remains unavailable without an explicitly chosen billing rate and database-owner policy; do not invent pricing for review.
- Resolve an authorized Kinic App Store Connect profile and inspect the current app version and latest uploaded build before selecting a build number. The local project proposes version 1.0.5; its App Store Connect availability has not yet been checked.
- Archive and export the current source, verify app and both extension identifiers/privacy manifests, upload once, and confirm Apple processing succeeds before TestFlight distribution.
- Check actual App Privacy declarations against DeepSeek/TypeSafe/OpenAI processing and retention. Prepare a populated database accessible to the reviewer and validate the review instructions. Keep review services accessible throughout review.
- Validate the complete App Store version, then submit the attached processed build. Upload, TestFlight availability, review submission and public release are separate outcomes. No upload or review submission has been performed in this rollout yet.

The local App Store metadata draft is `mobile/ios/Config/AppStoreMetadata.md`; it is not a record of App Store Connect state.
