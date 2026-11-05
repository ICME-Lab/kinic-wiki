# Conversation export behavior verification

Verified on 2026-11-05. No private conversations were exported and no production generation requests were submitted.

| Artifact | Version | What was verified |
| --- | --- | --- |
| Existing local release ZIP | 0.1.8 | Static inspection: `saveSource` saves evidence and then calls `trigger-source-generation`; offscreen submits to `/api/source/run`. |
| Installed browser extension | Unverified | Browser Use rejected `chrome://extensions` because only HTTP/HTTPS protocols are allowed. No browser-profile or alternate-surface workaround was attempted. |
| Chrome Web Store release | Unverified | Opening the public store listing through Browser Use returned `Not allowed`. Store package and version were not retrieved or equated with the local ZIP. |
| Current source / newly built extension | Development build | Tests and bundle inspection confirm conversation exports request generation after saving. Separate generation-folder settings are added by this change. This build has not been published. |

Existing ZIP inspected at `extensions/wiki-clipper/release/kinic-wiki-clipper-0.1.8.zip` in the original checkout; not overwritten during this verification. SHA-256: `9c28ceeb804a54febf112f79ea01aa90b9dde9b4431d71aa805aac163d593565`.

The old README claim that conversation exports only save evidence is inconsistent with that ZIP and the current implementation. The README, usage guide, and listing copy now describe source saving followed by a generation request. Queue acceptance is not completion; a failed trigger can leave an already-saved source.

Before publishing: independently confirm the installed/store version and inspect that release's package. Deploy the generator Worker, then WikiBrowser API, then publish the extension so optional `targetRoot` is understood throughout the pipeline. No deployment or store submission was performed here.
