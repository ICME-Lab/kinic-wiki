#!/usr/bin/env bash
# Where: mobile/ios/scripts/ensure-xcodegen-project.sh
# What: Generate Kinic.xcodeproj from the checked-in XcodeGen spec.
# Why: project.yml is the source of truth; pbxproj churn should stay out of Git.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
ios_dir="$repo_root/mobile/ios"
spec="$ios_dir/project.yml"
project="$ios_dir/Kinic.xcodeproj"
package_resolved="$ios_dir/Package.resolved"

fail() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

command -v xcodegen >/dev/null 2>&1 || fail "xcodegen is required. Install with: brew install xcodegen"
[[ -f "$spec" ]] || fail "XcodeGen spec not found: $spec"

xcodegen --spec "$spec" --project "$ios_dir" --quiet

[[ -f "$project/project.pbxproj" ]] || fail "Xcode project generation failed: $project"

if [[ -f "$package_resolved" ]]; then
  resolved_dir="$project/project.xcworkspace/xcshareddata/swiftpm"
  mkdir -p "$resolved_dir"
  cp "$package_resolved" "$resolved_dir/Package.resolved"
fi
