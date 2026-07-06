# kinic-vfs-cli

Operator CLI for Kinic Wiki databases and Skill Registry packages.

## Install

```bash
npm install -g kinic-vfs-cli
kinic-vfs-cli --help
```

The npm package downloads the matching release binary from GitHub Releases and verifies its SHA-256 checksum.

Canonical guide: https://wiki.kinic.xyz/docs/cli

Repo docs:

- CLI operations: ../../docs/CLI.md
- Skill Registry: ../../docs/SKILL_REGISTRY.md
- Store API: ../../docs/STORE_API.md
- Validation: ../../docs/validation/VFS_VALIDATION_PLAN.md

Supported platforms:

- macOS arm64
- Linux x64

## Codex Plugin

```bash
kinic-vfs-cli codex setup
```

Restart Codex after setup.
