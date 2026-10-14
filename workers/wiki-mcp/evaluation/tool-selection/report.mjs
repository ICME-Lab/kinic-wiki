import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { cases } from "./cases.mjs";
import { grade as frozenGrade, undeliveredCalls } from "./grade.mjs";
import { grade as historyGrade } from "./history-audit.mjs";
const historyAudit = process.argv.includes("--history");
const grade = historyAudit ? historyGrade : frozenGrade;
const auditSuffix = historyAudit ? "-history-audited" : "-audited";
const historyGraderHash = historyAudit
  ? createHash("sha256")
      .update(await readFile(new URL("./history-audit.mjs", import.meta.url)))
      .digest("hex")
  : undefined;
const auditedGraderHash = createHash("sha256")
  .update(await readFile(new URL("./grade.mjs", import.meta.url)))
  .digest("hex");
const here = fileURLToPath(new URL(".", import.meta.url));
const names = (await readdir(here + "reports")).filter((n) =>
  n.endsWith(".jsonl"),
);
const rows = [];
for (const name of names) {
  const run = name.slice(0, -6),
    audited = [];
  let evidence = [];
  try {
    evidence = (await readFile(here + `reports/evidence/${run}.jsonl`, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((s) => JSON.parse(s));
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  for (const line of (await readFile(here + "reports/" + name, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)) {
    let row = {
      run,
      ...JSON.parse(line),
      auditedGraderHash,
      ...(historyAudit
        ? { historyGraderHash, historyComplete: false, successful: false }
        : {}),
    };
    const trace = evidence.find((e) => e.id === row.id);
    if (
      trace?.attemptedCalls.some((c) =>
        c.error?.message?.includes("requires approval"),
      )
    )
      row.infrastructureError = "mcp_approval_denied";
    try {
      const events = (
        await readFile(
          here + `.tmp-test/runs/${run}/${row.id}/events.jsonl`,
          "utf8",
        )
      )
        .split("\n")
        .flatMap((s) => {
          try {
            return [JSON.parse(s)];
          } catch {
            return [];
          }
        });
      if (
        events.some((e) =>
          e.item?.error?.message?.includes("requires approval"),
        )
      )
        row.infrastructureError = "mcp_approval_denied";
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    try {
      const observation =
        trace?.observation ??
        JSON.parse(
          await readFile(
            here + `.tmp-test/runs/${run}/${row.id}/observation.json`,
            "utf8",
          ),
        );
      observation.rejectedCalls = undeliveredCalls(
        observation,
        trace?.attemptedCalls ?? [],
      );
      row = {
        ...row,
        ...grade(
          cases.find((c) => c.id === row.test),
          observation,
          row.answer,
        ),
      };
      if (row.infrastructureError) row.successful = false;
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    rows.push(row);
    audited.push(row);
  }
  if (process.argv.includes("--write"))
    await writeFile(
      here + `reports/${run}${auditSuffix}.json`,
      JSON.stringify(audited, null, 2) + "\n",
    );
}
const groups = Map.groupBy(rows, (r) => `${r.run}/${r.variant}/${r.mode}`);
const summaries = [...groups].map(([group, r]) => ({
  group,
  n: r.length,
  passed: r.filter((x) => x.successful).length,
  unsafe: r.filter((x) => x.unsafe).length,
  ...(historyAudit
    ? { historyIncomplete: r.filter((x) => x.historyComplete !== true).length }
    : {}),
  infrastructure: r.filter((x) => x.infrastructureError).length,
  meanCalls: r.reduce((n, x) => n + (x.callCount ?? 0), 0) / r.length,
  inputErrors: r.reduce((n, x) => n + (x.inputErrors ?? 0), 0),
  unnecessaryCalls: r.reduce((n, x) => n + (x.unnecessaryCalls ?? 0), 0),
  timingSessions: r.filter((x) => !x.timingUnavailable).length,
  meanMs: Math.round(
    r.filter((x) => !x.timingUnavailable).reduce((n, x) => n + x.elapsedMs, 0) /
      r.filter((x) => !x.timingUnavailable).length,
  ),
  usageSessions: r.filter((x) => x.usage).length,
  inputTokens: r.reduce((n, x) => n + (x.usage?.input_tokens ?? 0), 0),
  outputTokens: r.reduce((n, x) => n + (x.usage?.output_tokens ?? 0), 0),
}));
console.table(summaries);
for (const r of rows.filter((x) => !x.successful))
  console.log(
    JSON.stringify({
      run: r.run,
      id: r.id,
      infra: r.infrastructureError,
      unexpected: r.unexpected,
      missingEvidence: r.missingEvidence,
      factsMissing: r.factsMissing,
      atomicViolation: r.atomicViolation,
    }),
  );
if (process.argv.includes("--write"))
  await writeFile(
    here +
      (historyAudit ? "reports/summary-history.json" : "reports/summary.json"),
    JSON.stringify(summaries, null, 2) + "\n",
  );
