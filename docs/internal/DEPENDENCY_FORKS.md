# Dependency Forks

This project patches selected IC stable-memory crates while multi-database canister storage depends on widened memory IDs.

## Current patches

- `ic-stable-structures`: `https://github.com/humandebri/stable-structures`, rev `a24a7d7572e36eda104abd8280946aeb7ac4e060`

## Reason

The multi-database VFS canister needs one index DB plus many per-database SQLite memories. The upstream memory ID shape is too small for the target layout. This fork widens memory IDs from `u8` to `u16`, allowing user DB memory IDs `11..=32767`.

## Mainline requirement

Before merging this dependency strategy into a long-lived mainline branch, move the forks under the ICME-Lab organization or replace them with upstream releases that contain the mount ID widening.

Track upstream PRs for the widening and keep each pinned revision tied to a reviewed diff. Do not update these revisions mechanically.

## WASI audit

The canister SQLite path does not use WASI, wasi2ic, stable-fs, or ic-rusqlite. It uses `ic-sqlite-vfs` over stable memory selected through `MemoryManager`.

Remaining `Cargo.lock` entries for `wasi`, `wasip2`, and `wasip3` are platform/transitive dependencies from `getrandom`, `tempfile`, `proptest`, and `ic-agent` paths. They are not direct canister SQLite dependencies.

Remaining `pnpm-lock.yaml` entries such as `@emnapi/wasi-threads` and `@unrs/resolver-binding-wasm32-wasi` are Node package platform optional bindings in the web workspaces. They are not part of the canister SQLite execution path.

## Update checks

When changing any patched revision:

- verify memory IDs above `255` can be allocated and used for a database
- run `./.local/check.sh`
- confirm `crates/vfs_canister/vfs.did` still matches the generated Candid interface
