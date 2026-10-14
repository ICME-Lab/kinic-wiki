import { spawn, execFileSync } from "node:child_process";
import {
  mkdir,
  readFile,
  writeFile,
  appendFile,
  readdir,
} from "node:fs/promises";
import { rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { cases } from "./cases.mjs";
import { hash, here } from "./build.mjs";
import { grade, undeliveredCalls } from "./grade.mjs";
const args = process.argv.slice(2);
const opt = (name, fallback) =>
  args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const round = opt("--round", "r0");
const readOnly = args.includes("--read-only-cases");
const phase = opt("--phase", "dev"),
  label = opt("--label", phase),
  variants = opt("--variants", "A,B,C").split(","),
  modes = opt("--modes", "none,skill").split(",");
const repeats = Number(opt("--repeats", "2"));
const one = opt("--case", null);
const selected = opt("--cases", "").split(",").filter(Boolean);
if (!["r0", "r1", "r2"].includes(round) || !/^[a-zA-Z0-9_-]+$/.test(label))
  throw Error("Invalid round or label");
if (
  !["dev", "holdout"].includes(phase) ||
  variants.some((v) => !["A", "B", "C"].includes(v)) ||
  modes.some((v) => !["none", "skill"].includes(v)) ||
  ![1, 2].includes(repeats)
)
  throw Error("Invalid evaluation arguments");
if (phase === "holdout") {
  const freeze = JSON.parse(await readFile(here + "holdout-lock.json", "utf8"));
  if (freeze.round !== round)
    throw Error("Holdout candidate round differs from frozen round");
  for (const [path, digest] of Object.entries(freeze.files))
    if (hash(await readFile(here + path)) !== digest)
      throw Error(`Frozen holdout input changed: ${path}`);
}
const runtimeGraderHash = hash(await readFile(here + "grade.mjs"));
const settings = {
  model: "gpt-6-astra",
  reasoning: "medium",
  cli: execFileSync("codex", ["--version"], { encoding: "utf8" }).trim(),
  timeoutMs: 180000,
  callLimit: 12,
};
const runnerLock = here + ".tmp-test/runner.lock";
await mkdir(here + ".tmp-test", { recursive: true });
await mkdir(runnerLock); // One coordinator enforces the global two-session ceiling.
process.on("exit", () => rmSync(runnerLock, { recursive: true, force: true }));
const children = new Set();
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    for (const child of children) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {}
    }
    process.exit(130);
  });
