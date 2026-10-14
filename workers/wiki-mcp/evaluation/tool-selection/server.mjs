import { readFileSync, writeFileSync } from "node:fs";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createHash } from "node:crypto";
const [variant, inputFile, observationFile, round = "r0"] =
  process.argv.slice(2);
const input = JSON.parse(readFileSync(inputFile, "utf8"));
const nodes = Object.fromEntries(
  Object.entries(input.nodes).map(([k, n]) => [
    k,
    {
      path: k.slice(k.indexOf(":") + 1),
      kind: "file",
      metadataJson: "{}",
      createdAt: "1",
      updatedAt: "1",
      etag: "v1",
      ...n,
    },
  ]),
);
globalThis.__wikiFixture = {
  nodes,
  reads: [],
  commits: [],
  mutationAttempts: 0,
  externalUpdates: 0,
  revision: 1,
  conflictPending: input.conflict === true,
  manifestRead: false,
};
const { createServer } = await import(`./.tmp-test/${round}/${variant}.mjs`);
const server = createServer(
  {
    KINIC_WIKI_PUBLIC_ORIGIN: "https://wiki.kinic.test",
    KINIC_WIKI_IDENTITY: {},
    KINIC_WIKI_AUTHORIZATION: {
      actionPermission: "all",
      scopes: ["mcp:read", "mcp:write"],
      identitySource: "internet_identity",
    },
  },
  { accessPolicy: "private_required", writesAvailable: true },
);
const transport = new StdioServerTransport();
const observation = { calls: [], descriptorHash: null, descriptorBytes: null };
const requests = new Map();
function save() {
  writeFileSync(
    observationFile,
    JSON.stringify({ ...observation, ...globalThis.__wikiFixture }),
  );
}
const send = transport.send.bind(transport);
transport.send = async (message) => {
  const request = requests.get(message.id);
  if (request?.method === "tools/call") {
    const call = observation.calls.find((c) => c.id === message.id);
    if (call) {
      call.response = message.result ?? message.error;
      call.protocolError = !!message.error;
    }
  }
  if (request?.method === "tools/list" && message.result) {
    const json = JSON.stringify(message.result);
    observation.descriptorHash = createHash("sha256")
      .update(json)
      .digest("hex");
    observation.descriptorBytes = Buffer.byteLength(json);
  }
  save();
  return send(message);
};
await server.connect(transport);
const receive = transport.onmessage;
transport.onmessage = (message, extra) => {
  requests.set(message.id, message);
  if (message.method === "tools/call") {
    if (observation.calls.length >= 12) {
      save();
      void send({
        jsonrpc: "2.0",
        id: message.id,
        error: {
          code: -32600,
          message: "Evaluation tool-call budget exhausted",
        },
      });
      return;
    }
    observation.calls.push({
      id: message.id,
      name: message.params.name,
      arguments: message.params.arguments,
    });
  }
  save();
  receive(message, extra);
};
save();
