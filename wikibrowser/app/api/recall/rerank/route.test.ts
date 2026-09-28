import { afterEach, describe, expect, it, vi } from "vitest";
import { OPTIONS, POST, setRecallRerankDepsForTest } from "./route";

const origin = "chrome-extension://jcfniiflikojmbfnaoamlbbddlikchaj";
const candidate = (path: string) => ({ path, preview: "Useful excerpt" });
const input = (candidates = [candidate("/Knowledge/one.md")]) => ({
  databaseId: "db-test", sessionNonce: "nonce-test", question: "What is the answer?", candidates
});
const request = (body: unknown, requestOrigin = origin) => new Request("https://wiki.kinic.xyz/api/recall/rerank", {
  method: "POST", headers: { origin: requestOrigin }, body: JSON.stringify(body)
});
const env = () => ({
  RECALL_JEV_ENABLED: "true", RECALL_JEV_THRESHOLD: "0.7", TYPESAFE_API_KEY: "test-key",
  KINIC_WIKI_CANISTER_ID: "canister-test", KINIC_WIKI_ALLOWED_DATABASE_ID: "db-test",
  KINIC_WIKI_CLIPPER_ORIGIN: origin,
  QUERY_ANSWER_RATE_LIMIT: { get: vi.fn().mockResolvedValue(null), put: vi.fn().mockResolvedValue(undefined) }
});
const deps = (probabilities: Record<string, number>) => {
  const score = vi.fn().mockResolvedValue({ probabilities });
  const checkSession = vi.fn().mockResolvedValue({ principal: "principal-test" });
  setRecallRerankDepsForTest({ score, checkSession });
  return { score, checkSession };
};

afterEach(() => setRecallRerankDepsForTest());

describe("Recall Jev API", () => {
  it("rejects a foreign Origin before processing input", async () => {
    deps({ candidate_0: 1 });
    expect((await POST(request(input(), "https://attacker.example"), env() as never)).status).toBe(403);
    expect(OPTIONS(new Request("https://wiki.kinic.xyz/api/recall/rerank", { headers: { origin: "https://attacker.example" } }), env() as never).status).toBe(403);
  });

  it("checks the canister session and returns only candidate indexes above the threshold", async () => {
    const { score, checkSession } = deps({ candidate_0: 0.69, candidate_1: 0.7, candidate_2: 0.95 });
    const response = await POST(request(input([
      candidate("/Knowledge/one.md"), candidate("/Sources/two.md"), candidate("/Knowledge/three.md")
    ])), env() as never);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ selectedIndices: [2, 1] });
    expect(checkSession).toHaveBeenCalledWith("canister-test", expect.objectContaining({ databaseId: "db-test", sessionNonce: "nonce-test" }));
    expect(score).toHaveBeenCalledWith(expect.objectContaining({ workflow: "recall", timeoutMs: 1_500 }));
  });

  it("returns no cards when even one candidate scores below the threshold", async () => {
    deps({ candidate_0: 0.1 });
    const response = await POST(request(input()), env() as never);
    expect(await response.json()).toEqual({ selectedIndices: [] });
  });

  it("rejects invalid bounds, database access, and expired sessions", async () => {
    const { checkSession } = deps({ candidate_0: 1 });
    const runtime = env();
    expect((await POST(request(input(Array.from({ length: 21 }, (_, index) => candidate(`/Knowledge/${index}.md`)))), runtime as never)).status).toBe(400);
    expect((await POST(request(input([candidate("/Knowledge/a.md"), candidate("/Knowledge/a.md")])), runtime as never)).status).toBe(400);
    expect((await POST(request({ ...input(), databaseId: "other-db" }), runtime as never)).status).toBe(403);
    checkSession.mockRejectedValueOnce(new Error("expired"));
    expect((await POST(request(input()), runtime as never)).status).toBe(403);
  });

  it("uses the Recall-specific staging database restriction when configured", async () => {
    deps({ candidate_0: 1 });
    const runtime = { ...env(), RECALL_ALLOWED_DATABASE_ID: "db-moj" };
    expect((await POST(request(input()), runtime as never)).status).toBe(403);
    expect((await POST(request({ ...input(), databaseId: "db-moj" }), runtime as never)).status).toBe(200);
  });

  it("enforces the rate limit and fails closed when the rate store fails", async () => {
    deps({ candidate_0: 1 });
    const runtime = env();
    runtime.QUERY_ANSWER_RATE_LIMIT.get.mockResolvedValueOnce("10");
    expect((await POST(request(input()), runtime as never)).status).toBe(429);
    runtime.QUERY_ANSWER_RATE_LIMIT.get.mockRejectedValueOnce(new Error("KV unavailable"));
    expect((await POST(request(input()), runtime as never)).status).toBe(503);
  });

  it("leaves the feature unavailable until explicitly enabled and configured", async () => {
    deps({ candidate_0: 1 });
    const runtime = env();
    runtime.RECALL_JEV_ENABLED = "false";
    expect((await POST(request(input()), runtime as never)).status).toBe(503);
    runtime.RECALL_JEV_ENABLED = "true";
    runtime.RECALL_JEV_THRESHOLD = "";
    expect((await POST(request(input()), runtime as never)).status).toBe(503);
  });
});
