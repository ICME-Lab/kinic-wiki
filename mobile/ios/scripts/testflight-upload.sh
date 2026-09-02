#!/usr/bin/env bash
# Where: mobile/ios/scripts/testflight-upload.sh
# What: Archive, export, and upload KinicWiki to TestFlight from CLI.
# Why: Signing and API upload must remain separate and must not require exporting Keychain API keys.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
env_files=("$repo_root/mobile/ios/.env.local" "$repo_root/mobile/ios/.env.testflight.local")
if [[ -n "${KINIC_IOS_ENV_FILE:-}" ]]; then
  env_files=("$KINIC_IOS_ENV_FILE")
fi
for env_file in "${env_files[@]}"; do
  if [[ -f "$env_file" ]]; then
    set -a
    # shellcheck source=/dev/null
    source "$env_file"
    set +a
  fi
done

project="$repo_root/mobile/ios/Kinic.xcodeproj"
scheme="${KINIC_IOS_SCHEME:-Kinic}"
configuration="${KINIC_IOS_CONFIGURATION:-Release}"
team_id="AKN976G7AK"
bundle_id="xyz.kinic.ios.KinicWiki"
asc_app_id="${ASC_APP_ID:-6785718977}"
build_number="${KINIC_IOS_BUILD_NUMBER:-}"
marketing_version="${KINIC_IOS_MARKETING_VERSION:-0.1.0}"
archive_path_override="${KINIC_IOS_ARCHIVE_PATH:-}"
export_path_override="${KINIC_IOS_EXPORT_PATH:-}"
asc_profile="${ASC_PROFILE:-}"
mode="upload"
distribution="external"
sandbox_mode=0
external_requested=0
print_runtime_config=0

fail() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage:
  ASC_PROFILE=<profile> mobile/ios/scripts/testflight-upload.sh
  ASC_PROFILE=<profile> mobile/ios/scripts/testflight-upload.sh --internal-only
  ASC_PROFILE=<profile> mobile/ios/scripts/testflight-upload.sh --sandbox
  ASC_PROFILE=<profile> mobile/ios/scripts/testflight-upload.sh --validate-only

Environment:
  Required:
    ASC_PROFILE                 Named asc API-key profile stored in macOS Keychain.

  Optional:
    ASC_APP_ID                  App Store Connect app ID. Defaults to Kinic 6785718977.
    KINIC_IOS_BUILD_NUMBER      Explicit build number. Otherwise ASC latest + 1 is used.
    KINIC_IOS_MARKETING_VERSION Defaults to 0.1.0.
    KINIC_IOS_ARCHIVE_PATH      Defaults under mobile/ios/build/TestFlight.
    KINIC_IOS_EXPORT_PATH       Defaults under mobile/ios/build/TestFlight.
    KINIC_IOS_SCHEME            Defaults to Kinic.
    KINIC_IOS_CONFIGURATION     Defaults to Release.
    KINIC_IOS_ENV_FILE          Overrides the default env file loading.

Options:
    --external                  Upload a build that can be assigned to external TestFlight groups. This is the default.
    --internal-only             Upload an internal-only TestFlight build.
    --sandbox                   Use staging services and force an internal-only build.
    --print-runtime-config      Print the selected runtime settings without building.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --validate-only)
      mode="validate-only"
      shift
      ;;
    --external)
      distribution="external"
      external_requested=1
      shift
      ;;
    --internal-only)
      distribution="internal-only"
      shift
      ;;
    --sandbox)
      sandbox_mode=1
      distribution="internal-only"
      shift
      ;;
    --print-runtime-config)
      print_runtime_config=1
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

if [[ "$sandbox_mode" == "1" && "$external_requested" == "1" ]]; then
  fail "Sandbox builds cannot be uploaded for external TestFlight distribution"
fi

