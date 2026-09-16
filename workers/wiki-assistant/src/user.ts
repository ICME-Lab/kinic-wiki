import { sha256 } from "@kinic/ii-server/crypto";
import {
  reserveVoice,
  settleVoiceCharge,
  voiceRate,
  voicePolicy,
  voiceReservation,
} from "./billing";
import OpenAI from "openai";
import { AssistantAuth } from "./auth";
import { AssistantStore } from "./store";
import { Leases, type Lease, RENEW_MS } from "./leases";
import { z } from "zod";
import { restoreKinicIdentity } from "@kinic/ii-server/internet-identity";
import {
  AssistantError,
  DEFAULT_LIMITS,
  questionSchema,
  scopeSchema,
  validateAnswer,
  type Answer,
  type Scope,
} from "./contracts";
import {
  createReadActor,
  emptyToolState,
  KinicReader,
  type ToolState,
} from "./kinic";
import {
  attachLive,
  cancelAgent,
  client,
  closeLiveSession,
  createLive,
  createAgent,
  deleteAgent,
  inputText,
  messageText,
  sessionItems,
} from "./openai";
import { failure, json, readJson } from "./http";
import { requireEnabled } from "./auth";
import type { Env } from "./env";

type Question = z.infer<typeof questionSchema>;
type Pending = {
  input: Question;
  generation: number;
  started: number;
  stage: "new" | "creating" | "sending" | "running";
  turnId: string | null;
  tools: ToolState;
  results: Record<string, { arguments: string; output: string }>;
  delegationId: string | null;
};
type Transcript = {
  role: "user" | "assistant";
  text: string;
  start: number;
  end: number;
};
type Charge = {
  attempts?: number;
  nextAttempt?: number;
  id: string;
  databaseId: string;
  principal: string;
  rate: string;
  reserved: number;
  started: number | null;
  stopped: number | null;
  expires: number;
  confirmed: number;
};
type VoiceUsage = {
  chargeId?: string;
  started: number;
  reserved: number;
  usageDay: string;
  settled: boolean;
};
type Conversation = {
  format: 2;
  native?: boolean;
  selectedPath?: string;
  history: { role: "user" | "assistant"; text: string }[];
  utterances: { id: string; voiceId: string; events: string[]; end: number; role: "user" | "assistant"; text: string }[];
  id: string;
  authId: string;
  principal: string;
  databaseId: string;
  scope: Scope;
  sessionId: string | null;
  generation: number;
  pending: Pending | null;
  activity: number;
  seen: number;
  status: "ready" | "working" | "cancelling";
  error: string | null;
  messages: {
    voice: boolean;
    requestId: string;
    question: string;
    answer: Answer | null;
    error: string | null;
  }[];
  live: {
    id: string | null;
    usage: VoiceUsage;
    stopping: boolean;
  } | null;
  transcripts: Transcript[];
  delegations: string[];
  deferred: { id: string; offset: number } | null;
};
type Cleanup = {
  attempts?: number;
  nextAttempt?: number;
  sessionId: string | null;
  conversationId: string;
  unknownCreate: boolean;
  liveId: string | null;
  requestId?: string;
  voiceUsage?: VoiceUsage;
};
export type UserState = {
  endRequested?: number;
  charges: Charge[];
  principal: string | null;
  day: string;
  questions: number;
  voiceSeconds: number;
  conversation: Conversation | null;
  cleanup: Cleanup[];
};
const day = () => new Date().toISOString().slice(0, 10);
const safeJson = (value: string): unknown => {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
};
// A voice session stops settling while the sideband is down, so recovery must
// not wait for the next maintenance tick (the cron runs once a minute).
export const SIDEBAND_RETRY_BASE_MS = 1000;
export const SIDEBAND_RETRY_MAX_MS = 15000;
export const sidebandRetryDelay = (attempt: number) =>
  Math.min(SIDEBAND_RETRY_MAX_MS, SIDEBAND_RETRY_BASE_MS * 2 ** attempt);

