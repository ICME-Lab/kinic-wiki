import { env } from "cloudflare:test";
import { beforeAll, expect, it } from "vitest";
import { Leases } from "../src/leases";
const db = (env as unknown as { PROBE_DB: D1Database }).PROBE_DB;
// Ordinary Worker handler: no DO, no module-level connection registry.
async function connect(id: string) {
  const leases = new Leases(db);
  const lease = await leases.claim("connection", id);
  if (!lease) return new Response("occupied", { status: 409 });
  const client = new WebSocketPair();
  const provider = new WebSocketPair();
  client[1].accept();
  provider[0].accept();
  provider[1].accept();
  provider[1].addEventListener("message", (e) => provider[1].send(e.data));
  client[1].addEventListener("message", async (e) => {
    if (await leases.valid(lease)) provider[0].send(e.data);
  });
  provider[0].addEventListener("message", async (e) => {
    if (await leases.valid(lease)) client[1].send(e.data);
  });
  client[1].addEventListener("close", () => {
    provider[0].close();
    provider[1].close();
  });
  return new Response(null, { status: 101, webSocket: client[0] });
}
beforeAll(async () => {
  await db.exec(
    "CREATE TABLE assistant_leases (scope TEXT NOT NULL,id TEXT NOT NULL,owner TEXT NOT NULL,generation INTEGER NOT NULL,expires_at INTEGER NOT NULL,PRIMARY KEY(scope,id));",
  );
});
it("keeps an ordinary Worker control WebSocket attached to a mock sideband", async () => {
  const r = await connect(crypto.randomUUID());
  const ws = r.webSocket!;
  ws.accept();
  const reply = new Promise((resolve) =>
    ws.addEventListener("message", (e) => resolve(e.data), { once: true }),
  );
  ws.send("delegation-result");
  expect(await reply).toBe("delegation-result");
  ws.close();
});
it("reconstructs ownership from D1 after a lost invocation and fences the old owner", async () => {
  const id = crypto.randomUUID();
  const first = new Leases(db);
  const old = (await first.claim("connection", id, 1000))!;
  expect(await new Leases(db).claim("connection", id, 1001)).toBeNull();
  const replacement = (await new Leases(db).claim("connection", id, 46000))!;
  expect(replacement.generation).toBe(old.generation + 1);
  expect(await first.renew(old, 46000)).toBe(false);
  expect(await first.valid(old, 46000)).toBe(false);
  expect(await new Leases(db).valid(replacement, 46000)).toBe(true);
  expect(await new Leases(db).claim("question", id, 46000)).not.toBeNull();
});