runtime_build_settings=(
  KINIC_DEPLOYMENT_ENVIRONMENT=production
  KINIC_CANISTER_ID=6emaw-iyaaa-aaaay-aacka-cai
  KINIC_API_BASE_URL=https://icp0.io
  KINIC_IDENTITY_PROVIDER=https://id.ai/authorize
  KINIC_DERIVATION_ORIGIN=https://6emaw-iyaaa-aaaay-aacka-cai.icp0.io
  KINIC_AUTH_ORIGIN=https://wiki.kinic.xyz
  KINIC_CALLBACK_DOMAIN=wiki.kinic.xyz
  KINIC_ASSOCIATED_DOMAIN=wiki.kinic.xyz
  KINIC_PAYMENT_BASE_URL=https://payment.kinic.xyz
  KINIC_IAP_PRODUCT_IDS=xyz.kinic.dbcredits.small
)
if [[ "$sandbox_mode" == "1" ]]; then
  runtime_build_settings=(
    KINIC_DEPLOYMENT_ENVIRONMENT=sandbox
    KINIC_CANISTER_ID=3ryrw-kyaaa-aaaaf-qgxpq-cai
    KINIC_API_BASE_URL=https://icp0.io
    KINIC_IDENTITY_PROVIDER=https://id.ai/authorize
    KINIC_DERIVATION_ORIGIN=https://3ryrw-kyaaa-aaaaf-qgxpq-cai.icp0.io
    KINIC_AUTH_ORIGIN=https://kinic-wiki-browser-staging.hude.workers.dev
    KINIC_CALLBACK_DOMAIN=kinic-wiki-browser-staging.hude.workers.dev
    KINIC_ASSOCIATED_DOMAIN=kinic-wiki-browser-staging.hude.workers.dev
    KINIC_PAYMENT_BASE_URL=https://kinic-payment-sandbox.hude.workers.dev
    KINIC_IAP_PRODUCT_IDS=xyz.kinic.dbcredits.small
  )
fi

if [[ "$print_runtime_config" == "1" ]]; then
  printf 'distribution=%s\n' "$distribution"
  printf '%s\n' "${runtime_build_settings[@]}"
  exit 0
fi

[[ -n "$asc_profile" ]] || fail "ASC_PROFILE is required"

resolve_next_build_number() {
  local build_json latest
  if ! build_json="$(asc --profile "$asc_profile" builds info \
      --app "$asc_app_id" --latest --platform IOS --output json)"; then
    fail "Could not read the latest App Store Connect build with profile $asc_profile"
  fi
  latest="$(printf '%s' "$build_json" | node -e '
    let input = "";
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => {
      const value = JSON.parse(input);
      const candidate = value?.data?.attributes?.version
        ?? value?.data?.attributes?.buildNumber
        ?? value?.attributes?.version
        ?? value?.version
        ?? value?.buildNumber;
      if (!/^\d+$/.test(String(candidate ?? ""))) process.exit(2);
      process.stdout.write(String(candidate));
    });
  ')" || fail "Could not parse the latest App Store Connect build number"
  printf '%s\n' "$((latest + 1))"
}

if [[ "$sandbox_mode" == "1" || -z "$build_number" ]]; then
  build_number="$(resolve_next_build_number)"
fi

archive_path="${archive_path_override:-$repo_root/mobile/ios/build/TestFlight/KinicWiki-$marketing_version-$build_number.xcarchive}"
export_path="${export_path_override:-$repo_root/mobile/ios/build/TestFlight/export-$marketing_version-$build_number}"

[[ "$build_number" =~ ^[0-9]+$ ]] || fail "KINIC_IOS_BUILD_NUMBER must be numeric"
(( build_number > 1 )) || fail "KINIC_IOS_BUILD_NUMBER must be greater than 1 for TestFlight"
[[ -n "$marketing_version" ]] || fail "KINIC_IOS_MARKETING_VERSION must not be empty"
[[ "$asc_app_id" =~ ^[0-9]+$ ]] || fail "ASC_APP_ID must be numeric"

