import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire, stripTypeScriptTypes } from "node:module";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const runtimeRequire = createRequire(
  import.meta.resolve("@cloudflare/vitest-pool-workers"),
);
const { Miniflare } = runtimeRequire("miniflare");
const leaseCode = stripTypeScriptTypes(
  await readFile(new URL("../src/leases.ts", import.meta.url), "utf8"),
  { mode: "transform" },
);
const migration = await readFile(
  new URL("../migrations/0001_assistant.sql", import.meta.url),
  "utf8",
);
const script = `${leaseCode.replaceAll("export ", "")}
export default { async fetch(request,env) {
 const path=new URL(request.url).pathname;
 if(path==='/init'){await env.DB.exec(${JSON.stringify(migration)});return new Response('initialized');}
 if(path==='/expire'){await env.DB.prepare("UPDATE assistant_leases SET expires_at=0").run();return new Response('expired');}
 if(path==='/state')return Response.json(await env.DB.prepare("SELECT * FROM assistant_leases").first());
 const leases=new Leases(env.DB),lease=await leases.claim('connection','conversation');
 if(!lease)return new Response('occupied',{status:409});
 const client=new WebSocketPair(),sideband=new WebSocketPair();
 client[1].accept();sideband[0].accept();sideband[1].accept();
 sideband[1].addEventListener('message',e=>sideband[1].send(e.data));
 client[1].addEventListener('message',async e=>{if(await leases.valid(lease))sideband[0].send(e.data);});
 sideband[0].addEventListener('message',async e=>{if(await leases.valid(lease))client[1].send(e.data);});
 client[1].addEventListener('close',()=>{sideband[0].close();sideband[1].close();});
 return new Response(null,{status:101,webSocket:client[0]});
}};`;
test(
  "workerd restart retains D1 ownership and admits a new generation only after expiry",
  { timeout: 30000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "assistant-restart-"));
    const options = {
      modules: true,
      script,
      compatibilityDate: "2026-08-08",
      d1Databases: { DB: "assistant-restart-test" },
      resourcePersistencePath: directory,
    };
    let runtime = new Miniflare(options);
    try {
      const initialized = await runtime.dispatchFetch("https://test/init");
      assert.equal(initialized.status, 200, await initialized.text());
      const response = await runtime.dispatchFetch("https://test/socket", {
        headers: { upgrade: "websocket" },
      });
      assert.equal(response.status, 101);
      const ws = response.webSocket;
      ws.accept();
      const echoed = new Promise((resolve) =>
        ws.addEventListener("message", (e) => resolve(e.data), { once: true }),
      );
      ws.send("verified answer");
      assert.equal(await echoed, "verified answer");
      const before = await runtime.dispatchFetch("https://test/state");
      const beforeText = await before.text();
      assert.equal(before.status, 200, beforeText);
      const old = JSON.parse(beforeText);
      ws.close();
      await runtime.dispose();
      runtime = new Miniflare(options);
      const after = await runtime.dispatchFetch("https://test/state");
      const afterText = await after.text();
      assert.equal(after.status, 200, afterText);
      const recovered = JSON.parse(afterText);
      assert.equal(recovered.owner, old.owner);
      assert.equal(
        (await runtime.dispatchFetch("https://test/socket")).status,
        409,
      );
      await runtime.dispatchFetch("https://test/expire");
      const replacement = await runtime.dispatchFetch("https://test/socket", {
        headers: { upgrade: "websocket" },
      });
      assert.equal(replacement.status, 101);
      replacement.webSocket.accept();
      replacement.webSocket.close();
      const next = await (
        await runtime.dispatchFetch("https://test/state")
      ).json();
      assert.equal(next.generation, old.generation + 1);
      assert.notEqual(next.owner, old.owner);
    } finally {
      await runtime.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
