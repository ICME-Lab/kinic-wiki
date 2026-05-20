# kinic-vfs-cli

`kinic-vfs-cli` is the operator CLI for Kinic VFS-backed wiki databases and Skill Registry packages.

## Install

```bash
npm install -g kinic-vfs-cli
kinic-vfs-cli --help
```

The npm package downloads the matching release binary from GitHub Releases and verifies its SHA-256 checksum.

Supported platforms:

- macOS arm64
- Linux x64

For other platforms, build from source:

```bash
cargo install --git https://github.com/ICME-Lab/kinic-wiki.git --package kinic-vfs-cli --bin kinic-vfs-cli --locked
```

## Codex Plugin

```bash
kinic-vfs-cli codex setup
```

Restart Codex after setup so the local plugin is loaded.
