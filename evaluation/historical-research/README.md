# Historical memory research

This standalone research package prepares six frozen tasks from genuine Kinic
history and preserves an interrupted diagnostic run. **Live execution is blocked:
there is no valid efficacy comparison.** The distributed Rust CLI and its public
report schema are unchanged; no knowledge was promoted.

The attempted experiment was stopped after 14 reserved agent invocations. One
contained task produced seven completed decisions and one revision, but an agent
retrieved external GitHub evidence. Review also demonstrated that killing an
agent's original process group does not kill detached descendants. Local file
canary denials alone were insufficient. The final `run()` refuses before creating
output or reserving a call; there is no override that labels this backend safe.

See [diagnostic results](results/2026-11-02/RESULTS.md) and
[machine-readable accounting](results/2026-11-02/summary.json).

## Historical evidence and intended design

| Family | Genuine Git evidence | Reconstructed tasks |
| --- | --- | --- |
| Stale guidance | `07ac286e`: one-path MCP reads migrate to `read_paths`, including item-level errors | request and response adapters |
| Environment/version | `366f95b7`: pinned Wrangler environment migrates to `cf` beta | current UUID command and retained legacy name command |
| Conditional applicability | `e776f1e9`: database creation exposes actual status/free-grant outcome | active and pending routing despite stale preflight |

These are researcher-authored small coding reconstructions, **not recovered natural
agent episodes**. Historical lessons are exact excerpts of existing repository
guidance, not invented experience or model-written histories. Two tasks within a
family share a historical change. This is three independent source families, not
six independent domains.

Preparation extracts source bytes, immutable Git commit IDs, paths, line numbers,
whole-source SHA-256 hashes, one target lesson per task, a fixed new lesson, initial
files, and hidden behavioral checks. Everything is frozen before inference. The
oracle remains outside decision workspaces; revisions receive historical sources
and lessons only, never the task or checks.

The planned arms were `none` (no memory), `raw` (original/latest sources), `current`
(old lesson plus fixed new lesson), and `revision` (replace only the old lesson).
Each task would receive one revision reused across two decision trials, using
`gpt-6.1-sol` with high reasoning. Arm order rotates by task and reverses within
trial pairs. Contexts have the same 65,536-byte ceiling, not matched token lengths.
No claim about revision benefit can be drawn from the interrupted run.

The ledger preserves failed launches and explicit corrections, with a maximum of
60 agent invocations and an unchanged two-hour deadline from preparation. The
attempted runner used a 180-second leader timeout, but its descendant-lifetime
limitation prevents claiming a hard bound on all spawned processes. Agent
invocations are not provider API requests: tool turns and provider retries can
make additional requests. The harness did not automatically retry; two corrections
were explicitly directed and used the same ledger. The installed built-in provider
rejected retry overrides, so internal retries were not claimed disabled.

## Working local functionality

Preparation and deterministic checks require Python 3 and the repository's complete
Git history. Actual verifier and filesystem-boundary checks additionally require
macOS `sandbox-exec`; CI runs these on macOS. No dependency installation, model
inference, canister or Wiki mutation is involved in these commands:

```sh
python3 -m unittest discover -s evaluation/historical-research -v
python3 evaluation/historical-research/prepare.py \
  --output evaluation/historical-research/runs/new-frozen
```

Some source commits predate squash merges and are not reachable from current branch
heads. Fetch their immutable objects if absent (CI does this explicitly):

```sh
git fetch --no-tags origin \
  07ac286ec5b39e879c4824f08d31c5efd25852c6 \
  366f95b737ff9d4abd98e1288d73859336f3474f \
  e776f1e9a3b798bcb16a15df524c1e9298d006cf
```

Preparation refuses existing output paths. The committed
[frozen snapshot](results/2026-11-02/frozen/suite.json) and
[hash manifest](results/2026-11-02/frozen/freeze.json) preserve the actual pre-inference
inputs. The matching oracle is published only after the experiment was stopped.

The verifier reads a size-bounded regular candidate file once without following
symlinks, hashes those bytes, and scores a read-only copy. Expected outputs remain
in its parent. A separate Python process has network and process-fork denied,
three seconds of CPU, a ten-second wall timeout and one MiB per output file. Actual
preflight checks a known-good candidate, a known-bad candidate, and denied fork /
detached subprocess creation. A broken boundary returns `infrastructure_error`
with unknown success, not a model failure. These later checks do not retroactively
validate the historical scores. This is not a general malicious-code sandbox;
for example, it does not claim an enforced address-space quota.

The filesystem-policy/fresh-home helpers selectively adapt reviewed code from
unmerged PR #160. They are retained for deterministic isolation probes, not as a
sufficient live execution backend. Their content boundary excludes oracle, other
arms, ordinary-chat canaries and prior authentication homes. The historical run's
mandatory outer seatbelt allowed actual editing, but permitted network access;
fresh homes did not prevent server-side apps from appearing.

## Requirements before another live experiment

A separately reviewed backend must demonstrate all of the following before the
live gate can be replaced:

- Provider-only egress and no remote apps/web/repository lookup. Local config and
  a fresh home are insufficient; test the effective model-visible capabilities.
- Complete descendant lifetime containment, including normal exit, timeouts,
  cancellation, `setsid`, double fork and retained network listeners. Agent tools
  need subprocesses, so the verifier's no-fork policy cannot be reused unchanged.
- Immutable artifact capture after the entire invocation has stopped; no prior
  task process may alter a later score or expose evidence to another arm.
- The existing file-denial, verifier-preflight, one-shot budget, fresh-session and
  frozen-source checks under the real selected runtime.

Any new experiment needs a new explicitly authorized budget and preserved protocol;
this stopped experiment must not be resumed automatically or relabeled valid.
`runs/` remains ignored because it contains private authentication homes and raw
traces. Never commit that directory. Only reviewed, sanitized exports belong in
`results/`.
