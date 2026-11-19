import { expect, it, vi } from "vitest";
import type { Identity } from "@icp-sdk/core/agent";

const databases = vi.hoisted(() => vi.fn());
vi.mock("./vfs-client/cycles", () => ({
  listDatabasesAuthenticated: databases,
}));

import { ownerDatabases } from "./vault-credit";

it("offers only active owner databases for a credit transfer", async () => {
  databases.mockResolvedValue([
    { databaseId: "active", role: "owner", status: "active" },
    { databaseId: "pending", role: "owner", status: "pending" },
    { databaseId: "deleted", role: "owner", status: "deleted" },
    { databaseId: "reader", role: "reader", status: "active" },
  ]);

  const found = await ownerDatabases("wiki", {} as Identity);
  expect(found.map((db) => db.databaseId)).toEqual(["active"]);
});
