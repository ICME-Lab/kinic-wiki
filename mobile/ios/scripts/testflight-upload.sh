#!/usr/bin/env bash
# Where: mobile/ios/scripts/testflight-upload.sh
# What: Archive KinicWikiApp and upload it to TestFlight from CLI.
# Why: TestFlight submissions need a repeatable production build path without editing Xcode project files.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
project="$repo_root/mobile/ios/Kinic.xcodeproj"
scheme="${KINIC_IOS_SCHEME:-Kinic}"
configuration="${KINIC_IOS_CONFIGURATION:-Release}"
team_id="AKN976G7AK"
bundle_id="xyz.kinic.ios.KinicWiki"
build_number="${KINIC_IOS_BUILD_NUMBER:-}"
marketing_version="${KINIC_IOS_MARKETING_VERSION:-0.1.0}"
archive_path="${KINIC_IOS_ARCHIVE_PATH:-$repo_root/mobile/ios/build/TestFlight/KinicWikiApp-$marketing_version-$build_number.xcarchive}"
export_path="${KINIC_IOS_EXPORT_PATH:-$repo_root/mobile/ios/build/TestFlight/export-$marketing_version-$build_number}"
asc_key_path="${ASC_KEY_PATH:-}"
asc_key_id="${ASC_KEY_ID:-}"
asc_issuer_id="${ASC_ISSUER_ID:-}"
mode="upload"

fail() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage:
  KINIC_IOS_BUILD_NUMBER=<number> ASC_KEY_PATH=<AuthKey_XXX.p8> ASC_KEY_ID=<key-id> ASC_ISSUER_ID=<issuer-id> mobile/ios/scripts/testflight-upload.sh
  mobile/ios/scripts/testflight-upload.sh --validate-only

Environment:
  Required:
    KINIC_IOS_BUILD_NUMBER      App Store Connect build number. Must be numeric and greater than 1.
    ASC_KEY_PATH                App Store Connect API private key path.
    ASC_KEY_ID                  App Store Connect API key id.
    ASC_ISSUER_ID               App Store Connect issuer id.

  Optional:
    KINIC_IOS_MARKETING_VERSION Defaults to 0.1.0.
    KINIC_IOS_ARCHIVE_PATH      Defaults under mobile/ios/build/TestFlight.
    KINIC_IOS_EXPORT_PATH       Defaults under mobile/ios/build/TestFlight.
    KINIC_IOS_SCHEME            Defaults to Kinic.
    KINIC_IOS_CONFIGURATION     Defaults to Release.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --validate-only)
      mode="validate-only"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "unknown argument: $1"
      ;;
  esac
done

[[ -n "$build_number" ]] || fail "KINIC_IOS_BUILD_NUMBER is required"
[[ "$build_number" =~ ^[0-9]+$ ]] || fail "KINIC_IOS_BUILD_NUMBER must be numeric"
(( build_number > 1 )) || fail "KINIC_IOS_BUILD_NUMBER must be greater than 1 for TestFlight"
[[ -n "$marketing_version" ]] || fail "KINIC_IOS_MARKETING_VERSION must not be empty"
[[ -n "$asc_key_path" ]] || fail "ASC_KEY_PATH is required"
[[ -f "$asc_key_path" ]] || fail "ASC_KEY_PATH does not exist: $asc_key_path"
[[ -n "$asc_key_id" ]] || fail "ASC_KEY_ID is required"
[[ -n "$asc_issuer_id" ]] || fail "ASC_ISSUER_ID is required"

if [[ "$mode" == "validate-only" ]]; then
  printf 'TestFlight upload inputs validated for %s build %s.\n' "$marketing_version" "$build_number"
  exit 0
fi

export_options="$(mktemp "${TMPDIR:-/tmp}/kinic-testflight-export.XXXXXX.plist")"
trap 'rm -f "$export_options"' EXIT

mkdir -p "$(dirname "$archive_path")" "$export_path"

cat >"$export_options" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>destination</key>
  <string>upload</string>
  <key>manageAppVersionAndBuildNumber</key>
  <false/>
  <key>method</key>
  <string>app-store-connect</string>
  <key>signingStyle</key>
  <string>automatic</string>
  <key>teamID</key>
  <string>$team_id</string>
  <key>testFlightInternalTestingOnly</key>
  <true/>
  <key>uploadSymbols</key>
  <true/>
</dict>
</plist>
EOF

printf 'Archiving %s %s (%s) for App Store Connect...\n' "$bundle_id" "$marketing_version" "$build_number"
xcodebuild archive \
  -project "$project" \
  -scheme "$scheme" \
  -configuration "$configuration" \
  -destination "generic/platform=iOS" \
  -archivePath "$archive_path" \
  -allowProvisioningUpdates \
  -authenticationKeyPath "$asc_key_path" \
  -authenticationKeyID "$asc_key_id" \
  -authenticationKeyIssuerID "$asc_issuer_id" \
  CURRENT_PROJECT_VERSION="$build_number" \
  MARKETING_VERSION="$marketing_version" \
  KINIC_CANISTER_ID="6emaw-iyaaa-aaaay-aacka-cai" \
  KINIC_API_BASE_URL="https://icp0.io" \
  KINIC_IDENTITY_PROVIDER="https://id.ai/#authorize" \
  KINIC_DERIVATION_ORIGIN="https://6emaw-iyaaa-aaaay-aacka-cai.icp0.io" \
  KINIC_AUTH_ORIGIN="https://wiki.kinic.xyz" \
  KINIC_CALLBACK_DOMAIN="wiki.kinic.xyz" \
  KINIC_ASSOCIATED_DOMAIN="wiki.kinic.xyz"

app_privacy="$archive_path/Products/Applications/KinicWikiApp.app/PrivacyInfo.xcprivacy"
extension_privacy="$archive_path/Products/Applications/KinicWikiApp.app/PlugIns/KinicShareExtension.appex/PrivacyInfo.xcprivacy"
[[ -f "$app_privacy" ]] || fail "PrivacyInfo.xcprivacy missing from app archive"
[[ -f "$extension_privacy" ]] || fail "PrivacyInfo.xcprivacy missing from Share Extension archive"

printf 'Uploading archive to TestFlight...\n'
xcodebuild -exportArchive \
  -archivePath "$archive_path" \
  -exportPath "$export_path" \
  -exportOptionsPlist "$export_options" \
  -allowProvisioningUpdates \
  -authenticationKeyPath "$asc_key_path" \
  -authenticationKeyID "$asc_key_id" \
  -authenticationKeyIssuerID "$asc_issuer_id"

printf 'Uploaded KinicWikiApp %s (%s) to TestFlight.\n' "$marketing_version" "$build_number"
