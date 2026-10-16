# Kinic learning for DeepSeek Harness

This native Cordis plugin calls `kinic-vfs-cli agent hook --engine dsh`. Each first accepted turn step recalls context from Kinic Wiki. The plugin returns `createUserMessage` content through `agent/pre-step`; the normal agent loop commits that message and its `kinic-learning` source before a model request. Its `receiptId` identifies the exact supplied recall receipt. Recall content is recorded as supplied context; it does not establish adoption or success.

The `session/event` listener sends observed facts unchanged to the CLI. The CLI owns project discovery, durable evidence, learning jobs, evaluation, publication, and rollback; the plugin has no learning database or decision logic. The request carries `session_id`, `run_id` as `session:turn`, `cwd`, `turn_id`, and `payload.event`. A terminal `turn/end` is sent as `event: "Stop"` with `terminal: true`, after earlier observations in the same transport queue. The CLI persists the evidence and requests a finite learning drain; the plugin never launches its own drain process. A `turn/end` reason remains evidence; the plugin never converts `completed` into a passing task outcome. Transport calls run serially, with a configurable in-memory pending limit; this is not a persistent learning queue. Queue overflow emits a warning and leaves the affected event unrecorded. CLI failures also emit warnings and do not claim successful persistence; recall failure returns the original downstream decision. Unloading removes listeners and drains the bounded record queue. The plugin never forces a turn to continue.

The package is native ESM and needs no build. Use Node.js 22.19 or later and the DSH 0.1.7 SDK generation. Install the package into the profile you selected, then add the supplied overlay to that profile's normal composition:

```sh
cd plugins/dsh
npm pack

dsh plugin --profile sdk add /absolute/path/to/kinic-dsh-learning-0.1.0.tgz
dsh --profile sdk --patch /absolute/path/to/kinic-learning.patch.yml
```

Copy `cordis.patch.example.yml`, set the CLI executable and the recall configuration path, and supply database/identity options as separate `cliArgs` entries where needed. `recallConfig` selects the CLI's project learning configuration; without it the CLI discovers `.kinic-learning.json` from the session workspace. Set up an arbitrary project with `kinic-vfs-cli learn setup`; the project does not need a Kinic source checkout. The installed CLI must be on PATH or explicitly selected with `cliExecutable`. The plugin leaves a missing or invalid configuration to the CLI and warns on its error. Installation and profile activation are explicit operations; this repository does not alter a running server or the user's existing DSH configuration.

The config accepts `cliExecutable` (default `kinic-vfs-cli`), `cliArgs` (default `[]`), optional `recallConfig`, `timeoutMs` (10000 per call), `maxOutputBytes` (1048576 per output stream), and `maxPendingRecords` (128, including the active record). Values are checked before listener registration. Each CLI invocation uses argv and JSON stdin, with no shell expansion. The CLI runs with the session working directory and inherited operator environment so existing database authentication continues to work.

Run `npm test` after installing peer dependencies. The tests use the real Cordis dispatcher, DSH Session model, AgentRegistry, and disposable fixture CLI processes. They verify durable recall message content and source, turn identity, downstream rejection, terminal event ordering, CLI-only invocation, raw non-success evidence, and offline behavior. They do not contact a model provider or modify a profile.

Prepare the package and shared settings with
`kinic-vfs-cli agent setup --engine dsh --executable /absolute/path/to/launcher`.
Use `--dry-run` to preview and `--apply` for existing-file replacements. The
adapter passes session cwd before CLI connection resolution. Ordinary
`kinic-vfs-cli agent doctor --engine dsh` does not start DSH, run a wrapper or
modify a profile. See [configuration and diagnostics](../../docs/AGENT_CONFIGURATION.md).
