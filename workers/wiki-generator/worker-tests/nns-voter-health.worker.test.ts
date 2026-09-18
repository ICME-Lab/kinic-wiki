// Where: workers/wiki-generator/worker-tests/nns-voter-health.worker.test.ts
// What: Workerd smoke test for the isolated NNS voter Worker.
// Why: Its entrypoint and bindings must initialize without exposing a vote route.
import { SELF } from "cloudflare:test";
import { expect, it } from "vitest";

it("starts the isolated voter without exposing a public vote endpoint", async () => {
  const health = await SELF.fetch("https://nns-voter.internal/healthz");
  const vote = await SELF.fetch("https://nns-voter.internal/vote", { method: "POST" });

  expect(health.status).toBe(200);
  await expect(health.json()).resolves.toEqual({ ok: true });
  expect(vote.status).toBe(404);
});
