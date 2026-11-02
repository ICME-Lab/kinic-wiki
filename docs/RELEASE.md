# Release

`kinic-vfs-cli` is published as the single operator binary for database setup, scripted writes, and Skill Registry maintenance. The Browser remains the primary public UI.

Primary distribution is npm. The npm package downloads GitHub Release assets and verifies SHA-256 checksums. Cargo install is a Rust-user fallback; crates.io publication is deferred.

## Breaking Changes

- Archive/restore APIs and CLI commands remain removed.
- Source nodes no longer require canonical `/Sources/<provider>/<id>.md` paths. Safe `/Sources/...` paths are accepted, and URL capture writes immutable suffixed paths on collision.

### Structured node-mutation errors

The node-mutation methods replace `Err : text` with `Err : NodeMutationError`, and move requests add optional `expected_target_etag`. This is a Candid-breaking change: an old decoder can fail even when the caller only expects to handle an error response. A live overwrite requires the current destination etag, preventing a concurrent destination update from being silently discarded.

Do not upgrade the production canister until all production consumers below have compatible code and an identified release artifact or deployment:

- Wiki Browser production Worker
- MCP production Worker
- Skill Registry Worker
- Wiki Generator Worker
- Wiki Clipper Chrome extension
- `kinic-vfs-cli` GitHub Release and matching npm package
- Kinic iOS TestFlight/App Store build
- shared `@kinic/vfs-candid` consumers in this repository
- known externally maintained Candid clients

For the Wiki Clipper, increment the extension version, run its release checks, and prepare the Chrome Web Store package. For the CLI, increment the aligned Cargo and npm versions, create the GitHub Release assets, and publish the matching npm package. For iOS, verify the mutation decoder tests, increment the build number, and prepare the TestFlight build. Record or notify owners of external Candid clients before the canister upgrade; repository checks cannot prove those clients are compatible.

Prepare and validate every artifact before changing the production canister. During the promotion window, stop mutation smoke traffic, upgrade the canister, deploy the production Wiki Browser and MCP Workers, promote the remaining pinned consumers and CLI/iOS/extension artifacts, then run Candid drift and mutation smoke checks before resuming normal writes. Do not intentionally leave an old decoder pointed at the upgraded canister.

The IAP mainnet backport is an additive exception to that coordinated rollout. Mainnet already
serves the structured node-mutation contract, while the backport only adds optional
`iap_authority_id` fields, `DatabaseCyclesIapGrantRequest`, and
`grant_database_cycles_from_iap`. Validate it against `contracts/mainnet-vfs-83bbb0b6.did` with
`scripts/check-mainnet-candid-compat.mjs`; existing consumers do not need a simultaneous release.

This release also adds native publication recovery state. The index database migrates exactly `001→002→003` (or `002→003`), and each filesystem database migrates exactly `001→002`. The canister upgrade applies versioned migrations once; it does not infer or absorb unknown schemas and does not use `IF NOT EXISTS` as migration state. After a native node mutation commits, publication-finalization failures remain in the durable journal and do not turn the mutation response into an ambiguous failure; the next publication operation or restart reconciles them. The canister instead traps on the same finalization failure so the IC message rolls back atomically. Keep the pre-upgrade backup until publication reads and mutations pass after restart.

The isolated staging rollout is narrower because the Skill Registry, Wiki Generator, iOS app, and Wiki Clipper are pinned to the production canister. Follow [`STAGING.md`](STAGING.md) and use a CLI binary built from the same branch for staging smoke tests.

## npm

Install the released CLI on macOS arm64 or Linux x64 (Node.js 18 or newer):

```bash
npm install -g kinic-vfs-cli@2.0.5
kinic-vfs-cli --version
kinic-vfs-cli --help
```

`--version` must report `kinic-vfs-cli 2.0.5`. The npm installer downloads the
matching GitHub Release archive and validates its SHA-256 checksum. The recorder
plugin remains at **0.2.2**; this CLI release does not publish a plugin, crates.io
packages, or a canister upgrade.

### Update from 2.0.4 and compatible recovery

Before replacing a 2.0.4 installation, stop the host sessions/hooks that can start
learning or delivery work. For each affected project, disable learning and wait
for its existing learning/delivery processes to exit:

```bash
kinic-vfs-cli learn disable --project-root /path/to/project --json
kinic-vfs-cli learn status --project-root /path/to/project --json
```

Record the CLI version, selected identity, database target, project configuration,
and the state/SQLite paths used by that project. Take a consistent SQLite backup
with its transaction state and save the matching project configuration while
writers remain stopped. A copy of a live `.sqlite` file alone is not a valid
backup. Keep this pre-update 2.0.4 backup and binary/package available until the
new version has been accepted.

