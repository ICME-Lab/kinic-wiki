# ReHarness pilot: failure and revision-effect investigation

Investigation date: 2026-10-16. This extends [the local results](REHARNESS_LOCAL_RESULTS.md)
using saved experiment evidence, DSH implementation inspection and offline SDK
fixtures. No new model/provider requests were made. These findings concern the
portable Kinic CLI learning feature, not repository-specific self-improvement.

## What stopped the DSH forward reflection?

The exact historical cause remains unknown. Raw-04 independently recorded
QUOTA / HTTP 402 / Insufficient Balance; that is not proof of the cause of
ReHarness-03's later missing forward reflection.

An earlier inspection incorrectly described the final session as header-only.
DSH concatenates independently compressed Zstandard frames. A single Node
`zstdDecompressSync` call decoded only the first frame. Scanning and decoding
every frame recovered five complete frames, 14 records and no torn tail.
A local two-frame fixture reproduced the inspection mistake.

The failed invocation reached turn/start, step/start and request construction.
It contains no persisted provider response, retry or terminal event. The preceding
successful revision had four RATE_LIMIT / HTTP 429 retries with balance-dependent
concurrency limits of 8 and then 6, before successfully completing. This establishes
provider pressure, but cannot identify the next invocation's response.

| Evidence | UTC, 2026-10-16 |
|---|---|
| Failed forward-write invocation created | 01:53:58.758340 |
| Last request/context event | 01:53:59.673 |
| Last persisted event, session/title | 01:53:59.675 |
| Failure comparison file created | 01:54:00.654133 |

The approximately 1.90-second interval is inconsistent with a normal 360-second
timeout, absent a clock discontinuity. A fast provider error, SDK/protocol failure,
runtime exit or supervisor termination cannot be distinguished retrospectively.
No uncertain inference reservation was replayed.

## Two evidence-loss defects reproduced and fixed

1. **Memory inference discarded its execution diagnostics on failure.** The
   runner retained root terminal events, but the inference layer returned a generic
   error; the comparison driver intentionally omitted arbitrary stderr. Commit
   `a4d52296` persists a bounded `failure.json` before returning inference errors.
   It records phase, normalized exit reason, allowlisted provider category, HTTP
   status, elapsed time and byte counters. It excludes prompts, model output,
   reasoning, freeform provider messages and request identifiers. Root attribution
   requires unambiguous receipt/session correlation and excludes known children.
   Existing files and symlinks are never overwritten. Publication uses a hard link;
   unsupported filesystems may lose this diagnostic, but retain the original error.
2. **Terminal DSH failures were killed without graceful shutdown.** DSH batches
   live session writes for up to 200 ms. Previously the CLI sent shutdown only for
   successful turns, so failure evidence could remain buffered. Commit `a92f47d4`
   sends shutdown after a terminal root turn and idle, including failed turns,
   drains both output pipes, and allows a bounded two-second grace period. Capture
   remains bounded and a hung child is killed. Failed outcomes remain failed.

The second defect was reproduced with an offline SDK process that flushes after
350 ms and writes 262 KiB to each pipe. The old implementation lost its durable
marker; the new implementation retained it despite a 4096-byte capture budget.
A hung-shutdown fixture verifies bounded termination. Neither reproduction proves
which provider error occurred in the historical invocation, nor does graceful
shutdown guarantee persistence if the SDK itself fails or exceeds the deadline.

## Why the pilot cannot establish a benefit from backward revision

The fixture intentionally omits exact profile conventions, then reveals the
**complete rules on every failure**. Four legacy tasks precede four current tasks;
tasks otherwise use the same stub and five verifier cases, mostly changing the
literal operation kind. Codex raw retrieval, frozen append-only reflections and
ReHarness all passed all six post-disclosure tasks. That leaves no observed
success headroom for revision in that subset. Six of eight is a practical
information-limited ceiling here, not a mathematical bound against lucky guesses.

All three Codex policies asked for the unknown current rules at task 5 and left
the stub unchanged. This was missing information, not demonstrated interference
from stale knowledge. The explicit profile rename permits simple scoping; the
fixture never silently changes a rule under the same profile or returns to an
older profile after learning the new one.

