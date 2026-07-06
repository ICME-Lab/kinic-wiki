# Kinic iOS

SwiftUI app and Share Extension scaffold for Kinic Wiki mobile capture.

## Current scope

- Uses `humandebri/ICNativeClient` through Swift Package Manager.
- Includes AppIcon assets generated from the existing Kinic mark.
- Includes `PrivacyInfo.xcprivacy` for app group `UserDefaults` usage.
- Opens Internet Identity through the `/native-auth` bridge model.
- Receives Safari/browser Share Sheet URLs through `KinicShareExtension`.
- Submits shared URLs directly from `KinicShareExtension` when a shared Keychain session and selected database are available.
- Stores shared URLs in the App Group inbox for later app-side auto-submit when immediate Share Extension submission is unavailable.
- Lists writable VFS databases and filters to `Owner` / `Writer` roles.
- Builds the same `kinic.source_capture_request` markdown shape used by `wikibrowser/lib/source-capture.ts`.
- Writes `/Sources/source-capture-requests/...` through a VFS-specific Candid codec, then triggers the source-capture worker through `https://wiki.kinic.xyz/api/source-capture/trigger`.

## Required App Store / Apple settings

Configured Apple identifiers:

- `DEVELOPMENT_TEAM = AKN976G7AK`
- `APP_GROUP_ID = group.xyz.kinic.ios.KinicWiki`
- Developer ID: `bdc34275-05a0-48b2-b4ab-fd82026d4b3a`

The Bundle IDs are fixed to the App Store records:

- `KINIC_APP_BUNDLE_ID = xyz.kinic.ios.KinicWiki`
- `KINIC_SHARE_EXTENSION_BUNDLE_ID = xyz.kinic.ios.KinicWiki.ShareExtension`

The production AASA document is a static JSON file at `wikibrowser/public/.well-known/apple-app-site-association`.
It uses the fixed App ID `AKN976G7AK.xyz.kinic.ios.KinicWiki`.

Enable these capabilities:

- App Groups for both targets:
  - `group.xyz.kinic.ios.KinicWiki`
- Keychain Sharing for both targets:
  - `AKN976G7AK.xyz.kinic.ios.KinicWiki`
- Associated Domains on the app target:
  - `applinks:$(KINIC_CALLBACK_DOMAIN)`
  - `webcredentials:$(KINIC_CALLBACK_DOMAIN)`

Share Extension capture is best-effort: it writes directly through VFS and triggers the source-capture worker when possible. If request creation fails, it queues the URL for app-side submission. If worker trigger fails after the request is saved, it shows an error and keeps a pending trigger for app-side retry. Internet Identity login depends on `https://wiki.kinic.xyz/.well-known/apple-app-site-association` serving the static `applinks` / `webcredentials` document for `AKN976G7AK.xyz.kinic.ios.KinicWiki` and the `/ios-auth-callback` route.

The Share Extension intentionally supports URL shares only. WebPage shares are not enabled until JavaScript preprocessing and property-list URL extraction are implemented.

## Runtime target

iOS local tunnel execution is not supported. Real-device and TestFlight checks use the mainnet configuration in `mobile/ios/Config/Kinic.xcconfig`: canister `6emaw-iyaaa-aaaay-aacka-cai`, IC gateway `https://icp0.io`, Internet Identity `https://id.ai/#authorize`, and callback domain `wiki.kinic.xyz`.

## Verification

- `xcodebuild build -project mobile/ios/Kinic.xcodeproj -scheme Kinic -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO`
- `xcodebuild build-for-testing -project mobile/ios/Kinic.xcodeproj -scheme Kinic -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO`
- `xcodebuild build -project mobile/ios/Kinic.xcodeproj -scheme Kinic -destination 'generic/platform=iOS' -allowProvisioningUpdates`
- `mobile/ios/scripts/install-device.sh`
- `mobile/ios/scripts/testflight-upload.sh --validate-only`
- `pnpm --dir wikibrowser test`
- `pnpm --dir wikibrowser typecheck`

`xcodebuild test` requires a working CoreSimulatorService. If simulator services are down, use `build-for-testing` plus a real-device smoke test.

`mobile/ios/scripts/install-device.sh` builds `KinicWikiApp` for the first connected iPhone reported by Xcode, then installs it with `devicectl`. If device discovery or install stalls, unlock the iPhone, keep the screen awake, trust this Mac, reconnect USB, then retry. Set `KINIC_IOS_DEVICE_ID=<udid>` to pin a specific device.

## TestFlight

TestFlight uploads use production defaults from `mobile/ios/Config/Kinic.xcconfig`: mainnet canister `6emaw-iyaaa-aaaay-aacka-cai`, IC gateway `https://icp0.io`, Internet Identity `https://id.ai/#authorize`, and callback domain `wiki.kinic.xyz`.
The upload script overrides `CURRENT_PROJECT_VERSION` from `KINIC_IOS_BUILD_NUMBER` and does not edit the Xcode project.

Validate inputs without archiving:

```bash
KINIC_IOS_BUILD_NUMBER=<next-build-number> \
ASC_KEY_PATH=/path/to/AuthKey_<key-id>.p8 \
ASC_KEY_ID=<key-id> \
ASC_ISSUER_ID=<issuer-id> \
mobile/ios/scripts/testflight-upload.sh --validate-only
```

Upload an internal TestFlight build:

```bash
KINIC_IOS_BUILD_NUMBER=<next-build-number> \
ASC_KEY_PATH=/path/to/AuthKey_<key-id>.p8 \
ASC_KEY_ID=<key-id> \
ASC_ISSUER_ID=<issuer-id> \
mobile/ios/scripts/testflight-upload.sh
```

Before upload, confirm `https://wiki.kinic.xyz/.well-known/apple-app-site-association` is 200 and includes `AKN976G7AK.xyz.kinic.ios.KinicWiki`. The app target must keep `applinks:wiki.kinic.xyz` and `webcredentials:wiki.kinic.xyz` through `KINIC_CALLBACK_DOMAIN`.
The script fails before upload if either the app archive or Share Extension archive lacks `PrivacyInfo.xcprivacy`.
