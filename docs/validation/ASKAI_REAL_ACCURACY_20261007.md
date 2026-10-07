# Ask AI: real Wiki, Jev and DeepSeek comparison

Date: 2026-10-07. **Result: performance improvement observed, reliability gate failed.** No production deployment or Wiki writes were performed.

Update after the follow-up fix: the optimized implementation completed all eight answer-generation attempts below, including four overviews, without whitespace responses. This supersedes the initial optimization failure for the tested sample, not as a guarantee of production reliability. Comparison-wide tests still expose a legacy schema failure and clarification outcomes; see follow-up results.

## Execution and scope

Used the previously tested database `db_23dhmsxlhukv` on production canister `6emaw-iyaaa-aaaay-aacka-cai`. Anonymous status and document reads succeeded. Compared sequential model-directed retrieval against the current seeded/batched text-turn implementation, using real Jev routing, real Jev search reranking when applicable, and real DeepSeek `deepseek-flash` responses. Alternated mode order between cases.

Both modes use the current reader and provider runner; the legacy mode reconstructs sequential retrieval and per-tool authorization rather than running a historical deployed binary. Local CLI adapters perform actual canister reads. Checkpoints are no-ops: D1, native authentication, WebSocket delivery and actual iOS UI latency are **not** included. This evaluates retrieval/answer generation, not full production end-to-end behavior.

The initial five paired cases tested the same overview twice, a selected Hono index summary, a focused `app.request` search, and an unavailable 2027 revenue figure. Added two overview pairs after a failure. All 14 Jev route classifications matched the intended routes. Focused questions also exercised live reranking of search previews. API keys were loaded from the existing local environment file and were not logged or included in reports.

## Measured results

| Case | Sequential | Optimized | Outcome |
| --- | --- | --- | --- |
| Overview, initial pair 1 | 31.022 s, 5 model calls | Failed at 4.859 s | `deepseek_invalid_response` |
| Overview, initial pair 2 | 24.016 s, 3 model calls | 8.724 s, 1 model call | Both valid answers |
| Selected Hono index | 9.302 s, 2 model calls | 3.888 s, 1 model call | Both valid answers |
| Focused HTTP testing search | 27.367 s, 4 model calls | 12.772 s, 4 model calls | Both valid answers; caveat below |
| Unavailable revenue figure | 19.820 s, 4 model calls | 9.161 s, 4 model calls | Both insufficient, no invented revenue |
| Overview, repeat pair 1 | 26.830 s, 4 model calls | 11.409 s, 1 model call | Both valid answers |
| Overview, repeat pair 2 | 31.619 s, 5 model calls | Failed at 5.112 s | `deepseek_invalid_response` |

Sequential: 7/7 completed. Optimized: 5/7 completed; optimized overviews: 2/4 completed. These small sample counts do not estimate production failure rates. Success-only timings must not conceal the failed requests. Focused-search model-call counts were unchanged; timing differences combine retrieval overhead, different model-selected reads/output and variable API latency, so they do not establish a stable speedup for that route.

Both live Vitest runs **failed** their all-answers-complete assertion. The repeat preserved the provider response for diagnosis. Its failing overview received HTTP 200 with `finish_reason: stop` and an assistant `content` consisting only of whitespace. There was one model request. The current runner correctly rejects this as invalid JSON. The first failure used the same error code, but its raw response was not retained, so its cause is not proven identical.

## Accuracy assessment

Manually compared successful answers with their retrieved evidence, in addition to the application's exact citation validation. All 12 completed answers passed schema/citation validation (36 resolved citations total).

- Overview answers retained the two main observed groups: Hono development documentation and Sol/Luna agent-strategy notes. They disclosed truncated inventory. Sequential answers tended to cover routing; optimized answers covered runtime setup from a different representative note. No whole-database coverage claim is justified by these four-document samples.
- Both selected-index summaries retained the source identifier, payload count 945, knowledge scope and provenance path, and explained that the index does not contain API examples. This is one short document, not evidence of long-document summarization quality.
- Both focused answers covered GET/POST requests, status, headers and response bodies with supporting evidence. Their selected document sets differed: the sequential answer also covered FormData, while the optimized answer added an example from the `App - Hono: request()` note.
- **Practical accuracy concern:** that additional example contains `new Request('Hello!', { method: 'POST' })`. It matches the retrieved source, but Node's standard Request constructor throws `TypeError: Failed to parse URL from Hello!`. Thus source fidelity and valid citations do not guarantee executable code. This observation does not prove the optimization introduced the source defect; it shows a limitation of the current answer validation.
- Both revenue answers explicitly reported missing evidence and set `insufficient: true`; neither fabricated an amount or currency.

## Reproduction and evidence

