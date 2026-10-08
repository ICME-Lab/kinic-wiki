# AskAI Worker CPU validation — 2026-10-07

## Result

The local Miniflare/workerd measurements do not show increased CPU consumption from focused-search prefetch. They do **not** establish that the unpublished working-tree implementation stays within Cloudflare's production CPU budget.

A read-only production telemetry query found one historical `exceededCpu` outcome. The current deployed version had no such outcome among the retrieved 11 measured invocations. Therefore CPU exhaustion has happened in this application, but was not observed in this small current-version sample.

## Local measurements

`workers/wiki-assistant/scripts/profile-text-turn.mjs` runs bundled assistant modules in Miniflare/workerd. It takes V8 inspector profiles, then stops the profiler and separately measures kernel CPU counters for its own workerd child process. Each scenario/mode has five warm unprofiled process-CPU measurements. The table reports their median.

| Synthetic scenario | History fixture entries | Before / baseline CPU | Optimized CPU |
| --- | ---: | ---: | ---: |
| Overview, legacy sequential retrieval vs seeded overview | 0 | 6.921 ms | 1.809 ms |
| Overview, same comparison | 20 | 12.414 ms | 2.524 ms |
| Focused search, main-style adjacent batched reads vs prefetch | 0 | 4.600 ms | 3.759 ms |
| Focused search, same comparison | 20 | 11.505 ms | 11.235 ms |
| Focused search with 1 MiB Candid document replies | 0 | 3.889 ms | 3.845 ms |
| Focused search with 1 MiB Candid document replies | 20 | 8.414 ms | 7.315 ms |

Focused fixtures retain two concurrent body reads in both modes. Prefetch reduces synthetic provider requests from three to two and checkpoint calls from eight to seven. All responses passed citation validation. The Candid fixture uses the actual `read_node` return schema from `readIdlFactory`; warm reads decode cached packed replies. The first profiled iteration also prepares/encodes fixture replies and is not used for the warm process-CPU median.

These numbers are local **process CPU**, not Cloudflare's billed or quota CPU time. They include local workerd infrastructure and native crypto. V8 sample-duration totals are preserved in the raw reports but can include suspended frames/I/O gaps and omit native crypto; they are not presented as CPU-time measurements. The machine and runtime warmup affect small timings, and these separate runs do not support precise percentage-reduction claims.

The fixtures mock provider and ranked search results. Actual IC transport/signing, Jev, D1 operations, native session authentication, combined HTTP history retrieval, Durable Object scheduling and production concurrent load are not profiled here. Each synthetic checkpoint encrypts all fixture history; actual incremental history persistence is not represented. Large Candid replies exercise decoded payload handling, not the full real IC HTTP-agent path. No external service calls, production changes or real credentials are used by this benchmark.

The 35 workerd regression tests and Worker TypeScript check passed. A successful local run does not prove the absence of CPU limit failures: [Cloudflare's configuration documentation](https://developers.cloudflare.com/workers/wrangler/configuration/#limits) states that configured runtime limits are enforced on Cloudflare's network, not in local development. [Cloudflare's CPU profiling documentation](https://developers.cloudflare.com/workers/observability/dev-tools/cpu-usage/) also explains why local profiling must use representative requests and data.

## Production observations

Queried `kinic-wiki-assistant` logs for a 24-hour window ending at Unix timestamp `1791372809884`, through the official `cf observability telemetry query` with the `kinic-production` profile. Received 204 events, with 198 invocation CPU measurements across several deployed versions. This is the returned log sample, not a guarantee of complete traffic coverage.

- Across versions: 196 invocation outcomes `ok`, one `exceededCpu`, one `exception`.
- Historical CPU failure: `2026-10-07 11:58:19.597 JST`, `GET /api/assistant/native/conversation`, version `d9a26632-9ef9-4fda-9edd-abf755293737`, `cpuTimeMs=10`, `wallTimeMs=758`. This predates the current deployment. That event identifies the affected request, but does not by itself identify the CPU-heavy function or current configured limit.
- Current deployed version `e891c451-1716-448c-b656-280938ead3b2`: 11 measured invocations, all `ok`; median CPU 1 ms, maximum 35 ms. The sample includes scheduled work and HTTP work and is too small for a meaningful traffic-wide p95.
- Largest CPU value across older versions: 711 ms with `outcome=ok`; this is not attributed to the current working-tree prefetch implementation.

The CPU log audit is stronger evidence for production budget behavior than local elapsed time. The current prefetch branch has not been deployed, so its actual production CPU remains to be measured after an authorized deployment. No resource limits, account plan, bindings or secrets were changed.

## Reproduction and artifacts

From `workers/wiki-assistant`:

```sh
ASKAI_PROFILE_OUTPUT=/private/tmp/askai-cpu-overview.json node scripts/profile-text-turn.mjs
ASKAI_PROFILE_SCENARIO=focused ASKAI_PROFILE_OUTPUT=/private/tmp/askai-cpu-focused.json node scripts/profile-text-turn.mjs
ASKAI_PROFILE_SCENARIO=focused ASKAI_PROFILE_CANDID_BYTES=1048576 ASKAI_PROFILE_OUTPUT=/private/tmp/askai-cpu-candid.json node scripts/profile-text-turn.mjs
pnpm exec vitest run --config vitest.worker.config.ts
```

This run's reports: `/private/tmp/askai-cpu-overview-20261007.json`, `/private/tmp/askai-cpu-focused-20261007.json`, `/private/tmp/askai-cpu-candid-large-final-20261007.json`, `/private/tmp/askai-cpu-production-telemetry.json` and `/private/tmp/askai-cpu-production-error-details.json`. Production reports retain CPU metrics, outcomes, version identifiers and the historical error's pathname; they omit request headers, URL queries, questions and document text.