export class AssistantUser {
  private state!: UserState;
  private revision = 0;
  private pumping = false;
  private voiceStarting = false;
  private metering = false;
  private sideband: WebSocket | null = null;
  private sidebandId: string | null = null;
  private sidebandRetry: ReturnType<typeof setTimeout> | undefined;
  private sidebandAttempt = 0;
  private attaching: Promise<void> | null = null;
  private liveEvents: Promise<void> = Promise.resolve();
  private stopping: Promise<void> | null = null;
  private store: AssistantStore;
  private leases: Leases;
  private questionLease: Lease | null = null;
  private connectionLease: Lease | null = null;
  private sockets: WebSocket[] = [];
  private nextWake = 0;
  private driving = false;
  private checkingDeadlines = false;
  private connectionRenewal: ReturnType<typeof setInterval> | undefined;
  private saveChain: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | undefined;
  constructor(
    private readonly env: Env,
    private readonly principal: string,
    private readonly background: (p: Promise<unknown>) => void = (p) => {
      void p.catch(() => {});
    },
    private readonly recoveryLease?: Lease,
  ) {
    this.store = new AssistantStore(env);
    this.leases = new Leases(env.ASSISTANT_DB);
  }
  async initialize() {
    const loaded = await this.store.load(this.principal);
    this.state = loaded.state;
    this.revision = loaded.revision;
    // Format 2 adds durable utterances. Retire earlier temporary sessions once;
    // never reinterpret an older encrypted conversation as the new format.
    if (this.state.conversation && this.state.conversation.format !== 2) {
      await this.endOwned(this.state.conversation.authId, this.state.conversation.id);
    }
    this.nextWake = this.wakeDeadline();
    if (this.state.endRequested !== undefined && this.state.conversation)
      await this.endOwned(
        this.state.conversation.authId,
        this.state.conversation.id,
        this.state.endRequested,
      );
    return this;
  }
  private async save(): Promise<void> {
    const next = this.saveChain
      .catch(() => {})
      .then(async () => {
        this.nextWake = Math.min(
          this.nextWake || Infinity,
          this.wakeDeadline(),
        );
        this.revision = await this.store.save(
          this.principal,
          this.revision,
          this.state,
          this.nextWake,
          this.questionLease ?? this.connectionLease ?? this.recoveryLease,
        );
      });
    this.saveChain = next;
    return next;
  }
  private wakeDeadline(): number {
    const now = Date.now(),
      c = this.state?.conversation,
      limits = this.limits();
    const deadlines = [now + (c ? 15000 : 86400000)];
    if (!c) {
      for (const task of this.state?.cleanup ?? [])
        deadlines.push(task.nextAttempt ?? now + 15000);
      for (const charge of this.state?.charges ?? [])
        deadlines.push(charge.nextAttempt ?? now + 15000, charge.expires);
    }
    if (c) {
      deadlines.push(c.activity + limits.idleMs, c.seen + limits.reconnectMs);
      if (c.pending)
        deadlines.push(now + 1000, c.pending.started + limits.turnMs);
      if (c.live && !c.live.stopping) deadlines.push(this.voiceDeadline(c)!);
    }
    for (const b of this.state?.charges ?? [])
      if (b.started !== null && b.stopped === null)
        deadlines.push(b.started + b.reserved * 1000);
    return Math.max(now, Math.min(...deadlines));
  }
  private limits() {
    return DEFAULT_LIMITS;
  }
  private resetDay(): void {
    if (this.state.day !== day()) {
      this.state.day = day();
      this.state.questions = 0;
      this.state.voiceSeconds = 0;
    }
  }
  private current(): Conversation {
    const c = this.state.conversation;
    if (!c) throw new AssistantError("conversation_ended", 410);
    return c;
  }
  private async reader(
    c: Conversation,
    tools = emptyToolState(),
  ): Promise<KinicReader> {
    const auth = await new AssistantAuth(this.env, c.authId).material();
    if (auth.principal !== c.principal)
      throw new AssistantError("identity_changed", 403);
    const key = auth.material.appKey;
    if (key.length !== 2) throw new AssistantError("invalid_delegation", 401);
    const identity = restoreKinicIdentity(
      { ...auth.material, appKey: [key[0], key[1]] },
      this.env.ASSISTANT_DERIVATION_ORIGIN,
      Date.now(),
    );
    if (c.native)
      await voicePolicy(this.env, identity, c.databaseId, c.principal);
    return new KinicReader(
      createReadActor(this.env.KINIC_WIKI_CANISTER_ID, identity),
      c.databaseId,
      c.scope,
      tools,
      this.limits().characters,
      this.limits().calls,
    );
  }
  private snapshot(c: Conversation) {
    return {
      id: c.id,
      databaseId: c.databaseId,
      scope: c.scope,
      status: c.status,
      error: c.error,
      generation: c.generation,
      reconnectGraceMs: this.limits().reconnectMs,
      messages: c.messages,
      utterances: c.utterances.map(({ id, role, text }) => ({ id, role, text })),
      voice: c.live ? (c.live.stopping ? "stopping" : "connected") : "off",
      voiceDeadline: this.voiceDeadline(c),
      voiceId: c.live?.usage.chargeId ?? null,
      progress: c.pending
        ? { calls: c.pending.tools.calls, stage: c.pending.stage }
        : null,
    };
  }
  private voiceDeadline(c: Conversation): number | null {
    if (!c.live || c.live.stopping) return null;
    const b = this.state.charges.find((b) => b.id === c.live?.usage.chargeId);
    return Math.min(
      c.live.usage.started + c.live.usage.reserved * 1000,
      b
        ? b.started !== null
          ? b.started + b.reserved * 1000
          : c.live.usage.started + 30000
        : Infinity,
    );
  }
  private broadcast(): void {
    const c = this.state.conversation;
    const payload = JSON.stringify(
      c ? { type: "snapshot", ...this.snapshot(c) } : { type: "ended" },
    );
    for (const socket of this.sockets) {
      try {
        socket.send(payload);
      } catch {
        socket.close(1011, "Disconnected");
      }
    }
  }
  async fetch(request: Request): Promise<Response> {
    try {
      requireEnabled(this.env);
      const principal = request.headers.get("x-assistant-principal");
      const authId = request.headers.get("x-assistant-auth-id");
      if (!principal || !authId)
        throw new AssistantError("authentication_required", 401);
      if (this.state.principal && this.state.principal !== principal)
        throw new AssistantError("identity_changed", 403);
      this.state.principal = principal;
      const path = new URL(request.url).pathname.replace(
        /^\/api\/assistant/,
        "",
      );
      if (path === "/conversations" && request.method === "POST") {
        const input = z
          .object({
            databaseId: z.string().min(1).max(128),
            scope: scopeSchema,
            consent: z.literal("2026-09-16"),
            selectedPath: z.string().max(512).optional(),
            history: z.array(z.object({role: z.enum(["user", "assistant"]), text: z.string().max(4000)}).strict()).max(20).refine((items) => new TextEncoder().encode(JSON.stringify(items)).length <= 12000).default([]),
          })
          .strict()
          .parse(await readJson(request));
        if (this.state.conversation)
          throw new AssistantError("conversation_already_active", 409);
        if (this.state.cleanup.length)
          throw new AssistantError("cleanup_pending", 409);
        const c: Conversation = {
          format: 2,
          id: crypto.randomUUID(),
          native: request.headers.get("x-assistant-client") === "native",
          selectedPath: input.selectedPath,
          history: input.history,
          utterances: [],
          principal,
          authId,
          databaseId: input.databaseId,
          scope: input.scope,
          sessionId: null,
          generation: 0,
          pending: null,
          activity: Date.now(),
          seen: Date.now(),
          status: "ready",
          error: null,
          messages: [],
          live: null,
          transcripts: [],
          delegations: [],
          deferred: null,
        };
        await (await this.reader(c)).manifest();
        if (this.state.conversation)
          throw new AssistantError("conversation_already_active", 409);
        this.state.conversation = c;
        await this.save();
        return json(this.snapshot(c), 201);
      }
      const c = this.current();
      if (
        path === "/active" &&
        request.method === "GET" &&
        c.authId === authId
      ) {
        await (await this.reader(c)).authorize();
        c.seen = Date.now();
        await this.save();
        return json(this.snapshot(c));
      }
      const id = new URL(request.url).searchParams.get("conversationId");
      if (c.id !== id || c.authId !== authId)
        throw new AssistantError("conversation_not_owned", 403);
      if (path === "/end" && request.method === "POST") {
        await this.endOwned(authId);
        return json({ ended: true });
      }
      if (path === "/voice/stop" && request.method === "POST") {
        const receivedAt = Number(
          request.headers.get("x-assistant-received-at"),
        );
        this.stopCharge(
          c,
          receivedAt > 0 ? Math.min(Date.now(), receivedAt) : Date.now(),
        );
      }
      await (await this.reader(c)).authorize();
      if (this.state.conversation !== c)
        throw new AssistantError("conversation_ended", 410);
      c.seen = Date.now();
      if (
        path === "/events" &&
        request.headers.get("upgrade") === "websocket"
      ) {
        if (this.sockets.length >= 2)
          throw new AssistantError("connection_limit", 429);
        return this.openControl(c);
      }
      if (path === "/conversation" && request.method === "GET") {
        await this.save();
        return json(this.snapshot(c));
      }
      if (path === "/questions" && request.method === "POST") {
        await this.enqueue(
          c,
          questionSchema.parse(await readJson(request)),
          null,
        );
        return json(this.snapshot(c), 202);
      }
      if (path === "/cancel" && request.method === "POST") {
        await this.cancel(c);
        return json(this.snapshot(c));
      }
      if (path === "/voice/quote" && request.method === "GET") {
        const rate = await voiceRate(this.env);
        return json({
          rateVersion: rate.version.toString(),
          cyclesPerMinute: rate.cycles_per_minute.toString(),
          maximumCycles: (
            (rate.cycles_per_minute * BigInt(this.limits().connectionSeconds) +
              59n) /
            60n
          ).toString(),
          maximumSeconds: this.limits().connectionSeconds,
        });
      }
      if (path === "/voice" && request.method === "POST") {
        const { sdp, rateVersion, requestId } = z
          .object({
            sdp: z.string().min(1).max(60000),
            rateVersion: z
              .string()
              .regex(/^[0-9]{1,19}$/)
              .optional(),
            requestId: z.string().uuid().optional(),
          })
          .strict()
          .parse(await readJson(request));
        return json(await this.startVoice(c, sdp, rateVersion, requestId), 201);
      }
      if (path === "/voice/connected" && request.method === "POST") {
        const { voiceId } = z
          .object({ voiceId: z.string().uuid() })
          .strict()
          .parse(await readJson(request));
        const b = this.state.charges.find((b) => b.id === voiceId);
        if (
          !c.live ||
          c.live.stopping ||
          c.live.usage.chargeId !== voiceId ||
          !b ||
          b.stopped !== null
        )
          throw new AssistantError("voice_connection_failed", 409);
        if (b.started === null) {
          if (Date.now() >= c.live.usage.started + 30000) {
            await this.stopVoice(c, false);
            throw new AssistantError("voice_connection_failed", 409);
          }
          b.started = Date.now();
          c.live.usage.started = b.started;
          await this.save();
          this.broadcast();
        }
        return json(this.snapshot(c));
      }
      if (path === "/voice/stop" && request.method === "POST") {
        await this.stopVoice(c);
        return json(this.snapshot(c));
      }
      if (path === "/citation" && request.method === "POST") {
        const { citationId } = z
          .object({ citationId: z.string().uuid() })
          .strict()
          .parse(await readJson(request));
        const citation = c.messages
          .flatMap((m) => m.answer?.citations ?? [])
          .find((item) => item.id === citationId);
        if (!citation) throw new AssistantError("citation_not_found", 404);
        const result = await (
          await this.reader(c)
        ).actor.read_node(c.databaseId, citation.path);
        if ("Err" in result) throw new AssistantError("wiki_read_denied", 403);
        return json({
          changed: result.Ok[0]?.etag !== citation.etag,
          missing: !result.Ok[0],
        });
      }
      throw new AssistantError("not_found", 404);
    } catch (error) {
      return failure(error);
    }
  }
  private async enqueue(
    c: Conversation,
    input: Question,
    delegationId: string | null,
  ): Promise<void> {
    const previous = c.messages.find((m) => m.requestId === input.requestId);
    if (previous) {
      if (previous.question !== input.question)
        throw new AssistantError("request_id_reused", 409);
      return;
    }
    if (input.scope !== c.scope)
      throw new AssistantError("scope_not_allowed", 403);
    if (c.pending || c.status === "cancelling")
      throw new AssistantError("turn_in_progress", 409);
    this.resetDay();
    if (this.state.questions >= this.limits().questions)
      throw new AssistantError("question_limit", 429);
    if (c.messages.length >= 50)
      throw new AssistantError("conversation_limit", 429);
    this.state.questions++;
    c.generation++;
    c.activity = Date.now();
    c.error = null;
    c.status = "working";
    c.pending = {
      input,
      generation: c.generation,
      started: Date.now(),
      stage: "new",
      turnId: null,
      tools: emptyToolState(),
      results: {},
      delegationId,
    };
    c.messages.push({
      voice: delegationId !== null,
      requestId: input.requestId,
      question: input.question,
      answer: null,
      error: null,
    });
    await this.save();
    this.broadcast();
    this.background(this.pump());
  }
  private async valid(c: Conversation, p: Pending): Promise<boolean> {
    return (
      !!this.questionLease &&
      (await this.leases.valid(this.questionLease)) &&
      this.state.conversation === c &&
      c.pending === p &&
      c.generation === p.generation &&
      Date.now() <= p.started + this.limits().turnMs
    );
  }
  private async pump(): Promise<void> {
    if (this.pumping) return;
    const id = this.state.conversation?.id;
    if (!id) return;
    this.pumping = true;
    let lease: Lease | null;
    try {
      lease = await this.leases.claim("question", id);
    } catch (error) {
      this.pumping = false;
      throw error;
    }
    if (!lease) {
      this.pumping = false;
      return;
    }
    this.questionLease = lease;
    const renewal = setInterval(
      () => this.background(this.leases.renew(lease)),
      RENEW_MS,
    );
    const startedConversation = this.state.conversation;
    const startedPending = startedConversation?.pending;
    try {
      const c = this.state.conversation;
      const p = c?.pending;
      if (!c || !p || !(await this.valid(c, p))) return;
      const api = client(this.env.OPENAI_API_KEY);
      if (Date.now() - p.started > this.limits().turnMs) {
        c.error = "turn_timeout";
        await this.cancel(c);
        return;
      }
      await (await this.reader(c)).authorize();
      if (!(await this.valid(c, p))) return;
      const input = inputText(
        p.input.requestId,
        p.input.question,
        c.scope,
        p.input.selectedPath,
        c.history,
      );
      if (p.stage === "new") {
        p.stage = c.sessionId ? "sending" : "creating";
        await this.save();
        if (!c.sessionId) {
          const intent = "agent:" + c.id + ":" + p.input.requestId;
          await this.store.intent(intent, this.principal, c.id, "agent", {
            requestId: p.input.requestId,
            providerId: null,
          });
          const result = await createAgent(api, c.id, p.input.requestId, input);
          await this.store.created(intent, result.id);
          if (!(await this.valid(c, p))) {
            const uncertain = this.state.cleanup.find(
              (task) =>
                task.conversationId === c.id &&
                task.requestId === p.input.requestId &&
                task.unknownCreate,
            );
            if (uncertain) {
              uncertain.sessionId = result.id;
              uncertain.unknownCreate = false;
              uncertain.nextAttempt = 0;
            } else
              this.state.cleanup.push({
                sessionId: result.id,
                conversationId: c.id,
                unknownCreate: false,
                liveId: null,
              });
            await this.save();
            return;
          }
          c.sessionId = result.id;
        } else {
          await api.beta.agents.sessions.events.create(c.sessionId, {
            events: [
              {
                type: "agent.session.input.message",
                input: [
                  {
                    role: "user",
                    content: [{ type: "input_text", text: input }],
                  },
                ],
              },
            ],
          });
        }
        if (!(await this.valid(c, p))) return;
        p.stage = "running";
        await this.save();
      }
      if (!c.sessionId) {
        // Creation may have succeeded before a transport failure. Never submit it again.
        let count = 0;
        for await (const session of api.beta.agents.sessions.list({
          limit: 100,
        })) {
          if (
            session.metadata.kinic_conversation === c.id &&
            session.metadata.kinic_request === p.input.requestId
          ) {
            await this.store.created(
              "agent:" + c.id + ":" + p.input.requestId,
              session.id,
            );
            c.sessionId = session.id;
            p.stage = "running";
            await this.save();
            break;
          }
          if (++count >= 300) break;
        }
        if (!c.sessionId) return;
      }
      const sessionId = c.sessionId;
      const items = await sessionItems(api, sessionId);
      if (!(await this.valid(c, p))) return;
      const userMessage = items.find(
        (item) =>
          item.type === "message" &&
          item.role === "user" &&
          messageText(item) === input,
      );
      if (!userMessage) return; // Ambiguous input submission: reconcile, never resubmit.
      p.turnId = userMessage.turn_id;
      const session = await api.beta.agents.sessions.retrieve(sessionId);
      if (!(await this.valid(c, p))) return;
      if (session.status === "failed")
        throw new AssistantError("agent_failed", 502);
      for (const action of session.required_actions) {
        if (!(await this.valid(c, p))) return;
        if (action.type !== "function_call" || action.turn_id !== p.turnId)
          throw new AssistantError("unexpected_agent_action", 502);
        const signature = JSON.stringify({
          name: action.name,
          arguments: action.arguments,
        });
        let result = p.results[action.call_id];
        if (result && result.arguments !== signature)
          throw new AssistantError("tool_call_changed", 502);
        if (!result) {
          const reader = await this.reader(c, p.tools);
          const output = await reader.execute(action.name, action.arguments);
          if (!(await this.valid(c, p))) return;
          result = { arguments: signature, output };
          p.results[action.call_id] = result;
          await this.save();
          this.broadcast();
        }
        await (await this.reader(c)).authorize();
        if (!(await this.valid(c, p))) return;
        await api.beta.agents.sessions.events.create(sessionId, {
          events: [
            {
              type: "agent.session.input.tool_result",
              turn_id: action.turn_id,
              call_id: action.call_id,
              success: true,
              output: result.output,
            },
          ],
        });
      }
      const turn = await api.beta.agents.sessions.turns.retrieve(p.turnId, {
        session_id: sessionId,
      });
      if (!(await this.valid(c, p))) return;
      if (turn.status === "failed" || turn.status === "cancelled")
        throw new AssistantError("agent_" + turn.status, 502);
      if (turn.status !== "completed") return;
      const finalItems = await sessionItems(api, sessionId);
      const final = finalItems.find(
        (item) =>
          item.type === "message" &&
          item.role === "assistant" &&
          item.turn_id === p.turnId &&
          item.phase === "final_answer",
      );
      if (!final) throw new AssistantError("answer_missing", 502);
      const answer = validateAnswer(
        JSON.parse(messageText(final)),
        p.tools.evidence,
      );
      await (await this.reader(c)).authorize();
      if (!(await this.valid(c, p))) return;
      const message = c.messages.find(
        (item) => item.requestId === p.input.requestId,
      )!;
      message.answer = answer;
      c.pending = null;
      c.status = "ready";
      c.error = null;
      await this.save();
      this.broadcast();
      console.log(
        JSON.stringify({
          event: "assistant_answer",
          durationMs: Date.now() - p.started,
          calls: p.tools.calls,
          characters: p.tools.characters,
          inputTokens: turn.usage?.input_tokens,
          outputTokens: turn.usage?.output_tokens,
        }),
      );
      if (p.delegationId && c.live && !c.live.stopping) {
        try {
          await this.ensureSideband(c);
          if (this.state.conversation === c && c.generation === p.generation)
            await this.sendLive({
              type: "session.commentary.append",
              event_id: crypto.randomUUID(),
              delegation_id: p.delegationId,
              // Bound UTF-8 bytes conservatively below the 500-token limit.
              content: voiceSummary(answer),
            });
        } catch {
          if (this.state.conversation === c) {
            await this.failVoice(c);
          }
        }
      }
    } catch (error) {
      const c = startedConversation;
      if (!c || !startedPending || !(await this.valid(c, startedPending)))
        return;
      if (c && error instanceof AssistantError) {
        c.error = error.code;
        if (error.status === 401 || error.status === 403)
          await this.endOwned(c.authId);
        else await this.cancel(c);
      } else if (
        c &&
        (error instanceof z.ZodError ||
          error instanceof SyntaxError ||
          (error instanceof OpenAI.APIError &&
            [400, 401, 403, 404].includes(error.status ?? 0)))
      ) {
        let unknownCreate: boolean | undefined;
        if (error instanceof OpenAI.APIError && c.pending?.stage === "creating") {
          const intent = "agent:" + c.id + ":" + c.pending.input.requestId;
          let discarded = false;
          try {
            if (this.questionLease)
              discarded = await this.store.discardUncreatedAgentIntent(
                intent,
                this.questionLease,
              );
          } catch {
            console.error(
              JSON.stringify({ event: "assistant_job_finalization_pending" }),
            );
          }
          if (!discarded) {
            c.error = "checking_request_status";
            await this.save();
            this.broadcast();
            return;
          }
          unknownCreate = false;
        }
        c.error = "agent_response_unavailable";
        await this.cancel(c, unknownCreate);
      } else if (c?.pending) {
        // Network errors are reconciled by the next owner, without duplicate input submission.
        c.error = "checking_request_status";
        await this.save();
        this.broadcast();
      }
    } finally {
      clearInterval(renewal);
      await this.leases.release(lease);
      this.questionLease = null;
      this.pumping = false;
    }
  }
  private async cancel(
    c: Conversation,
    unknownCreateOverride?: boolean,
  ): Promise<void> {
    c.generation++;
    c.deferred = null;
    if (c.pending) {
      const message = c.messages.find(
        (m) => m.requestId === c.pending?.input.requestId,
      );
      if (message) message.error = c.error ?? "cancel_requested";
    }
    this.state.cleanup.push({
      sessionId: c.sessionId,
      conversationId: c.id,
      unknownCreate:
        unknownCreateOverride ??
        (c.pending?.stage === "creating" && !c.sessionId),
      requestId: c.pending?.input.requestId,
      liveId: null,
    });
    c.sessionId = null;
    c.pending = null;
    c.status = "cancelling";
    await this.sendLive({
      type: "session.instructions.append",
      event_id: crypto.randomUUID(),
      delegation_id: null,
      content:
        "Stop speaking about the previous request. Its result must not be used. Wait for the next verified backend result.",
    });
    await this.save();
    this.broadcast();
    await this.cleanup();
  }
  async endOwned(
    authId: string,
    conversationId?: string,
    stoppedAt = Date.now(),
  ): Promise<void> {
    const c = this.state.conversation;
    if (
      !c ||
      c.authId !== authId ||
      (conversationId !== undefined && conversationId !== c.id)
    )
      return;
    c.generation++;
    this.stopCharge(c, stoppedAt);
    this.state.cleanup.push({
      sessionId: c.sessionId,
      conversationId: c.id,
      unknownCreate: c.pending?.stage === "creating" && !c.sessionId,
      requestId: c.pending?.input.requestId,
      liveId: c.live?.id ?? null,
      voiceUsage: c.live?.usage,
    });
    this.state.conversation = null; // Drop transcripts, excerpts, and answers before remote cleanup.
    await this.save();
    this.broadcast();
    for (const ws of this.sockets) ws.close(1000, "Conversation ended");
    await this.cleanup();
  }
  private async cleanup(): Promise<void> {
    const api = client(this.env.OPENAI_API_KEY);
    for (const task of this.state.cleanup.slice()) {
      if ((task.nextAttempt ?? 0) > Date.now()) continue;
      try {
        if (task.unknownCreate) {
          let count = 0;
          let found = false;
          for await (const session of api.beta.agents.sessions.list({
            limit: 100,
          })) {
            if (
              session.metadata.kinic_conversation === task.conversationId &&
              session.metadata.kinic_request === task.requestId
            ) {
              await this.store.created(
                "agent:" + task.conversationId + ":" + task.requestId,
                session.id,
              );
              await cancelAgent(api, session.id);
              await deleteAgent(api, session.id);
              found = true;
            }
            if (++count >= 300) break;
          }
          // Unknown creation cannot be declared deleted just because listing found nothing.
          if (!found) throw new Error("unknown_session_creation");
          task.unknownCreate = false;
        }
        if (task.sessionId) {
          try {
            await cancelAgent(api, task.sessionId);
          } catch {
            /* Deletion below is authoritative. */
          }
          await deleteAgent(api, task.sessionId);
          task.sessionId = null;
        }
        if (task.liveId) {
          const ws =
            this.sidebandId === task.liveId && this.sideband
              ? this.sideband
              : await attachLive(this.env.OPENAI_API_KEY!, task.liveId);
          const seconds = await this.closeSocketSession(task.liveId, ws);
          if (task.voiceUsage) this.settleVoice(task.voiceUsage, seconds);
          task.liveId = null;
        }
        this.state.cleanup = this.state.cleanup.filter((item) => item !== task);
      } catch (error) {
        task.attempts = (task.attempts ?? 0) + 1;
        task.nextAttempt =
          Date.now() +
          Math.min(1800000, 60000 * 2 ** Math.min(task.attempts - 1, 5));
        if (
          error instanceof AssistantError &&
          error.code === "voice_session_gone"
        ) {
          if (task.voiceUsage) this.settleVoice(task.voiceUsage);
          task.liveId = null;
        } else
          console.error(
            JSON.stringify({
              event: "assistant_cleanup_pending",
              conversationId: task.conversationId,
            }),
          );
      }
    }
    const c = this.state.conversation;
    if (c?.status === "cancelling" && !this.state.cleanup.length) {
      c.status = "ready";
      c.error = c.error === "checking_request_status" ? null : c.error;
    }
    await this.save();
    this.broadcast();
  }
  async tick(recovery = false): Promise<void> {
    this.nextWake = 0;
    const c = this.state.conversation;
    if (recovery && c && (await this.leases.active("connection", c.id))) return;
    if (recovery && c?.live) {
      this.stopCharge(c, Math.min(c.seen, Date.now()));
      c.live.stopping = true;
      await this.save();
    }
    if (c) {
      try {
        requireEnabled(this.env);
        const now = Date.now();
        if (
          now - c.activity >= this.limits().idleMs ||
          now - c.seen >= this.limits().reconnectMs
        ) {
          await this.endOwned(c.authId, c.id);
          return;
        }
        if (c.pending && now - c.pending.started >= this.limits().turnMs) {
          c.error = "turn_timeout";
          await this.cancel(c);
        }
        if (
          c.live &&
          (c.live.stopping ||
            now - c.live.usage.started >= c.live.usage.reserved * 1000)
        )
          await this.stopVoice(c, false);
        const b = this.state.charges.find(
          (b) => b.id === c.live?.usage.chargeId,
        );
        if (
          b &&
          b.started === null &&
          c.live &&
          now >= c.live.usage.started + 30000
        ) {
          c.error = "voice_connection_failed";
          await this.stopVoice(c, false);
        }
        if (
          b?.started !== null &&
          b?.started !== undefined &&
          now >= b.started + b.reserved * 1000
        ) {
          c.error = "voice_budget_exhausted";
          await this.stopVoice(c, false);
        }
        await (await this.reader(c)).authorize();
        if (this.state.conversation !== c) return;
      } catch {
        await this.endOwned(c.authId, c.id);
        return;
      }
      if (
        recovery &&
        c.live &&
        !(await this.leases.active("connection", c.id))
      ) {
        this.stopCharge(c, Math.min(c.seen, Date.now()));
        await this.failVoice(c);
      }
      if (!recovery && c.live?.id && !c.live.stopping) {
        try {
          await this.ensureSideband(c);
        } catch {
          await this.failVoice(c);
        }
      }
      if (c.pending) await this.pump();
      if (c.deferred && !c.pending && c.status === "ready") {
        try {
          await this.delegate(c, c.deferred.id, c.deferred.offset);
        } catch {
          c.error = "voice_request_failed";
          c.deferred = null;
        }
      }
    }
    await this.meterCharges();
    if (this.state.cleanup.length) await this.cleanup();
    if (
      !this.state.conversation &&
      !this.state.cleanup.length &&
      !this.state.charges.length &&
      this.state.day !== day()
    ) {
      await this.store.db
        .prepare("DELETE FROM assistant_cleanup WHERE principal=?")
        .bind(this.principal)
        .run();
      this.state.questions = 0;
      this.state.voiceSeconds = 0;
      this.state.day = day();
    } else await this.save();
  }
  private async openControl(c: Conversation): Promise<Response> {
    const lease = await this.leases.claim("connection", c.id);
    if (!lease) throw new AssistantError("connection_already_active", 409);
    this.connectionLease = lease;
    this.connectionRenewal = setInterval(
      () =>
        this.background(
          this.leases.renew(lease).then((ok) => {
            if (!ok)
              for (const socket of this.sockets)
                socket.close(1008, "Connection lease expired");
          }),
        ),
      RENEW_MS,
    );
    const pair = new WebSocketPair();
    pair[1].accept();
    this.sockets.push(pair[1]);
    pair[1].addEventListener("message", (event) =>
      this.background(this.controlMessage(pair[1], c, event.data)),
    );
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      this.sockets = [];
      clearInterval(this.timer);
      clearInterval(this.connectionRenewal);
      const stoppedAt = Date.now();
      this.background(
        (async () => {
          try {
            if (await this.leases.valid(lease)) {
              const current = this.state.conversation;
              if (current?.id === c.id && current.live) {
                this.stopCharge(current, stoppedAt);
                await this.failVoice(current);
              }
            }
          } finally {
            this.clearSidebandRetry();
            this.sideband?.close();
            this.sideband = null;
            await this.leases.release(lease);
            this.connectionLease = null;
          }
        })(),
      );
    };
    pair[1].addEventListener("close", close);
    pair[1].addEventListener("error", close);
    this.timer = setInterval(
      () =>
        this.background(
          this.drive().catch(() => {
            pair[1].close(1011, "Reconnect required");
            close();
          }),
        ),
      1000,
    );
    this.broadcast();
    return new Response(null, { status: 101, webSocket: pair[0] });
  }
  private async drive() {
    if (!this.checkingDeadlines && this.connectionLease) {
      this.checkingDeadlines = true;
      try {
        const c = this.state.conversation,
          now = Date.now();
        if (
          c?.live &&
          !c.live.stopping &&
          now >= (this.voiceDeadline(c) ?? Infinity)
        ) {
          this.stopCharge(c, this.voiceDeadline(c)!);
          await this.stopVoice(c, false);
        }
        if (c?.pending && now >= c.pending.started + this.limits().turnMs) {
          c.error = "turn_timeout";
          await this.cancel(c);
        }
      } finally {
        this.checkingDeadlines = false;
      }
    }
    if (this.driving || !this.connectionLease) return;
    this.driving = true;
    try {
      const lease = this.connectionLease;
      if (
        lease.expires_at - Date.now() <= 35000 &&
        !(await this.leases.renew(lease))
      )
        throw new Error("lease_lost");
      const receivedEvents = this.liveEvents;
      await receivedEvents;
      const expectedRevision = this.revision;
      const current = await this.store.db
        .prepare("SELECT revision FROM assistant_users WHERE principal=?")
        .bind(this.principal)
        .first<{ revision: number }>();
      if (current && current.revision !== this.revision) {
        const loaded = await this.store.load(this.principal);
        // Do not overwrite an event received while the snapshot was loading.
        if (this.liveEvents !== receivedEvents || this.revision !== expectedRevision) return;
        this.state = loaded.state;
        this.revision = loaded.revision;
        this.broadcast();
      }
      if (this.state.conversation?.live?.stopping || Date.now() >= this.nextWake) await this.tick();
    } finally {
      this.driving = false;
    }
  }
  private async controlMessage(
    ws: WebSocket,
    original: Conversation,
    message: string | ArrayBuffer,
  ) {
    if (
      !this.connectionLease ||
      !(await this.leases.valid(this.connectionLease))
    ) {
      ws.close(1008, "Stale connection");
      return;
    }
    if (typeof message === "string" && message.length <= 65536) {
      const heartbeat = z
        .object({ type: z.literal("heartbeat"), requestId: z.string().uuid() })
        .strict()
        .safeParse(safeJson(message));
      if (heartbeat.success) {
        const c = this.state.conversation;
        if (!c || c.id !== original.id) {
          ws.close(1000, "Conversation ended");
          return;
        }
        await (await this.reader(c)).authorize();
        c.seen = Date.now();
        await this.store.touch(this.principal, c.id);
        // The client cannot tell a quiet session from a dead peer without a
        // reply, so every heartbeat is echoed.
        ws.send(
          JSON.stringify({
            type: "heartbeat",
            requestId: heartbeat.data.requestId,
          }),
        );
        return;
      }
    }
    let requestId = "";
    try {
      if (typeof message !== "string" || message.length > 65536)
        throw new AssistantError("invalid_command", 400);
      const command = z
        .object({
          type: z.literal("command"),
          requestId: z.string().uuid(),
          action: z.enum([
            "questions",
            "voice",
            "voice/connected",
            "voice/stop",
            "cancel",
          ]),
          payload: z.record(z.string(), z.unknown()),
          generation: z.number().int(),
        })
        .strict()
        .parse(JSON.parse(message));
      requestId = command.requestId;
      const c = this.current();
      if (c.id !== original.id) throw new AssistantError("stale_state", 409);
      const record = await this.store.command(
        c.id,
        requestId,
        await sha256(
          JSON.stringify({
            action: command.action,
            payload: Object.keys(command.payload)
              .sort()
              .map((key) => [key, command.payload[key]]),
          }),
        ),
      );
      if (record.response) {
        ws.send(
          JSON.stringify({
            type: "command.result",
            requestId,
            ...record.response,
          }),
        );
        return;
      }
      if (!record.fresh && command.action !== "questions")
        throw new AssistantError("command_outcome_pending", 409);
      const duplicate =
        command.action === "questions" &&
        c.messages.some((m) => m.requestId === command.payload.requestId);
      if (command.generation !== c.generation && !duplicate)
        throw new AssistantError("stale_state", 409);
      const response = await this.fetch(
        new Request(
          "https://assistant/api/assistant/" +
            command.action +
            "?conversationId=" +
            c.id,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-assistant-principal": this.principal,
              "x-assistant-auth-id": c.authId,
              "x-assistant-client": c.native ? "native" : "web",
              "x-assistant-received-at": String(Date.now()),
            },
            body: JSON.stringify(command.payload),
          },
        ),
      );
      const result = { status: response.status, body: await response.json() };
      await this.store.commandResult(c.id, requestId, result);
      ws.send(JSON.stringify({ type: "command.result", requestId, ...result }));
    } catch (error) {
      const response = failure(error);
      ws.send(
        JSON.stringify({
          type: "command.result",
          requestId,
          status: response.status,
          body: await response.json(),
        }),
      );
    }
  }
  // Cleanup may use an expired credential's owner binding, but never returns content.
  async stopVoiceOwned(
    authId: string,
    conversationId: string,
    receivedAt: number,
    voiceId?: string,
  ): Promise<void> {
    const c = this.current();
    if (c.authId !== authId || c.id !== conversationId)
      throw new AssistantError("conversation_not_owned", 403);
    if (voiceId && c.live?.usage.chargeId !== voiceId) return;
    this.stopCharge(c, Math.min(Date.now(), receivedAt));
    await this.stopVoice(c, false);
  }
  private async startVoice(
    c: Conversation,
    sdp: string,
    rateVersion?: string,
    requestId?: string,
  ) {
    if (this.voiceStarting)
      throw new AssistantError("voice_or_turn_in_progress", 409);
    this.voiceStarting = true;
    try {
      return await this.createVoice(c, sdp, rateVersion, requestId);
    } finally {
      this.voiceStarting = false;
    }
  }
  private async createVoice(
    c: Conversation,
    sdp: string,
    rateVersion?: string,
    requestId?: string,
  ) {
    if (c.live || c.pending || c.status !== "ready")
      throw new AssistantError("voice_or_turn_in_progress", 409);
    this.resetDay();
    const limits = this.limits();
    const reserved = Math.min(
      limits.connectionSeconds,
      limits.voiceSeconds - this.state.voiceSeconds,
    );
    if (reserved < 15) throw new AssistantError("voice_limit", 429);
    let charge: Charge | undefined;
    if (c.native) {
      if (!rateVersion)
        throw new AssistantError("voice_price_consent_required", 400);
      if (!requestId) throw new AssistantError("invalid_voice_request", 400);
      charge = {
        id: requestId,
        databaseId: c.databaseId,
        principal: c.principal,
        rate: rateVersion,
        reserved: 60,
        started: null,
        stopped: null,
        expires: Date.now() + 86400000,
        confirmed: 0,
      };
      this.state.charges.push(charge);
      await this.save();
      try {
        await reserveVoice(
          this.env,
          charge.id,
          c.databaseId,
          c.principal,
          rateVersion,
          60,
        );
      } catch (error) {
        charge.stopped = Date.now();
        await this.save();
        throw error;
      }
      if (this.state.conversation !== c) {
        charge.stopped = Date.now();
        await this.save();
        throw new AssistantError("conversation_ended", 410);
      }
    }
    this.state.voiceSeconds += reserved;
    c.activity = Date.now();
    const usage: VoiceUsage = {
      chargeId: charge?.id ?? requestId ?? crypto.randomUUID(),
      started: Date.now(),
      reserved,
      usageDay: this.state.day,
      settled: false,
    };
    c.live = { id: null, usage, stopping: false };
    this.sidebandAttempt = 0;
    const live = c.live;
    c.transcripts = [];
    c.delegations = [];
    await this.save();
    try {
      const intent =
        "live:" + c.id + ":" + (usage.chargeId ?? crypto.randomUUID());
      await this.store.intent(intent, this.principal, c.id, "live", {
        providerId: null,
        voiceId: usage.chargeId ?? null,
        requestId: usage.chargeId ?? null,
      });
      const result = await createLive(client(this.env.OPENAI_API_KEY), sdp, c.history);
      await this.store.created(intent, result.session.id);
      if (this.state.conversation !== c || c.live !== live) {
        this.state.cleanup.push({
          sessionId: null,
          conversationId: c.id,
          unknownCreate: false,
          liveId: result.session.id,
          voiceUsage: usage,
        });
        await this.save();
        throw new AssistantError("conversation_ended", 410);
      }
      c.live.id = result.session.id;
      await this.save();
      await this.ensureSideband(c);
      this.broadcast();
      return {
        sdp: result.transport.sdp,
        voiceId: usage.chargeId,
        voiceDeadline: this.voiceDeadline(c),
      };
    } catch {
      if (charge) {
        charge.started = null;
        charge.stopped = Date.now();
      }
      this.settleVoice(live.usage, 0);
      if (c.live === live && c.live.id) await this.stopVoice(c);
      else if (c.live === live) {
        c.live = null;
        await this.save();
      } // Keep the cleanup job if creation outcome is unknown.
      throw new AssistantError("voice_connection_failed", 502);
    }
  }
  private stopCharge(c: Conversation, stoppedAt = Date.now()): void {
    const b = this.state.charges.find((b) => b.id === c.live?.usage.chargeId);
    if (b && b.stopped === null) b.stopped = stoppedAt;
  }
  private async meterCharges(): Promise<void> {
    if (this.metering) return;
    this.metering = true;
    try {
      await this.flushCharges();
    } finally {
      this.metering = false;
    }
  }
  private async flushCharges(): Promise<void> {
    for (const b of this.state.charges.slice()) {
      if ((b.nextAttempt ?? 0) > Date.now() && Date.now() < b.expires) continue;
      if (Date.now() >= b.expires) {
        console.error(
          JSON.stringify({ event: "voice_billing_expired", sessionId: b.id }),
        );
        this.state.charges = this.state.charges.filter((v) => v !== b);
        continue; // Canister timeout releases only unconfirmed amounts.
      }
      const c = this.state.conversation;
      if (b.stopped === null && c?.live?.usage.chargeId !== b.id) {
        if (this.voiceStarting && b.started === null) continue;
        b.stopped = Date.now();
      }
      if (b.started === null && b.stopped === null) continue;
      const seconds =
        b.started === null
          ? 0
          : Math.min(
              b.reserved,
              Math.max(
                0,
                Math.ceil(((b.stopped ?? Date.now()) - b.started) / 1000),
              ),
            );
      const closing = b.stopped !== null;
      try {
        let settled;
        try {
          settled = await settleVoiceCharge(this.env, b.id, seconds, closing);
        } catch (error) {
          const known = await voiceReservation(this.env, b.id);
          if (
            !known ||
            (!known.closed && Number(known.confirmed_seconds) < seconds)
          )
            throw error;
          settled = known;
        }
        b.attempts = 0;
        b.nextAttempt = 0;
        b.confirmed = Number(settled.confirmed_seconds);
        if (settled.closed) {
          this.state.charges = this.state.charges.filter((v) => v !== b);
          if (b.stopped === null && c?.live?.usage.chargeId === b.id) {
            c.error = "voice_budget_exhausted";
            await this.stopVoice(c, false);
          }
        } else if (
          b.stopped === null &&
          c?.live &&
          b.reserved < c.live.usage.reserved &&
          b.reserved - seconds <= 30
        ) {
          try {
            const next = Math.min(
              b.reserved + 60,
              Math.floor(c.live.usage.reserved / 60) * 60,
            );
            if (next > b.reserved) {
              let reservation;
              try {
                reservation = await reserveVoice(
                  this.env,
                  b.id,
                  b.databaseId,
                  b.principal,
                  b.rate,
                  next,
                );
              } catch (error) {
                const known = await voiceReservation(this.env, b.id);
                if (
                  !known ||
                  known.closed ||
                  Number(known.reserved_seconds) < next
                )
                  throw error;
                reservation = known;
              }
              b.reserved = Number(reservation.reserved_seconds);
              await this.save();
              this.broadcast();
            }
          } catch {
            c.error = "voice_budget_exhausted";
          }
        }
      } catch {
        b.attempts = (b.attempts ?? 0) + 1;
        b.nextAttempt =
          Date.now() +
          (b.stopped !== null
            ? Math.min(1800000, 60000 * 2 ** Math.min(b.attempts - 1, 5))
            : 15000);
        console.error(
          JSON.stringify({ event: "voice_billing_pending", sessionId: b.id }),
        );
      }
      await this.save();
    }
  }
  private async ensureSideband(c: Conversation): Promise<void> {
    if (this.attaching) return this.attaching;
    this.attaching = this.attachSideband(c);
    try {
      await this.attaching;
    } finally {
      this.attaching = null;
    }
  }
  private async attachSideband(c: Conversation): Promise<void> {
    const id = c.live?.id;
    const conversationId = c.id;
    const lease = this.connectionLease;
    if (!id || !lease) return;
    // Readiness, not the tracked id, decides whether coverage already exists: a
    // socket that closed after attach leaves the id behind.
    if (this.sidebandId === id && this.sideband?.readyState === WebSocket.OPEN)
      return;
    this.sideband?.close();
    this.sideband = null;
    this.sidebandId = null;
    this.clearSidebandRetry();
    const ws = await attachLive(this.env.OPENAI_API_KEY!, id);
    const ownsConnection = await this.leases.valid(lease);
    const current = this.state.conversation;
    if (
      !ownsConnection ||
      this.connectionLease !== lease ||
      current?.id !== conversationId ||
      current.live?.id !== id
    ) {
      // Release only this attachment; persisted cleanup owns session termination.
      ws.close();
      return;
    }
    this.sideband = ws;
    this.sidebandId = id;
    // The attempt counter is deliberately not reset here: an attachment that
    // closes immediately would otherwise retry at the floor interval forever.
    ws.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      const data = event.data;
      const accepted = this.sideband === ws && this.sidebandId === id;
      if (!accepted) return;
      if ((safeJson(data) as { type?: unknown } | undefined)?.type === "session.closed") {
        this.clearSidebandRetry();
        const live = this.state.conversation?.live;
        if (live?.id === id) live.stopping = true;
      }
      // Capture ownership on receipt: a subsequent socket close must not discard
      // already received transcript fragments waiting for their D1 write.
      this.liveEvents = this.liveEvents.catch(() => {}).then(() => this.liveEvent(conversationId, id, ws, data, true));
      this.background(this.liveEvents);
    });
    ws.addEventListener("close", () => {
      if (this.sideband === ws) {
        this.sideband = null;
        this.sidebandId = null;
      }
      this.scheduleSidebandRetry(id);
    });
    ws.addEventListener("error", () => {
      ws.close();
    });
    await this.sendLive({
      type: "session.thinking.append",
      event_id: crypto.randomUUID(),
      delegation_id: null,
      content: `Selected Wiki scope: ${current.scope}. Use the backend for every Wiki claim.`,
    });
    // A socket can already be closed when it is adopted, and such a socket may
    // never emit `close`; without this the session would stay uncovered.
    if (ws.readyState !== WebSocket.OPEN) {
      if (this.sideband === ws) {
        this.sideband = null;
        this.sidebandId = null;
      }
      this.scheduleSidebandRetry(id);
    }
  }
  private clearSidebandRetry(): void {
    if (this.sidebandRetry !== undefined) {
      clearTimeout(this.sidebandRetry);
      this.sidebandRetry = undefined;
    }
  }
  private scheduleSidebandRetry(id: string): void {
    // Reattachment is only useful while this user still owns a live voice
    // session; stopping sessions are settled by stopVoice and cleanup.
    const c = this.state.conversation;
    const lease = this.connectionLease;
    if (this.sidebandRetry !== undefined || !lease || c?.live?.id !== id) return;
    if (c.live.stopping) return;
    // Only a socket that is still open keeps the session covered. A socket that
    // closed just after attach leaves the id behind, so readiness, not the id,
    // decides whether recovery is still needed.
    if (this.sidebandId === id && this.sideband?.readyState === WebSocket.OPEN)
      return;
    const attempt = this.sidebandAttempt++;
    this.sidebandRetry = setTimeout(() => {
      this.sidebandRetry = undefined;
      this.background(
        (async () => {
          const current = this.state.conversation;
          if (!current || current.live?.id !== id || current.live.stopping)
            return;
          if (!this.connectionLease) return;
          if (!(await this.leases.valid(this.connectionLease))) return;
          if (this.sideband?.readyState === WebSocket.OPEN) return;
          try {
            await this.ensureSideband(current);
          } catch (error) {
            if (
              error instanceof AssistantError &&
              error.code === "voice_session_gone"
            ) {
              this.finishVoice(current);
              await this.save();
              this.broadcast();
            } else this.scheduleSidebandRetry(id);
            return;
          }
          // The attachment may have closed while it was being adopted; coverage
          // is only restored once the socket is actually open.
          this.scheduleSidebandRetry(id);
        })(),
      );
    }, sidebandRetryDelay(attempt));
  }
  private async sendLive(value: unknown): Promise<void> {
    const c = this.state.conversation;
    if (
      !c?.live ||
      c.live.stopping ||
      !this.connectionLease ||
      !(await this.leases.valid(this.connectionLease)) ||
      !(await this.store.canSend(
        this.principal,
        c.id,
        c.live.usage.chargeId ?? "",
      ))
    )
      return;
    if (this.sideband?.readyState === WebSocket.OPEN)
      this.sideband.send(JSON.stringify(value));
  }
  private async liveEvent(
    conversationId: string,
    id: string,
    ws: WebSocket,
    data: string,
    accepted = false,
  ): Promise<void> {
    const lease = this.connectionLease;
    if (!lease || !(await this.leases.valid(lease))) return;
    const c = this.state.conversation;
    if (
      this.connectionLease !== lease ||
      (!accepted && (this.sideband !== ws || this.sidebandId !== id)) ||
      c?.id !== conversationId ||
      c.live?.id !== id ||
      data.length > 65536
    )
      return;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(data) as Record<string, unknown>;
    } catch {
      return;
    }
    if (event.type === "session.closed") {
      this.finishVoice(
        c,
        (event.usage as { seconds?: unknown } | undefined)?.seconds,
      );
      await this.save();
      this.broadcast();
      return;
    }
    if (
      (event.type === "session.input_transcript.delta" ||
        event.type === "session.output_transcript.delta") &&
      typeof event.delta === "string" && event.delta.length > 0 &&
      typeof event.start_ms === "number" &&
      typeof event.end_ms === "number" &&
      typeof event.event_id === "string" && event.event_id.length <= 200
    ) {
      const role = event.type === "session.input_transcript.delta" ? "user" : "assistant";
      const voiceId = id;
      const eventId = event.event_id;
      if (c.utterances.some((item) => item.voiceId === voiceId && item.events.includes(eventId))) return;
      if (c.utterances.length >= 500 || c.utterances.reduce((n, item) => n + item.events.length, 0) >= 2000) {
        c.error = "voice_context_limit";
        this.background(this.stopVoice(c));
        return;
      }
      const last = c.utterances.at(-1);
      if (last && last.voiceId === voiceId && last.role === role && event.start_ms - last.end < 2000 && last.text.length + event.delta.length <= 4000 && last.events.length < 200) {
        last.text += event.delta;
        last.end = event.end_ms;
        last.events.push(eventId);
      } else {
        c.utterances.push({ id: crypto.randomUUID(), voiceId, events: [eventId], end: event.end_ms, role, text: event.delta.slice(0, 4000) });
      }
      if (c.utterances.reduce((n, item) => n + item.text.length, 0) > 48000) {
        c.error = "voice_context_limit";
        this.background(this.stopVoice(c));
        return;
      }
      c.transcripts.push({
        role:
          event.type === "session.input_transcript.delta"
            ? "user"
            : "assistant",
        text: event.delta.slice(0, 4000),
        start: event.start_ms,
        end: event.end_ms,
      });
      c.activity = Date.now();
      if (c.transcripts.reduce((n, t) => n + t.text.length, 0) > 24000) {
        c.error = "voice_context_limit";
        this.background(this.stopVoice(c));
        return;
      }
      await this.save();
      this.broadcast();
    }
    if (c.live?.stopping) return;
    if (event.type === "session.delegation.created") {
      const charge = this.state.charges.find(
        (b) => b.id === c.live?.usage.chargeId,
      );
      if (charge && charge.started === null) {
        this.background(this.stopVoice(c, false));
        return;
      }
      const parsed = z
        .object({
          delegation: z.object({
            id: z.string().max(200),
            target: z.literal("client"),
          }),
          offset_ms: z.number(),
        })
        .safeParse(event);
      if (parsed.success) {
        try {
          await this.delegate(
            c,
            parsed.data.delegation.id,
            parsed.data.offset_ms,
          );
        } catch {
          c.error = "voice_request_failed";
          await this.save();
          this.broadcast();
        }
      }
    }
  }
  private async delegate(
    c: Conversation,
    id: string,
    offset: number,
  ): Promise<void> {
    if (c.delegations.includes(id) || !c.live || c.live.stopping) return;
    if (c.pending || c.status === "cancelling") {
      // Supersede the old task, then wait for cancellation before starting the corrected one.
      if (c.pending) await this.cancel(c);
      c.deferred = { id, offset };
      await this.save();
      return;
    }
    const transcript = c.transcripts
      .filter((t) => t.start <= offset)
      .map((t) => `${t.role}: ${t.text}`)
      .join("\n");
    if (!transcript.trim()) {
      c.error = "voice_transcript_missing";
      await this.save();
      return;
    }
    await (await this.reader(c)).authorize();
    c.delegations.push(id);
    c.deferred = null;
    await this.enqueue(
      c,
      {
        requestId: crypto.randomUUID(),
        scope: c.scope,
        selectedPath: c.selectedPath,
        question: `Answer the latest question or correction in the voice conversation. Ask for clarification if it is ambiguous.\n${transcript.slice(-3600)}`,
      },
      id,
    );
  }
  private finishVoice(c: Conversation, reportedSeconds?: unknown): void {
    const live = c.live;
    if (!live) return;
    this.settleVoice(live.usage, reportedSeconds);
    this.stopCharge(c);
    c.live = null;
    c.deferred = null;
    c.transcripts = [];
    c.delegations = [];
    this.clearSidebandRetry();
    this.sideband?.close();
    this.sideband = null;
    this.sidebandId = null;
  }
  private settleVoice(usage: VoiceUsage, reportedSeconds?: unknown): void {
    if (usage.settled) return;
    usage.settled = true;
    const charge = this.state.charges.find((b) => b.id === usage.chargeId);
    const seconds =
      charge?.started === null
        ? 0
        : typeof reportedSeconds === "number" &&
            Number.isFinite(reportedSeconds) &&
            reportedSeconds >= 0
          ? Math.ceil(reportedSeconds)
          : null;
    if (seconds !== null && usage.usageDay === this.state.day)
      this.state.voiceSeconds = Math.max(
        0,
        this.state.voiceSeconds - usage.reserved + seconds,
      );
    console.log(
      JSON.stringify({
        event: "assistant_voice_closed",
        durationSeconds: seconds,
        usageConfirmed: seconds !== null,
      }),
    );
  }
  private async failVoice(c: Conversation): Promise<void> {
    if (this.state.conversation !== c) return;
    c.error = "voice_connection_failed";
    await this.stopVoice(c, false);
  }
  private async closeSocketSession(
    id: string,
    ws: WebSocket,
  ): Promise<unknown> {
    return closeLiveSession(this.env.OPENAI_API_KEY!, id, ws, () => this.liveEvents);
  }
  private async stopVoice(
    c: Conversation,
    cancelPending = false,
  ): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopping = this.stopVoiceOnce(c, cancelPending);
    try { await this.stopping; } finally { this.stopping = null; }
  }
  private async stopVoiceOnce(c: Conversation, cancelPending: boolean): Promise<void> {
    if (!c.live) return;
    this.clearSidebandRetry();
    this.stopCharge(c);
    c.live.stopping = true;
    c.deferred = null;
    await this.save();
    this.broadcast();
    if (cancelPending && c.pending?.delegationId) await this.cancel(c);
    if (c.live?.id) {
      let temporaryLease: Lease | null = null;
      try {
        if (!this.connectionLease) {
          temporaryLease = await this.leases.claim("connection", c.id);
          if (!temporaryLease) return;
          this.connectionLease = temporaryLease;
        }
        await this.ensureSideband(c);
        if (!this.sideband) throw new Error("voice_close_unconfirmed");
        const seconds = await this.closeSocketSession(
          c.live.id,
          this.sideband,
        );
        this.finishVoice(c, seconds);
      } catch (error) {
        if (
          error instanceof AssistantError &&
          error.code === "voice_session_gone"
        )
          this.finishVoice(c);
        else c.error = "voice_close_pending";
      } finally {
        if (temporaryLease) {
          this.sideband?.close(); this.sideband = null; this.sidebandId = null;
          this.connectionLease = null;
          await this.leases.release(temporaryLease);
        }
      }
    } else c.live = null;
    await this.save();
    this.broadcast();
  }
}

export function voiceSummary(answer: {
  answer: string;
  insufficient: unknown;
  contradictions: unknown[];
  unverified: unknown[];
}): string {
  const caveat =
    answer.insufficient ||
    answer.contradictions.length ||
    answer.unverified.length
      ? "Caution: evidence is incomplete, conflicting, or unverified. Check the details on screen.\n"
      : "Details and sources are available on screen.\n";
  const encoder = new TextEncoder();
  let content = caveat;
  for (const character of answer.answer) {
    if (encoder.encode(content + character).length > 450) break;
    content += character;
  }
  return content;
}
