import { afterEach, expect, it, vi } from "vitest";
import { loadPublicNodePageData } from "./page";

const calls = vi.hoisted(() => ({ imports: 0, read: vi.fn() }));
vi.mock("@/lib/vfs-client", () => {
  calls.imports++;
  return { readPublicNode: calls.read };
});
afterEach(() => vi.unstubAllEnvs());

it("defers the SDK until a valid published-note request and preserves missing/error behavior", async () => {
  expect(calls.imports).toBe(0);
  expect((await loadPublicNodePageData("invalid")).node).toBeNull();
  expect(calls.imports).toBe(0);
  vi.stubEnv("VITE_KINIC_WIKI_CANISTER_ID", "6emaw-iyaaa-aaaay-aacka-cai");
  const id = "00112233445566778899aabbccddeeff";
  const node = { content: "# Public note\nBody", updatedAt: "1", publishedAtMs: "2" };
  calls.read.mockResolvedValue(node);
  const data = await loadPublicNodePageData(id);
  expect(calls.imports).toBe(1);
  expect(data.node).toEqual(node);
  expect(data.title).toBe("Public note");
  calls.read.mockResolvedValue(null);
  expect((await loadPublicNodePageData(id)).node).toBeNull();
  calls.read.mockRejectedValue(new Error("Unavailable"));
  await expect(loadPublicNodePageData(id)).rejects.toThrow("Unavailable");
});
