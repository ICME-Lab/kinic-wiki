import type { Env } from "./env";
import { AssistantStore } from "./store";
import { AssistantUser } from "./user";
import { Leases } from "./leases";
import {
  client,
  attachLive,
  cancelAgent,
  deleteAgent,
} from "./openai";
import { AssistantError } from "./contracts";
export async function closeLive(env: Env, id: string) {
  try {
    const ws = await attachLive(env.OPENAI_API_KEY!, id);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error("voice_close_unconfirmed"));
      }, 5000);
      ws.addEventListener("message", (e) => {
        if (typeof e.data !== "string") return;
        try {
          if (JSON.parse(e.data).type === "session.closed") {
            clearTimeout(timer);
            ws.close();
            resolve();
          }
        } catch {
          /* Not a lifecycle event. */
        }
      });
      try {
        ws.send(JSON.stringify({ type: "session.close" }));
      } catch (e) {
        clearTimeout(timer);
        ws.close();
        reject(e);
      }
    });
  } catch (e) {
    if (!(e instanceof AssistantError && e.code === "voice_session_gone"))
      throw e;
  }
}
export async function sweep(
  env: Env,
  closeProvider: (env: Env, id: string) => Promise<void> = closeLive,
) {
  const store = new AssistantStore(env),
    leases = new Leases(env.ASSISTANT_DB);
  const users = await store.due(10);
  // Ten user recoveries plus ten provider jobs, four runners per batch.
  for (let offset = 0; offset < users.length; offset += 4)
    await Promise.all(
      users.slice(offset, offset + 4).map(async ({ principal }) => {
        const lease = await leases.claim("maintenance", principal);
        if (!lease) return;
        const renewal = setInterval(() => {
          void leases.renew(lease).catch(() => false);
        }, 10000);
        try {
          await (
            await new AssistantUser(
              env,
              principal,
              undefined,
              lease,
            ).initialize()
          ).tick(true);
        } catch {
          console.error(
            JSON.stringify({ event: "assistant_recovery_pending" }),
          );
        } finally {
          clearInterval(renewal);
          await env.ASSISTANT_DB.prepare(
            "UPDATE assistant_users SET next_attempt=? WHERE principal=? AND next_attempt<=? AND EXISTS(SELECT 1 FROM assistant_leases WHERE scope='maintenance' AND id=? AND owner=? AND generation=? AND expires_at>?)",
          )
            .bind(
              Date.now() + 60000,
              principal,
              Date.now(),
              principal,
              lease.owner,
              lease.generation,
              Date.now(),
            )
            .run();
          await leases.release(lease);
        }
      }),
    );
  const jobs = (
    await env.ASSISTANT_DB.prepare(
      "SELECT id,principal,kind,data,conversation_id,attempts FROM assistant_jobs WHERE state='pending' AND next_attempt<=? ORDER BY next_attempt LIMIT ?",
    )
      .bind(Date.now(), 10)
      .all<{
        id: string;
        principal: string;
        kind: string;
        data: string;
        conversation_id: string;
        attempts: number;
      }>()
  ).results;
  for (let offset = 0; offset < jobs.length; offset += 4)
    await Promise.all(
      jobs.slice(offset, offset + 4).map(async (job) => {
        const lease = await leases.claim("cleanup", job.id);
        if (!lease) return;
        const renewal = setInterval(() => {
          void leases.renew(lease).catch(() => false);
        }, 10000);
        try {
          const data = JSON.parse(job.data) as {
            providerId?: string;
            requestId?: string;
          };
          // The user cleanup record also settles the daily voice reservation.
          // Do not race it or bypass its backoff with a duplicate close.
          const owned = await env.ASSISTANT_DB.prepare(
            "SELECT 1 FROM assistant_cleanup,json_each(assistant_cleanup.data,'$.cleanup') AS task WHERE principal=?1 AND (json_extract(task.value,'$.sessionId')=?2 OR json_extract(task.value,'$.liveId')=?2 OR (json_extract(task.value,'$.unknownCreate')=1 AND json_extract(task.value,'$.requestId')=?3))",
          )
            .bind(
              job.principal,
              data.providerId ?? null,
              data.requestId ?? null,
            )
            .first();
          if (owned) {
            await env.ASSISTANT_DB.prepare(
              "UPDATE assistant_jobs SET next_attempt=?1 WHERE id=?2 AND EXISTS(SELECT 1 FROM assistant_leases WHERE scope='cleanup' AND id=?2 AND owner=?3 AND generation=?4 AND expires_at>?5)",
            )
              .bind(
                Date.now() + 60000,
                job.id,
                lease.owner,
                lease.generation,
                Date.now(),
              )
              .run();
            return;
          }
          if (job.kind === "live") {
            if (!data.providerId) {
              const delay = Math.min(
                1800000,
                60000 * 2 ** Math.min(job.attempts, 5),
              );
              const deferred = await env.ASSISTANT_DB.prepare(
                "UPDATE assistant_jobs SET attempts=attempts+1,next_attempt=?2 WHERE id=?1 AND EXISTS(SELECT 1 FROM assistant_leases WHERE scope='cleanup' AND id=?1 AND owner=?3 AND generation=?4 AND expires_at>?5)",
              )
                .bind(
                  job.id,
                  Date.now() + delay,
                  lease.owner,
                  lease.generation,
                  Date.now(),
                )
                .run();
              if (deferred.meta.changes === 1)
                console.error(
                  JSON.stringify({
                    event: "assistant_live_creation_unresolved",
                    operationId: job.id,
                    attempts: job.attempts + 1,
                  }),
                );
              return;
            }
            await closeProvider(env, data.providerId);
          } else {
            const api = client(env.OPENAI_API_KEY);
            const ids: string[] = [];
            if (data.providerId) ids.push(data.providerId);
            else {
              let count = 0;
              for await (const session of api.beta.agents.sessions.list({
                limit: 100,
              })) {
                if (
                  session.metadata.kinic_conversation === job.conversation_id &&
                  session.metadata.kinic_request === data.requestId
                )
                  ids.push(session.id);
                if (++count >= 300) break;
              }
              if (!ids.length) throw new Error("unknown_agent_creation");
            }
            for (const id of ids) {
              try {
                await cancelAgent(api, id);
              } catch {
                /* Deletion is authoritative. */
              }
              await deleteAgent(api, id);
            }
          }
          await env.ASSISTANT_DB.prepare(
            "DELETE FROM assistant_jobs WHERE id=?1 AND EXISTS(SELECT 1 FROM assistant_leases WHERE scope='cleanup' AND id=?1 AND owner=?2 AND generation=?3 AND expires_at>?4)",
          )
            .bind(job.id, lease.owner, lease.generation, Date.now())
            .run();
        } catch {
          const delay = Math.min(
            1800000,
            60000 * 2 ** Math.min(job.attempts, 5),
          );
          await env.ASSISTANT_DB.prepare(
            "UPDATE assistant_jobs SET attempts=attempts+1,next_attempt=?2 WHERE id=?1 AND EXISTS(SELECT 1 FROM assistant_leases WHERE scope='cleanup' AND id=?1 AND owner=?3 AND generation=?4 AND expires_at>?5)",
          )
            .bind(
              job.id,
              Date.now() + delay,
              lease.owner,
              lease.generation,
              Date.now(),
            )
            .run();
          console.error(
            JSON.stringify({
              event: "assistant_cleanup_pending",
              operationId: job.id,
              attempts: job.attempts + 1,
            }),
          );
        } finally {
          clearInterval(renewal);
          await leases.release(lease);
        }
      }),
    );
  await env.ASSISTANT_DB.prepare(
    "DELETE FROM assistant_auth WHERE expires_at<=? AND id NOT IN (SELECT auth_id FROM assistant_users WHERE conversation_id IS NOT NULL)",
  )
    .bind(Date.now())
    .run();
}
