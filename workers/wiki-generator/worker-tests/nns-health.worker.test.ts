// Where: workers/wiki-generator/worker-tests/nns-health.worker.test.ts
// What: Workerd smoke test for the private NNS proposal review Worker.
// Why: The dedicated entrypoint and bindings must initialize independently from wiki-generator.
import { SELF } from "cloudflare:test";
import { expect, it } from "vitest";

it("starts the dedicated NNS Worker with auditing disabled", async () => {
  const health = await SELF.fetch("https://nns-proposal-review.internal/healthz");
  const status = await SELF.fetch("https://nns-proposal-review.internal/status");

  expect(health.status).toBe(200);
  await expect(health.json()).resolves.toEqual({ ok: true });
  expect(status.status).toBe(200);
  await expect(status.json()).resolves.toEqual({ enabled: false });
});
