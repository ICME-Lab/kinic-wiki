# DSH filesystem containment for experimental rollouts

`dsh_isolated_runner.py` is an executable replacement for the DSH launcher. It forwards SDK arguments and stdin/stdout unchanged through `/usr/bin/sandbox-exec`, replacing itself with that process so the evaluation controller retains process-group ownership. It requires macOS and fails closed if sandbox-exec or its policy fails. No unsandboxed fallback exists.

Each invocation gets a new private directory, home and temporary directory. Only `DEEPSEEK_API_KEY` is copied from an owner-only minimal credential JSON into an owner-only `.credentials.yaml`. Browser credentials, other API keys, profiles, plugins, storage and prior sessions are not imported. The SDK profile declares only the shipped base and SDK bundles; explicit links to configured installation packages avoid resolving packages through forbidden ancestor workspaces. Each invocation retains its own diagnostic/session files for inspection; remove only completed invocation directories when retention is no longer needed.

## Private configuration

Create a private JSON outside task workspaces:

```json
{
  "launcher": ["/absolute/dsh/runtime/bin/node", "/absolute/dsh/core/apps/cli/lib/bin.js"],
  "trusted_read_roots": ["/absolute/dsh/core", "/absolute/dsh/runtime", "/absolute/python/runtime"],
  "tool_bin_dirs": ["/absolute/python/runtime/bin"],
  "shipped_modules_dirs": [
    "/absolute/dsh/core/apps/cli/node_modules",
    "/absolute/dsh/core/packages/bundle/base/node_modules",
    "/absolute/dsh/core/packages/bundle/sdk-app/node_modules"
  ],
  "credential_source": "/private/pilot/credential.json",
  "invocations_root": "/private/pilot/invocations"
}
```

The credential source is JSON with `version` and `refs.DEEPSEEK_API_KEY`, mode 0600. Its value is never printed. Configure runner environment with both `DSH_ISOLATION_CONFIG` (absolute filename) and `DSH_ISOLATION_CONFIG_SHA256` (SHA-256 of exact configuration bytes). The wrapper verifies the digest before reading credentials or launching a child. The stream's runner binding then pins the configuration digest, not merely its filename. Pinning the allowlist does not hash credentials or attest unchanged runtime/package files; record runtime provenance separately. Package templates are defined in the wrapper, whose executable bytes are already bound by the evaluator.

Use `engine: "dsh"`, the wrapper's absolute filename as `executable`, an explicit model and `timeout_seconds: 360` for the fresh contained pilot. This is a new runner configuration; prior 180-second uncontained runs are not made valid by changing configuration. No special wrapper arguments are added; the evaluator supplies `--profile sdk` and `DSH_PERMISSION_MODE=read-only` or `workspace-write`.

## Enforcement and limitations

The outer policy denies file contents/directory enumeration and filesystem writes by default. It allows read access to the exact task cwd, this invocation's home/tmp, explicit trusted runtime roots, and standard system runtime trees (`/usr`, `/bin`, `/sbin`, `/System`, `/Library`, `/dev`, `/private/etc`, `/private/var/db`). Metadata queries remain allowed. Literal `/` directory reads are required by macOS startup; this does not grant reads beneath arbitrary root children. Writes are allowed only to this invocation directory and, for `workspace-write`, the exact cwd tree; standard `/dev/null` and `/dev/tty` writes are allowed for process I/O. Symlinks to denied files remain denied.

No `/Users`, `/Volumes`, `/private/tmp`, output-parent or shared-session-home subtree is granted. The configured trusted roots must be runtime-only directories; do not add project/evaluator sources or broad home roots to make a tool work. Task-local commands may require additional explicitly trusted runtime dependencies. Metadata-only access can reveal existence and filenames already known to the caller; this is a content/write boundary, not complete machine secrecy. Standard system directories remain readable. Network access remains enabled for model requests; this is not a network isolation mechanism.

Only inside the mandatory outer sandbox is `DSH_PERMISSION_MODE=danger-full-access` set. This avoids an unsupported nested macOS sandbox while leaving the original read-only/workspace-write restriction enforced for the complete SDK process and all descendants, including native filesystem tools. No active user permission setting changes. The child receives a small environment allowlist, fresh HOME/DSH_HOME/TMPDIR and explicit runtime PATH; NODE_OPTIONS, alternate home/runtime injections and unrelated secrets are not inherited.

## Verification

```sh
python3 -m unittest discover -s evaluation/reharness -p test_dsh_isolated_runner.py -v
```

Actual macOS tests cover shell `cat`, native Perl/Node reads, sibling/evaluator/shared-home denial, symlink denial, read-only writes, workspace writes, own policy reads, outer wrapper SDK argv/stdin/stdout continuity, read-only enforcement despite the inner mode, independent invocation homes, minimal credentials, and configuration digest drift rejection. macOS tests skip on other platforms; the wrapper itself rejects those platforms.

The dedicated read-only live SDK smoke completed a short no-tools model turn and exited 0. This confirms startup/auth/stdio within the boundary; it does not claim every DSH tool or arbitrary dependency is supported. Failed early startup probes were retained separately and were never substituted with unrestricted execution.
