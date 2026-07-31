import { describe, expect, it, vi } from "vitest";
import { DelegationChain } from "@icp-sdk/core/identity";
import {
  generateIiKey,
  IiDelegationError,
  IiRegistrationError,
  mintKinicIdentity,
  PER_APP_DELEGATION_TTL_NS,
  redeemRegistration,
  resolveKinicMcpTargetOrigin,
  restoreRegistrationIdentity,
  type InternetIdentityActor
} from "../src/auth/internet-identity.js";
import {
  authenticationBoundaryResponse,
  authenticationMode,
  classifyRegistrationFailure,
  readLimitedText
} from "../src/auth/oauth.js";
import type { RuntimeEnv } from "../src/vfs.js";

const KINIC_CANISTER_ID = "6emaw-iyaaa-aaaay-aacka-cai";
const KINIC_MCP_TARGET_ORIGIN = `https://${KINIC_CANISTER_ID}.ic0.app`;

describe("Internet Identity MCP protocol", () => {
  it("restores an actual serialized two-hop registration delegation", async () => {
    const rootKey = generateIiKey();
    const browserKey = generateIiKey();
    const registrationKey = generateIiKey();
    const expiration = new Date(Date.now() + 60_000);
    const firstHop = await DelegationChain.create(rootKey, browserKey.getPublicKey(), expiration);
    const secondHop = await DelegationChain.create(browserKey, registrationKey.getPublicKey(), expiration, {
      previous: firstHop
    });

    const identity = restoreRegistrationIdentity(registrationKey, JSON.stringify(secondHop.toJSON()));

    expect(identity.getPrincipal().toText()).toBe(rootKey.getPrincipal().toText());
  });

  it("classifies a malformed registration delegation without exposing its contents", () => {
    expect(() => restoreRegistrationIdentity(generateIiKey(), "{\"delegations\":[]}")).toThrowError(
      new IiRegistrationError("invalid_delegation", "delegation_restore")
    );
  });

  it("accepts a full-access registration grant", async () => {
    const actor = actorStub();
    actor.mcp_register_v2 = vi.fn().mockResolvedValue({
      Ok: { expiration: 10_000_000_000n, permissions: { all: null } }
    });
    await expect(redeemRegistration(generateIiKey(), generateIiKey(), "", actor)).resolves.toEqual({
      grantExpiresAt: 10_000,
      permissions: "all"
    });
  });

  it("classifies an Internet Identity registration rejection", async () => {
    const actor = actorStub();
    actor.mcp_register_v2 = vi.fn().mockResolvedValue({ Err: "sensitive upstream detail" });

    await expect(redeemRegistration(generateIiKey(), generateIiKey(), "", actor)).rejects.toMatchObject(
      new IiRegistrationError("registration_rejected", "registration_result")
    );
  });

  it("classifies an Internet Identity actor call failure", async () => {
    const actor = actorStub();
    actor.mcp_register_v2 = vi.fn().mockRejectedValue(new Error("sensitive transport detail"));

    await expect(redeemRegistration(generateIiKey(), generateIiKey(), "", actor)).rejects.toMatchObject(
      new IiRegistrationError("temporarily_unavailable", "registration_call")
    );
  });

  it("accepts a queries grant and converts its expiration", async () => {
    const actor = actorStub();
    actor.mcp_register_v2 = vi.fn().mockResolvedValue({
      Ok: { expiration: 10_000_000_000n, permissions: { queries: null } }
    });
    await expect(redeemRegistration(generateIiKey(), generateIiKey(), "", actor)).resolves.toEqual({
      grantExpiresAt: 10_000,
      permissions: "queries"
    });
  });

  it.each([
    { accessLevel: "queries", delegationPermissions: ["queries"] as [string] },
    { accessLevel: "all", delegationPermissions: [] as [] }
  ])(
    "uses the fixed Kinic origin, default account, and five-minute $accessLevel delegation",
    async ({ delegationPermissions }) => {
      const actor = actorStub();
      const appKey = generateIiKey();
      actor.mcp_prepare_delegation = vi.fn().mockImplementation(
        async (_origin, _account, publicKey) => ({
          Ok: { user_key: appKey.getPublicKey().toDer(), expiration: 20_000_000_000n, account_number: [] }
        })
      );
      actor.mcp_get_delegation = vi.fn().mockImplementation(async (_origin, _account, publicKey) => ({
        Ok: {
          delegation: {
            pubkey: publicKey,
            expiration: 20_000_000_000n,
            targets: [],
            permissions: delegationPermissions
          },
          signature: new Uint8Array(64)
        }
      }));

      await mintKinicIdentity(generateIiKey(), KINIC_MCP_TARGET_ORIGIN, actor);

      expect(actor.mcp_get_accounts).toHaveBeenCalledWith(KINIC_MCP_TARGET_ORIGIN);
      expect(actor.mcp_prepare_delegation).toHaveBeenCalledWith(
        KINIC_MCP_TARGET_ORIGIN,
        [],
        expect.any(Uint8Array),
        [PER_APP_DELEGATION_TTL_NS]
      );
      expect(actor.mcp_get_delegation).toHaveBeenCalledWith(
        KINIC_MCP_TARGET_ORIGIN,
        [],
        expect.any(Uint8Array),
        20_000_000_000n
      );
    }
  );

  it("classifies account lookup transport and result failures without upstream details", async () => {
    const transportFailure = actorStub();
    transportFailure.mcp_get_accounts = vi.fn().mockRejectedValue(new Error("sensitive transport detail"));
    await expect(mintKinicIdentity(generateIiKey(), KINIC_MCP_TARGET_ORIGIN, transportFailure)).rejects.toMatchObject(
      new IiDelegationError("accounts_call")
    );

    const resultFailure = actorStub();
    resultFailure.mcp_get_accounts = vi.fn().mockResolvedValue({
      Err: { InternalCanisterError: "sensitive upstream detail" }
    });
    await expect(mintKinicIdentity(generateIiKey(), KINIC_MCP_TARGET_ORIGIN, resultFailure)).rejects.toMatchObject(
      new IiDelegationError("accounts_result")
    );
  });

  it("accepts only the bare ic0.app origin for the configured Kinic canister", () => {
    expect(resolveKinicMcpTargetOrigin(KINIC_MCP_TARGET_ORIGIN, KINIC_CANISTER_ID)).toBe(
      KINIC_MCP_TARGET_ORIGIN
    );
  });

  it.each([
    undefined,
    "",
    `http://${KINIC_CANISTER_ID}.ic0.app`,
    `${KINIC_MCP_TARGET_ORIGIN}/`,
    `${KINIC_MCP_TARGET_ORIGIN}/path`,
    `${KINIC_MCP_TARGET_ORIGIN}:443`,
    `${KINIC_MCP_TARGET_ORIGIN}?query=1`,
    `${KINIC_MCP_TARGET_ORIGIN}#fragment`,
    "https://aaaaa-aa.ic0.app",
    `https://${KINIC_CANISTER_ID}.icp0.io`
  ])("rejects invalid MCP target origin %s", (targetOrigin) => {
    expect(() => resolveKinicMcpTargetOrigin(targetOrigin, KINIC_CANISTER_ID)).toThrowError(
      new IiDelegationError("origin_configuration")
    );
  });

  it("rejects a missing or mismatched Kinic canister id", () => {
    expect(() => resolveKinicMcpTargetOrigin(KINIC_MCP_TARGET_ORIGIN, undefined)).toThrowError(
      new IiDelegationError("origin_configuration")
    );
    expect(() => resolveKinicMcpTargetOrigin(KINIC_MCP_TARGET_ORIGIN, "aaaaa-aa")).toThrowError(
      new IiDelegationError("origin_configuration")
    );
  });

  it("maps registration failures to stable callback responses", () => {
    expect(
      classifyRegistrationFailure(new IiRegistrationError("invalid_delegation", "delegation_restore"))
    ).toEqual({
      error: "invalid_connection",
      stage: "delegation_restore",
      status: 400
    });
    expect(
      classifyRegistrationFailure(new IiRegistrationError("registration_rejected", "registration_result"))
    ).toMatchObject({ error: "registration_rejected", stage: "registration_result", status: 401 });
    expect(
      classifyRegistrationFailure(new IiRegistrationError("temporarily_unavailable", "registration_call"))
    ).toMatchObject({ error: "temporarily_unavailable", stage: "registration_call", status: 503 });
    expect(classifyRegistrationFailure(new Error("unknown"))).toMatchObject({
      error: "temporarily_unavailable",
      stage: "registration_unknown",
      status: 503
    });
  });
});

