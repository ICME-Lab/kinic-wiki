# Plan 001: Parallelize production wiki generation on the standard Queue Worker

## Status

- **Priority**: P1
- **Risk**: HIGH
- **Planned at**: commit `0533681d`, 2026-07-16
- **Status**: IMPLEMENTED, review gate blocked by external code-export policy

## Goal

Run only `source` generation messages concurrently inside a Queue batch, starting with
`max_batch_size = 4` and `max_concurrency = 5`. Keep source capture and link-preview
work sequential. Use only Cloudflare features available to the current free account; do not use
Dynamic Workers or Worker Loader.

## Required behavior

- Acquire a five-minute D1 execution lease with one atomic compare-and-set before paid LLM work.
- Checkpoint generated Markdown in D1 before VFS commit and resume commit without a second LLM call.
- Preserve the generated checkpoint after commit retries are exhausted; manual requeue resumes commit.
- Delay active-lease duplicates by re-enqueuing them before acknowledging the original delivery.
- Bound DeepSeek calls to 180 seconds and responses to 256 KiB; reject redirects.
- Classify transient provider/D1/VFS failures for delayed retry and permanent input/auth/schema
  failures for terminal status.
- Apply exactly one per-message `ack()` or `retry()` after processing settles.
- On the fifth transient failure, publish a sanitized diagnostic to a dedicated failure Queue;
  never use automatic raw-message DLQ forwarding because messages may contain a session nonce.

## Verification

- `pnpm typecheck`
- `pnpm cf-typecheck`
- `pnpm test`
- `pnpm exec wrangler deploy --dry-run`
- local D1 application of migrations 0001 and 0002
- `/Users/0xhude/Desktop/MyCLI/checker/lint.sh`
- `/Users/0xhude/Desktop/MyCLI/checker/check.sh`
- `codex-review-gate`

All local checks passed. The read-only Codex reviewer could not be started because the execution
environment rejected exporting repository contents to an external review service. No commit was
created; explicit approval is required before retrying that gate.

## Rollout

Create `kinic-wiki-generation-failures`, apply D1 migration 0002, then deploy the Worker with
batch 4, timeout 1 second, concurrency 5, and five retries. Hold these settings for the first
100 jobs or 24 hours while monitoring backlog age, 429/5xx rate, retry/failure Queue depth,
LLM/end-to-end p95, and D1/VFS failures. Pause the Queue consumer as the kill switch.
