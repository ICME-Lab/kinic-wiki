import { describe, expect, it } from "vitest";
import { requireEnabled } from "../src/auth";
import type { Env } from "../src/env";
import worker from "../src/index";

const configured = {
  ASSISTANT_ENABLED: "true",
  OPENAI_API_KEY: "openai-key",
  TYPESAFE_API_KEY: "typesafe-key",
  ASSISTANT_KEY_ENCRYPTION_KEY: "encryption-key",
  ASSISTANT_ORIGIN: "https://wiki.kinic.xyz",
} as unknown as Env;
const context = {} as ExecutionContext;

describe("assistant provider configuration", () => {
  it("accepts an enabled service only when every provider key is configured", () => {
    expect(() => requireEnabled(configured)).not.toThrow();
  });

  it("fails closed when the TypeSafe key is missing", () => {
    expect(() =>
      requireEnabled({ ...configured, TYPESAFE_API_KEY: undefined }),
    ).toThrow("assistant_not_configured");
  });

  it("reports status as unavailable when the TypeSafe key is missing", async () => {
    const response = await worker.fetch(
      new Request("https://wiki.kinic.xyz/api/assistant/status"),
      { ...configured, TYPESAFE_API_KEY: undefined },
      context,
    );
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: "assistant_not_configured",
    });
  });

  it("rejects authentication setup before touching other bindings", async () => {
    const response = await worker.fetch(
      new Request("https://wiki.kinic.xyz/api/assistant/auth/start", {
        method: "POST",
        headers: { origin: "https://wiki.kinic.xyz" },
      }),
      { ...configured, TYPESAFE_API_KEY: undefined },
      context,
    );
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: "assistant_not_configured",
    });
  });
});
