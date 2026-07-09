# Kinic Android

Kotlin / Jetpack Compose app scaffold for Kinic Wiki mobile capture.

`mobile/android` is an independent Android Gradle project. It mirrors the iOS app shape where Android platform support is already clear:

- Receives browser shares through `ShareActivity`.
- Stores pending shared URLs in a file-backed inbox.
- Builds the same `kinic.source_capture_request` markdown node shape used by iOS and `wikibrowser/lib/source-capture.ts`.
- Includes a VFS-specific Candid encoder for source capture writes and trigger-session authorization.
- Includes a Kotlin IC client for signed query/call/read_state envelopes and Internet Identity delegation sessions.
- Provides a Compose app shell for pending captures and manual URL queueing.

## Current gaps

- Browser launch UI for Internet Identity is not wired into the Compose screen yet. Android uses `/android-auth-callback`, so the web bridge must allow that callback before native sign-in can complete end to end.
- Signed IC `queryRaw` / `callRaw` transport exists, but mainnet verification still needs an Android device/browser auth smoke test.
- Native browse/manage screens are not ported yet; only capture-core logic and app entry points exist.

## Runtime defaults

- VFS canister: `6emaw-iyaaa-aaaay-aacka-cai`
- IC gateway: `https://icp0.io`
- Internet Identity: `https://id.ai/#authorize`
- Auth origin: `https://wiki.kinic.xyz`
- Derivation origin: `https://6emaw-iyaaa-aaaay-aacka-cai.icp0.io`

## Verification

Use Android Studio with JDK 17, or a local Gradle install:

```bash
cd mobile/android
gradle testDebugUnitTest
gradle assembleDebug
```

This repository worktree currently has no Gradle installation, so command-line verification depends on Android Studio or Gradle being installed locally.
