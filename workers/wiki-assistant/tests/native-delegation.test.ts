import { describe, expect, it } from "vitest";
import { Ed25519KeyIdentity } from "@icp-sdk/core/identity";
import { nativeDelegation, publicKeyBase64 } from "../src/native-delegation";
const key = Ed25519KeyIdentity.generate();
const root = Ed25519KeyIdentity.generate();
const now = 1_800_000_000_000;
function fixture() { return { jsonrpc: "2.0", id: "request", result: { publicKey: publicKeyBase64(root), signerDelegation: [{ delegation: {
  pubkey: publicKeyBase64(key), expiration: String(BigInt(now + 10000) * 1000000n), permissions: "queries", targets: undefined as string[] | undefined,
}, signature: btoa("test signature") }] } }; }
function parse(value: unknown) { return nativeDelegation(value, "request", key, "https://wiki.example", "aaaaa-aa", now + 3600000, now); }
describe("native delegation structural gate (IC query must additionally verify signatures)", () => {
  it("accepts query-only without canister targets and preserves signed permissions", () => {
    const { material } = parse(fixture());
    expect(material.expiresAt).toBe(now + 10000);
    expect(material.delegation.delegations[0].delegation.permissions).toBe("queries");
  });
  it("accepts a target restriction that includes the configured canister", () => {
    const value = fixture(); value.result.signerDelegation[0].delegation.targets = ["aaaaa-aa"];
    expect(() => parse(value)).not.toThrow();
  });
  it("rejects target restrictions excluding the configured canister", () => {
    const value = fixture(); value.result.signerDelegation[0].delegation.targets = ["2vxsx-fae"];
    expect(() => parse(value)).toThrow("invalid_delegation_target");
  });
  it("rejects an update-capable chain", () => {
    const value = fixture(); value.result.signerDelegation[0].delegation.permissions = "all";
    expect(() => parse(value)).toThrow("choose_questions_only");
  });
  it("rejects wrong request and final public key", () => {
    const value = fixture(); value.id = "old"; expect(() => parse(value)).toThrow("invalid_auth_state");
    value.id = "request"; value.result.signerDelegation[0].delegation.pubkey = publicKeyBase64(root);
    expect(() => parse(value)).toThrow("invalid_delegation_key");
  });
  it("rejects expired and overlong effective delegations", () => {
    const value = fixture(); value.result.signerDelegation[0].delegation.expiration = String(BigInt(now) * 1000000n);
    expect(() => parse(value)).toThrow("authentication_required");
    value.result.signerDelegation[0].delegation.expiration = String(BigInt(now + 3600001) * 1000000n);
    expect(() => parse(value)).toThrow("invalid_delegation_expiry");
  });
  it("bounds effective lifetime without rejecting a longer parent hop", () => {
    const value = fixture(); const leaf = value.result.signerDelegation[0];
    value.result.signerDelegation.unshift({ ...leaf, delegation: { ...leaf.delegation, pubkey: publicKeyBase64(root), expiration: String(BigInt(now + 86400000) * 1000000n) } });
    expect(parse(value).material.expiresAt).toBe(now + 10000);
  });
});
