# Stopped historical diagnostic, 2026-11-02

**No valid current-versus-revision comparison was obtained.** Six source-backed
tasks were prepared, but execution stopped during the first task. The exported
scores are historical diagnostics, not quality evidence or adoption criteria.

| Accounting | Observed |
| --- | ---: |
| Reserved agent invocations, including setup failures and interruptions | 14 / 60 |
| Elapsed preparation to last invocation end | 592.46 seconds |
| Completed decisions in the contained attempt | 7 / 48 planned |
| Completed revisions in the contained attempt | 1 / 6 planned |
| Invocations reporting token usage, across all attempts | 11 |
| Invocations without token usage | 3 |
| Reported input tokens for those 11 invocations | 1,357,614 |
| Cached input subset | 1,209,472 |
| Reported output tokens for those 11 invocations | 10,016 |
| Reasoning output subset | 1,860 |
| Total tokens across all attempts | unknown |
| Monetary cost | unknown |

Subset counters must not be added to their corresponding totals. Counts describe
agent invocations, not individual provider requests. No model calls occurred after
the stop. No knowledge was promoted.

The first attempt failed configuration loading because the installed Codex
`0.166.0-alpha.5.1` rejects overriding the built-in `openai` provider. An explicitly
directed correction retained that failed reservation and the original deadline.
The next attempt showed native nested seatbelt failures:
`sandbox-exec: sandbox_apply: Operation not permitted`. Two coding decisions could
not write files; they are not capability failures. A second explicitly directed
correction retained mandatory outer file containment and removed only the inner
nested sandbox.

The contained attempt passed local file-access denial probes, but one revision-arm
decision used web search, attempted `codex_apps.github.fetch_commit`, and successfully
ran curl against GitHub's commit API. This introduces external evidence beyond the
frozen arms. Independently, review reproduced a detached child surviving a kill of
its parent's process group. No actual model-created orphan was observed, but the
missing lifecycle guarantee also prevents quality eligibility. The experiment was
stopped rather than spending the remaining budget on a compromised comparison.

The last invocation of each interrupted attempt is recorded by the original runner
as `launch_failed` due its cleanup race; this **does not mean no inference happened**.
The original labels are retained in [the ledger](invocations.json), with this
correction in the record. Missing usage remains unknown.

Subsequent deterministic hardening blocks live execution before any reservation.
It adds immutable candidate snapshots, actual verifier preflight, explicit
infrastructure-error status, and a no-fork verifier policy. These changes were not
used in the historical run and do not validate its samples retroactively.

The frozen tasks use genuine repository documentation, but task packaging and
lesson selection were performed for this experiment. They are not naturally
recovered agent histories. This record neither demonstrates a revision gain nor
supports a claim that revision is ineffective; the experiment did not establish a
valid comparison.
