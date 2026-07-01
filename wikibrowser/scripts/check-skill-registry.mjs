import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

const route = readFileSync(new URL("../app/skills/[databaseId]/page.tsx", import.meta.url), "utf8");
const client = readFileSync(new URL("../app/skills/skill-registry-client.tsx", import.meta.url), "utf8");
const adminHeader = readFileSync(new URL("../components/admin-header.tsx", import.meta.url), "utf8");
const ui = readFileSync(new URL("../app/skills/skill-registry-ui.tsx", import.meta.url), "utf8");
const catalog = readFileSync(new URL("../lib/skill-registry-catalog.ts", import.meta.url), "utf8");
const details = readFileSync(new URL("../lib/skill-registry-details.ts", import.meta.url), "utf8");
const operations = readFileSync(new URL("../lib/skill-registry-operations.ts", import.meta.url), "utf8");
const packages = readFileSync(new URL("../lib/skill-registry-package.ts", import.meta.url), "utf8");
const folders = readFileSync(new URL("../lib/vfs-folders.ts", import.meta.url), "utf8");
const homeUi = readFileSync(new URL("../app/home-ui.tsx", import.meta.url), "utf8");
const dashboardHomeClient = readFileSync(new URL("../app/dashboard/dashboard-home-client.tsx", import.meta.url), "utf8");
const dashboardClient = readFileSync(new URL("../app/dashboard/dashboard-client.tsx", import.meta.url), "utf8");
const inspector = readFileSync(new URL("../components/inspector.tsx", import.meta.url), "utf8");
const skillManifest = readFileSync(new URL("../lib/skill-manifest.ts", import.meta.url), "utf8");
const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

assert.match(route, /params: Promise<\{ databaseId: string \}>/);
assert.match(route, /<SkillRegistryClient databaseId=\{databaseId\} \/>/);
assert.match(client, /SkillRegistryClient/);
assert.match(adminHeader, /export function AdminHeader/);
assert.match(adminHeader, /src="\/kinic-mark\.png"/);
assert.doesNotMatch(adminHeader, /src="\/icon\.png"/);
assert.match(client, /<AdminHeader/);
assert.doesNotMatch(client, /Database dashboard/);
assert.match(client, /hrefForPath\(canisterId, databaseId, "\/Knowledge"\)/);
assert.doesNotMatch(client, /unknown database/);
assert.match(client, /loadSkillCatalog/);
assert.match(client, /updateSkillStatus/);
assert.match(client, /recordSkillRun/);
assert.doesNotMatch(client, /approveSkillProposal|previewApplyProposalDiff|previewProposal/);
assert.match(ui, /Run Evidence/);
assert.doesNotMatch(ui, /Proposals|ProposalList|proposalCanApply/);
assert.match(ui, /Trust:/);
assert.match(catalog, /const REGISTRY_ROOTS = \[/);
assert.match(catalog, /\/Skills/);
assert.match(catalog, /parseSkillManifest/);
assert.match(catalog, /listChildren/);
assert.match(catalog, /readNode/);
assert.match(catalog, /MANIFEST_READ_CONCURRENCY/);
assert.match(details, /loadSkillCatalogDetails/);
assert.match(details, /DETAIL_READ_CONCURRENCY/);
assert.doesNotMatch(details, /parseProposalRoot|\/proposals|kinic\.skill_evolution_proposal_status/);
assert.doesNotMatch(catalog, /ProposalStatus|SkillProposal|proposals/);
assert.match(catalog, /recentRuns/);
assert.match(catalog, /events/);
assert.match(operations, /writeNodeAuthenticated/);
assert.match(operations, /ensureParentFoldersAuthenticated/);
assert.match(operations, /recorded_by: browser/);
assert.match(operations, /recordSkillEvent/);
assert.doesNotMatch(operations, /kinic\.skill_evolution_proposal_status|assertProposalStatus|proposalStatusPathForSkill/);
assert.match(operations, /frontmatterEnd\(rest\)/);
assert.doesNotMatch(operations, /indexOf\("\\n---"\)/);
assert.match(packages, /importPublicGitHubSkill/);
assert.match(packages, /upsertSkillPackage/);
assert.match(packages, /ensureParentFoldersAuthenticated/);
assert.match(packages, /normalizeManifestForSkill/);
assert.match(packages, /setRootFrontmatterField/);
assert.match(packages, /insertBeforeFrontmatterTerminator/);
assert.doesNotMatch(packages, /replace\(\s*\/\\n---\//);
assert.match(packages, /raw\.githubusercontent\.com/);
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
assert.match(folders, /mkdirNodeAuthenticated/);
assert.match(folders, /segments\.slice\(0, -1\)/);
assert.doesNotMatch(details, /improvement-proposals|kinic\.skill_improvement_proposal/);
assert.match(client, /statusFilter/);
assert.match(client, /RoleBanner/);
assert.match(client, /PackageManager/);
assert.match(client, /databaseCanWrite/);
assert.match(client, /getCyclesBillingConfig/);
assert.match(client, /databaseCyclesDisabledReason/);
assert.match(client, /const writable = databaseCanWrite\(databaseSummary, cyclesConfig\)/);
assert.match(client, /const refreshSkillRegistry = useCallback\([\s\S]*loadCatalog\(activeIdentity\)[\s\S]*loadRole\(activeIdentity\)/);
assert.match(client, /refresh: refreshSkillRegistry/);
assert.match(client, /if \(refreshAfterSuccess\) await refreshSkillRegistry\(identity\)/);
assert.match(client, /const databases = await listDatabasesAuthenticated\(canisterId, activeIdentity\)/);
assert.match(client, /setCyclesConfig\(await getCyclesBillingConfig\(canisterId\)\)/);
assert.doesNotMatch(client, /const \[databases, config\] = await Promise\.all/);
assert.doesNotMatch(homeUi, /href=\{`\/skills\/\$\{encodeURIComponent\(database\.databaseId\)\}`\}/);
assert.match(dashboardHomeClient, /DatabaseBody/);
assert.doesNotMatch(dashboardClient, /href=\{`\/skills\/\$\{encodeURIComponent\(databaseId\)\}`\}/);
assert.doesNotMatch(inspector, /skill-manifest/);
assert.doesNotMatch(inspector, /parseSkillManifest|manifestPathForSkillRegistryFile/);
assert.doesNotMatch(inspector, /title="Skill"/);
assert.match(skillManifest, /kind: "kinic.skill"/);
assert.match(packageJson.scripts.test, /check-skill-registry\.mjs/);

console.log("Skill registry checks OK");

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