describe("staging authentication boundary", () => {
  const stagingEnv = {
    KINIC_WIKI_CANISTER_ID: KINIC_CANISTER_ID,
    KINIC_WIKI_MCP_TARGET_ORIGIN: KINIC_MCP_TARGET_ORIGIN,
    MCP_ACCESS_POLICY: "private_opt_in",
    MCP_PUBLIC_ORIGIN: "https://wiki-mcp-staging.kinic.xyz",
    MCP_KEY_ENCRYPTION_KEY: "test-key",
    MCP_AUTH_STATE: {} as RuntimeEnv["MCP_AUTH_STATE"],
    MCP_REGISTRATION_RATE_LIMIT: {} as RuntimeEnv["MCP_REGISTRATION_RATE_LIMIT"]
  } satisfies RuntimeEnv;

  it("enables private opt-in only on the canonical staging origin", async () => {
    expect(authenticationMode(new Request("https://wiki-mcp-staging.kinic.xyz/mcp"), stagingEnv)).toBe(
      "private_opt_in"
    );

    const mismatchedMode = authenticationMode(
      new Request("https://kinic-wiki-mcp-staging.example.workers.dev/mcp"),
      stagingEnv
    );
    expect(mismatchedMode).toBe("origin_mismatch");
    const response = authenticationBoundaryResponse(mismatchedMode);
    expect(response?.status).toBe(404);
    await expect(response?.json()).resolves.toEqual({ error: "not found" });
  });

  it("fails closed for invalid access policy or private configuration", async () => {
    const misconfiguredMode = authenticationMode(new Request("https://wiki-mcp-staging.kinic.xyz/mcp"), {
      MCP_ACCESS_POLICY: "invalid",
      MCP_PUBLIC_ORIGIN: "https://unexpected.example"
    });
    expect(misconfiguredMode).toBe("misconfigured");
    const response = authenticationBoundaryResponse(misconfiguredMode);
    expect(response?.status).toBe(503);
    await expect(response?.json()).resolves.toEqual({ error: "temporarily_unavailable" });

    expect(
      authenticationMode(new Request("https://wiki-mcp-staging.kinic.xyz/mcp"), {
        ...stagingEnv,
        MCP_REGISTRATION_RATE_LIMIT: undefined
      })
    ).toBe("misconfigured");

    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const invalidTargetMode = authenticationMode(new Request("https://wiki-mcp-staging.kinic.xyz/mcp"), {
      KINIC_WIKI_CANISTER_ID: KINIC_CANISTER_ID,
      KINIC_WIKI_MCP_TARGET_ORIGIN: `https://${KINIC_CANISTER_ID}.icp0.io`,
      MCP_ACCESS_POLICY: "private_opt_in",
      MCP_PUBLIC_ORIGIN: "https://wiki-mcp-staging.kinic.xyz",
      MCP_KEY_ENCRYPTION_KEY: "test-key",
      MCP_AUTH_STATE: {} as RuntimeEnv["MCP_AUTH_STATE"],
      MCP_REGISTRATION_RATE_LIMIT: {} as RuntimeEnv["MCP_REGISTRATION_RATE_LIMIT"]
    });
    expect(invalidTargetMode).toBe("origin_configuration");
    const invalidTargetResponse = authenticationBoundaryResponse(invalidTargetMode);
    expect(invalidTargetResponse?.status).toBe(503);
    await expect(invalidTargetResponse?.json()).resolves.toEqual({ error: "temporarily_unavailable" });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('"stage":"origin_configuration"'));
    log.mockRestore();

    expect(authenticationMode(new Request("https://wiki-mcp.kinic.xyz/mcp"), {})).toBe("misconfigured");
    expect(
      authenticationMode(new Request("https://wiki-mcp.kinic.xyz/mcp"), { MCP_ACCESS_POLICY: "public" })
    ).toBe("public");
  });
});

