import { env } from "cloudflare:test";
import { Cbor, requestIdOf, type DerEncodedPublicKey } from "@icp-sdk/core/agent";
import { IDL } from "@icp-sdk/core/candid";
import { DelegationChain, Ed25519KeyIdentity, Ed25519PublicKey } from "@icp-sdk/core/identity";
import { Principal } from "@icp-sdk/core/principal";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { AssistantAuth } from "../src/auth";
import { AssistantStore } from "../src/store";
import type { Env } from "../src/env";

const bindings = env as Env;
beforeAll(async () => {
  await bindings.ASSISTANT_DB.exec((env as Env & { TEST_MIGRATION: string }).TEST_MIGRATION);
});
afterEach(() => vi.unstubAllGlobals());
const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

it.each([false, true])("authenticates native delegation with a signed query and enforces denied=%s without response certificates", async (denied) => {
  const root = Ed25519KeyIdentity.generate();
  const id = crypto.randomUUID();
  const auth = new AssistantAuth(bindings, id);
  const pending = await auth.beginNative(id, "native-db", root.getPrincipal().toText());
  const leafBytes = Uint8Array.from(atob(pending.publicKey), c => c.charCodeAt(0));
  const leaf = Ed25519PublicKey.fromDer(leafBytes as DerEncodedPublicKey);
  const chain = await DelegationChain.create(root, leaf, new Date(Date.now() + 60_000), {
    permissions: "queries", targets: [Principal.fromText(bindings.KINIC_WIKI_CANISTER_ID)],
  });
  const response = {
    jsonrpc: "2.0", id: pending.requestId,
    result: { publicKey: base64(chain.publicKey), signerDelegation: chain.delegations.map(hop => ({
      delegation: {
        pubkey: base64(hop.delegation.pubkey), expiration: String(hop.delegation.expiration),
        targets: hop.delegation.targets?.map(p => p.toText()), permissions: hop.delegation.permissions,
      }, signature: base64(hop.signature),
    })) },
  };
  const transport = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    expect(url.origin).toBe("https://icp0.io");
    expect(url.pathname.endsWith("/query")).toBe(true);
    const envelope = Cbor.decode<{
      content: { sender: Uint8Array; method_name: string; arg: Uint8Array };
      sender_pubkey: Uint8Array; sender_sig: Uint8Array;
      sender_delegation: { delegation: { permissions: string; targets: Uint8Array[] } }[];
    }>(new Uint8Array(init!.body as ArrayBuffer));
    expect(envelope.content.method_name).toBe("read_node");
    expect(Principal.fromUint8Array(envelope.content.sender).toText()).toBe(root.getPrincipal().toText());
    expect([...envelope.sender_pubkey]).toEqual([...root.getPublicKey().toDer()]);
    expect(envelope.sender_delegation[0].delegation.permissions).toBe("queries");
    expect(envelope.sender_delegation[0].delegation.targets).toEqual([Principal.fromText(bindings.KINIC_WIKI_CANISTER_ID).toUint8Array()]);
    expect(IDL.decode([IDL.Text, IDL.Text], envelope.content.arg)).toEqual(["native-db", "/Knowledge"]);
    const challenge = new Uint8Array([...new TextEncoder().encode("\x0Aic-request"), ...requestIdOf(envelope.content)]);
    expect(Ed25519KeyIdentity.verify(envelope.sender_sig, challenge, leaf.toRaw())).toBe(true);
    const arg = IDL.encode([IDL.Variant({ Ok: IDL.Opt(IDL.Record({})), Err: IDL.Text })], [denied ? { Err: "access denied" } : { Ok: [] }]);
    // Deliberately no query response signatures: only the fixed HTTPS gateway
    // response is trusted. The request's signature/delegation remains intact.
    return new Response(Cbor.encode({ status: "replied", reply: { arg } }), { status: 200 });
  });
  vi.stubGlobal("fetch", transport);
  if (denied) {
    await expect(auth.completeNative(pending.token, pending.state, response)).rejects.toThrow("database_access_denied");
  } else {
    expect((await auth.completeNative(pending.token, pending.state, response)).principal).toBe(root.getPrincipal().toText());
  }
  expect(transport).toHaveBeenCalledTimes(1);
  const record = await new AssistantStore(bindings).auth<{ phase: string; principal: string | null }>(id);
  expect(record?.phase === "active").toBe(!denied);
  expect(record?.principal).toBe(denied ? null : root.getPrincipal().toText());
});
