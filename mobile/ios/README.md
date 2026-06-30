# Kinic iOS

SwiftUI app and Share Extension scaffold for Kinic Wiki mobile capture.

## Current scope

- Uses `humandebri/ICNativeClient` through Swift Package Manager.
- Includes AppIcon assets generated from the existing Kinic mark.
- Includes `PrivacyInfo.xcprivacy` for app group `UserDefaults` usage.
- Opens Internet Identity through the `/native-auth` bridge model.
- Receives Safari/browser Share Sheet URLs through `KinicShareExtension`.
- Stores shared URLs in the App Group inbox, opens the main app, and auto-submits when signed in.
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

Set the web deployment environment:

- `KINIC_IOS_APP_ID = AKN976G7AK.xyz.kinic.ios.KinicWiki`

The AASA route returns `503` until `KINIC_IOS_APP_ID` is configured, to avoid caching a bad Apple association document.

Enable these capabilities:

- App Groups for both targets:
  - `group.xyz.kinic.ios.KinicWiki`
- Associated Domains on the app target:
  - `applinks:$(KINIC_CALLBACK_DOMAIN)`
  - `webcredentials:$(KINIC_CALLBACK_DOMAIN)`

## Verification

- `xcodebuild build -project mobile/ios/Kinic.xcodeproj -scheme Kinic -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO`
- `xcodebuild build-for-testing -project mobile/ios/Kinic.xcodeproj -scheme Kinic -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO`
- `xcodebuild build -project mobile/ios/Kinic.xcodeproj -scheme Kinic -destination 'generic/platform=iOS' -allowProvisioningUpdates`
- `pnpm --dir wikibrowser test`
- `pnpm --dir wikibrowser typecheck`

`xcodebuild test` requires a working CoreSimulatorService. If simulator services are down, use `build-for-testing` plus a real-device smoke test.
