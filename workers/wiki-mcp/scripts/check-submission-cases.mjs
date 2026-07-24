#!/usr/bin/env node
// Where: workers/wiki-mcp/scripts/check-submission-cases.mjs
// What: Validates the review submission and its fixed public read-only MCP cases.
// Why: OpenAI review prompts must remain self-contained and reproducible against deployed endpoints.

import { readFileSync } from "node:fs";

const SKILL_ROOT = new URL("../../../skills/kinic-wiki-mcp/", import.meta.url);
const SKILL_FILE = new URL("SKILL.md", SKILL_ROOT);
const SKILL_TOOL_REFERENCE = new URL("references/tools.md", SKILL_ROOT);
const SKILL_OPENAI_CONFIG = new URL("agents/openai.yaml", SKILL_ROOT);
const DATABASE_ID = "db_kva4v2twg6jv";
const DATABASE_QUERY = "KINIC-WIKI";
const BROWSER_CLIPPER_PATH = "/Wiki/operators/browser-and-clipper.md";
const OPERATOR_INDEX_PATH = "/Wiki/operators/index.md";
const CODE_MAP_PATH = "/Wiki/architecture/code-map.md";
const MISSING_PATH = "/__kinic_openai_review_missing__.md";
const EXPECTED_TOOLS = [
  "context",
  "fetch_many",
  "find_databases",
  "list",
  "memory_manifest",
  "read_path",
  "read_paths",
  "search"
];
const EXPECTED_CASE_TOOLS = [
  "find_databases",
  "context",
  "search, fetch_many",
  "list, read_paths",
  "memory_manifest, read_path"
];
const DEFAULT_MCP_URLS = [
  "https://wiki-mcp-staging.kinic.xyz/mcp",
  "https://wiki-mcp.kinic.xyz/mcp"
];

const args = parseArgs(process.argv.slice(2));
let jsonRpcId = 0;

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

async function main() {
  const submission = JSON.parse(
    readFileSync(new URL("../chatgpt-app-submission.json", import.meta.url), "utf8")
  );
  validateSubmission(submission);
  validateSkill();

  const reports = [];
  for (const mcpUrl of args.mcpUrls) {
    for (let run = 1; run <= args.repeats; run += 1) {
      const started = performance.now();
      await checkEndpoint(mcpUrl);
      reports.push({
        mcp_url: mcpUrl,
        run,
        ok: true,
        elapsed_ms: Math.round((performance.now() - started) * 100) / 100
      });
    }
  }

  console.log(JSON.stringify({
    ok: true,
    submission: {
      tools: EXPECTED_TOOLS.length,
      positive_test_cases: submission.test_cases.length,
      negative_test_cases: submission.negative_test_cases.length,
      skill: "kinic-wiki-mcp"
    },
    reports
  }, null, 2));
}

function validateSkill() {
  const skill = readRequiredFile(SKILL_FILE, "skill instructions");
  const toolReference = readRequiredFile(SKILL_TOOL_REFERENCE, "skill tool reference");
  const openAiConfig = readRequiredFile(SKILL_OPENAI_CONFIG, "skill OpenAI configuration");

  assert(/^name:\s*kinic-wiki-mcp$/m.test(skill), "skill name must be kinic-wiki-mcp");
  assert(
    skill.includes("Never pass ChatGPT citation aliases such as `turn0file0`."),
    "skill must reject ChatGPT citation aliases"
  );
  assert(
    skill.includes("https://wiki.kinic.xyz/db/{database_id}{path}"),
    "skill must document the public fetch URL fallback"
  );
  assert(
    /Reject or decline write, delete, private-access, and credential requests without calling the MCP\./.test(skill),
    "skill must keep unsupported requests from invoking the MCP"
  );
  assert(
    toolReference.includes(`"database_id":"${DATABASE_ID}"`),
    `skill reference must use ${DATABASE_ID}`
  );
  for (const path of [BROWSER_CLIPPER_PATH, OPERATOR_INDEX_PATH, CODE_MAP_PATH]) {
    assert(toolReference.includes(path), `skill reference must include ${path}`);
  }
  assert(
    openAiConfig.includes('value: "kinic-wiki-mcp"') &&
      openAiConfig.includes('transport: "streamable_http"') &&
      openAiConfig.includes('url: "https://wiki-mcp.kinic.xyz/mcp"'),
    "skill OpenAI configuration must depend on the production Kinic Wiki MCP"
  );
  assert(
    openAiConfig.includes("allow_implicit_invocation: true"),
    "skill must allow implicit invocation for submitted review prompts"
  );
}

