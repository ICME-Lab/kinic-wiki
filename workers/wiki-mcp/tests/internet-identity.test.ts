import { describe, expect, it, vi } from "vitest";
import { DelegationChain } from "@icp-sdk/core/identity";
import {
  generateIiKey,
  IiRegistrationError,
  KINIC_DERIVATION_ORIGIN,
  mintKinicIdentity,
  PER_APP_DELEGATION_TTL_NS,
  redeemRegistration,
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

  it("rejects any registration permission other than queries", async () => {
    const actor = actorStub();
    actor.mcp_register_v2 = vi.fn().mockResolvedValue({
      Ok: { expiration: 10_000_000_000n, permissions: { all: null } }
    });
    await expect(redeemRegistration(generateIiKey(), generateIiKey(), "", actor)).rejects.toMatchObject(
      new IiRegistrationError("read_only_required", "permission_check")
    );
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

  it("uses the fixed Kinic origin, default account, and five-minute read-only delegation", async () => {
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
          permissions: ["queries"]
        },
        signature: new Uint8Array(64)
      }
    }));

    await mintKinicIdentity(generateIiKey(), actor);

    expect(actor.mcp_get_accounts).toHaveBeenCalledWith(KINIC_DERIVATION_ORIGIN);
    expect(actor.mcp_prepare_delegation).toHaveBeenCalledWith(
      KINIC_DERIVATION_ORIGIN,
      [],
      expect.any(Uint8Array),
      [PER_APP_DELEGATION_TTL_NS]
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
      classifyRegistrationFailure(new IiRegistrationError("read_only_required", "permission_check"))
    ).toMatchObject({ error: "read_only_required", stage: "permission_check", status: 403 });
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
    MCP_AUTH_ENABLED: "true",
    MCP_PUBLIC_ORIGIN: "https://wiki-mcp-staging.kinic.xyz"
  } satisfies RuntimeEnv;

  it("requires authentication only on the canonical staging origin", async () => {
    expect(authenticationMode(new Request("https://wiki-mcp-staging.kinic.xyz/mcp"), stagingEnv)).toBe("required");

    const mismatchedMode = authenticationMode(
      new Request("https://kinic-wiki-mcp-staging.example.workers.dev/mcp"),
      stagingEnv
    );
    expect(mismatchedMode).toBe("origin_mismatch");
    const response = authenticationBoundaryResponse(mismatchedMode);
    expect(response?.status).toBe(404);
    await expect(response?.json()).resolves.toEqual({ error: "not found" });
  });

  it("fails closed for invalid staging configuration and keeps production anonymous", async () => {
    const misconfiguredMode = authenticationMode(new Request("https://wiki-mcp-staging.kinic.xyz/mcp"), {
      MCP_AUTH_ENABLED: "true",
      MCP_PUBLIC_ORIGIN: "https://unexpected.example"
    });
    expect(misconfiguredMode).toBe("misconfigured");
    const response = authenticationBoundaryResponse(misconfiguredMode);
    expect(response?.status).toBe(503);
    await expect(response?.json()).resolves.toEqual({ error: "temporarily_unavailable" });

    expect(authenticationMode(new Request("https://wiki-mcp.kinic.xyz/mcp"), {})).toBe("disabled");
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
    await expect(readLimitedText(request, maxBytes)).resolves.toHaveLength(maxBytes);
  });

  it("rejects an oversized streamed body without Content-Length", async () => {
    const request = new Request("https://wiki-mcp-staging.kinic.xyz/oauth/register", {
      method: "POST",
      body: new Uint8Array(maxBytes + 1)
    });
    expect(request.headers.get("content-length")).toBeNull();
    await expect(readLimitedText(request, maxBytes)).resolves.toBeNull();
  });

  it("rejects invalid or oversized Content-Length before reading", async () => {
    for (const contentLength of ["-1", "invalid", String(maxBytes + 1)]) {
      const request = new Request("https://wiki-mcp-staging.kinic.xyz/oauth/register", {
        method: "POST",
        headers: { "content-length": contentLength },
        body: "{}"
      });
      await expect(readLimitedText(request, maxBytes)).resolves.toBeNull();
    }
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