Use the same pinned npm install command above to update to 2.0.5. Inspect
`learn status --project-root /path/to/project --json` and `agent status --json`,
confirm the expected target/identity and queue state, and review paused or
ambiguous jobs before starting host sessions. Enable learning only after those
checks with `learn enable --project-root /path/to/project --json`.
See [portable learning recovery](PORTABLE_LEARNING.md) for bounded job controls.

To stop or recover, disable learning again and stop all relevant writers. Preserve
the failing state for inspection. Restore a **matching CLI version, consistent
state backup, and project configuration** together while learning stays disabled.
An older CLI must not open newly written 2.0.5 state: 2.0.4 does not understand
paused learning jobs. Returning to 2.0.4 requires the pre-update 2.0.4 backup,
not just `npm install -g kinic-vfs-cli@2.0.4`. Inspect identity, target and pending
jobs before re-enabling; do not edit queue rows or replay ambiguous publications
manually.

### Publish npm after GitHub Release

Run local checks before tagging (Python 3.11+ is required for release scripts):

```bash
python3 -B -m unittest scripts.test_cli_release
bash scripts/kinic_vfs_cli_release_version.sh
npm --prefix npm/kinic-vfs-cli test
cd npm/kinic-vfs-cli
npm pack --dry-run
```

After the GitHub Release is published, run `Publish npm CLI` using its exact tag
`v2.0.5`, or dispatch from the current workflow with `release_tag=v2.0.5`.
The workflow checks out `refs/tags/v2.0.5`; branch runs without a release tag fail.
It requires aligned Cargo, npm and Cargo.lock versions, matching local/remote tag
and checkout commits, and the release's `target_commitish` to be that exact SHA.
A branch name in old release metadata is not accepted as evidence of the artifact
source; do not change old tags or release metadata to bypass that check.

Both platform archives and checksum files are downloaded and their actual hashes
verified, including macOS assets when npm publishing runs on Linux. The workflow
runs package tests and packing, installs the package in an isolated prefix,
asserts its binary version and checks the non-writing setup dry-run contract.
Immediately before `npm publish`, it repeats the tag/commit and both-platform
checksum checks. A checksum mismatch, missing asset or draft release stops npm
publication. `NPM_TOKEN` is used only by the publish step. Setup dry-run does not
claim plugin activation or live learning acceptance.

Configure GitHub Environment approval for the publish workflow when release
approval must be explicit. Use an npm automation token scoped to this package;
keep 2FA/provenance policy in the npm organization settings.

## Local Build

```bash
cargo build -p kinic-vfs-cli --bin kinic-vfs-cli --release
target/release/kinic-vfs-cli --help
```

Use the binary with the same flags documented in [`CLI.md`](CLI.md):

```bash
target/release/kinic-vfs-cli database current
```

## GitHub Release

Verify that the next version is unused in GitHub tags, GitHub Releases and npm.
Align `crates/vfs_cli_app/Cargo.toml`, its `Cargo.lock` entry, and
`npm/kinic-vfs-cli/package.json` before creating the tag on the reviewed release
commit. Create and push the tag only as part of the approved release operation:

```bash
git tag v2.0.5 <reviewed-release-commit>
git push origin v2.0.5
```

Never move or recreate a published tag. `Release CLI` can also be dispatched with
`version=v2.0.5`; it checks out that existing tag, not the branch selected in the
workflow UI. A source job verifies the tag/version and pins one commit for both
builds and the publish job. Remote tag movement causes verification to fail.

The workflow builds these four assets:

- `kinic-vfs-cli-v2.0.5-linux-x86_64.tar.gz`
- `kinic-vfs-cli-v2.0.5-linux-x86_64.sha256`
- `kinic-vfs-cli-v2.0.5-macos-arm64.tar.gz`
- `kinic-vfs-cli-v2.0.5-macos-arm64.sha256`

Each archive contains `kinic-vfs-cli`, `README.md`, and `LICENSE`. Packaging
checks the binary version and normalizes archive metadata. A new release starts
as a draft with the exact source SHA and an already-existing tag; it is published
only after all four assets pass verification. The workflow never creates a tag
or overwrites an asset.

For a partial upload, rerun the failed publish job using the original build
artifacts. It downloads **every existing expected asset**, including checksum
files, and compares its bytes with the original build output before uploading
anything missing. Matching complete releases are a no-op. A source SHA mismatch,
unknown asset, or differing bytes stops the operation without replacing assets.
A complete rebuild is not assumed to reproduce identical binary bytes even
though archive metadata is deterministic. If original artifacts are unavailable
or a published asset is wrong, stop and prepare a new unused patch release;
do not delete assets, retag, or use `--clobber` to make a retry pass.

Verify downloaded artifacts locally:

```bash
shasum -a 256 -c kinic-vfs-cli-v2.0.5-macos-arm64.sha256
tar -xzf kinic-vfs-cli-v2.0.5-macos-arm64.tar.gz
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
