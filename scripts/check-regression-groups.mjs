// Where: scripts/check-regression-groups.mjs
// What: Verify that the grouped bug-regression coverage required by the 100-bug plan remains wired.
// Why: The concrete regressions live in language-specific tests; this guard keeps the plan-level groups visible.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const groups = {
  security_path_validation: [
    ["crates/wiki_domain/src/lib.rs", "source_path_rejects_non_sources_paths"],
    ["crates/vfs_canister/src/tests.rs", "fs_entrypoints_allow_source_paths_without_schema_validation"],
    ["workers/wiki-generator/tests/source-path.test.ts", "/Sourcesfoo/alpha/alpha.md"],
    ["extensions/wiki-clipper/tests/source-capture-request.test.mjs", "normalizedHttpUrl accepts only http and https"]
  ],
  skill_registry_schema: [
    ["crates/vfs_cli_app/src/skill_registry_tests.rs", "skill_upsert_snapshots_existing_skill_before_update"],
    ["crates/vfs_cli_app/src/skill_registry_tests.rs", "skill_upsert_rejects_noncanonical_skill_ids_before_writing"],
    ["crates/vfs_cli_app/src/skill_registry_tests.rs", "skill_set_status_removes_stale_status_metadata"],
    ["wikibrowser/scripts/check-skill-registry.mjs", "parseProposalRoot|\\/proposals"],
    ["wikibrowser/scripts/check-skill-registry.mjs", "skill..v1"],
    ["skill-registry-web/scripts/check-skill-registry-web.mjs", "skill-evolution-jobs|\\/proposals"],
    ["docs/SKILL_REGISTRY.md", "/Skills/<id>/versions/<snapshot-id>/SKILL.md"]
  ],
  frontmatter_markdown: [
    ["workers/wiki-generator/tests/frontmatter.test.ts", "frontmatter parser requires a whole-line terminator"],
    ["crates/vfs_cli_app/src/skill_registry_tests.rs", "docs/Project (Alpha).md"],
    ["crates/vfs_cli_app/src/skill_registry_tests.rs", "docs/usage.md \\\"Usage\\\""],
    ["wikibrowser/scripts/check-skill-registry.mjs", "docs/Project Plan.md"],
    ["wikibrowser/scripts/check-skill-registry.mjs", "docs/usage.md \\\"Usage\\\""],
    ["skill-registry-web/scripts/check-skill-registry-web.mjs", "docs/Project Plan.md"],
    ["skill-registry-web/scripts/check-skill-registry-web.mjs", "docs/usage.md \\\"Usage\\\""]
  ],
  worker_jobs: [
    ["workers/wiki-generator/tests/processing.test.ts", "missing queued source is recorded as failed"],
    ["workers/wiki-generator/tests/processing.test.ts", "kind: \"source_capture\""],
    ["workers/wiki-generator/src/processing.ts", "source_capture requestPath is invalid"],
    ["workers/wiki-generator/src/jobs.ts", "attempts = 0"],
    ["workers/wiki-generator/src/jobs.ts", "target_path = NULL"],
    ["workers/wiki-generator/tests/openai.test.ts", "non-JSON DeepSeek failures before parsing"]
  ],
  extension_capture: [
    ["extensions/wiki-clipper/tests/evidence-source.test.mjs", "truncates long conversation ids to a canonical source filename"],
    ["extensions/wiki-clipper/tests/evidence-source.test.mjs", "removes dotdot from conversation source filenames"],
    ["extensions/wiki-clipper/tests/source-capture-request.test.mjs", "normalizedHttpUrl"],
    ["wikibrowser/lib/source-capture.ts", "safeSourceCaptureRequestId(Date.now(), crypto.randomUUID())"]
  ],
  canister_ci_filter: [
    [".github/workflows/ci.yml", "crates/(vfs_canister|vfs_runtime|vfs_types|vfs_store|wiki_domain)/"],
    [".github/workflows/ci.yml", "set_output rust_all"]
  ],
  canister_cycles_billing: [
    ["scripts/smoke/local_canister_post_upgrade.sh", "scripts/local/deploy_wiki.sh --mode upgrade"],
    ["scripts/check-mainnet-deploy-wiki.mjs", "get_cycles_billing_config"],
    ["docs/DB_LIFECYCLE.md", "billing-authority review"],
    ["docs/DB_LIFECYCLE.md", "repair browser UI, purchase retry API, and ambiguous purchase repair/cancel API are not implemented"],
    ["docs/DB_LIFECYCLE.md", "If ledger transfer succeeds but local DB activation or cycle application fails"],
    ["docs/DB_LIFECYCLE.md", "Remaining DB cycles are discarded"]
  ]
};

for (const [group, checks] of Object.entries(groups)) {
  for (const [relativePath, marker] of checks) {
    const content = readFileSync(join(root, relativePath), "utf8");
    assert.match(content, new RegExp(escapeRegExp(marker)), `${group}: missing marker ${marker} in ${relativePath}`);
  }
}

assert.doesNotMatch(
  readFileSync(join(root, "docs/DB_LIFECYCLE.md"), "utf8"),
  /自動 repair API と cancel repair API は提供しない/,
  "canister_cycles_billing: obsolete repair wording remains in docs/DB_LIFECYCLE.md"
);

console.log(`Regression groups OK: ${Object.keys(groups).join(", ")}`);

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
