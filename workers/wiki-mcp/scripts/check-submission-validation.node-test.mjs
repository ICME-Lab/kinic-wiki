import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { validateOpenAiConfigYaml, validateSubmissionSchema } from "./check-submission-cases.mjs";

const validYaml = readFileSync(
  new URL("../../../skills/kinic-wiki-mcp/agents/openai.yaml", import.meta.url),
  "utf8"
);
const validSubmission = JSON.parse(
  readFileSync(new URL("../chatgpt-app-submission.json", import.meta.url), "utf8")
);

test("accepts the checked-in OpenAI YAML", () => {
  assert.doesNotThrow(() => validateOpenAiConfigYaml(validYaml));
});

test("rejects malformed YAML", () => {
  assert.throws(() => validateOpenAiConfigYaml("interface:\n display_name: [broken"));
});

test("rejects duplicate YAML keys", () => {
  assert.throws(() =>
    validateOpenAiConfigYaml(`${validYaml}\npolicy:\n  allow_implicit_invocation: true\n`)
  );
});

test("rejects expected strings at the wrong hierarchy", () => {
  assert.throws(() =>
    validateOpenAiConfigYaml(`
interface:
  display_name: Kinic Wiki MCP
  short_description: Public wiki
  default_prompt: Use wiki
dependencies:
  tools: []
type: mcp
value: kinic-wiki-mcp
transport: streamable_http
url: https://wiki-mcp.kinic.xyz/mcp
policy:
  allow_implicit_invocation: true
`)
  );
});

test("rejects expected strings that appear only in comments", () => {
  assert.throws(() =>
    validateOpenAiConfigYaml(`
# value: kinic-wiki-mcp
# transport: streamable_http
# url: https://wiki-mcp.kinic.xyz/mcp
interface:
  display_name: Kinic Wiki MCP
  short_description: Public wiki
  default_prompt: Use wiki
dependencies:
  tools: []
policy:
  allow_implicit_invocation: true
`)
  );
});

test("rejects incorrect YAML value types", () => {
  assert.throws(() =>
    validateOpenAiConfigYaml(validYaml.replace("allow_implicit_invocation: true", "allow_implicit_invocation: yes"))
  );
});

test("accepts the checked-in submission JSON against the pinned schema", () => {
  assert.doesNotThrow(() => validateSubmissionSchema(validSubmission));
});

test("rejects submission JSON with an outdated schema URL", () => {
  assert.throws(() =>
    validateSubmissionSchema({
      ...validSubmission,
      $schema: "https://developers.openai.com/apps-sdk/schemas/chatgpt-app-submission.v1.json"
    })
  );
});

test("rejects submission JSON with invalid annotation types", () => {
  assert.throws(() =>
    validateSubmissionSchema({
      ...validSubmission,
      tools: {
        ...validSubmission.tools,
        context: {
          ...validSubmission.tools.context,
          annotations: {
            ...validSubmission.tools.context.annotations,
            readOnlyHint: "true"
          }
        }
      }
    })
  );
});
