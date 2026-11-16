import { test } from "node:test";
import assert from "node:assert/strict";
import {
  acceptMessage,
  parseLaunch,
  bridgeUrl,
  parseExactCycles,
  approvalFor,
  sessionFence,
  bridgeOrigins,
} from "./browser.ts";
const nonce = "a".repeat(64),
  id = "b".repeat(32),
  peer = {};
test("rejects wrong origin, source, nonce and extra secret-bearing fields", () => {
  const data = { protocol: "kinic-credit-v1", type: "offer", nonce, id };
  const accepts = (event) =>
    acceptMessage(event, {
      origin: "https://wiki.kinic.xyz",
      source: peer,
      nonce,
    });
  assert.equal(
    accepts({ origin: "https://wiki.kinic.xyz", source: peer, data })?.id,
    id,
  );
  for (const event of [
    { origin: "https://evil.test", source: peer, data },
    { origin: "https://wiki.kinic.xyz", source: {}, data },
    {
      origin: "https://wiki.kinic.xyz",
      source: peer,
      data: { ...data, nonce: "c".repeat(64) },
    },
    {
      origin: "https://wiki.kinic.xyz",
      source: peer,
      data: { ...data, identity: "secret" },
    },
  ])
    assert.equal(accepts(event), null);
});
test("launch parser admits opaque identifiers only and fixed origins", () => {
  const url = bridgeUrl("wiki", { mode: "link", id, nonce });
  assert.equal(
    url,
    `https://wiki.kinic.xyz/vault-credit#mode=link&id=${id}&nonce=${nonce}`,
  );
  assert.deepEqual(parseLaunch(new URL(url).hash), { mode: "link", id, nonce });
  for (const fragment of [
    `#mode=link&id=${id}&nonce=${nonce}&amount=1`,
    `#mode=link&id=${id}&nonce=${nonce}&id=${id}`,
    "#mode=link&id=x&nonce=y",
  ])
    assert.equal(parseLaunch(fragment), null);
  assert.throws(() =>
    bridgeOrigins(
      { wiki: "http://localhost:3010", vault: "http://localhost:3024" },
      false,
    ),
  );
  assert.throws(() =>
    bridgeOrigins(
      { wiki: "https://evil.test", vault: "http://localhost:3024" },
      true,
    ),
  );
});
test("Exact cycles reject rounding, zero, negatives and out of range; All requires explicit checkbox", () => {
  assert.equal(parseExactCycles("9007199254740993"), 9007199254740993n);
  for (const input of ["0", "-1", "1.5", "1e9", " 1", "9223372036854775808"])
    assert.throws(() => parseExactCycles(input));
  assert.throws(() => approvalFor({ All: null }, false));
  assert.deepEqual(approvalFor({ All: null }, true), { AllAvailable: null });
  assert.deepEqual(approvalFor({ Exact: 123n }, false), { Exact: 123n });
});
test("same Principal reauthentication and epoch changes reject all late responses", () => {
  const identity = { principal: "same" };
  let current = { identity, client: {}, epoch: 1 };
  const check = sessionFence(() => current);
  check();
  current = { ...current, identity: { principal: "same" } };
  assert.throws(check);
  const check2 = sessionFence(() => current);
  current = { ...current, epoch: 2 };
  assert.throws(check2);
  const check3 = sessionFence(() => current);
  current = { ...current, client: {} };
  assert.throws(check3);
});

test("fund receipts retain a strict opaque marker distinct from fresh launches", () => {
  const launch = { mode: "fund", id, nonce, receipt: "1" };
  assert.deepEqual(
    parseLaunch(new URL(bridgeUrl("wiki", launch)).hash),
    launch,
  );
  assert.equal(
    parseLaunch(`#mode=link&id=${id}&nonce=${nonce}&receipt=1`),
    null,
  );
  assert.equal(
    parseLaunch(`#mode=fund&id=${id}&nonce=${nonce}&receipt=0`),
    null,
  );
  assert.equal(
    parseLaunch(`#mode=fund&id=${id}&nonce=${nonce}&receipt=1&receipt=1`),
    null,
  );
});
