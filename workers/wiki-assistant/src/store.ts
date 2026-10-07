import {
  encryptJson,
  decryptJson,
  type EncryptedValueV1,
} from "@kinic/ii-server/crypto";
import type { Lease } from "./leases";
import type { Env } from "./env";
import { AssistantError } from "./contracts";
import type { UserState } from "./user";
import { boundedHistoryPage, type HistoryEntry } from "./history-page";
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
  async load(principal: string, includeMessages = true): Promise<UserRecord> {
    const row = await this.db
      .prepare("SELECT * FROM assistant_users WHERE principal=?")
      .bind(principal)
      .first<{
        revision: number;
        data: string | null;
        usage_day: string;
        questions: number;
        seen: number;
      }>();
    const state: UserState = {
      principal,
      day: row?.usage_day ?? new Date().toISOString().slice(0, 10),
      questions: row?.questions ?? 0,
      conversation: null,
      cleanup: [],
    };
    if (row?.data) {
      state.conversation = await this.decode(
        row.data,
        principal + ":conversation",
      );
      if (state.conversation) {
        state.conversation.seen = Math.max(state.conversation.seen, row.seen);
        if (includeMessages) {
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
    }
    const cleanup = await this.db
      .prepare("SELECT data FROM assistant_cleanup WHERE principal=?")
      .bind(principal)
      .first<{ data: string }>();
    if (cleanup) {
      const saved = JSON.parse(cleanup.data) as Pick<UserState, "cleanup">;
      state.cleanup = (saved.cleanup ?? []).filter((task) => !task.liveId && !task.voiceUsage);
    }
    if (state.conversation) {
      state.endRequested = (await this.db.prepare("SELECT MIN(stopped_at) AS stopped_at FROM assistant_stops WHERE conversation_id=? AND voice_id='*'").bind(state.conversation.id).first<{ stopped_at: number | null }>())?.stopped_at ?? undefined;
    }
    return { revision: row?.revision ?? 0, state };
  }
  async historyPage(principal: string, c: NonNullable<UserState["conversation"]>, revision: number, cursor: number) {
    const count = await this.db.prepare("SELECT COUNT(*) AS count FROM assistant_requests WHERE conversation_id=?")
      .bind(c.id).first<{ count: number }>();
    const messageCount = count?.count ?? 0;
    const total = messageCount + c.utterances.length;
    if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > total)
      throw new AssistantError("invalid_cursor", 400);
    const rows = cursor < messageCount
      ? (await this.db.prepare("SELECT request_id,data FROM assistant_requests WHERE conversation_id=? ORDER BY rowid LIMIT 10 OFFSET ?")
          .bind(c.id, cursor).all<{ request_id: string; data: string }>()).results
      : [];
    const entries: HistoryEntry[] = await Promise.all(rows.map(async (row) => ({
      kind: "message" as const,
      value: await this.decode<NonNullable<UserState["conversation"]>["messages"][number]>(row.data, c.id + ":" + row.request_id),
    })));
    const utteranceOffset = Math.max(0, cursor - messageCount);
    if (cursor + rows.length >= messageCount) {
      entries.push(...c.utterances.slice(utteranceOffset, utteranceOffset + 10 - entries.length)
        .map(({ id, role, text }) => ({ kind: "utterance" as const, value: { id, role, text } })));
    }
    // A concurrent commit can change counts, rows or utterances. Never return
    // content assembled from different revisions, including an ended session.
    const current = await this.db.prepare("SELECT revision,conversation_id FROM assistant_users WHERE principal=?")
      .bind(principal).first<{ revision: number; conversation_id: string | null }>();
    if (current?.revision !== revision || current.conversation_id !== c.id)
      throw new AssistantError("stale_state", 409);
    return boundedHistoryPage(revision, cursor, total, entries);
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
          0,
          c?.seen ?? 0,
          c?.activity ?? 0,
          next,
          revision,
          fence?.scope ?? null,
          fence?.id ?? null,
          fence?.owner ?? null,
          fence?.generation ?? null,
          Date.now(),
          null,
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
          JSON.stringify({ cleanup: state.cleanup }),
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
          `UPDATE assistant_jobs SET state='pending' WHERE principal=?1 AND ${condition} AND kind='agent' AND conversation_id<>?3`,
        )
        .bind(principal, commit, c?.id ?? ""),
    );
    if (!c) {
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
            `UPDATE assistant_jobs SET state='pending' WHERE principal=?1 AND kind='agent' AND ${condition}`,
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
  async requestEnd(
    principal: string,
    authId: string,
    id: string,
    at: number,
  ) {
    const result = await this.db.batch([
      this.db
        .prepare(
          "INSERT INTO assistant_stops(conversation_id,voice_id,stopped_at) SELECT ?1,'*',?2 FROM assistant_users WHERE principal=?3 AND auth_id=?4 AND conversation_id=?1 ON CONFLICT(conversation_id,voice_id) DO UPDATE SET stopped_at=MIN(stopped_at,excluded.stopped_at)",
        )
        .bind(id, at, principal, authId),
      this.db
        .prepare(
          "UPDATE assistant_users SET revision=revision+1,next_attempt=0 WHERE principal=?1 AND auth_id=?2 AND conversation_id=?3 AND EXISTS(SELECT 1 FROM assistant_stops WHERE conversation_id=?3 AND voice_id='*')",
        )
        .bind(principal, authId, id),
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
  async schedule(principal: string, id: string, revision: number, next: number) {
    await this.db.prepare("UPDATE assistant_users SET next_attempt=? WHERE principal=? AND conversation_id=? AND revision=?")
      .bind(next, principal, id, revision).run();
  }
  async intent(
    id: string,
    principal: string,
    conversationId: string,
    kind: "agent",
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
  async discardUncreatedAgentIntent(id: string, fence: Lease) {
    if (fence.scope !== "question") return false;
    const result = await this.db
      .prepare(
        "DELETE FROM assistant_jobs WHERE id=?1 AND conversation_id=?2 AND kind='agent' AND state='active' AND json_extract(data,'$.providerId') IS NULL AND EXISTS(SELECT 1 FROM assistant_leases WHERE scope='question' AND id=?2 AND owner=?3 AND generation=?4 AND expires_at>?5)",
      )
      .bind(
        id,
        fence.id,
        fence.owner,
        fence.generation,
        Date.now(),
      )
      .run();
    return result.meta.changes === 1;
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
