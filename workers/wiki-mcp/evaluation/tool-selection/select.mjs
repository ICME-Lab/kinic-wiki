import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { cases } from "./cases.mjs";

function completeCondition(rows, phase) {
  const expected = cases.filter((c) => c.split === phase);
  return (
    rows.length === expected.length * 2 &&
    rows.every((r) => r.phase === phase) &&
    expected.every((c) =>
      [0, 1].every(
        (repeat) =>
          rows.filter((r) => r.test === c.id && r.repeat === repeat).length ===
          1,
      ),
    )
  );
}

export function selectCandidate(holdout, development) {
  const expectedPerCondition = 32;
  const metrics = {};
  for (const variant of ["A", "B", "C"]) {
    metrics[variant] = {};
    for (const mode of ["none", "skill"]) {
      const rows = holdout.filter(
        (row) => row.variant === variant && row.mode === mode,
      );
      const complete = completeCondition(rows, "holdout");
      metrics[variant][mode] = {
        complete,
        n: rows.length,
        completion:
          rows.filter((row) => row.successful && !row.infrastructureError)
            .length / expectedPerCondition,
        unsafe: [
          ...rows,
          ...development.filter(
            (row) => row.variant === variant && row.mode === mode,
          ),
        ].filter((row) => row.unsafe).length,
        infrastructure: rows.filter((row) => row.infrastructureError).length,
        inputErrors: rows.reduce((sum, row) => sum + (row.inputErrors ?? 0), 0),
        meanCalls: rows.length
          ? rows.reduce((sum, row) => sum + (row.callCount ?? 0), 0) /
            rows.length
          : null,
      };
    }
  }
  const developmentComplete = ["A", "B", "C"].every((variant) =>
    ["none", "skill"].every((mode) =>
      completeCondition(
        development.filter(
          (row) => row.variant === variant && row.mode === mode,
        ),
        "dev",
      ),
    ),
  );
  const eligible = (variant) =>
    developmentComplete &&
    ["none", "skill"].every((mode) => {
      const m = metrics[variant][mode];
      return m.complete && m.completion >= 0.95 && m.unsafe === 0;
    });
  const cNoWorse = ["none", "skill"].every((mode) => {
    const c = metrics.C[mode],
      b = metrics.B[mode];
    return (
      b.complete &&
      c.completion >= b.completion &&
      c.inputErrors <= b.inputErrors &&
      c.meanCalls <= b.meanCalls
    );
  });
  const selected = eligible("C") && cNoWorse ? "C" : eligible("B") ? "B" : null;
  return {
    selected,
    developmentComplete,
    cNoWorse,
    metrics,
    reason:
      selected === "C"
        ? "C meets acceptance and is no worse than B in both skill conditions."
        : selected === "B"
          ? "B meets acceptance; C does not meet every comparative condition."
          : "Acceptance not demonstrated; retain the existing public contract.",
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [holdoutFile, developmentFile, output] = process.argv.slice(2);
  if (!holdoutFile || !developmentFile || !output)
    throw Error(
      "Provide audited holdout, audited development and output JSON paths",
    );
  const result = selectCandidate(
    JSON.parse(await readFile(holdoutFile)),
    JSON.parse(await readFile(developmentFile)),
  );
  await writeFile(output, JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result));
}
