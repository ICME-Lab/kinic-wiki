# Release

`kinic-vfs-cli` is published as the single operator binary for database setup, scripted writes, and Skill Registry maintenance. The Browser remains the primary public UI.

Primary distribution is npm. The npm package downloads GitHub Release assets and verifies SHA-256 checksums. Cargo install is a Rust-user fallback; crates.io publication is deferred.

## Breaking Changes

- Archive/restore APIs and CLI commands remain removed. Upgrade deploy preflight rejects legacy `archiving`, `archived`, and `restoring` database rows.
- Source nodes no longer require canonical `/Sources/<provider>/<id>.md` paths. Safe `/Sources/...` paths are accepted, and URL capture writes immutable suffixed paths on collision.

## npm

Install:

```bash
npm install -g kinic-vfs-cli
kinic-vfs-cli --help
```

The npm package supports:

- macOS arm64
- Linux x64

Publish after the matching GitHub Release assets exist:

```bash
npm --prefix npm/kinic-vfs-cli test
cd npm/kinic-vfs-cli
npm pack --dry-run
```

Then run the `Publish npm CLI` workflow from the exact release tag `v${package.version}`. It refuses branch runs, checks Cargo/npm version alignment, checks release asset and checksum names, runs package tests, dry-runs packing, installs the packed package into a temporary prefix, verifies `kinic-vfs-cli --version`, then publishes with `NPM_TOKEN`.
Configure GitHub Environment approval for the publish workflow when release approval must be explicit.
Use an npm automation token scoped to this package; keep 2FA/provenance policy in the npm organization settings.

## Local Build

```bash
cargo build -p kinic-vfs-cli --bin kinic-vfs-cli --release
target/release/kinic-vfs-cli --help
```

Use the binary with the same flags documented in [`CLI.md`](CLI.md):

```bash
target/release/kinic-vfs-cli --canister-id <canister-id> database current
```

## GitHub Release

Tag a release with a `v*` version:

```bash
git tag v0.1.4
git push origin v0.1.4
```

The `Release CLI` workflow builds and uploads:

- `kinic-vfs-cli-v0.1.4-linux-x86_64.tar.gz`
- `kinic-vfs-cli-v0.1.4-linux-x86_64.sha256`
- `kinic-vfs-cli-v0.1.4-macos-arm64.tar.gz`
- `kinic-vfs-cli-v0.1.4-macos-arm64.sha256`

Each tarball contains only:

- `kinic-vfs-cli`
- `README.md`
- `LICENSE`

Verify after download:

```bash
shasum -a 256 -c kinic-vfs-cli-v0.1.4-macos-arm64.sha256
tar -xzf kinic-vfs-cli-v0.1.4-macos-arm64.tar.gz
./kinic-vfs-cli --help
./kinic-vfs-cli --version
```

## CI Artifacts

The normal `cli-artifacts` CI job uses the same tarball layout as the release workflow, but uploads workflow artifacts instead of creating a GitHub Release.
Keep distribution-only changes separate from Skill Registry lifecycle changes when possible; mixed release and job lifecycle diffs are harder to review and bisect.

No `wiki-cli` or `skill-cli` artifact is produced in v1.

## Cargo Fallback

Rust users can install from GitHub when they accept a local Cargo build:

```bash
cargo install --git https://github.com/ICME-Lab/kinic-wiki.git --package kinic-vfs-cli --bin kinic-vfs-cli --locked
kinic-vfs-cli --help
```

crates.io publication is deferred. If needed later, publish in this order:

```text
kinic-vfs-types
kinic-vfs-client
kinic-wiki-domain
kinic-vfs-cli-core
kinic-vfs-cli
```

## Limits

- Artifacts include SHA-256 checksums.
- Artifacts are not signed in v1.
- macOS artifacts are not notarized in v1.
- npm supports macOS arm64 and Linux x64 in v1.
- crates.io publication is deferred.
- Browser deployments are built separately from `wikibrowser/`.
