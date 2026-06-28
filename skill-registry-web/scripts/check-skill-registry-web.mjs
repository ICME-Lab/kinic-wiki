import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { checkCandidSubset } from "../../scripts/candid-subset-check.mjs";
import { didTypeAliases, expectedMethods, expectedTypes } from "../../wikibrowser/scripts/candid-shapes.mjs";

const route = readFileSync(new URL("../app/skills/[databaseId]/page.tsx", import.meta.url), "utf8");
const client = readFileSync(new URL("../app/skills/skill-registry-client.tsx", import.meta.url), "utf8");
const panels = readFileSync(new URL("../app/skills/skill-registry-panels.tsx", import.meta.url), "utf8");
const catalog = readFileSync(new URL("../lib/skill-registry-catalog.ts", import.meta.url), "utf8");
const details = readFileSync(new URL("../lib/skill-registry-details.ts", import.meta.url), "utf8");
const operations = readFileSync(new URL("../lib/skill-registry-operations.ts", import.meta.url), "utf8");
const packages = readFileSync(new URL("../lib/skill-registry-package.ts", import.meta.url), "utf8");
const wikiHelpers = readFileSync(new URL("../lib/wiki-helpers.ts", import.meta.url), "utf8");
const types = readFileSync(new URL("../lib/types.ts", import.meta.url), "utf8");
const vfsClient = readFileSync(new URL("../lib/vfs-client.ts", import.meta.url), "utf8");
const vfsIdl = readFileSync(new URL("../lib/vfs-idl.ts", import.meta.url), "utf8");
const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const did = readFileSync(new URL("../../crates/vfs_canister/vfs.did", import.meta.url), "utf8");

