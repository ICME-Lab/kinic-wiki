# AskAI focused retrieval and answer delivery validation — 2026-10-07

Branch: `perf/askai-focused-prefetch`. Baseline: `main` at `a965fcff420390c652fd427dc7f2598d340b04c8`.

## Changes

- Keep Jev intent routing and reranking. After the first model-directed search batch completes, prefetch at most two ranked, discovered, unread documents. Simultaneous initial searches contribute their strongest hits in turn. Keep later searches, body chunks, and source reads model-directed.
- Use the existing authorized reader and citation validation. Preserve the 12-call and 24,000-character limits; reserve character capacity for follow-up evidence. Checkpoint synthetic read calls before I/O, then checkpoint results. Empty prefetched documents supply no evidence; denied reads fail closed. Resume does not repeat a checkpointed search or issue another ambiguous provider request.
- Measure provider requests, tool retrieval, provider-boundary authorization and provider round counts. Metrics contain no questions, document text, credentials or paths. Retrieval time includes reranking, so it must not be added to rerank time. Lease checks, persistence and final publication are outside these stage counters; their sum is not total end-to-end latency.
- `GET /conversation?includeHistory=1` optionally embeds the existing bounded first history page. `knownRevision` avoids rereading an unchanged cached history after authorization. Old clients keep metadata-only responses. New iOS clients accept embedded pages, continue pagination, and fall back to `/history` with older servers or WebSocket metadata. Stale revisions restart the read; credential changes cancel it.
- A live comparison exposed a fully received answer missing the required `insufficient` boolean. A structure validation failure now checkpoints one correction prompt and allows one further provider submission, with tools disabled for that submission. Required fields and exact citation validation remain enforced. Ambiguous HTTP failures are never resubmitted automatically. This corrects structure, not factual content.
- Another comparison exposed a model-directed read of an empty search hit. Focused reads now report `empty_document` without creating a citation, allowing the model to use other evidence or state insufficiency. This does not relax authorization or allow reads past the retrieval budget.

## Checks

- Worker TypeScript check passed.
- Worker tests: 155 unit tests, 35 workerd tests, 2 Node tests passed (192 total).
- iOS `AssistantNativeAuthorizationTests`: 25 tests passed on the shared iPhone 17 / iOS 27.0 simulator. Tests cover combined retrieval, pagination, stale metadata recovery, legacy fallback, authorization failure, cache invalidation and existing connection recovery. The simulator was stopped after the run.
- Official `cf deploy --dry-run --mode production` passed. No upload or production deployment was performed.
- `git diff --check` passed. The three existing `mobile/ios/demo-video` changes retain their original SHA-256 hashes.

## Real Wiki / Jev / DeepSeek comparisons

Read-only Wiki: `db_23dhmsxlhukv`, canister `6emaw-iyaaa-aaaay-aacka-cai`. Actual Jev routing and reranking and `deepseek-flash` are used. Both baseline and optimized runs use native-style body authorization and adjacent read batching. The baseline follows the merged focused-search implementation, without prefetch or final-structure correction. No route is forced.

Trial 5 uses the final shared reader, including empty-hit handling, in both modes. Thus its baseline reconstructs the main focused runner with that shared reader fix, rather than checking out an immutable old binary. Trials 1–4 ran before the empty-hit fix. Raw reports from those invocations use the earlier `main-a965fcff` label; this distinction matters when reproducing the comparison.

The local CLI adapter incurs process/network costs and does not exercise D1, native authentication transport, WebSocket delivery or an iPhone UI. These timings are comparisons of answer generation through this adapter, not production or device latency guarantees. Each pair can generate different searches and answer lengths.

| Trial / implementation | HTTP-handler question | Provider rounds | Citations | Absent revenue question | Provider rounds |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 baseline | 28.325 s | 5 | 5 | 19.322 s | 4 |
| 1 initial prefetch | 13.923 s | 4 | 5 | 13.948 s | 5 |
| 2 baseline | 29.726 s | 5 | 5 | 15.741 s | 3 |
| 2 initial prefetch | failed required-field validation | 5 received responses | no answer published | 8.686 s | 3 |
| 3 baseline | 26.402 s | 5 | 5 | 14.150 s | 3 |
| 3 corrected prefetch | 12.739 s | 3 | 5 | 5.617 s | 2 |
| 4 baseline | 21.324 s | 4 | 4 | 18.106 s | 4 |
| 4 corrected prefetch | 16.708 s | 4 | 6 | failed on empty body read | 3 received responses |
| 5 baseline runner with shared reader fix | 21.669 s | 4 | 4 | 28.732 s | 6 |
| 5 final prefetch | 14.449 s | 4 | 5 | 11.487 s | 5 |

Trials 2 and 4 are retained as failures, rather than excluded from the results. Trial 2's two initial searches also exposed a missed optimization opportunity, addressed by supporting the initial search batch. Trial 3 passed all four runs after these changes. Trial 4's `empty_excerpt_or_budget` error was caused by an empty node, not budget exhaustion, and led to the focused empty-hit handling change. The bounded structure correction is verified by deterministic missing-field and repeated-malformed-response tests; trial 3 did not need a correction.

Trial 5 passed all four runs, including the semantic assertions and exact citation validation. The known answer retained five citations and the unknown answer remained insufficient, with no invented financial amount. The known question took 14.449 s versus 21.669 s in this pair (about 33% less elapsed time); provider rounds were equal at four, so this trial does not demonstrate a round-count reduction. Empty-hit continuation is verified by the reader regression test; the stochastic final run does not prove that the exact failed trial 4 path was reproduced.

For the HTTP-handler question, the corrected run still retrieved the later POST, FormData and Request-instance chunks and returned five validated citations. The answer explains GET/POST assertions, body handling and an absolute URL for `Request`. For the absent-revenue question it set `insufficient=true`, returned no invented amount, and limited the absence statement to the searched material. The live harness asserts grounded `app.request` content and a testing-document citation for the known question, and insufficient evidence for the unknown question. All successful runs passed the production exact-excerpt citation validator.

Raw reports remain local: `/private/tmp/askai-focused-prefetch-live-{1,2,3,4,5}.json`. They contain excerpts and generated answers but no credentials. Test/build logs are in `/private/tmp/askai-prefetch-worker-final-tests.log`, `/private/tmp/askai-prefetch-ios-tests.log` and `/private/tmp/askai-prefetch-final-build.log`.

## Limits

This small question set does not establish a general accuracy rate, stable p50/p95 latency or behavior under concurrent load. Citation validation establishes that quoted text exists in retrieved evidence; it does not prove every explanatory sentence correct. Prefetch may read an irrelevant hit or require further model-directed reads. Schema repair may add a provider round, and a second malformed answer still fails closed. iOS request-count savings are verified with URLProtocol tests; actual device time savings require the updated app and a production deployment. This branch has not been deployed or distributed to iOS.