Live test: `workers/wiki-assistant/tests/speed-accuracy.live.test.ts`, explicitly opted in with `KINIC_LIVE_PRIVATE_EGRESS=1`, target IDs, `ASKAI_ACCURACY_OUTPUT`, and existing provider keys. The repeat filters cases via `ASKAI_ACCURACY_CASES=overview-1,overview-2` and captures provider responses without request headers. `ASKAI_CAPTURE_ONLY=1` creates a local review packet without model egress.

Local reports (contain Wiki excerpts and answers; no API keys):

- `/private/tmp/askai-accuracy-egress-preview.json`
- `/private/tmp/askai-real-accuracy-comparison.json`
- `/private/tmp/askai-real-accuracy-overview-repeat.json`

`pnpm typecheck` and `git diff --check` passed after adding the live evaluation. The prior 176 local automated tests passed, but they did not predict the real provider's whitespace-only response. The overview reliability failure must be addressed and re-evaluated before treating the optimization as ready for production. Actual iOS/native production timing remains unverified.

## Follow-up implementation

Added an explicit user message after deterministic retrieval, requesting a nonempty final JSON answer for overviews and preserving additional excerpt reads for selected summaries. The provider runner now recovers once from a fully received assistant response whose string content is whitespace-only. It records the recovery count and prompt in the existing durable turn state and checkpoints before sending the correction. A second blank response fails. Other malformed responses and ambiguous in-flight submissions retain their existing failure behavior. Authorization, cancellation and deadlines remain checked before provider egress; retrieved evidence and citation validation are preserved.

The answer instructions now flag potentially invalid source code, including a Request constructor whose input is not a valid URL, and prohibit claims of execution that was not performed. This is an instruction-level quality improvement, not a general code execution validator.

Added tests for blank-response recovery, retry bounds, recovery-prompt persistence across restart, ambiguous recovery submission and revoked authorization, plus a workerd test ensuring that recovery does not repeat the seeded reads. All **182 automated tests passed** (145 unit, 35 workerd and two Node tests), and typechecking passed. The changes are local and undeployed.

## Follow-up real-model results

| Case | Sequential retrieval with updated answer instructions | Optimized retrieval with updated answer instructions |
| --- | --- | --- |
| Overview, pair 1 | 31.456 s | 10.681 s |
| Overview, pair 2 | Failed: missing required `insufficient` | 8.067 s |
| Selected index summary | 9.774 s | 4.196 s |
| Focused HTTP testing search | 29.335 s | 15.635 s |
| Unavailable revenue figure | 22.644 s, insufficient | 7.271 s, insufficient |
| Overview, repeat pair 1 | 33.316 s | 9.616 s |
| Overview, repeat pair 2 | 34.437 s | 11.770 s |
| Code-example document, clarified summary request | 10.559 s | 4.450 s |

Optimized: **8/8 answer-generation attempts completed**, with 23 resolved citations passing validation. Overviews: **4/4 completed, one provider call each, 8.067–11.770 seconds**. No whitespace response was observed in this follow-up real-model sample, so recovery itself was exercised through unit/workerd injection, not a newly observed real-provider blank response. Both overview theme groups and inventory-truncation caveats were retained. The unavailable revenue answer remained insufficient and did not invent an amount.

The initial follow-up comparison Vitest run failed because the sequential baseline omitted `insufficient`; the optimized five answers all completed. The second run's four overview answers all completed, but its code-example question returned clarification-required in both modes. The initial wording asked whether the code could run; Jev did not select a confident route. Rewording it as “選択した文書を要約して。Requestを使うコード例の注意点も説明して。” selected `selected_node_summary` in both modes, and that dedicated live test passed. Clarification outcomes are recorded, not counted as successful answers or silently dropped from the experiment.

For the clarified code-example question, both answers identified `'Hello!'` as an invalid Request URL, separated a proposed correction from the original source, and explicitly stated they had not executed the example. Independently checked that the proposed `new Request('http://localhost/message', { method: 'POST', body: 'Hello!' })` constructs a Request with the expected URL, method and body; this does not validate a complete Hono handler or the asserted response status. The general focused answer now retrieved the valid absolute-URL example and also included GET, POST, FormData and response assertions.

Evidence:

- `/private/tmp/askai-real-accuracy-after-fix.json`
- `/private/tmp/askai-real-accuracy-after-fix-repeat.json`
- `/private/tmp/askai-real-code-quality-after-fix.json`

The sample supports the implemented improvement without establishing broad model accuracy or zero production failures. Automatic recovery remains deliberately limited to received whitespace responses; missing fields or invalid citations still fail rather than being guessed. No deployment, Git commit or iOS distribution was performed. Actual iOS/native production timing remains outstanding.
