// Where: extensions/wiki-clipper/scripts/capture-web-source-local.mjs
// What: Capture public pages with the same DOM source logic as the MV3 action click.
// Why: Extraction quality should be inspectable without installing or invoking the extension.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { buildWebEvidenceSource, collectWebPageSnapshot } from "../src/web-source.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = resolve(root, "tmp", "web-source-captures");
const urls = process.argv.slice(2);
const targets =
  urls.length > 0
    ? urls
    : [
        "https://www.iana.org/help/example-domains",
        "https://developer.mozilla.org/en-US/docs/Web/API/Document",
        "https://web.dev/articles/structured-data"
      ];

await mkdir(outputRoot, { recursive: true });
const browser = await chromium.launch({ headless: true });
const results = [];

try {
  for (const url of targets) {
    const page = await browser.newPage();
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
      const snapshot = await page.evaluate(collectWebPageSnapshot);
      const evidenceSource = await buildWebEvidenceSource(snapshot);
      const localDir = resolve(outputRoot, evidenceSource.sourceId);
      const localPath = resolve(localDir, `${evidenceSource.sourceId}.md`);
      await mkdir(localDir, { recursive: true });
      await writeFile(localPath, evidenceSource.content, "utf8");
      const textChars = JSON.parse(evidenceSource.metadataJson).text_chars;
      const preview = evidenceSource.content.split("\n").slice(14, 24).join("\n").trim();
      results.push({
        ok: true,
        url,
        finalUrl: snapshot.url,
        title: snapshot.title,
        textChars,
        localPath,
        sourcePath: evidenceSource.path,
        preview
      });
    } catch (error) {
      results.push({
        ok: false,
        url,
        error: error instanceof Error ? error.message : String(error)
      });
    } finally {
      await page.close().catch(() => {});
    }
  }
} finally {
  await browser.close();
}

const reportPath = resolve(outputRoot, "report.md");
await writeFile(reportPath, renderReport(results), "utf8");
console.log(reportPath);
for (const result of results) {
  console.log(`${result.ok ? "OK" : "FAIL"} ${result.url}${result.ok ? ` -> ${result.localPath}` : `: ${result.error}`}`);
}

function renderReport(items) {
  const lines = ["# Local Web Source Capture Report", ""];
  for (const item of items) {
    lines.push(`## ${item.ok ? "OK" : "FAIL"} ${item.url}`, "");
    if (!item.ok) {
      lines.push(`- error: ${item.error}`, "");
      continue;
    }
    lines.push(`- final_url: ${item.finalUrl}`);
    lines.push(`- title: ${item.title}`);
    lines.push(`- text_chars: ${item.textChars}`);
    lines.push(`- local_path: ${item.localPath}`);
    lines.push(`- source_path: ${item.sourcePath}`);
    lines.push("");
    lines.push("```text");
    lines.push(item.preview);
    lines.push("```", "");
  }
  return `${lines.join("\n")}\n`;
}
