# Kinic Hermes Plugin

Hermes専用のKinic連携plugin。
`kinic-vfs-cli` はVFS/Skill Registryの正本操作を担当し、`plugins/runtime/kinic_agent_runtime` が記録/evolution runnerの共通処理を担当する。
このpackageはHermes hookとHermes adapterだけを持つ。

## Normal Flow

```bash
kinic-vfs-cli hermes setup
```

Hermes内:

```text
/kinic_evolve_job
```

`hermes setup` が `$HERMES_HOME/plugins/kinic` へ自己完結pluginを配置し、`plugins.enabled` に `kinic` を追加し、reviewed/promoted skill のprojection syncを行う。
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
- `KINIC_SKILL_EVOLVE`: `kinic-skill-evolve` のパス。未指定ならPATHから探索し、最後にpackage内shimへfallbackする。

run evidenceは `kinic-vfs-cli skill record-run --create-ready-jobs` 経由で記録する。
記録に失敗したrun evidenceは `KINIC_HOME/pending-runs` に保存する。
plugin logは `KINIC_HOME/hermes-plugin.log` に追記する。

`KINIC_VFS_CLI_ALLOW_NON_II=1` を設定した場合だけ、pluginは `kinic-vfs-cli` 呼び出しに `--allow-non-ii-identity` を付ける。
未指定時はInternet Identity identity前提のまま。

Codexからの記録と改善job処理はHermesを経由しない。
通常は `kinic-vfs-cli codex setup` で自己完結pluginを `~/.codex/plugins/kinic-skill-recorder` へ配置する。
repo開発時だけ `scripts/install-codex-skill-recorder.sh` で同じsourceを同期する。
Codex側は `kinic-record-skill-run` と `kinic-evolve-skill-job` を使う。
Codex側の改善job処理もplugin同梱の `kinic_agent_runtime/evolve.py` runnerを呼び、Codex自身がcandidate `SKILL.md` を生成する。

Metrics route:

- Hermes: `generator=hermes-plugin`, `llm_route=hermes-ctx-llm`
- Codex: `generator=codex-plugin`, `llm_route=codex-skill`

確認:

```bash
target/debug/kinic-vfs-cli recent-nodes --path /Sources/skill-runs --limit 20 --json
ls ~/.kinic/pending-runs
tail ~/.kinic/hermes-plugin.log
```

## Internal Commands

```bash
kinic-skill-evolve prepare-job [job-id] --json
kinic-skill-evolve finish-job <job-id> --candidate-file ./candidate.md
kinic-skill-evolve sync-local <skill-id> --projection-dir ~/.kinic/hermes-current/skills
kinic-skill-evolve history <skill-id>
```

`prepare-job` はplugin内部用。queued jobをclaimし、Hermes `ctx.llm` に渡すmessagesを作る。
`finish-job` はplugin内部用。候補SKILL.mdをproposalへ保存し、gate通過後に `kinic-vfs-cli skill apply-proposal` を呼ぶ。
`sync-local` と `history` はdebug用。
