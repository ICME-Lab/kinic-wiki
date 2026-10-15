# LLM-led Wiki maintenance

`index.md` is a persisted, curated agent catalog. LLM ingest/edit workflows maintain it and periodic maintenance finds missed work. Catalogs may lag; actual inventory and search remain available. `query_context` retains its existing catalog-first ordering; this change does not introduce new context-budget or fallback behavior. No save hook or background deterministic catalog rebuild is installed.

The browser's ordinary folder view shows actual children and an optional collapsible `overview.md` description. Folder Edit edits the overview; catalogs remain explicitly readable as files. Existing catalogs are preserved. Splitting an index's descriptive prose into an overview is an evidence-aware maintenance repair, not a migration at application startup.

## Run contract

Install `kinic-wiki-maintain`, `kinic-wiki-lint`, and `kinic-wiki-edit` from the same revision. The complete contract is in [maintain.md](../skills/kinic-wiki-maintain/maintain.md). Inputs are canister, database, Knowledge prefix, inspect/repair mode, budgets, and a local report destination. Defaults: inspect, `/Knowledge`, 3 passes, 20 distinct changed nodes, 15 minutes. Remote access requires a supplied target and an authorized identity.

Lint alone never writes. Explicit repair mode authorizes supported non-destructive edits inside the prefix. Inspect, choose repairs, reread and guard edits with etags, then reinspect. Missing evidence, listing caps, partial coverage, conflicts, permissions, and budget stops remain unresolved. No article deletion, source changes, publication, or deployment is implied. A narrower prefix cannot authorize edits to its parent catalog.

Validate a report using:

```sh
python3 skills/kinic-wiki-maintain/scripts/validate-report.py outputs/wiki-maintenance/report.json
python3 -m unittest discover -s skills/kinic-wiki-maintain/tests
```

The validator enforces completion/report invariants; it cannot prove an LLM inspected the claimed content. Preserve command and readback evidence. The isolated tests cover report acceptance/rejection. `skills/kinic-wiki-maintain/tests/fixture_wiki.py` also provides an offline VFS rehearsal adapter: initialize a fresh `--state` file, inspect inventory and bodies, then perform explicitly scoped etag writes with `--mode repair`. It never contacts a canister. Use it for an LLM-led rehearsal of mixed-description repair, broken-link repair, and no-change reinspection; keep reports and readback evidence. This does not replace deployment validation against a selected canister.

## Distribution

Repository `skills/` is the canonical source for the Wiki workflow packages. Before replacing an installed package, compare it and review installed-only instructions; preserve useful customizations in the repository deliberately, not by blindly copying obsolete instructions. Back up the installed packages outside the install root, then install each complete repository package through the environment's skill installation flow. Ship the five query/ingest/edit/lint/maintain packages from the same Git revision and record that revision with the deployment. Do not modify arbitrary user skills as a side effect of application deployment.

```sh
node scripts/check-wiki-skill-distribution.mjs --installed-root /absolute/path/to/installed/skills
```

The command only reads files, reports missing/different/installed-only paths, and exits 1 on drift (0 on parity, 2 on bad usage). It compares supporting files as well as SKILL.md, ignoring Python caches. Run again after installation. Local installed skills and published registry packages are separate deployment targets; repository edits do not silently update either.

## Periodic runner

Use the prompt example in maintain.md with explicit target, authorized identity, mode, budgets, and a per-run report path. Configure cadence in the chosen runner and prevent overlapping runs for a target/prefix. Stay quiet for clean unchanged runs; notify for meaningful improvements, failure, or user action. Retain reports across runs so unresolved findings remain visible. No recurring job is created by this change.

`rebuild-index` and `rebuild-scope-index` remain explicit broad-repair tools. They replace catalog bodies and are not the ordinary LLM maintenance loop. Context Pack's exported `index.md` is a separate artifact and retains its format.
