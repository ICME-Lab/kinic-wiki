#!/usr/bin/env bash
# Where: mobile/ios/scripts/install-device.sh
# What: Build and install KinicWiki on a connected iPhone from CLI.
# Why: Xcode GUI can recover device state, but repeatable real-device updates need one command.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
project="$repo_root/mobile/ios/Kinic.xcodeproj"
scheme="${KINIC_IOS_SCHEME:-Kinic}"
derived_data="${KINIC_IOS_DERIVED_DATA:-/tmp/kinic-ios-device-build}"
device_id="${KINIC_IOS_DEVICE_ID:-}"
install_timeout="${KINIC_IOS_INSTALL_TIMEOUT:-180}"
sandbox_mode=0
print_config=0
build_args=()

fail() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --sandbox)
      sandbox_mode=1
      shift
      ;;
    --print-runtime-config)
      print_config=1
      shift
      ;;
    *)
      build_args+=("$1")
      shift
      ;;
  esac
done

sandbox_build_settings=()
if [[ "$sandbox_mode" == "1" ]]; then
  sandbox_build_settings=(
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

if [[ "$print_config" == "1" ]]; then
  printf '%s\n' "${sandbox_build_settings[@]}"
  exit 0
fi

"$repo_root/mobile/ios/scripts/ensure-xcodegen-project.sh"

run_with_timeout() {
  local seconds="$1"
  shift
  "$@" &
  local command_pid="$!"
  (
    sleep "$seconds"
    if kill -0 "$command_pid" 2>/dev/null; then
      kill "$command_pid" 2>/dev/null || true
    fi
  ) &
  local watchdog_pid="$!"
  local status=0
  wait "$command_pid" || status="$?"
  kill "$watchdog_pid" 2>/dev/null || true
  wait "$watchdog_pid" 2>/dev/null || true
  return "$status"
}

discover_device_id() {
  xcodebuild -project "$project" -scheme "$scheme" -showdestinations \
    | sed -nE 's/.*platform:iOS, arch:[^,]+, id:([^,]+), name:.*/\1/p' \
    | head -n 1
}

if [[ -z "$device_id" ]]; then
  device_id="$(discover_device_id)"
fi

[[ -n "$device_id" ]] || fail "No connected iPhone found. Unlock the iPhone, trust this Mac, connect USB, then retry."

app_path="$derived_data/Build/Products/Debug-iphoneos/KinicWiki.app"

printf 'Building %s for device %s (%s)...\n' "$scheme" "$device_id" "$([[ "$sandbox_mode" == "1" ]] && printf sandbox || printf production)"
xcodebuild build \
  -project "$project" \
  -scheme "$scheme" \
  -destination "platform=iOS,id=$device_id" \
  -derivedDataPath "$derived_data" \
  "${sandbox_build_settings[@]}" \
  "${build_args[@]}"

[[ -d "$app_path" ]] || fail "Built app not found: $app_path"

printf 'Installing %s...\n' "$app_path"
run_with_timeout "$install_timeout" xcrun devicectl device install app --device "$device_id" "$app_path" \
  || fail "devicectl install failed. Unlock iPhone, keep the screen awake, re-plug USB, then rerun KINIC_IOS_DEVICE_ID=$device_id mobile/ios/scripts/install-device.sh"

printf 'Installed KinicWiki on %s.\n' "$device_id"
