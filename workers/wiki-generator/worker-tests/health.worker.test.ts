// Where: workers/wiki-generator/worker-tests/health.worker.test.ts
// What: Starts the production entrypoint in workerd and checks its health route.
// Why: Node tests select different package exports and cannot catch Worker startup failures.
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("Worker startup", () => {
  it("serves healthz inside the Workers runtime", async () => {
    const response = await SELF.fetch("https://wiki-generator.kinic.xyz/healthz");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    await expect(response.json()).resolves.toEqual({ ok: true });
  });
});
