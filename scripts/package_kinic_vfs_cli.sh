#!/usr/bin/env bash
set -euo pipefail

VERSION="${1:?usage: scripts/package_kinic_vfs_cli.sh <version> <platform> [binary] [out-dir]}"
PLATFORM="${2:?usage: scripts/package_kinic_vfs_cli.sh <version> <platform> [binary] [out-dir]}"
BINARY="${3:-target/release/kinic-vfs-cli}"
OUT_DIR="${4:-dist}"

if [[ ! -x "$BINARY" ]]; then
  echo "missing executable binary: $BINARY" >&2
  exit 1
fi

mkdir -p "$OUT_DIR"
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/kinic-vfs-cli.XXXXXX")"
trap 'rm -rf "$WORK_DIR"' EXIT

PACKAGE_DIR="$WORK_DIR/kinic-vfs-cli"
mkdir -p "$PACKAGE_DIR"
cp "$BINARY" "$PACKAGE_DIR/kinic-vfs-cli"
cp README.md "$PACKAGE_DIR/README.md"
cp LICENSE "$PACKAGE_DIR/LICENSE"

ASSET="kinic-vfs-cli-${VERSION}-${PLATFORM}.tar.gz"
tar -C "$PACKAGE_DIR" -czf "$OUT_DIR/$ASSET" kinic-vfs-cli README.md LICENSE
(cd "$OUT_DIR" && shasum -a 256 "$ASSET" > "${ASSET%.tar.gz}.sha256")

echo "$OUT_DIR/$ASSET"