describe("OAuth request body limits", () => {
  const maxBytes = 16_384;

  it("accepts exactly the byte limit without Content-Length", async () => {
    const request = new Request("https://wiki-mcp-staging.kinic.xyz/oauth/register", {
      method: "POST",
      body: new Uint8Array(maxBytes)
    });
    expect(request.headers.get("content-length")).toBeNull();
    await expect(readLimitedText(request, maxBytes)).resolves.toEqual({
      ok: true,
      text: "\0".repeat(maxBytes)
    });
  });

  it("rejects an oversized streamed body without Content-Length", async () => {
    const request = new Request("https://wiki-mcp-staging.kinic.xyz/oauth/register", {
      method: "POST",
      body: new Uint8Array(maxBytes + 1)
    });
    expect(request.headers.get("content-length")).toBeNull();
    await expect(readLimitedText(request, maxBytes)).resolves.toEqual({
      ok: false,
      reason: "too_large"
    });
  });

  it("rejects invalid or oversized Content-Length before reading", async () => {
    for (const contentLength of ["-1", "invalid"]) {
      const request = new Request("https://wiki-mcp-staging.kinic.xyz/oauth/register", {
        method: "POST",
        headers: { "content-length": contentLength },
        body: "{}"
      });
      await expect(readLimitedText(request, maxBytes)).resolves.toEqual({
        ok: false,
        reason: "invalid_content_length"
      });
    }

    const oversized = new Request("https://wiki-mcp-staging.kinic.xyz/oauth/register", {
      method: "POST",
      headers: { "content-length": String(maxBytes + 1) },
      body: "{}"
    });
    await expect(readLimitedText(oversized, maxBytes)).resolves.toEqual({
      ok: false,
      reason: "too_large"
    });
  });
});

function actorStub(): InternetIdentityActor {
  return {
    mcp_register_v2: vi.fn().mockResolvedValue({
      Ok: { expiration: 10_000_000_000n, permissions: { queries: null } }
    }),
    mcp_get_accounts: vi.fn().mockResolvedValue({ Ok: [] }),
    mcp_prepare_delegation: vi.fn(),
    mcp_get_delegation: vi.fn()
  };
}
