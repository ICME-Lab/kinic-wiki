# Ask AI text-turn speed improvement — local validation

Date: 2026-10-07. This change has not been deployed. Existing production configuration, CPU limits and billing settings were not changed.

## Implementation

- Database overview loads the existing inventory and up to four representative excerpts before the first model request, then asks for the final answer. Selected-node summaries seed the first excerpt and still allow further reads. Focused search preserves model query rewriting and Jev ranking.
- Independent, adjacent `wiki_read` calls run in batches of at most two. Inventory/query dependencies and tool output order are preserved. No new canister batch endpoint is required.
- Read authorization and path discovery checks remain in place. Authorization material is refreshed and full access checked before every provider request; cancellation, deadline and execution ownership are checked around work. `query_context` is not substituted because its access rules differ from the existing read path.
- Batch reads reserve overview capacity before I/O, retain the four-document and 24,000-character bounds, and commit evidence in request order only after all fetches succeed. Citation path, etag and exact-quote validation remain intact.
- Provider submission checkpoints remain durable before egress. Tool results are checkpointed once per read batch. A persisted ambiguous provider submission is refused rather than repeated; seeded retrieval is not repeated when resuming a persisted turn.

## Verification

From `workers/wiki-assistant`:

```sh
pnpm test
pnpm typecheck
pnpm exec cf deploy --dry-run --mode production
node --check scripts/profile-text-turn.mjs
ASKAI_PROFILE_OUTPUT=/private/tmp/askai-speed-cpu-profile.json node scripts/profile-text-turn.mjs
```

All 170 tests passed: 137 unit, 31 real workerd/Miniflare and 2 Node tests. Type checking and the official `cf` build dry-run passed. New tests cover overview/selected-node seeding, preserving focused search, authorization revocation, cancellation, ambiguous-request recovery, concurrent read ordering, global context limits, overview capacity, invalid paths and atomic rejection without evidence mutation.

## Synthetic local benchmark

The script runs actual retrieval/model-runner/context-encryption code in local workerd with four approximately 4 KB synthetic documents, fake canister/model responses and 5 ms artificial response waits. No private data, remote API or real API key is used. Legacy mode reproduces sequential tool authorization and checkpoint behavior with the current reader. Each CPU median uses five warm runs with the inspector profiler stopped.

| Metric | Legacy | Optimized |
| --- | ---: | ---: |
| Retrieval/access-check requests | 27 | 5 |
| Model requests | 3 | 1 |
| Checkpoints | 11 | 2 |
| Encrypted values with 20 history records | 231 | 42 |
| Maximum concurrent document reads | 1 | 2 |
| Warm process CPU median, no prior history | 5.61 ms | 1.91 ms |
| Warm process CPU median, 20 prior history records | 14.61 ms | 2.49 ms |
| Synthetic wall time median, 20 prior history records | 168 ms | 32 ms |

CPU comes from Darwin kernel user/system counters for this benchmark's own workerd child, converted from Mach ticks using `mach_timebase_info`, following [Apple XNU's recount tests](https://raw.githubusercontent.com/apple-oss-distributions/xnu/main/tests/recount/recount_perf_tests.c). It includes native work in that process. V8 stack samples are retained only as diagnostics: they can include paused frames and omit native cryptography, and must not be interpreted as billed CPU.

These figures demonstrate fewer operations and lower local synthetic CPU, not production latency or Cloudflare-billed CPU. Real IC signing/decoding, D1 operations, production cold starts and actual model latency are not exercised. [Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/) document the free HTTP Worker CPU allowance of 10 ms and exclude network wait from CPU; this benchmark does not establish compliance with that allowance. Production verification must inspect CPU/limit errors separately from elapsed response time after deployment.

## Review fix: empty representative documents

Seeding skips genuinely empty documents without creating citation evidence, and tries later inventory representatives within the existing 12-tool-call budget until four documents supply evidence. Empty-only seeding proceeds to an insufficient-evidence answer. Denied reads, missing nodes and exhausted character budgets still fail normally; model-directed reads retain their existing behavior.

Added regressions for mixed empty/nonempty read batches, empty-only inventories exceeding the call budget, and denied reads alongside empty documents. After this fix, `pnpm test` passed all 173 tests (140 unit, 31 workerd and two Node tests), and `pnpm typecheck` passed. This fix has not been deployed.

## Post-fix performance and runtime verification

Re-ran `pnpm test` and `pnpm typecheck` after adding three workerd regressions for mixed empty/nonempty documents, empty-only inventories and denied document reads. All **176 tests passed** (140 unit, 34 workerd and two Node tests). Existing coverage also exercises selected-node summaries, focused search routing, citation validation, cancellation, authorization revocation, ownership loss and ambiguous provider-request recovery. `git diff --check` passed.

Repeated `scripts/profile-text-turn.mjs` in two independent runs after the empty-document fix. Each run collects five warm wall-time samples and five separate kernel CPU samples per mode/history setting. The legacy comparison preserves sequential tool/auth/checkpoint behavior using the current reader; it is not execution of a historical production binary.

| Overview scenario | Legacy warm wall median, runs 1 / 2 | Optimized warm wall median, runs 1 / 2 | Legacy CPU median, runs 1 / 2 | Optimized CPU median, runs 1 / 2 |
| --- | --- | --- | --- | --- |
| No prior history | 163 / 163 ms | 31 / 31 ms | 6.43 / 5.72 ms | 1.69 / 1.76 ms |
| 20 history records | 168 / 168 ms | 32 / 32 ms | 15.15 / 15.40 ms | 2.43 / 2.44 ms |

Both runs confirmed read/access calls **27 → 5**, provider requests **3 → 1**, checkpoints **11 → 2**, and maximum concurrent reads **1 → 2**. Each benchmark response validates its answer citations against retrieved evidence. Raw local reports: `/private/tmp/askai-speed-retest-1.json` and `/private/tmp/askai-speed-retest-2.json`.

These results verify the overview optimization and tested error paths in local workerd with synthetic data and provider/IC responses. They do **not** establish production iOS latency, actual-model answer quality, Cloudflare billed CPU or equivalent improvements for focused search. The speed optimization remains undeployed; authenticated production measurements and an actual iOS end-to-end check remain outstanding.

Subsequent real Wiki/Jev/DeepSeek evaluation initially found an overview reliability failure despite faster successful responses. After adding explicit final-answer instructions and bounded whitespace recovery, eight optimized answer-generation attempts completed, including four overviews; the comparison still recorded legacy failure and clarification outcomes. See [real accuracy and performance comparison](ASKAI_REAL_ACCURACY_20261007.md) for all results and limitations. Production remains unverified.
