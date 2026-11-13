// Test-only bridge for PocketIC 16.1's TestThresholdKeys subnet, which the
// locked @dfinity/pic 0.21.0 request encoder and topology enum do not expose.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { realpathSync } from "node:fs";

const local = createRequire(new URL("../package.json", import.meta.url));
const require = createRequire(realpathSync(local.resolve("@dfinity/pic")));
const { PocketIc } = require("@dfinity/pic");
const { PocketIcClient } = require("@dfinity/pic/dist/pocket-ic-client.js");
const { Http2Client } = require("@dfinity/pic/dist/http2-client.js");
const { encodeCreateInstanceRequest } = require(
  "@dfinity/pic/dist/pocket-ic-client-types.js",
);

export async function createVaultPocketIcWithTestKeys(url, options) {
  assert.equal(
    require("@dfinity/pic/package.json").version,
    "0.21.0",
    "Review the test-key adapter against the installed PocketIC client",
  );
  const request = encodeCreateInstanceRequest(options);
  request.subnet_config_set.test_threshold_keys = {
    state_config: "New",
    instruction_config: "Production",
  };
  // Mirror 0.21.0's create/transport/client ownership; only the subnet is added.
  const transport = new Http2Client(url, options.processingTimeoutMs ?? 30_000);
  const result = await transport.jsonPost({ path: "/instances", body: request });
  assert.ok("Created" in result, JSON.stringify(result));
  const id = result.Created.instance_id;
  const client = new PocketIcClient(transport, `/instances/${id}`, id);
  try {
    // Read the real REST topology: 0.21.0 cannot decode TestThresholdKeys.
    const topology = await transport.jsonGet({
      path: `/instances/${id}/_/topology`,
    });
    const kinds = Object.values(topology.subnet_configs).map((x) => x.subnet_kind);
    for (const kind of ["Application", "Fiduciary", "TestThresholdKeys"])
      assert.ok(kinds.includes(kind), `Missing actual ${kind} subnet`);
    console.log("Vault test-key topology:", kinds.join(", "));
    return new PocketIc(client);
  } catch (error) {
    await client.deleteInstance();
    throw error;
  }
}
