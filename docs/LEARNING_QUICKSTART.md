# Continual learning quickstart

Continual learning lets a coding agent (Codex, Claude Code or DeepSeek Harness)
learn from its own work in any project. Each prompt recalls relevant lessons from
your Kinic Wiki database, each finished turn is recorded as evidence, and a
background job proposes revisions to the lessons. A revision is published only
after it measurably improves results on your own validation tasks.

This page gets one project from nothing to recorded evidence and proposals. The
reference documents are [portable project setup](PORTABLE_LEARNING.md),
[continual learning](CONTINUAL_LEARNING.md) and
[agent configuration](AGENT_CONFIGURATION.md).

## What you need

- `kinic-vfs-cli` 2.0.4 or newer and `icp-cli`, both on `PATH`:

  ```bash
  npm install -g kinic-vfs-cli @icp-sdk/icp-cli
  ```

- An Internet Identity linked as your default `icp` identity. See
  [Identity Mode](CLI.md#identity-mode).
- A Kinic Wiki database where you are owner or writer. Your first database is
  created with a free initial cycles grant:

  ```bash
  kinic-vfs-cli database create "My agent memory"
  ```

- The agent you want to learn with, already installed and signed in.
- For automatic publication only: a validation suite (step 5).

The production Kinic Wiki canister already serves the revision and publication
APIs that learning uses. Nothing has to be deployed.

## 1. Link the project to your database

From the root of the project the agent works in:

```bash
kinic-vfs-cli database link <database-id>
```

This writes `.kinic/config.toml` for the project. It holds connection settings
only, never credentials.

## 2. Connect the agent's hooks

Hooks supply recalled context on each prompt and record evidence after each turn.

**Codex**

```bash
kinic-vfs-cli agent setup --engine codex --install-plugin --dry-run --json
```

```bash
kinic-vfs-cli agent setup --engine codex --install-plugin --apply
```

Then open `/hooks` in Codex, trust the Kinic hooks, and restart if asked. Setup
never trusts hooks for you.

**Claude Code**

```bash
kinic-vfs-cli agent setup --engine claude
```

```bash
claude plugin marketplace add "$HOME/.claude/plugins/kinic"
```

```bash
claude plugin install kinic-skill-recorder@kinic
```

Review `/hooks` and restart Claude Code if asked.

**DeepSeek Harness**: follow the [DSH plugin guide](../plugins/dsh/README.md).

Check the result with
`kinic-vfs-cli agent doctor --engine <codex|claude|dsh> --json`.

## 3. Write a runner file

The runner file names the agent executable the CLI launches to propose and
evaluate revisions. Copy an example from [examples/learning](../examples/learning/):

| Engine | Example | Notes |
|---|---|---|
| Codex | [`runner.codex.json`](../examples/learning/runner.codex.json) | Uses your existing Codex installation. |
| Claude Code | [`runner.claude.json`](../examples/learning/runner.claude.json) | Needs Claude Code 2.1.286 or newer. CLI-owned runs use bare mode, which does not use subscription login, so `ANTHROPIC_API_KEY` (or supported provider credentials) must be set. |
| DeepSeek Harness | [`runner.dsh.json`](../examples/learning/runner.dsh.json) | Replace the executable with your absolute `dsh` path. |

Credentials never go in this file. List variable *names* in
`inherited_environment`; setup rejects secret-looking keys under `environment`.

These runs call your model provider, so they cost what that provider charges.

## 4. Turn learning on (proposals only)

```bash
kinic-vfs-cli learn setup --project-root . --runner-file "$PWD/runner.json" --json
```

```bash
kinic-vfs-cli learn status --project-root . --json
```

Setup writes `.kinic-learning.json` with an opaque project ID and the pinned
connection. Without a validation suite, learning stores proposals but never
publishes them. That is a safe way to start.

Now use the agent normally. After a few turns:

- `kinic-vfs-cli agent status --json` shows delivered context and evidence.
- `kinic-vfs-cli learn status --project-root . --json` shows queued, paused and
  finished learning jobs with their errors.
- Proposals appear under `/Sources/learning-candidates/` in the database.

Jobs run in a short-lived background CLI process; hooks never wait for them. To
process pending work immediately, run `kinic-vfs-cli learn drain --project-root . --json`.

## 5. Allow automatic publication (optional)

Publication needs evidence that a revision helps. Write a validation suite of
tasks from your own project, each with a commit where the task is unsolved, a
prompt, machine checks and the paths the agent may change. Start from
[`validation-suite.example.json`](../examples/learning/validation-suite.example.json).

A revision is eligible only with **at least three task families and six paired
results on the `validation` split**, a strictly positive improvement interval and
no family regression. Smaller suites keep proposals unpublished. Keep the suite
and verifier scripts outside the project source (the example uses `{suite_dir}`).
This keeps the verifiers out of the exported source, but does not prevent the
agent from reading them on the host. Use runner sandbox permissions or an
external container to deny access to held-out oracles and solution checkouts;
see the [evaluation boundaries](../evaluation/continual-learning/README.md).

Isolated evaluation clears the environment and uses a temporary `HOME`. Before
setup, add the credential variable names your runner needs to `runner.json`, for
example `"inherited_environment": ["OPENAI_API_KEY"]` for Codex with an API key.
To use an existing Codex login instead, set `CODEX_HOME` in the launching process
to your existing Codex configuration directory and add
`"inherited_environment": ["CODEX_HOME"]`. Exporting it alone does not pass it to
the isolated runner. Keep credential values out of both configuration files.

For a new project, pass the suite at setup:

```bash
kinic-vfs-cli learn setup --project-root . --runner-file "$PWD/runner.json" --validation-suite /absolute/path/outside-your-project/validation-suite.json --json
```

Setup copies the runner configuration into `.kinic-learning.json`; later edits
to `runner.json` do not change the configured runner. Running setup again on an
already configured project changes nothing, including the runner and suite.
For a project set up in step 4, edit `runner.inherited_environment` in
`.kinic-learning.json` to configure evaluation credentials, and add the suite's
absolute path at the top level:

```json
"validation_suite": "/absolute/path/to/validation-suite.json"
```

`learn status` then reports `"publication": "validation_required"` instead of
`"candidate_only"`. Paused jobs recorded under the old configuration cannot be
resumed after the suite changes; see
[normal use and recovery](PORTABLE_LEARNING.md#normal-use-and-recovery).

## What learning may change

- Each project gets private scopes: `/Knowledge/projects/<id>`,
  `/Memory/projects/<id>` and `/Skills/projects/<id>`. Other projects' private
  knowledge is never recalled implicitly.
- Only nodes whose metadata says `"authority": "agent"` can be revised
  automatically. Human, protected and approved nodes are rejected.
- Every publication can be undone with `kinic-vfs-cli learn rollback`.

## Pause or stop

```bash
kinic-vfs-cli learn disable --project-root . --json
```

`learn enable` resumes. Disabling keeps evidence and pending work. To stop all
automatic intake, also disable the Kinic hooks in your agent. Do not delete local
queues to clear an error; see
[normal use and recovery](PORTABLE_LEARNING.md#normal-use-and-recovery).
