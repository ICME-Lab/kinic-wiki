# Maintenance execution contract

## Inputs

Require an explicit canister ID and database ID before remote access. Use an absolute Knowledge `prefix` (default `/Knowledge`) and `mode` (`inspect` by default, or explicitly authorized `repair`). Confirm access using `status --json`.

Budgets default to `max_passes: 3`, `max_changed_nodes: 20`, `max_minutes: 15`. Each must be positive; a caller may override them. Count distinct changed paths across the entire run, including indexes and descriptions. Inspect mode changes zero nodes. Check elapsed time and remaining budget before each additional read batch or mutation; do not start work that knowingly exceeds the budget. Record actual elapsed time even when an in-flight call overruns the deadline.

A repair request accepts evidence-backed index/link/description and article-organization edits within the prefix, including creation of a useful missing index or overview. It does not authorize article deletion, moving nodes, access changes, raw `/Sources` edits, unsubstantiated factual changes, or changes outside the prefix. Changes to parent indexes outside the prefix must be reported for a separately scoped run. A lint finding alone is not permission to write.

## One pass

1. Inspect using `kinic-wiki-lint`. Pass the target prefix explicitly as `query_context.namespace` / CLI `--namespace`; the public API defaults to `/Memory`. Enumerate current paths and inspect relevant article bodies, index links, and descriptions. Inventory comes from actual nodes, not the catalog. Record commands/queries and inspected paths.
2. Establish coverage. A listing at its limit is not proof of completeness. Use `list-children` for bounded subtrees or read-only database SQL with ordered keyset batches (`path > last_path`, ordered by path) under an exact prefix boundary. Escape SQL literals. If any subtree or body required for the claimed checks is unread, record it as uninspected and keep coverage partial. Reconcile the inventory again after edits; concurrent changes require reinspection or partial coverage.
3. Report findings with stable ID, affected paths, observed impact, evidence, and a focused repair. Check empty/stale catalogs, broken links, missing routes to important notes, misleading descriptions, duplicate or isolated notes, and note-role violations. Not every article belongs in an index; never call a curated omission a defect without a navigation impact.
4. In inspect mode, stop with findings and no writes. In repair mode select only supported, in-scope repairs that fit the remaining budget. Read current content and etag immediately before each write, and use etag guards. Skip unchanged content. Do not silently use rebuild commands or replace a curated index with a full inventory.
5. A conflict invalidates the proposed edit: reread, reevaluate the finding, and retry at most once within budget. If it conflicts again, retain it as unresolved. A permission error stops mutations. Preserve successful earlier edits; report partial progress rather than claiming transaction-wide rollback.
6. Reinspect each repair: read the saved body, verify new links resolve, check preserved content and role boundaries, and rerun the affected lint checks. A successful write acknowledgement alone is not verification. Only then mark a finding resolved. Reconcile affected folder inventory to detect additions during the pass.
7. Continue while actionable issues remain and budget permits. Stop when a complete inspection finds no remaining issues; otherwise report the actual stopping reason. Stable content must not be rewritten just to produce activity.

## Catalog and description rules

- `/Knowledge/index.md` is the agent's root navigation entry. Subfolder indexes guide readers to important direct children and child scopes. A missing scoped index is actionable only when useful navigation is absent; do not create templates in empty folders or add `none` sections.
- Indexes describe navigation, not completeness or evidence. Keep classification, short summaries, and reading order where helpful. Use listing for exhaustive inventory and article bodies plus source evidence for answers.
- `overview.md` is the optional reader-facing synthesis/description displayed by the browser. Do not create empty overviews. When splitting prose out of an index, read any existing overview first, preserve unique claims, provenance, and links, merge without duplicating content, verify the overview, then remove only the transferred prose from the index. Never delete the index. If either write fails, preserve the recoverable intermediate state and report the unfinished split.
- Validate relative links against each file's actual path. Keep useful existing index links and descriptions, and repair references to moved/deleted articles using confirmed destinations; do not invent replacement targets.
- Article improvements must be justified by inspected evidence. Preserve exact settled values. Flag ambiguous claims and destructive duplicate consolidation for user review.
- If a relevant `log.md` exists and logging is required, append only, within the same scope and node budget; do not create a log by default.

## Output and completion

Write a local JSON report to the caller's output path (default `outputs/wiki-maintenance/report.json` in the task workspace), never implicitly into the Wiki. Include:

- `target`: `canister_id`, `database_id`, `prefix`, `mode`.
- `budgets`: `max_passes`, `max_changed_nodes`, `max_minutes`.
- `passes`, `elapsed_minutes`, `coverage`: `complete`/`partial`, `inspected_paths`, `uninspected_paths`, and `evidence` (commands, queries, and inventory observations).
- `findings`: objects with `id`, `paths`, `impact`, `evidence`, `status` (`open`/`resolved`), and `verification` (required for resolved findings).
- `changed_paths`, `verification` (chronological objects with absolute `path`, `result`: `passed`/`failed`, and `evidence`; the last entry for each path is its final result), `unresolved` (remaining finding IDs or explicit operational blockers), `stop_reason`, and `status`.

`status` is `complete` only for complete coverage with no open findings, unverified changes, or unresolved blockers. Any path whose final verification failed keeps the run incomplete, including paths that were inspected but not changed. A later successful reinspection may resolve an earlier failure; keep both entries in chronological order. `inspect` with findings returns `needs_repair`; budget, coverage, permission, conflict, or verification stops return `incomplete`, even if some repairs succeeded. Stop reasons are `clean`, `inspection_only`, `pass_limit`, `node_limit`, `time_limit`, `coverage_incomplete`, `permission_denied`, `conflict`, or `verification_failed`. Validate with `scripts/validate-report.py`; never edit the report merely to hide failed verification.

## Scheduler handoff

No scheduler is installed by this skill. A scheduler must explicitly provide target, mode, credentials with appropriate reader/writer access, budgets, and a durable report destination unique to each run. Prevent overlapping runs for the same target/prefix; if that cannot be guaranteed, use etag conflicts and report overlap rather than overwriting work.

Example prompt:

> Use kinic-wiki-maintain for canister <CANISTER>, database <DATABASE>, prefix /Knowledge, mode repair. Use this runner's existing authorized writer identity. Limit to 3 passes, 20 changed nodes, and 15 minutes. Save the report to <RUN_OUTPUT>/report.json. Keep quiet when complete with no changes; notify only for meaningful improvements, failures, or required user action. Do not delete articles, change sources, or deploy anything.

Schedule frequency and runner identity are deployment configuration. Do not create a recurring job or repair production content as an installation side effect.

## Local validation and rehearsal

Resolve these commands relative to this skill directory:

```sh
python3 scripts/validate-report.py /absolute/path/to/report.json
python3 -m unittest discover -s tests
```

The validator checks report consistency, not whether the LLM actually inspected the claimed content. Preserve command and readback evidence. `tests/fixture_wiki.py` is an offline VFS rehearsal adapter: initialize a fresh `--state` file, inspect inventory and bodies, then make etag-guarded writes with `--mode repair`. It never contacts a canister. Rehearse mixed-description and broken-link repairs, preservation of existing prose, and no-change reinspection. This does not replace validation against a selected canister.
