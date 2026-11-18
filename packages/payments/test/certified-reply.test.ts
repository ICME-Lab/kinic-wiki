import { afterEach, expect, it, vi } from "vitest";
import { Certificate, Cbor, HttpAgent, requestIdOf } from "@icp-sdk/core/agent";
import { Principal } from "@icp-sdk/core/principal";
import { certifiedReply } from "../src/transports/certified-reply";
const canisterId = "aaaaa-aa";
const sender = Principal.fromUint8Array(Uint8Array.of(2)).toText();
const base64 = (a: Uint8Array) => Buffer.from(a).toString("base64");
const arg = Uint8Array.of(1, 2);
const nonce = Uint8Array.of(3, 4);
const request = { canisterId, sender, method: "pay", arg: base64(arg), nonce: base64(nonce) };
const content = { request_type: "call", canister_id: Principal.fromText(canisterId).toUint8Array(), sender: Principal.fromText(sender).toUint8Array(), method_name: "pay", arg, nonce };
function result(changes = {}) { return { contentMap: base64(Cbor.encode({ ...content, ...changes })), certificate: base64(Uint8Array.of(0)) }; }
afterEach(() => vi.restoreAllMocks());
it.each([{ sender: Uint8Array.of(9) }, { canister_id: Uint8Array.of(9) }, { method_name: "submit" }, { arg: Uint8Array.of(2, 1) }, { nonce: Uint8Array.of(4) }])("rejects wrong signed request fields", async change => {
  const verify = vi.spyOn(Certificate, "create");
  await expect(certifiedReply("https://icp0.io", request, result(change))).rejects.toMatchObject({ code: "InvalidReply" });
  expect(verify).not.toHaveBeenCalled();
});
it("rejects an invalid certificate", async () => {
  await expect(certifiedReply("https://icp0.io", request, result())).rejects.toMatchObject({ code: "InvalidReply" });
});
it.each(["https://icp0.io", "https://127.0.0.1.example", "http://localhost:4943", "http://127.0.0.1:4943"])("only fetches a root key on a configured loopback host %s", async host => {
  const fetchKey = vi.spyOn(HttpAgent.prototype, "fetchRootKey").mockResolvedValue(Uint8Array.of(1));
  const lookup = vi.fn(() => ({ status: "Found", value: Uint8Array.of(42) }));
  vi.spyOn(Certificate, "create").mockResolvedValue({ lookup_path: lookup } as never);
  await expect(certifiedReply(host, request, result())).resolves.toEqual(Uint8Array.of(42));
  expect(lookup).toHaveBeenCalledWith([new TextEncoder().encode("request_status"), requestIdOf(content), "reply"]);
  expect(fetchKey).toHaveBeenCalledTimes(host.startsWith("http://") ? 1 : 0);
  lookup.mockReturnValue({ status: "Absent", value: Uint8Array.of() });
  await expect(certifiedReply(host, request, result())).rejects.toMatchObject({ code: "InvalidReply" });
});
