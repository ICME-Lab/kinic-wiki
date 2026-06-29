# Kinic Hermes Plugin

Hermes専用のKinic連携plugin。
`kinic-vfs-cli` はVFS/Skill Registryの正本操作を担当し、`plugins/runtime/kinic_agent_runtime` がrun evidence記録の共通処理を担当する。
このpackageはHermes hookとHermes adapterだけを持つ。

## Normal Flow

```bash
kinic-vfs-cli hermes setup
```

`hermes setup` が `$HERMES_HOME/plugins/kinic` へ自己完結pluginを配置し、`plugins.enabled` に `kinic` を追加し、reviewed/promoted skill のprojection syncを行う。既存configは書換前にbackupされ、root / `plugins` / `plugins.enabled` のshapeが不正なら修復せず失敗する。
DashboardなどでDB上のskillを更新した後は `kinic-vfs-cli hermes pull` でprojectionだけ再同期する。
Hermesから `kinic_hermes.register(ctx)` を読み込ませる。

## Skill Registry Web

Skill Registry dashboardは repo root の `skill-registry-web/` に置く。

```bash
pnpm --dir skill-registry-web install
pnpm --dir skill-registry-web dev
```

Open:

```text
http://localhost:3000/skills/<database-id>
```

Checks:

```bash
pnpm --dir skill-registry-web test
pnpm --dir skill-registry-web typecheck
pnpm --dir skill-registry-web build
```

## Environment

- `KINIC_VFS_CLI`: 使用する `kinic-vfs-cli` のパス。未指定ならPATHから探索する。
- `KINIC_HOME`: pending evidenceとplugin logの保存先。既定値は `~/.kinic`。

run evidenceは `kinic-vfs-cli skill record-run --json` 経由で記録する。
記録に失敗したrun evidenceは `KINIC_HOME/pending-runs` に保存する。
plugin logは `KINIC_HOME/hermes-plugin.log` に追記する。
通常の自動captureはtool名、redact/truncate済みargs/result excerpt、final response、usage delta、`redacted` / `truncated` / `max_chars` metadataを保存する。
`KINIC_HERMES_CAPTURE_RAW=0` ならraw tool/result/final responseを保存しない。
`KINIC_HERMES_MAX_TOOL_TRACE_ITEMS` は保存するtool trace件数の上限で、既定値は20。
不要なpending evidenceは `KINIC_HOME/pending-runs` から削除する。

`KINIC_VFS_CLI_ALLOW_NON_II=1` を設定した場合だけ、pluginは `kinic-vfs-cli` 呼び出しに `--allow-non-ii-identity` を付ける。
未指定時はInternet Identity identity前提のまま。

Codex と Claude Code の記録は Hermes を経由しない。
詳細は [`../codex/README.md`](../codex/README.md) と [`../claude-code/README.md`](../claude-code/README.md) を参照する。

確認:

```bash
target/debug/kinic-vfs-cli list-nodes --prefix /Sources/skill-runs --recursive --json
ls ~/.kinic/pending-runs
tail ~/.kinic/hermes-plugin.log
```
