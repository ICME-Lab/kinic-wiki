import { afterEach, expect, it, vi } from "vitest";
import sitemap from "./sitemap";

const calls = vi.hoisted(() => ({ imports: 0, list: vi.fn() }));
vi.mock("@/lib/vfs-client", () => {
  calls.imports++;
  return { listDatabasesPublic: calls.list };
});
afterEach(() => vi.unstubAllEnvs());

it("loads the SDK only for a sitemap request, keeping active public URLs and failure fallback", async () => {
  expect(calls.imports).toBe(0);
  vi.stubEnv("VITE_KINIC_WIKI_CANISTER_ID", "");
  const staticEntries = await sitemap();
  expect(calls.imports).toBe(0);
  vi.stubEnv("VITE_KINIC_WIKI_CANISTER_ID", "6emaw-iyaaa-aaaay-aacka-cai");
  calls.list.mockResolvedValue([
    { databaseId: "db_public", status: "active" },
    { databaseId: "db_pending", status: "pending" },
  ]);
  const entries = await sitemap();
  expect(calls.imports).toBe(1);
  expect(entries.map((entry) => entry.url)).toContain("https://wiki.kinic.xyz/db/db_public/Knowledge");
  expect(entries.some((entry) => entry.url.includes("db_pending"))).toBe(false);
  calls.list.mockRejectedValue(new Error("Unavailable"));
  expect((await sitemap()).map((entry) => entry.url)).toEqual(staticEntries.map((entry) => entry.url));
});
