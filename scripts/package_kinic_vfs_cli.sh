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
if [[ "$("$BINARY" --version)" != "kinic-vfs-cli ${VERSION#v}" ]]; then
  echo "binary version does not match release $VERSION" >&2
  exit 1
fi
case "$PLATFORM" in
  linux-x86_64|macos-arm64) ;;
  *) echo "unsupported release platform: $PLATFORM" >&2; exit 1 ;;
esac

# Normalize timestamps, owner and modes so retries package identical inputs identically.
python3 - "$VERSION" "$PLATFORM" "$BINARY" "$OUT_DIR" <<'PYTHON'
import gzip
import hashlib
import sys
import tarfile
from pathlib import Path
version, platform, binary, output = sys.argv[1:]
output = Path(output)
output.mkdir(parents=True, exist_ok=True)
name = f'kinic-vfs-cli-{version}-{platform}'
archive = output / f'{name}.tar.gz'
with archive.open('wb') as raw, gzip.GzipFile(filename='', mode='wb', fileobj=raw, mtime=0) as compressed:
    with tarfile.open(fileobj=compressed, mode='w', format=tarfile.USTAR_FORMAT) as tar:
        for source, member, mode in [(binary, 'kinic-vfs-cli', 0o755), ('README.md', 'README.md', 0o644), ('LICENSE', 'LICENSE', 0o644)]:
            info = tarfile.TarInfo(member)
            info.size = Path(source).stat().st_size
            info.mode = mode
            with open(source, 'rb') as data:
                tar.addfile(info, data)
with archive.open('rb') as data:
    digest = hashlib.file_digest(data, 'sha256').hexdigest()
(output / f'{name}.sha256').write_text(f'{digest}  {archive.name}\n')
print(archive)
PYTHON
