import { spawnSync } from "node:child_process";

const baseUrl = readRequiredArg("--base-url", "WIKI_BROWSER_PUBLIC_BASE_URL").replace(/\/$/, "");
const databaseId = readRequiredArg("--database-id", "WIKI_BROWSER_PUBLIC_DATABASE_ID");
const path = normalizePath(readRequiredArg("--path", "WIKI_BROWSER_PUBLIC_PATH"));
const nodeUrl = `${baseUrl}/db/${encodeURIComponent(databaseId)}${path}`;

runNodeScript("scripts/smoke-ui.mjs", ["--url", nodeUrl]);
runNodeScript("scripts/smoke-errors.mjs", ["--base-url", baseUrl, "--database-id", databaseId]);

console.log(`Wiki browser public smoke OK: ${baseUrl} ${databaseId} ${path}`);

function readRequiredArg(flag, envName) {
  const argIndex = process.argv.indexOf(flag);
  const value = argIndex >= 0 ? process.argv[argIndex + 1] : process.env[envName];
  if (!value) {
    throw new Error(`missing ${flag} or ${envName}`);
  }
  return value;
}

function normalizePath(value) {
  return value.startsWith("/") ? value : `/${value}`;
}

function runNodeScript(script, args) {
  const result = spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  const output = `${result.stdout}${result.stderr}`;
  if (result.status !== 0) {
    throw new Error(output);
  }
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
}
