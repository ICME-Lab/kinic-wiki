#!/usr/bin/env bash
# Reproducible native crypto bridge: DFINITY ic-vetkeys, no handwritten BLS.
set -euo pipefail
export MACOSX_DEPLOYMENT_TARGET=15.0
export IPHONEOS_DEPLOYMENT_TARGET=18.0
repo_root="$(cd "$(dirname "$0")/../../.." && pwd)"
native_dir="$repo_root/mobile/ios/Native/VaultVetKeys"
artifacts="$repo_root/mobile/ios/Packages/KinicVaultNative/Artifacts"
target_dir="$repo_root/.local/vault-native-target-macos15-ios18"
mkdir -p "$artifacts"
mode="${1:-all}"
[[ "$mode" == all || "$mode" == --macos-only ]] || { echo "usage: $0 [--macos-only]" >&2; exit 2; }
fingerprint="$mode-$(cat "$native_dir/Cargo.toml" "$native_dir/Cargo.lock" "$native_dir/src/lib.rs" "$native_dir/include/VaultVetKeys.h" "$native_dir/include/module.modulemap" "$0" | shasum -a 256 | cut -d' ' -f1)"
if [[ -d "$artifacts/KinicVetKeys.xcframework" && -f "$artifacts/fingerprint" && "$(cat "$artifacts/fingerprint")" == "$fingerprint" ]]; then exit 0; fi
targets=(aarch64-apple-darwin)
if [[ "$mode" == all ]]; then targets+=(aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios); fi
for target in "${targets[@]}"; do
  CARGO_TARGET_DIR="$target_dir" cargo build --locked --manifest-path "$native_dir/Cargo.toml" --release --target "$target"
done
work_dir=$(mktemp -d "$artifacts/.xcframework-XXXXXX")
trap 'rm -rf "$work_dir"' EXIT
args=(-library "$target_dir/aarch64-apple-darwin/release/libkinic_vault_vetkeys.a" -headers "$native_dir/include")
if [[ "$mode" == all ]]; then
  lipo -create "$target_dir/aarch64-apple-ios-sim/release/libkinic_vault_vetkeys.a" "$target_dir/x86_64-apple-ios/release/libkinic_vault_vetkeys.a" -output "$work_dir/libkinic_vault_vetkeys_sim.a"
  args+=(-library "$target_dir/aarch64-apple-ios/release/libkinic_vault_vetkeys.a" -headers "$native_dir/include" -library "$work_dir/libkinic_vault_vetkeys_sim.a" -headers "$native_dir/include")
fi
xcodebuild -create-xcframework "${args[@]}" -output "$work_dir/KinicVetKeys.xcframework"
rm -rf "$artifacts/KinicVetKeys.xcframework"
mv "$work_dir/KinicVetKeys.xcframework" "$artifacts/KinicVetKeys.xcframework"
printf '%s\n' "$fingerprint" > "$artifacts/fingerprint"
