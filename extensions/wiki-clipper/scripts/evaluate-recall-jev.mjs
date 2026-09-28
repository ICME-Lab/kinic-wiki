// Opt-in, paid evaluation of human-labelled Recall candidates from real Wiki documents.
// Usage: TYPESAFE_API_KEY=... node scripts/evaluate-recall-jev.mjs cases.json
import { readFile } from "node:fs/promises";
import { classifyWithJev } from "@kinic/jev-reranker";

const fixturePath = process.argv[2];
const apiKey = process.env.TYPESAFE_API_KEY;
if (!fixturePath || !apiKey) {
  console.error("Provide a 60-case fixture path and TYPESAFE_API_KEY; this opt-in run calls TypeSafe.");
  process.exit(2);
}
const cases = JSON.parse(await readFile(fixturePath, "utf8"));
if (!Array.isArray(cases) || cases.length !== 60 ||
    cases.filter(({ split }) => split === "calibration").length !== 20 ||
    cases.filter(({ split }) => split === "holdout").length !== 40 ||
    cases.filter(({ relevantPaths }) => relevantPaths.length > 0).length !== 45 ||
    cases.filter(({ split, relevantPaths }) => split === "holdout" && relevantPaths.length === 0).length !== 10)
  throw new Error("Expected 20 calibration and 40 holdout cases: 45 positive and 15 negative overall, 10 holdout negatives");

const results = [];
for (const item of cases) {
  if (typeof item.id !== "string" || typeof item.question !== "string" ||
      !Array.isArray(item.candidates) || item.candidates.length > 20 ||
      !Array.isArray(item.relevantPaths) || !Number.isFinite(item.searchMs) || item.searchMs < 0 ||
      !item.candidates.every(({ path, preview }) =>
        typeof path === "string" && typeof preview === "string" && preview.length <= 300))
    throw new Error(`Invalid fixture ${item.id || "unknown"}`);
  const questions = Object.fromEntries(item.candidates.map((_, index) => [
    `candidate_${index}`,
    {
      question: `Would candidate_${index} help answer the search intent based on its path and preview?`,
      trueCriteria: "The candidate contains information useful for answering or substantiating the question.",
      falseCriteria: "The candidate is unrelated, only shares generic words, or offers no useful evidence."
    }
  ]));
  const started = performance.now();
  const result = item.candidates.length === 0 ? { probabilities: {} } : await classifyWithJev({
    state: {
      search_intent: item.question,
      candidates: item.candidates.map((candidate, index) => ({ id: `candidate_${index}`, ...candidate }))
    },
    questions,
    apiKey,
    workflow: "recall",
    timeoutMs: 1_500,
    logMetric: (metric) => console.error(JSON.stringify(metric))
  });
  results.push({ ...item, probabilities: result.probabilities, jevMs: performance.now() - started });
  console.error(`Evaluated ${results.length}/${cases.length}: ${item.id}`);
}

function selected(item, threshold) {
  return item.candidates.map((candidate, index) => ({
    ...candidate, index, probability: item.probabilities[`candidate_${index}`]
  })).filter(({ probability }) => probability >= threshold)
    .sort((a, b) => b.probability - a.probability ||
      Number(!a.path.startsWith("/Knowledge/")) - Number(!b.path.startsWith("/Knowledge/")) || a.index - b.index)
    .slice(0, 3).map(({ path }) => path);
}
function metrics(items, threshold, mode) {
  let relevantShown = 0;
  let shown = 0;
  let hits = 0;
  let falseDisplay = 0;
  for (const item of items) {
    const paths = mode === "baseline" ? item.candidates.slice(0, 3).map(({ path }) => path) : selected(item, threshold);
    const relevant = new Set(item.relevantPaths);
    shown += paths.length;
    relevantShown += paths.filter((path) => relevant.has(path)).length;
    if (paths.some((path) => relevant.has(path))) hits++;
    if (relevant.size === 0 && paths.length > 0) falseDisplay++;
  }
  return { precisionAt3: shown ? relevantShown / shown : 1, hitAt3: hits / items.filter(({ relevantPaths }) => relevantPaths.length > 0).length, falseDisplay };
}
const calibration = results.filter(({ split }) => split === "calibration");
const holdout = results.filter(({ split }) => split === "holdout");
const baseline = metrics(holdout, 0, "baseline");
const thresholds = Array.from({ length: 101 }, (_, index) => index / 100);
const calibrationBaseline = metrics(calibration, 0, "baseline");
const threshold = thresholds.map((value) => ({ value, metric: metrics(calibration, value, "jev") }))
  .filter(({ metric }) => metric.hitAt3 >= calibrationBaseline.hitAt3)
  .sort((a, b) => b.metric.precisionAt3 - a.metric.precisionAt3 ||
    a.metric.falseDisplay - b.metric.falseDisplay || b.metric.hitAt3 - a.metric.hitAt3 || a.value - b.value)[0]?.value ?? 0;
const jev = metrics(holdout, threshold, "jev");
const latencySamples = holdout.map(({ searchMs, jevMs }) => Number(searchMs) + jevMs).sort((a, b) => a - b);
const estimatedP95Ms = latencySamples[Math.ceil(latencySamples.length * 0.95) - 1];
const qualityPassed = jev.precisionAt3 >= baseline.precisionAt3 + 0.1 &&
  jev.hitAt3 >= baseline.hitAt3 && jev.falseDisplay <= 1;
process.stdout.write(`${JSON.stringify({ threshold, baseline, jev, estimatedP95Ms, qualityPassed,
  latencyNote: "searchMs + Jev API time excludes browser rendering; measure displayed-card p95 in staging before enabling"
}, null, 2)}\n`);
