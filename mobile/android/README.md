# Kinic Android

`mobile/android` is the Kotlin / Jetpack Compose KinicWiki app. It follows the iOS
Home / Browse / Ask AI / Manage structure and supports:

- Direct ICRC-167 Internet Identity login through `/native-auth-callback`, encrypted session restore, and signed IC query/call/read_state requests.
- Member, public, purchased, and direct-ID Browse with folder navigation, search, Markdown/raw display, and app links.
- Source Capture from Android shares or manually entered URLs, retryable queue/history, and generated-document navigation.
- Grounded Ask AI conversations with evidence and source-document navigation.
- Database creation, metadata, members, cycles billing/history, funding, and guarded deletion.

IC read-state certificates and query signatures are decoded but not cryptographically
verified. This matches the current iOS implementation and remains a separate hardening task.

## Runtime defaults

- VFS canister: `6emaw-iyaaa-aaaay-aacka-cai`
- IC gateway: `https://icp0.io`
- Internet Identity: `https://id.ai/authorize`
- Auth origin: `https://wiki.kinic.xyz`
- Derivation origin: `https://6emaw-iyaaa-aaaay-aacka-cai.icp0.io`

## Development verification

The project uses the checked-in Gradle 9.4.1 wrapper. Install JDK 17 and Android
SDK Platform 37 with Build Tools 36.0.0, then run:

```bash
cd mobile/android
./gradlew testDebugUnitTest assembleDebug lintDebug connectedDebugAndroidTest
```

`connectedDebugAndroidTest` requires a running Android device or emulator. CI uses an
API 35 emulator.

## Play release bundle

Play App Signing uses separate upload and app-signing certificates. The environment
variables below configure the upload key used to sign the AAB. Keep the keystore
outside this repository.

Set `KINIC_ANDROID_VERSION_CODE` to the latest Play Console version code plus one:

```bash
export KINIC_ANDROID_VERSION_CODE=<next-version-code>
export KINIC_ANDROID_UPLOAD_STORE_FILE=/absolute/path/to/upload-key.jks
export KINIC_ANDROID_UPLOAD_STORE_PASSWORD=<store-password>
export KINIC_ANDROID_UPLOAD_KEY_ALIAS=<key-alias>
export KINIC_ANDROID_UPLOAD_KEY_PASSWORD=<key-password>

./gradlew bundleRelease
```

The bundle is written to `app/build/outputs/bundle/release/app-release.aab`.
`bundleRelease` stops before compilation when a required value is absent or the
keystore path does not exist. Upload this AAB manually to the Play internal testing
track, then install it from the internal-testing opt-in page. Do not use the upload
certificate fingerprint in `assetlinks.json`.

## Production App Links

Copy the SHA-256 fingerprint of the **App signing key certificate** from Play Console.
Configure it as the Cloudflare build variable and use the same value for deployment:

```bash
cd ../../wikibrowser
export KINIC_ANDROID_APP_LINK_SHA256_CERT_FINGERPRINT=<Play-App-Signing-SHA-256-fingerprint>
pnpm deploy:production
pnpm smoke:android-app-links
```

After installing the Play internal-testing build, force Android to recheck the domain:

```bash
adb shell pm verify-app-links --re-verify xyz.kinic.android.kinicwiki
adb shell pm get-app-links xyz.kinic.android.kinicwiki
```

The result must show `wiki.kinic.xyz: verified`.

## Mainnet smoke checklist

Use a Play-signed internal-testing build and complete these checks on a physical
Android device:

1. Sign in with Internet Identity, receive the Android callback, force-stop the app,
   reopen it, and confirm the same principal and signed database list are restored.
2. Browse member, public, purchased, and direct-ID databases; test folder navigation,
   search, Markdown/raw display, and a missing document's parent fallback.
3. Share a URL from Chrome and enqueue a manually entered URL. Confirm direct/queued
   submission, worker trigger, history refresh/retry, and generated document opening.
4. Ask a grounded question, inspect evidence, open a source, restart the app, and
   verify conversation history. Test conversation deletion and database switching.
5. Exercise non-destructive Manage actions on the development database. For create
   and delete, use only `android-smoke-<timestamp>` and verify the returned database ID
   before deletion.
