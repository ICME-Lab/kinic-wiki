import {
  encryptJson,
  decryptJson,
  type EncryptedValueV1,
} from "@kinic/ii-server/crypto";
import type { Lease } from "./leases";
import type { Env } from "./env";
import { AssistantError } from "./contracts";
import type { UserState } from "./user";
export type UserRecord = { revision: number; state: UserState };
export class AssistantStore {
  constructor(readonly env: Env) {}
  get db() {
    return this.env.ASSISTANT_DB;
  }
  private key() {
    if (!this.env.ASSISTANT_KEY_ENCRYPTION_KEY)
      throw new AssistantError("assistant_not_configured", 503);
    return this.env.ASSISTANT_KEY_ENCRYPTION_KEY;
  }
  async encode(value: unknown, context: string) {
    return JSON.stringify(await encryptJson(value, this.key(), context));
  }
  async decode<T>(value: string, context: string) {
    return decryptJson<T>(
      JSON.parse(value) as EncryptedValueV1,
      this.key(),
      context,
    );
  }
  async auth<T>(id: string): Promise<T | undefined> {
    const row = await this.db
      .prepare("SELECT phase,data FROM assistant_auth WHERE id=?")
      .bind(id)
      .first<{ phase: string; data: string }>();
    return row
      ? ({ ...JSON.parse(row.data), phase: row.phase } as T)
      : undefined;
  }
  async insertAuth(record: { id: string; phase: string; expiresAt: number }) {
    try {
      await this.db
        .prepare(
          "INSERT INTO assistant_auth(id,phase,expires_at,data) VALUES (?,?,?,?)",
        )
        .bind(record.id, record.phase, record.expiresAt, JSON.stringify(record))
        .run();
    } catch {
      throw new AssistantError("auth_already_started", 409);
    }
  }
  async saveAuth(
    record: { id: string; phase: string; expiresAt: number },
    expectedPhase?: string,
  ) {
    const result = await this.db
      .prepare(
        "UPDATE assistant_auth SET phase=?1,expires_at=?2,data=?3 WHERE id=?4 AND expires_at>?5 AND (?6 IS NULL OR phase=?6)",
      )
      .bind(
        record.phase,
        record.expiresAt,
        JSON.stringify(record),
        record.id,
        Date.now(),
        expectedPhase ?? null,
      )
      .run();
    if (result.meta.changes !== 1)
      throw new AssistantError("authentication_required", 401);
  }
  async claimAuth(id: string) {
    return (
      (
        await this.db
          .prepare(
            "UPDATE assistant_auth SET phase='claiming' WHERE id=? AND phase='pending' AND expires_at>?",
          )
          .bind(id, Date.now())
          .run()
      ).meta.changes === 1
    );
  }
  async deleteAuth(id: string) {
    await this.db
      .prepare("DELETE FROM assistant_auth WHERE id=?")
      .bind(id)
      .run();
  }
  async load(principal: string): Promise<UserRecord> {
    const row = await this.db
      .prepare("SELECT * FROM assistant_users WHERE principal=?")
      .bind(principal)
      .first<{
        revision: number;
        data: string | null;
        usage_day: string;
        questions: number;
        voice_seconds: number;
        seen: number;
      }>();
    const state: UserState = {
      principal,
      day: row?.usage_day ?? new Date().toISOString().slice(0, 10),
      questions: row?.questions ?? 0,
      voiceSeconds: row?.voice_seconds ?? 0,
      conversation: null,
      cleanup: [],
      charges: [],
    };
    if (row?.data) {
      state.conversation = await this.decode(
        row.data,
        principal + ":conversation",
      );
      if (state.conversation) {
        state.conversation.seen = Math.max(state.conversation.seen, row.seen);
        const messages = await this.db
          .prepare(
            "SELECT request_id,data FROM assistant_requests WHERE conversation_id=? ORDER BY rowid",
          )
          .bind(state.conversation.id)
          .all<{ request_id: string; data: string }>();
        state.conversation.messages = await Promise.all(
          messages.results.map((r) =>
            this.decode<
              NonNullable<UserState["conversation"]>["messages"][number]
            >(r.data, state.conversation!.id + ":" + r.request_id),
          ),
        );
      }
    }
    if (state.conversation) {
      const stops = await this.db
        .prepare(
          "SELECT voice_id,stopped_at FROM assistant_stops WHERE conversation_id=?",
        )
        .bind(state.conversation.id)
        .all<{ voice_id: string; stopped_at: number }>();
      for (const stop of stops.results) {
        if (stop.voice_id === "*") state.endRequested = stop.stopped_at;
        if (
          state.conversation.live &&
          (stop.voice_id === "*" ||
            state.conversation.live.usage.chargeId === stop.voice_id)
        ) {
          state.conversation.live.stopping = true;
          const charge = state.charges.find((b) => b.id === stop.voice_id);
          if (charge)
            charge.stopped = Math.min(
              charge.stopped ?? Infinity,
              stop.stopped_at,
            );
        }
      }
    }
    const cleanup = await this.db
      .prepare("SELECT data FROM assistant_cleanup WHERE principal=?")
      .bind(principal)
      .first<{ data: string }>();
    if (cleanup) Object.assign(state, JSON.parse(cleanup.data));
    if (state.conversation) {
      const stops = await this.db
        .prepare(
          "SELECT voice_id,stopped_at FROM assistant_stops WHERE conversation_id=?",
        )
        .bind(state.conversation.id)
        .all<{ voice_id: string; stopped_at: number }>();
      for (const stop of stops.results)
        for (const charge of state.charges)
          if (stop.voice_id === "*" || charge.id === stop.voice_id)
            charge.stopped = Math.min(
              charge.stopped ?? Infinity,
              stop.stopped_at,
            );
    }
    return { revision: row?.revision ?? 0, state };
  }
  async save(
    principal: string,
    revision: number,
    state: UserState,
    next: number,
    fence?: Lease,
  ) {
    const c = state.conversation,
      commit = crypto.randomUUID();
    const previous = !c
      ? await this.db
          .prepare("SELECT auth_id FROM assistant_users WHERE principal=?")
          .bind(principal)
          .first<{ auth_id: string | null }>()
      : null;
    const payload = c
      ? await this.encode({ ...c, messages: [] }, principal + ":conversation")
      : null;
    const condition =
      "EXISTS(SELECT 1 FROM assistant_users WHERE principal=?1 AND commit_id=?2)";
    const statements = [
      this.db
        .prepare(
          `INSERT INTO assistant_users(principal,revision,commit_id,conversation_id,auth_id,voice_id,data,usage_day,questions,voice_seconds,seen,activity,next_attempt) VALUES (?1,1,?2,?3,?4,?18,?5,?6,?7,?8,?9,?10,?11)
      ON CONFLICT(principal) DO UPDATE SET revision=assistant_users.revision+1,commit_id=excluded.commit_id,conversation_id=excluded.conversation_id,auth_id=excluded.auth_id,voice_id=excluded.voice_id,data=excluded.data,usage_day=excluded.usage_day,questions=excluded.questions,voice_seconds=excluded.voice_seconds,seen=MAX(assistant_users.seen,excluded.seen),activity=excluded.activity,next_attempt=excluded.next_attempt WHERE assistant_users.revision=?12 AND (?13 IS NULL OR EXISTS(SELECT 1 FROM assistant_leases WHERE scope=?13 AND id=?14 AND owner=?15 AND generation=?16 AND expires_at>?17))`,
        )
        .bind(
          principal,
          commit,
          c?.id ?? null,
          c?.authId ?? null,
          payload,
          state.day,
          state.questions,
          state.voiceSeconds,
          c?.seen ?? 0,
          c?.activity ?? 0,
          next,
          revision,
          fence?.scope ?? null,
          fence?.id ?? null,
          fence?.owner ?? null,
          fence?.generation ?? null,
          Date.now(),
          c?.live?.usage.chargeId ?? null,
        ),
      this.db
        .prepare(
          `DELETE FROM assistant_requests WHERE principal=?1 AND ${condition}`,
        )
        .bind(principal, commit),
      this.db
        .prepare(
          `INSERT INTO assistant_cleanup(principal,data) SELECT ?1,?3 WHERE ${condition} ON CONFLICT(principal) DO UPDATE SET data=excluded.data`,
        )
        .bind(
          principal,
          commit,
          JSON.stringify({ cleanup: state.cleanup, charges: state.charges }),
        ),
    ];
    for (const message of c?.messages ?? [])
      statements.push(
        this.db
          .prepare(
            `INSERT INTO assistant_requests(principal,conversation_id,request_id,data) SELECT ?1,?3,?4,?5 WHERE ${condition}`,
          )
          .bind(
            principal,
            commit,
            c!.id,
            message.requestId,
            await this.encode(message, c!.id + ":" + message.requestId),
          ),
      );
    statements.push(
      this.db
        .prepare(
          `UPDATE assistant_jobs SET state='pending' WHERE principal=?1 AND ${condition} AND (conversation_id<>?3 OR (?4 IS NULL AND kind='live'))`,
        )
        .bind(principal, commit, c?.id ?? "", c?.live?.id ?? null),
    );
    if (!c) {
      statements.push(
        this.db
          .prepare(
            `DELETE FROM assistant_stops WHERE conversation_id NOT IN (SELECT conversation_id FROM assistant_users WHERE conversation_id IS NOT NULL) AND ${condition}`,
          )
          .bind(principal, commit),
      );
      statements.push(
        this.db
          .prepare(
            `DELETE FROM assistant_commands WHERE conversation_id NOT IN (SELECT conversation_id FROM assistant_users WHERE conversation_id IS NOT NULL) AND ${condition}`,
          )
          .bind(principal, commit),
      );
      statements.push(
        this.db
          .prepare(
            `UPDATE assistant_jobs SET state='pending' WHERE principal=?1 AND ${condition}`,
          )
          .bind(principal, commit),
      );
      statements.push(
        this.db
          .prepare(`DELETE FROM assistant_auth WHERE id=?3 AND ${condition}`)
          .bind(principal, commit, previous?.auth_id ?? null),
      );
    }
    const result = await this.db.batch(statements);
    if (result[0].meta.changes !== 1)
      throw new AssistantError("stale_state", 409);
    return revision + 1;
  }
  async canSend(principal: string, id: string, voiceId: string) {
    return !!(await this.db
      .prepare(
        "SELECT 1 FROM assistant_users WHERE principal=?1 AND conversation_id=?2 AND voice_id=?3 AND NOT EXISTS(SELECT 1 FROM assistant_stops WHERE conversation_id=?2 AND voice_id IN ('*',?3))",
      )
      .bind(principal, id, voiceId)
      .first());
  }
  async requestStop(
    principal: string,
    authId: string,
    id: string,
    voiceId: string,
    at: number,
  ) {
    const result = await this.db.batch([
      this.db
        .prepare(
          "INSERT INTO assistant_stops(conversation_id,voice_id,stopped_at) SELECT ?1,?2,?3 FROM assistant_users WHERE principal=?4 AND auth_id=?5 AND conversation_id=?1 AND (?2='*' OR voice_id=?2) ON CONFLICT(conversation_id,voice_id) DO UPDATE SET stopped_at=MIN(stopped_at,excluded.stopped_at)",
        )
        .bind(id, voiceId, at, principal, authId),
      this.db
        .prepare(
          "UPDATE assistant_users SET revision=revision+1,next_attempt=0 WHERE principal=?1 AND auth_id=?2 AND conversation_id=?3 AND EXISTS(SELECT 1 FROM assistant_stops WHERE conversation_id=?3 AND voice_id=?4)",
        )
        .bind(principal, authId, id, voiceId),
    ]);
    return result[0].meta.changes === 1;
  }
  async touch(principal: string, id: string) {
    await this.db
      .prepare(
        "UPDATE assistant_users SET seen=? WHERE principal=? AND conversation_id=?",
      )
      .bind(Date.now(), principal, id)
      .run();
  }
  async intent(
    id: string,
    principal: string,
    conversationId: string,
    kind: "agent" | "live",
    data: unknown,
  ) {
    await this.db
      .prepare(
        "INSERT INTO assistant_jobs(id,principal,conversation_id,kind,data,state,created_at) VALUES (?,?,?,?,?,'active',?) ON CONFLICT(id) DO NOTHING",
      )
      .bind(
        id,
        principal,
        conversationId,
        kind,
        JSON.stringify(data),
        Date.now(),
      )
      .run();
  }
  async created(id: string, providerId: string) {
    await this.db
      .prepare(
        "UPDATE assistant_jobs SET data=json_set(data,'$.providerId',?),state=CASE WHEN EXISTS(SELECT 1 FROM assistant_users u WHERE u.conversation_id=assistant_jobs.conversation_id) THEN state ELSE 'pending' END WHERE id=?",
      )
      .bind(providerId, id)
      .run();
  }
  async command(id: string, requestId: string, hash: string) {
    const result = await this.db
      .prepare(
        "INSERT INTO assistant_commands(conversation_id,request_id,input_hash) VALUES (?,?,?) ON CONFLICT DO NOTHING",
      )
      .bind(id, requestId, hash)
      .run();
    const row = await this.db
      .prepare(
        "SELECT input_hash,response FROM assistant_commands WHERE conversation_id=? AND request_id=?",
      )
      .bind(id, requestId)
      .first<{ input_hash: string; response: string | null }>();
    if (!row || row.input_hash !== hash)
      throw new AssistantError("request_id_conflict", 409);
    return {
      fresh: result.meta.changes === 1,
      response: row.response
        ? await this.decode<{ status: number; body: unknown }>(
            row.response,
            id + ":" + requestId,
          )
        : null,
    };
  }
  async commandResult(
    id: string,
    requestId: string,
    response: { status: number; body: unknown },
  ) {
    await this.db
      .prepare(
        "UPDATE assistant_commands SET response=? WHERE conversation_id=? AND request_id=?",
      )
      .bind(await this.encode(response, id + ":" + requestId), id, requestId)
      .run();
  }
  async due(limit = 20) {
    return (
      await this.db
        .prepare(
          "SELECT principal FROM assistant_users WHERE next_attempt<=? ORDER BY next_attempt LIMIT ?",
        )
        .bind(Date.now(), limit)
        .all<{ principal: string }>()
    ).results;
  }
}