assert.equal(packageJson.name, "kinic-skill-registry-web");
assert.match(route, /<SkillRegistryClient databaseId=\{databaseId\} \/>/);
assert.doesNotMatch(client, /loadEvolutionJobs|previewApplyProposalDiff|approveSkillProposal/);
assert.match(panels, /Skill Registry Dashboard/);
assert.doesNotMatch(panels, /EvolutionJobsPanel|ProposalList|EvolutionJob/);
assert.match(panels, /Current SKILL\.md/);
assert.doesNotMatch(panels, /authenticated=\{false\}/);
assert.doesNotMatch(readFileSync(new URL("../app/skills/skill-registry-ui.tsx", import.meta.url), "utf8"), /proposal|Proposal/);
assert.match(client, /handlersFor\(skill\)|handlersFor\(selectedSkill\)/);
assert.doesNotMatch(details, /\/Knowledge\/skill-evolution-jobs|\/proposals|parseProposalRoot|kinic\.skill_evolution_proposal_status/);
assert.doesNotMatch(catalog, /ProposalStatus|SkillProposal|EvolutionJob|proposals|jobs/);
assert.doesNotMatch(operations, /kinic\.skill_evolution_proposal_status|assertProposalStatus|proposalStatusPathForSkill/);
assert.match(operations, /frontmatterEnd\(rest\)/);
assert.doesNotMatch(operations, /indexOf\("\\n---"\)/);
assert.match(wikiHelpers, /isKnowledgeSourcePath\(path\)/);
assert.match(wikiHelpers, /RESERVED_SOURCE_PROVIDERS/);
assert.doesNotMatch(wikiHelpers, /raw_source/);
assert.doesNotMatch(wikiHelpers, /path\.startsWith\("\/Sources\/raw/);
assert.match(types, /DatabaseStatus = "pending" \| "active" \| "deleted"/);
assert.doesNotMatch(vfsIdl, /Hot: idl\.Null/);
assert.match(vfsIdl, /Pending: idl\.Null/);
assert.match(vfsIdl, /Active: idl\.Null/);
assert.match(vfsIdl, /status: DatabaseStatus/);
assert.match(vfsIdl, /Deleted: idl\.Null/);
assert.match(vfsIdl, /deleted_at_ms: idl\.Opt\(idl\.Int64\)/);
assert.deepEqual(
  checkCandidSubset({
    didSource: did,
    idlSource: vfsIdl,
    expectedTypes: pickUsedExpectedTypes(vfsIdl),
    expectedMethods: pickUsedExpectedMethods(vfsIdl),
    didTypeAliases
  }),
  []
);
assert.match(vfsClient, /function normalizeDatabaseStatus/);
assert.match(vfsClient, /"Active" in status/);
assert.match(vfsClient, /"Pending" in status/);
assert.match(vfsClient, /"Deleted" in status/);
assert.doesNotMatch(vfsClient, /: "hot"/);
assert.doesNotMatch(client, /from ["']..\/..\/..\/wikibrowser/);
assert.doesNotMatch(panels, /from ["']..\/..\/..\/wikibrowser/);
assert.match(packages, /markdownLinkTargets/);
const packageParser = await importSkillRegistryPackageForTest("../lib/skill-registry-package.ts");
const manifestParser = await importSkillManifestForTest("../lib/skill-manifest.ts");
const normalizedManifest = packageParser.normalizeManifestForSkill(
  "Skill.v1",
  "---\nkind: kinic.skill\nschema_version: 1\nid: Skill.v1\nversion: 0.1.0\nentry: SKILL.md\ntitle: Existing\ntags:\n  - Existing\nprovenance:\n  license: Existing-License\n---\n# Manifest\n",
  "---\nmetadata:\n  title: Generated\n  category: Generated\ndescription: Generated summary\nlicense: Generated-License\n---\n# Skill\n"
);
assert.equal((normalizedManifest.match(/\ntags:/g) ?? []).length, 1);
assert.match(normalizedManifest, /  - Existing/);
assert.match(normalizedManifest, /summary: "Generated summary"/);
assert.doesNotMatch(normalizedManifest, /title: "Generated"/);
assert.doesNotMatch(normalizedManifest, /  - Generated/);
assert.doesNotMatch(normalizedManifest, /Generated-License/);
const normalizedEmptyManifest = packageParser.normalizeManifestForSkill(
  "Skill.v1",
  "---\nkind: kinic.skill\nschema_version: 1\nid: Skill.v1\nversion: 0.1.0\nentry: SKILL.md\ntitle: \"\"\nsummary: \"\"\ntags:\nprovenance:\n  license: \"\"\n---\n# Manifest\n",
  "---\nmetadata:\n  title: Generated\n  category: Generated\ndescription: Generated summary\nlicense: Generated-License\n---\n# Skill\n"
);
assert.equal((normalizedEmptyManifest.match(/\ntags:/g) ?? []).length, 1);
assert.equal((normalizedEmptyManifest.match(/\n  license:/g) ?? []).length, 1);
assert.match(normalizedEmptyManifest, /title: "Generated"/);
assert.match(normalizedEmptyManifest, /summary: "Generated summary"/);
assert.match(normalizedEmptyManifest, /  - "Generated"/);
assert.match(normalizedEmptyManifest, /  license: "Generated-License"/);
assert.deepEqual(
  packageParser.markdownPackageLinks([
    "[Plan](docs/Project Plan.md)",
    "[Angle](<docs/Project Plan.md>)",
    "[Alpha](docs/Project (Alpha).md)",
    "[Titled](docs/usage.md \"Usage\")",
    "[Angle titled](<docs/Project Plan.md> 'Project plan')",
    "[Parenthesized title](docs/reference.md (Reference))",
    "[Ignored](https://example.com/docs/External.md)",
    "[Escape](../escape.md)",
    "[Empty](docs//Broken.md)",
    "[Dot](docs/./Hidden.md)"
  ].join("\n")),
  ["docs/Project Plan.md", "docs/Project (Alpha).md", "docs/usage.md", "docs/reference.md"]
);
assert.equal(packageParser.cleanSkillId("Skill.v1"), "Skill.v1");
assert.throws(() => packageParser.cleanSkillId("skill..v1"), /single path-safe segment/);
assert.throws(() => packageParser.cleanSkillId("a".repeat(129)), /single path-safe segment/);
assert.equal(
  manifestParser.parseSkillManifest("---\nkind: kinic.skill\nschema_version: 1\nid: Skill.v1\nversion: 0.1.0\nentry: SKILL.md\n---\n# Skill")?.id,
  "Skill.v1"
);
assert.equal(
  manifestParser.parseSkillManifest("---\nkind: kinic.skill\nschema_version: 1\nid: skill..v1\nversion: 0.1.0\nentry: SKILL.md\n---\n# Skill"),
  null
);

console.log("Skill Registry web checks OK");

function pickUsedExpectedTypes(source) {
  return Object.fromEntries(
    Object.entries(expectedTypes).filter(([name]) => new RegExp(`const\\s+${name}\\s*=`).test(source))
  );
}

function pickUsedExpectedMethods(source) {
  return Object.fromEntries(
    Object.entries(expectedMethods).filter(([name]) => new RegExp(`${name}:\\s*idl\\.Func`).test(source))
  );
}

async function importSkillRegistryPackageForTest(relativePath) {
  const sourcePath = new URL(relativePath, import.meta.url);
  const source = readFileSync(sourcePath, "utf8")
    .replace(/^import .+;\n/gm, "")
    .concat("\nexport { markdownPackageLinks, cleanSkillId, normalizeManifestForSkill };\n");
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022
    }
  }).outputText;
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`;
  return import(moduleUrl);
}

async function importSkillManifestForTest(relativePath) {
  const sourcePath = new URL(relativePath, import.meta.url);
  const source = readFileSync(sourcePath, "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022
    }
  }).outputText;
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`;
  return import(moduleUrl);
}
