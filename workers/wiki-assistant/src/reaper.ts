import type { Env } from "./env";
import { AssistantStore } from "./store";
import { AssistantUser } from "./user";
import { Leases } from "./leases";

export async function sweep(env: Env) {
  const store = new AssistantStore(env);
  const leases = new Leases(env.ASSISTANT_DB);
  const users = await store.due(10);
  for (let offset = 0; offset < users.length; offset += 4) {
    await Promise.all(users.slice(offset, offset + 4).map(async ({ principal }) => {
      const lease = await leases.claim("maintenance", principal);
      if (!lease) return;
      const renewal = setInterval(() => {
        void leases.renew(lease).catch(() => false);
      }, 10000);
      try {
        await (await new AssistantUser(env, principal, undefined, lease).initialize()).tick(true);
      } catch {
        console.error(JSON.stringify({ event: "assistant_recovery_pending" }));
      } finally {
        clearInterval(renewal);
        await env.ASSISTANT_DB.prepare(
          "UPDATE assistant_users SET next_attempt=? WHERE principal=? AND next_attempt<=? AND EXISTS(SELECT 1 FROM assistant_leases WHERE scope='maintenance' AND id=? AND owner=? AND generation=? AND expires_at>?)",
        ).bind(Date.now() + 60000, principal, Date.now(), principal, lease.owner, lease.generation, Date.now()).run();
        await leases.release(lease);
      }
    }));
  }
  await env.ASSISTANT_DB.prepare(
    "DELETE FROM assistant_auth WHERE expires_at<=? AND id NOT IN (SELECT auth_id FROM assistant_users WHERE conversation_id IS NOT NULL AND auth_id IS NOT NULL)",
  ).bind(Date.now()).run();
}
