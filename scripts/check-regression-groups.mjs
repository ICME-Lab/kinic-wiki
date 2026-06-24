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
    ["crates/wiki_domain/src/lib.rs", "canonical_source_path_rejects_prefix_lookalikes"],
    ["crates/vfs_canister/src/tests.rs", "fs_entrypoints_reject_noncanonical_source_paths"],
    ["workers/wiki-generator/tests/source-path.test.ts", "/Sourcesfoo/alpha/alpha.md"],
    ["extensions/wiki-clipper/tests/url-ingest-request.test.mjs", "normalizedHttpUrl accepts only http and https"]
  ],
  skill_registry_schema: [
    ["crates/vfs_cli_app/src/skill_registry_tests.rs", "skill_approve_proposal_rejects_wrong_path_and_frontmatter"],
    ["crates/vfs_cli_app/src/skill_registry_tests.rs", "skill_upsert_rejects_noncanonical_skill_ids_before_writing"],
    ["crates/vfs_cli_app/src/skill_registry_tests.rs", "skill_set_status_removes_stale_status_metadata"],
    ["wikibrowser/scripts/check-skill-registry.mjs", "improvement-proposals|kinic\\.skill_improvement_proposal"],
    ["wikibrowser/scripts/check-skill-registry.mjs", "skill..v1"],
    ["skill-registry-web/scripts/check-skill-registry-web.mjs", "baseEtag"],
    ["docs/SKILL_REGISTRY.md", "/Wiki/skills/<name>/proposals/<proposal-id>/"]
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
    ["workers/wiki-generator/tests/processing.test.ts", "kind: \"url_ingest\""],
    ["workers/wiki-generator/src/processing.ts", "url_ingest requestPath is non-canonical"],
    ["workers/wiki-generator/src/jobs.ts", "attempts = 0"],
    ["workers/wiki-generator/src/jobs.ts", "target_path = NULL"],
    ["workers/wiki-generator/tests/openai.test.ts", "non-JSON DeepSeek failures before parsing"]
  ],
  extension_capture: [
    ["extensions/wiki-clipper/tests/raw-source.test.mjs", "truncates long conversation ids to a canonical source filename"],
    ["extensions/wiki-clipper/tests/raw-source.test.mjs", "removes dotdot from conversation source filenames"],
    ["extensions/wiki-clipper/tests/url-ingest-request.test.mjs", "normalizedHttpUrl"],
    ["wikibrowser/lib/url-ingest.ts", "safeIngestRequestId(Date.now(), crypto.randomUUID())"]
  ],
  canister_ci_filter: [
    [".github/workflows/ci.yml", "crates/(vfs_canister|vfs_runtime|vfs_types|vfs_store|wiki_domain)/"],
    [".github/workflows/ci.yml", "set_output rust_all"]
  ],
  canister_cycles_billing: [
    ["scripts/smoke/local_canister_post_upgrade.sh", "scripts/local/deploy_wiki.sh --mode upgrade"],
    ["docs/payment.md", "billing_authority_review"],
    ["docs/payment.md", "v1 では repair / cancel API は提供しない"],
    ["docs/payment.md", "v1 では retry API は提供しない"],
    ["docs/payment.md", "残高を全徴収"]
  ]
};

for (const [group, checks] of Object.entries(groups)) {
  for (const [relativePath, marker] of checks) {
    const content = readFileSync(join(root, relativePath), "utf8");
    assert.match(content, new RegExp(escapeRegExp(marker)), `${group}: missing marker ${marker} in ${relativePath}`);
  }
}

assert.doesNotMatch(
  readFileSync(join(root, "docs/payment.md"), "utf8"),
  /自動 repair API と cancel repair API は提供しない/,
  "canister_cycles_billing: obsolete repair wording remains in docs/payment.md"
);

console.log(`Regression groups OK: ${Object.keys(groups).join(", ")}`);

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