if [[ "$mode" == "validate-only" ]]; then
  printf 'TestFlight upload inputs validated for %s build %s (%s, %s).\n' \
    "$marketing_version" "$build_number" \
    "$([[ "$sandbox_mode" == "1" ]] && printf sandbox || printf production)" "$distribution"
  exit 0
fi

"$repo_root/mobile/ios/scripts/ensure-xcodegen-project.sh"

export_options="$(mktemp "${TMPDIR:-/tmp}/kinic-testflight-export.XXXXXX.plist")"
trap 'rm -f "$export_options"' EXIT

mkdir -p "$(dirname "$archive_path")" "$export_path"

cat >"$export_options" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>destination</key>
  <string>export</string>
  <key>manageAppVersionAndBuildNumber</key>
  <false/>
  <key>method</key>
  <string>app-store-connect</string>
  <key>signingStyle</key>
  <string>automatic</string>
  <key>teamID</key>
  <string>$team_id</string>
EOF

if [[ "$distribution" == "internal-only" ]]; then
  cat >>"$export_options" <<EOF
  <key>testFlightInternalTestingOnly</key>
  <true/>
EOF
fi

cat >>"$export_options" <<EOF
  <key>uploadSymbols</key>
  <true/>
</dict>
</plist>
EOF

printf 'Archiving %s %s (%s) for App Store Connect (%s)...\n' "$bundle_id" "$marketing_version" "$build_number" "$distribution"
xcodebuild archive \
  -quiet \
  -project "$project" \
  -scheme "$scheme" \
  -configuration "$configuration" \
  -destination "generic/platform=iOS" \
  -archivePath "$archive_path" \
  -allowProvisioningUpdates \
  CURRENT_PROJECT_VERSION="$build_number" \
  MARKETING_VERSION="$marketing_version" \
  "${runtime_build_settings[@]}"

archive_bundle_id="$(plutil -extract ApplicationProperties.CFBundleIdentifier raw -o - "$archive_path/Info.plist")"
archive_version="$(plutil -extract ApplicationProperties.CFBundleShortVersionString raw -o - "$archive_path/Info.plist")"
archive_build="$(plutil -extract ApplicationProperties.CFBundleVersion raw -o - "$archive_path/Info.plist")"
[[ "$archive_bundle_id" == "$bundle_id" ]] || fail "Archive Bundle ID mismatch: $archive_bundle_id"
[[ "$archive_version" == "$marketing_version" ]] || fail "Archive version mismatch: $archive_version"
[[ "$archive_build" == "$build_number" ]] || fail "Archive build mismatch: $archive_build"

app_privacy="$archive_path/Products/Applications/KinicWiki.app/PrivacyInfo.xcprivacy"
extension_privacy="$archive_path/Products/Applications/KinicWiki.app/PlugIns/KinicShareExtension.appex/PrivacyInfo.xcprivacy"
[[ -f "$app_privacy" ]] || fail "PrivacyInfo.xcprivacy missing from app archive"
[[ -f "$extension_privacy" ]] || fail "PrivacyInfo.xcprivacy missing from Share Extension archive"

printf 'Exporting signed IPA...\n'
xcodebuild -exportArchive \
  -quiet \
  -archivePath "$archive_path" \
  -exportPath "$export_path" \
  -exportOptionsPlist "$export_options" \
  -allowProvisioningUpdates

ipa_path="$export_path/KinicWiki.ipa"
[[ -f "$ipa_path" ]] || fail "Exported IPA not found: $ipa_path"

printf 'Uploading verified IPA with asc profile %s...\n' "$asc_profile"
asc --profile "$asc_profile" builds upload \
  --app "$asc_app_id" \
  --ipa "$ipa_path" \
  --version "$marketing_version" \
  --build-number "$build_number" \
  --wait

printf 'Uploaded KinicWiki %s (%s) to TestFlight (%s).\n' "$marketing_version" "$build_number" "$distribution"
