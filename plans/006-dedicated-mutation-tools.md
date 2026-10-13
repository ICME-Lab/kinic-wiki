# Dedicated Wiki MCP mutation tools

Implemented and verified locally on 2026-10-13. No deployment, live wiki writes,
or OpenAI rescan was performed. The isolated PR scope and its checks are recorded
below.

## Implementation

- Private MCP exposes eight reads and eight mutations (16 tools). Read-only
  configurations expose the same eight reads and omit mutation instructions.
- Added `append_nodes`, `edit_nodes`, `multi_edit_nodes`, `create_folders`,
  `move_nodes`, and `delete_nodes`. Each accepts `database_id` and 1–100
  `operations` of its fixed kind. Public item schemas omit `type` and reject
  attempts to supply it. The existing 256 KiB request limit remains applicable.
- Dedicated schemas derive from the existing mixed-operation schemas. Both
  entrypoints use `executeNodeMutations` and `executeMutationBatch`: one canister
  call, common scope/permission and reviewer-boundary checks, both move paths,
  etag handling, failed-index reporting, and bounded conflict/success responses.
- `mutate_nodes_batch` retains its name, input and output schemas, 100-item
  limit, order, and atomic transaction behavior. Its description now identifies
  the individually exposed operations and recommends mixed batches when different
  kinds must commit together. `write_nodes` retains its existing contract.
- Folder creation is non-destructive and idempotent: existing folders are left
  unchanged, and non-folder collisions fail. Other dedicated tools retain the
  destructive-capable/non-idempotent annotations; append can duplicate content
  and replace metadata/kind. All mutation tools disclose possible public effects.
- No canister implementation, Candid contract, or storage change was introduced
  for this task. Added Rust regression tests exercise the existing transaction
  implementation.

## Guides and submission artifacts

Updated server instructions, the `kinic-wiki-mcp` guide/tool reference, MCP docs,
Worker README, privacy tool inventory, submission metadata, descriptor snapshots,
and smoke/fixture scripts. Dedicated tools are preferred for same-kind work;
mixed atomic transactions must not be silently split into separate calls.

The five positive and three negative submission cases remain. The dedicated
write case now exercises all six new tools, verifies the final content, and
cleans the moved file before its newly created folder. The mixed case keeps edit
and delete in one transaction. Both executable scenarios have local fixture
tests; cleanup uses `delete_nodes` and current etags. The folder is cleaned only
after its creation has been confirmed. No live submission cases were executed.

Snapshots are generated from MCP discovery using the pinned SDK. A new local
contract test checks the 8/16 tool counts, complete descriptor hashes, and the
type-free dedicated schemas. In-memory descriptors are JSON-normalized to match
HTTP transport before hashing. Intentional regeneration:

```sh
UPDATE_MCP_DESCRIPTORS=1 pnpm --dir workers/wiki-mcp exec vitest run tests/descriptor-contract.test.ts
```

## Verification

| Check | Result |
| --- | --- |
| MCP full suite | 81 Node tests + 219 Vitest tests + 36 Worker/DO tests = 336 passed |
| MCP TypeScript | `pnpm --dir workers/wiki-mcp typecheck` passed |
| Submission consistency | Included in Node tests: schema, 16 tool names, guides, annotations, five positive/three negative cases |
| Dedicated tools | One/100 items, zero/101 rejection, fixed-kind schema, scope/action/identity checks, reviewer database/prefix, both move paths, etag errors, no retry, response byte limits |
| Store transactions | `cargo test -p vfs-store --test fs_store_vfs`: 29 passed |
| Private Worker build | `pnpm --dir workers/wiki-mcp build:private` (`cf deploy --dry-run --mode private`) passed; no upload |
| Patch whitespace | `git diff --check` passed |

The store tests confirm edit → move → delete results in order, full rollback
when the final delete conflicts, and unchanged content/etags after rollback.
Existing move-overwrite/destination-etag and midway failure tests also pass.
Repeated-path operations check the intermediate state: reusing an etag after an
earlier edit fails and rolls back the whole batch. This existing behavior is
documented; no implicit etag substitution or transaction splitting was added.

## Review follow-up and isolated PR verification

### Review follow-up: failed-mutation cleanup

Fixed the submission smoke cleanup losing the last confirmed content before an
append/edit/multi-edit or mixed edit/delete request completed. It now preserves
the confirmed content plus the pending content until success is acknowledged.
After an uncertain result, cleanup rereads the page, accepts only those two
owned content states, and deletes with the freshly read etag. Unrelated content
is preserved, and the original operation error is still reported after cleanup.

Added 14 regression cases covering rejection, request loss, committed response
loss for all four mutation paths, mixed-batch rollback after the edit, and a
concurrent foreign edit. The local fixture restores its transaction snapshot on
failure. All 95 Node script tests passed (including 25 submission smoke tests),
and `git diff --check` passed. This follow-up changes only smoke scripts/tests
and this record; Worker/Rust builds were not rerun. No live wiki writes occurred.

### Isolated PR checks

Selected only the dedicated-tool changes and cleanup fix on
`feat/wiki-mcp-dedicated-mutations`, leaving search/OAuth/page changes unstaged.
Exported the staged Git tree into a separate local source directory and installed
its frozen dependencies offline. Against that isolated tree:

- MCP full suite: 95 Node + 192 Vitest + 38 Worker/DO = 325 tests passed.
- Candid subset consistency and TypeScript checks passed.
- `cargo test -p vfs-store --test fs_store_vfs`: 29 passed.
- `pnpm --dir workers/wiki-mcp build:private`: cf dry-run passed, no upload.
- Staged whitespace check passed.

These counts differ from the earlier combined working-tree run because the PR
excludes search additions and retains the main branch's OAuth tests. Also removed
outdated two-tool wording and mixed-batch recommendations from the guides.

## Scope and later publication

Existing uncommitted search, OAuth, and page work was preserved. This task changes
mutation registration/metadata, guides/submission artifacts, smoke scripts, and
related tests. Shared files (`src/index.ts`, `docs/mcp.md`) contain pre-existing
changes too; select only this task's hunks if committing it separately.

Publishing the Worker and rescanning OpenAI are separate steps. A successful local
test does not prove that OpenAI accepts the retained mixed-batch tool. If the
finding remains, prepare an explanation of individually exposed operations and
the need for atomic mixed transactions; do not automatically remove the tool or
reduce functionality. The earlier body-read memory finding remains separate.