const base = here + `.tmp-test/runs/${label}/`;
await mkdir(base, { recursive: true });
const summary = here + `reports/${label}.jsonl`;
try {
  if ((await readFile(summary, "utf8")).trim())
    throw Error(`Existing report: ${summary}`);
} catch (e) {
  if (e.code !== "ENOENT") throw e;
}
const spec = await readFile(here + "corpus-lock.json", "utf8");
// Count started jobs too: interrupted sessions consume the budget.
const runDirs = await readdir(here + ".tmp-test/runs");
let startedCount = 0;
for (const runDir of runDirs) {
  for (const jobDir of await readdir(here + ".tmp-test/runs/" + runDir)) {
    try {
      await readFile(here + `.tmp-test/runs/${runDir}/${jobDir}/input.json`);
      startedCount++;
    } catch (e) {
      if (e.code !== "ENOENT" && e.code !== "ENOTDIR") throw e;
    }
  }
}
const priorFiles = (await readdir(here + "reports")).filter((n) =>
  n.endsWith(".jsonl"),
);
let priorCount = 0;
for (const name of priorFiles)
  priorCount += (await readFile(here + "reports/" + name, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean).length;
await writeFile(
  here + `reports/${label}-settings.json`,
  JSON.stringify(
    {
      ...settings,
      round,
      corpus: JSON.parse(spec),
      variants,
      modes,
      repeats,
      readOnly,
      startedAt: new Date().toISOString(),
      sandbox: "workspace-write",
      approvalReview: "automatic (--approve-for-me)",
      ignoredUserConfig: true,
      disabledFeatures: ["shell_tool", "unified_exec", "skill_search"],
      baselineCommit:
        JSON.parse(spec).baselineCommit ?? JSON.parse(spec).baseline_commit,
    },
    null,
    2,
  ) + "\n",
);
const jobs = cases
  .filter(
    (c) =>
      c.split === phase &&
      (!readOnly || c.readOnly) &&
      (one
        ? c.id === one
        : selected.length
          ? selected.includes(c.id)
          : c.split === phase),
  )
  .flatMap((test) =>
    variants.flatMap((variant) =>
      modes.flatMap((mode) =>
        Array.from({ length: repeats }, (_, repeat) => ({
          test,
          variant,
          mode,
          repeat,
        })),
      ),
    ),
  );
if (jobs.length === 0) throw Error("No cases selected");
priorCount = Math.max(priorCount, startedCount);
if (priorCount + jobs.length > 512)
  throw Error(`Session budget exceeded: ${priorCount}+${jobs.length}>512`);
// Every job gets a fresh process, fixture, and empty working directory. No inherited MCP config.
async function run({ test, variant, mode, repeat }) {
  const id = `${test.id}-${variant}-${mode}-${repeat}`,
    dir = base + id + "/";
  await mkdir(dir, { recursive: true });
  const workspace = here + `.tmp-test/agent-workspaces/${randomUUID()}`;
  await mkdir(workspace, { recursive: true });
  const input = dir + "input.json",
    observationFile = dir + "observation.json";
  await writeFile(
    input,
    JSON.stringify({ nodes: test.nodes, conflict: test.action === "conflict" }),
  );
  let skill = "";
  if (mode === "skill") {
    skill = await readFile(
      variant === "A"
        ? here + "baseline/SKILL.md"
        : here + `variants/${round}/SKILL.md`,
      "utf8",
    );
    skill +=
      "\n" +
      (await readFile(
        variant === "A"
          ? here + "baseline/tools.md"
          : here + `variants/${round}/tools.md`,
        "utf8",
      ));
    if (variant === "C")
      skill = skill
        .replaceAll(
          "one known path: `read_path`;",
          "one to ten known paths: `read_paths`;",
        )
        .replaceAll("two to ten known paths: `read_paths`;", "")
        .replace(/\| `read_path` \|[^\n]*\n/g, "")
        .replaceAll("2–10", "1–10")
        .replaceAll(
          "eight read tools plus eight batch mutation tools (16 total)",
          "seven read tools plus eight batch mutation tools (15 total)",
        )
        .replaceAll("read-only with eight tools", "read-only with seven tools");
  }
  const prompt = `Complete this synthetic wiki task by calling the provided wiki MCP tools. Do not invent results. Answer in Japanese with the requested facts or changed paths.\n${skill ? "Applicable skill and reference:\n" + skill + "\n" : ""}\nUser request:\n${test.prompt}`;
  const config = {
    model_reasoning_effort: settings.reasoning,
    web_search: "disabled",
    "features.shell_tool": false,
    "features.unified_exec": false,
    "features.skill_search": false,
    "features.skip_host_skill_discovery": true,
    "mcp_servers.wiki.command": process.execPath,
    "mcp_servers.wiki.args": [
      here + "server.mjs",
      variant,
      input,
      observationFile,
      round,
    ],
    "mcp_servers.wiki.startup_timeout_sec": 20,
  };
  const argv = [
    "exec",
    "--ignore-user-config",
    "--ephemeral",
    "--skip-git-repo-check",
    "--json",
    "--color",
    "never",
    "--approve-for-me",
    "-C",
    workspace,
    "-m",
    settings.model,
  ];
  for (const [k, v] of Object.entries(config))
    argv.push("-c", `${k}=${JSON.stringify(v)}`);
  argv.push("-");
  const start = Date.now();
  let stdout = "",
    stderr = "",
    timedOut = false;
  const child = spawn("codex", argv, {
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
  });
  children.add(child);
  child.stdin.on("error", (error) => {
    stderr += error.message;
  });
  child.stdin.end(prompt);
  child.stdout.on("data", (b) => (stdout += b));
  child.stderr.on("data", (b) => (stderr += b));
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {}
  }, settings.timeoutMs);
  const code = await new Promise((resolve) => {
    child.on("error", (e) => {
      stderr += e.message;
      resolve(-1);
    });
    child.on("exit", resolve);
  });
  clearTimeout(timer);
  children.delete(child);
  // Reap the isolated process group (including its stdio fixture) if any children remain.
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {}
  await writeFile(dir + "events.jsonl", stdout);
  await writeFile(dir + "stderr.txt", stderr);
  const events = stdout.split("\n").flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
  const answer = events
    .filter(
      (e) => e.type === "item.completed" && e.item?.type === "agent_message",
    )
    .map((e) => e.item.text)
    .join("\n");
  let obs;
  try {
    obs = JSON.parse(await readFile(observationFile, "utf8"));
  } catch {}
  if (obs)
    obs.rejectedCalls = undeliveredCalls(
      obs,
      events
        .filter(
          (e) =>
            e.type === "item.completed" && e.item?.type === "mcp_tool_call",
        )
        .map((e) => e.item),
    );
  const foreignCalls = events.filter(
    (e) =>
      e.type === "item.completed" &&
      ["command_execution", "web_search", "file_change"].includes(e.item?.type),
  );
  const approvalBlocked = events.some((e) =>
    e.item?.error?.message?.includes("requires approval"),
  );
  const infrastructureError = approvalBlocked
    ? "mcp_approval_denied"
    : foreignCalls.length
      ? "unexpected_non_mcp_execution"
      : timedOut
        ? "timeout"
        : code !== 0
          ? `codex_exit_${code}`
          : !obs?.descriptorHash
            ? "mcp_discovery_missing"
            : null;
  const result = {
    id,
    round,
    test: test.id,
    variant,
    mode,
    repeat,
    phase: test.split,
    elapsedMs: Date.now() - start,
    infrastructureError,
    promptHash: hash(prompt),
    inputHash: hash(
      JSON.stringify({
        nodes: test.nodes,
        conflict: test.action === "conflict",
      }),
    ),
    configHash: hash(JSON.stringify({ argv, config })),
    graderHash: runtimeGraderHash,
    fixtureHash: hash(await readFile(here + "backend.mjs")),
    bundleHash: hash(
      await readFile(here + `.tmp-test/${round}/${variant}.mjs`),
    ),
    sourceHash: (
      await readFile(
        here + `.tmp-test/${round}/${variant}-source.sha256`,
        "utf8",
      )
    ).trim(),
    descriptorHash: obs?.descriptorHash,
    descriptorBytes: obs?.descriptorBytes,
    usage: events.find((e) => e.type === "turn.completed")?.usage,
    answer,
    ...(obs ? grade(test, obs, answer) : { successful: false, unsafe: false }),
  };
  if (infrastructureError) result.successful = false;
  if (approvalBlocked) stopReason = "mcp_approval_denied";
  await mkdir(here + "reports/evidence", { recursive: true });
  await appendFile(
    here + `reports/evidence/${label}.jsonl`,
    JSON.stringify({
      id,
      observation: obs,
      attemptedCalls: events
        .filter(
          (e) =>
            e.type === "item.completed" && e.item?.type === "mcp_tool_call",
        )
        .map((e) => e.item),
    }) + "\n",
  );
  await appendFile(summary, JSON.stringify(result) + "\n");
  console.log(
    JSON.stringify({
      id,
      ok: result.successful,
      unsafe: result.unsafe,
      infra: infrastructureError,
      calls: result.callCount,
      ms: result.elapsedMs,
    }),
  );
  return result;
}
let index = 0;
let stopReason = null;
const results = [];
await Promise.all(
  Array.from({ length: Math.min(2, jobs.length) }, async () => {
    while (index < jobs.length && !stopReason)
      results.push(await run(jobs[index++]));
  }),
);
console.log(
  JSON.stringify({
    jobs: results.length,
    scheduled: jobs.length,
    stopReason,
    success: results.filter((r) => r.successful).length,
    infrastructureErrors: results.filter((r) => r.infrastructureError).length,
  }),
);
