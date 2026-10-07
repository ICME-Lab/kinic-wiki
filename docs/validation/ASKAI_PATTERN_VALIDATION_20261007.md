# AskAI question-pattern validation — 2026-10-07

Branch: `perf/askai-focused-prefetch`, working-tree implementation. No production deployment or iOS distribution was performed for this validation.

## Method

14 question patterns were run through the real Wiki (`db_23dhmsxlhukv`, canister `6emaw-iyaaa-aaaay-aacka-cai`), real Jev intent routing/reranking and DeepSeek Flash. Routes were not forced. The optimized-only live harness used the native text runner, authorized reader and exact-excerpt citation validation. Responses were manually reviewed for relevance, language and unsupported claims as well as checked by the harness.

This is an answer-generation test via a read-only CLI adapter. It does not establish iPhone display latency, production D1/transport behavior, concurrency performance, or a general accuracy percentage. Timings include the local adapter and are single observations.

## Initial results

| Pattern / actual question | Time | Citations | Assessment |
| --- | ---: | ---: | --- |
| `このdbについて教えて` | 9.573 s | 4 | Correctly routed to overview; describes Hono documentation and conversation-derived agent strategy notes; discloses incomplete observed coverage |
| `何が入ってるDB？` | 9.754 s | 4 | Same appropriate overview route and coverage caveat |
| English database overview | 8.959 s | 4 | Content and citations available, but answered in Chinese instead of English |
| Overview with themes and uses, first run | 10.174 s | 4 | Describes documentation and strategy-note uses, with coverage caveats |
| Same detailed overview, second run | 9.092 s | 4 | Consistent main themes and caveats |
| Selected index document summary | 4.287 s | 1 | Summarizes index metadata and explicitly says it does not supply API examples |
| Selected document with problematic Request example | 5.280 s | 1 | Flags `new Request('Hello!', ...)` as problematic; distinguishes a proposed URL/body correction from source text and executed code |
| `app.request` HTTP-handler tests | 14.360 s | 5 | Covers GET, POST, FormData and Request-instance examples with validated citations |
| Absent 2027 revenue figure | 9.318 s | 1 | Sets `insufficient=true` and invents no amount; wording still overstates database-wide absence in places |
| CORS origin and allowed methods | 8.171 s | 2 | Explains `origin`, `allowMethods`, multiple origins and dynamic origin callback with source examples |
| Workers versus Node.js comparison | 16.892 s | — | Fails with `tool_limit` after repeated retrieval; no answer published |
| Greeting | 1.417 s | 0 | Conversation response; no Wiki retrieval |
| Translate supplied Japanese sentence into English | 1.911 s | 0 | Wrongly refuses translation even though the supplied sentence requires no Wiki retrieval |
| `これどう？` without a selected target or history | 0.173 s | — | Jev requests clarification rather than forcing an answer route |

All five overview questions used one provider round and four representative document reads. The Japanese short questions worked without asking the user to provide search terms. The inventory was truncated, and the overview answers explicitly acknowledged partial coverage. Counts observed by inventory are not a complete count of all database documents.

The initial test command exited with failure because the runtime-comparison case hit `tool_limit`. Its initial automatic assertions did not detect the wrong response language or translation refusal; manual review did. The harness now also checks the opening language of the English overview and expected `tomorrow`/`meeting` content and non-insufficiency for translation, while preserving answers in semantic-failure reports. These coarse checks supplement manual review; they do not prove factual correctness.

## Issues to address

1. **Repeated retrieval consumes the tool budget on cross-document comparisons.** The failed runtime question issued several searches, reread the Workers document, requested sources, and then requested more searches. Retrieval should stop gracefully before exceeding the budget and answer only supported parts, or explicitly state missing evidence. Avoid changing the cap without accounting for privacy/context limits.
2. **Answer language is unstable.** Correct routing and valid citations did not ensure an English answer. Make requested output language explicit through the answer-generation path and verify it.
3. **Conversation instructions discourage a valid supplied-text transformation.** The translation was correctly routed to `conversation` with no Wiki calls, but refused as though the Wiki tools needed a translation capability. Clarify that supplied-text rewriting/translation can be performed without retrieval or database claims.
4. **Absence statements need narrower wording.** `insufficient=true` is appropriate for the revenue question, but searches do not prove that the entire DB contains only technical Hono documents. The overview also found agent-strategy notes. Prefer “not found in the searched material” over a database-wide absence claim.

These are validation findings, not fixes performed in this turn. Production behavior was not changed.

## Targeted repeat

Four cases were repeated without changing production code, with the added semantic assertions enabled:

| Case | Time | Result |
| --- | ---: | --- |
| Exact `このdbについて教えて` | 9.020 s | Passed, one provider round, four citations, same main themes and incomplete-coverage caveat |
| English overview | 8.840 s | Failed language check; again answered in Chinese, although four citations were valid |
| Workers versus Node.js comparison | 15.261 s | Passed this time, three rounds and five citations; earlier `tool_limit` remains an intermittent failure |
| Supplied-text translation | 2.002 s | Failed again; refused and set `insufficient=true` |

The repeat test exited with failure for the two semantic errors. Across the 14-pattern initial run and four targeted repeats there were 18 executions. This is not a reliable accuracy-rate estimate. In particular, the comparison succeeded on repeat but has not been fixed, while the answer-language and translation problems reproduced twice. The Japanese overview question succeeded twice.

## Artifacts

Raw initial report: `/private/tmp/askai-patterns-live-20261007.json`; log: `/private/tmp/askai-patterns-live-20261007.log`. Reports include source excerpts and model answers but no credentials. The live harness is `workers/wiki-assistant/tests/speed-accuracy.live.test.ts`, with `ASKAI_ACCURACY_MODE=optimized` selecting one run per pattern. Worker TypeScript checking passed after the harness changes.

Targeted repeat: `/private/tmp/askai-patterns-repeat-20261007.json` and `/private/tmp/askai-patterns-repeat-20261007.log`.