Ordered retrieval IDs were identical across memory policies and engines wherever
corresponding steps existed. Current evidence ranked second at tasks 6–8, behind
the same-kind legacy example, and was available within top-5. No retrieval miss
explains these outcomes. A simple exact profile-rule store is an important untested
control for this fixture.

Revision did make substantive scoping and evidence changes. However, raw and
append-only already contained sufficient information for every post-disclosure
Codex task. Final context sizes were 25,311 bytes raw, 6,866 append-only and 14,104
ReHarness. Its 25 revision invocations consumed 516.3 aggregate seconds. These
measure overhead on this fixture, not a causal quality penalty from longer text.

The legacy result field `model_calls` counts **agent invocations**, not provider
API requests. Decision agents can make multiple model/tool turns and the provider
can retry. Thus 8 / 16 / 41 invocations cannot be read as total API requests or
priced directly. Concurrent runs and observed rate limiting also confound latency.

## Grounding is a separate, measurable failure mode

| Saved evidence | Finding |
|---|---|
| Initial DSH task-1 reflection | Claimed one of five checks passed; all five actually failed. |
| Four subsequent revisions of that reflection | Preserved the false pass count despite access to original evidence. |
| Initial task-3 reflection | Claimed exception-only checks validated the other output fields, which the evidence did not establish. |
| Revised task-3 reflection before task 5 | Explicitly corrected that claim and limited support to smoke tests; correction persisted before task 6. |
| Task-5 reflection | Generalized a wrong identity mapping to any profile from only two observed profiles. |

These are mixed results: revision repaired one unsupported claim and failed to
repair another. Initial writing introduced the false pass count; this audit does
not show revision introduced it. Prompt instructions and access to source evidence
alone do not guarantee factual grounding.

DSH task 3 also used `event["kind"]` despite supplied memories explaining that kind
came from the task. Its own smoke inputs invented the missing field, masking the
bug. Task 4 recovered, but received both new reflection and revised old memories;
the improvement cannot be attributed to backward revision alone.

## Experiments needed to choose a design

These are next experiments, not executed quality results:

1. Fork identical immutable histories into raw, frozen-reflection, revised-reflection
   and exact-rule-store arms. Hold selected IDs, context budget, model and decision
   budget fixed. Preserve the same new reflection in frozen/revised arms to isolate
   backward revision from learning new information.
2. Add same-profile changes, partial updates, conflicting evidence, more distractors
   than top-5, and returns to earlier environments. Provide sufficient evidence
   before scored decisions; report first-disclosure failures separately from
   adaptation lag and stale-rule errors.
3. Score factual claims against original evidence independently of task success:
   false pass counts, unsupported validation claims, corrected claims and excessive
   scope. The observed failures above are concrete regression fixtures.
4. Use multiple disjoint task families and repeated paired trials. Keep final
   evaluation families out of candidate generation. Record actual provider usage,
   invocations, infrastructure failures and controlled latency separately.

Retain the paper-style reference path and policy switches. There is currently no
quality evidence for making every-read revision the default, nor for deleting it.
The immediate design priority is independently checked evidence and an evaluation
that distinguishes new-memory benefit from revision benefit. Automatic promotion
must remain gated by demonstrated improvement and regression checks.

## Verification and retained evidence

Independent review found no actionable issue in the two fixes. Offline tests
cover root/child attribution, hostile diagnostic strings, incomplete execution,
invalid reflection JSON, existing-file/symlink protection, delayed flush,
backpressure and hung shutdown. Final workspace totals are recorded in the local
results report. No new real-agent success rate is claimed.

Private investigation artifacts are retained under
`.superpowers/research/reharness-2610.12668v1/investigation/`: the multi-frame
extraction script and sanitized public timeline, revision evidence projections,
source-level forensic report, and RED/GREEN shutdown logs. Raw transcripts and
credentials are not published. The installed Wiki adapter/hook was also updated
from the plugin repository's committed v3-compatible implementation, preserving
its old files and the existing connection/identity, to repair workflow reporting.

The subsequent [matched-history experiment implementation](REHARNESS_PAIRED.md)
provides these controls; its engineering verification is separate from any new
real-agent quality result.