function readRequiredFile(url, label) {
  try {
    return readFileSync(url, "utf8");
  } catch (error) {
    throw new Error(`${label} is required at ${url.pathname}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function validateSubmission(submission) {
  assert(Array.isArray(submission.test_cases) && submission.test_cases.length === 5, "submission must contain exactly five positive test cases");
  assert(Array.isArray(submission.negative_test_cases) && submission.negative_test_cases.length === 3, "submission must contain exactly three negative test cases");
  assertSameValues(Object.keys(submission.tools).sort(), EXPECTED_TOOLS, "submission tool names");
  assertSameValues(
    submission.test_cases.map((testCase) => testCase.tools_triggered),
    EXPECTED_CASE_TOOLS,
    "positive test tool sequences"
  );

  const prompts = submission.test_cases.map((testCase) => testCase.user_prompt);
  assert(prompts[0].includes(DATABASE_QUERY), "database discovery prompt must name KINIC-WIKI");
  for (const prompt of prompts.slice(1)) {
    assert(prompt.includes(DATABASE_ID), `positive test prompt must include ${DATABASE_ID}`);
  }
  assert(prompts[3].includes(BROWSER_CLIPPER_PATH) && prompts[3].includes(OPERATOR_INDEX_PATH), "batch-read prompt must include both stable operator paths");
  assert(prompts[4].includes(CODE_MAP_PATH), "single-read prompt must include the stable code map path");

  for (const testCase of submission.test_cases) {
    assert(
      !/(ranking scores|batch metadata|internal truncation)/i.test(testCase.expected_output),
      "expected outputs must remain user-facing"
    );
  }

  for (const [toolName, tool] of Object.entries(submission.tools)) {
    const annotations = tool.annotations;
    assert(annotations?.readOnlyHint === true, `${toolName} must declare readOnlyHint=true`);
    assert(annotations?.openWorldHint === false, `${toolName} must declare openWorldHint=false`);
    assert(annotations?.destructiveHint === false, `${toolName} must declare destructiveHint=false`);
  }
}

async function checkEndpoint(mcpUrl) {
  const toolsResponse = await mcpRequest(mcpUrl, "tools/list", {});
  const toolNames = toolsResponse.result?.tools?.map((tool) => tool.name).sort();
  assertSameValues(toolNames, EXPECTED_TOOLS, `${mcpUrl} tool names`);

  const discovery = await callTool(mcpUrl, "find_databases", {
    query: DATABASE_QUERY,
    limit: 10
  });
  assert(
    discovery.payload.databases?.some((database) => database.database_id === DATABASE_ID),
    `${mcpUrl} must discover ${DATABASE_ID}`
  );

  const context = await callTool(mcpUrl, "context", {
    database_id: DATABASE_ID,
    task: "clipper usage",
    budget_tokens: 2000,
    include_evidence: true,
    depth: 1
  });
  assert(context.payload.namespace === "/", `${mcpUrl} context must default to namespace /`);
  assert(
    context.payload.nodes?.some((entry) => entry.node?.path === BROWSER_CLIPPER_PATH),
    `${mcpUrl} context must return the browser clipper page`
  );

  const search = await callTool(mcpUrl, "search", {
    database_id: DATABASE_ID,
    query: "clipper usage",
    prefix: "/",
    limit: 10,
    preview_mode: "content-start"
  });
  const searchResults = search.payload.results;
  assert(
    searchResults?.some((result) => result.metadata?.path === BROWSER_CLIPPER_PATH),
    `${mcpUrl} search must return the browser clipper page`
  );
  const publicUrls = searchResults.slice(0, 2).map((result) => result.url);
  const fetched = await callTool(mcpUrl, "fetch_many", { ids: publicUrls });
  assert(fetched.payload.results?.length === publicUrls.length, `${mcpUrl} fetch_many must return every requested result`);
  assert(
    fetched.payload.results.every((result) => result.is_error !== true && typeof result.text === "string"),
    `${mcpUrl} fetch_many must return readable node text`
  );

  const list = await callTool(mcpUrl, "list", {
    database_id: DATABASE_ID,
    prefix: "/",
    recursive: false,
    limit: 99
  });
  assert(Array.isArray(list.payload.entries) && list.payload.entries.length > 0, `${mcpUrl} list must return root inventory`);
  assert(list.payload.metadata?.limit === 99, `${mcpUrl} list must preserve limit 99`);

  const batch = await callTool(mcpUrl, "read_paths", {
    database_id: DATABASE_ID,
    paths: [BROWSER_CLIPPER_PATH, OPERATOR_INDEX_PATH]
  });
  assert(
    batch.payload.results?.every((result) => result.is_error !== true && typeof result.text === "string"),
    `${mcpUrl} read_paths must return both stable operator pages`
  );

  const manifest = await callTool(mcpUrl, "memory_manifest", {
    database_id: DATABASE_ID
  });
  assert(typeof manifest.payload.write_policy === "string", `${mcpUrl} manifest must include a write policy`);

  const node = await callTool(mcpUrl, "read_path", {
    database_id: DATABASE_ID,
    path: CODE_MAP_PATH
  });
  assert(node.payload.metadata?.path === CODE_MAP_PATH && typeof node.payload.text === "string", `${mcpUrl} read_path must return the stable code map`);

  const missing = await callTool(mcpUrl, "read_path", {
    database_id: DATABASE_ID,
    path: MISSING_PATH
  }, { expectError: true });
  assert(missing.response.result?.structuredContent === undefined, `${mcpUrl} tool errors must omit structuredContent`);
}

async function callTool(mcpUrl, name, toolArgs, options = {}) {
  const response = await mcpRequest(mcpUrl, "tools/call", {
    name,
    arguments: toolArgs
  });
  const content = response.result?.content;
  const text = Array.isArray(content) && content[0]?.type === "text" ? content[0].text : "";
  const payload = response.result?.structuredContent ?? parseJson(text, `${mcpUrl} ${name} returned non-JSON text`);
  const isError = response.result?.isError === true;
  assert(
    options.expectError ? isError : !isError,
    `${mcpUrl} ${name} ${options.expectError ? "must fail" : "must succeed"}: ${text}`
  );
  return { response: { result: response.result }, payload };
}

async function mcpRequest(mcpUrl, method, params) {
  jsonRpcId += 1;
  const response = await fetch(mcpUrl, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-protocol-version": "2025-06-18"
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: jsonRpcId,
      method,
      params
    })
  });
  const text = await response.text();
  const parsed = parseMcpResponse(text);
  assert(response.ok && !parsed.error, `${mcpUrl} ${method} failed: ${text}`);
  return parsed;
}

function parseMcpResponse(text) {
  const dataLine = text.split("\n").find((line) => line.startsWith("data: "));
  return parseJson(dataLine ? dataLine.slice("data: ".length) : text, "MCP returned invalid JSON");
}

function parseJson(value, message) {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(message);
  }
}

function parseArgs(argv) {
  const parsed = { mcpUrls: [], repeats: 1 };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      continue;
    } else if (arg === "--mcp-url") {
      parsed.mcpUrls.push(requiredValue(argv, ++index, arg));
    } else if (arg === "--repeats") {
      const repeats = Number.parseInt(requiredValue(argv, ++index, arg), 10);
      assert(Number.isInteger(repeats) && repeats > 0, "--repeats must be a positive integer");
      parsed.repeats = repeats;
    } else if (arg === "--help" || arg === "-h") {
      console.log("Usage: node scripts/check-submission-cases.mjs [--mcp-url <url>]... [--repeats <n>]");
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (parsed.mcpUrls.length === 0) {
    parsed.mcpUrls = DEFAULT_MCP_URLS;
  }
  return parsed;
}

function requiredValue(argv, index, flag) {
  const value = argv[index];
  assert(value, `${flag} requires a value`);
  return value;
}

function assertSameValues(actual, expected, label) {
  assert(
    Array.isArray(actual) &&
      actual.length === expected.length &&
      actual.every((value, index) => value === expected[index]),
    `${label} mismatch: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`
  );
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
