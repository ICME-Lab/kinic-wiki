import OpenAI from "openai";
import { DurableObject } from "cloudflare:workers";
import { z } from "zod";
import { restoreKinicIdentity } from "@kinic/ii-server/internet-identity";
import {
  AssistantError,
  parseLimits,
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
  createAgent,
  deleteAgent,
  inputText,
  messageText,
  sessionItems,
  voiceInstructions,
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
type VoiceUsage = {
  started: number;
  reserved: number;
  usageDay: string;
  settled: boolean;
};
type Conversation = {
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
  sessionId: string | null;
  conversationId: string;
  unknownCreate: boolean;
  liveId: string | null;
  requestId?: string;
  voiceUsage?: VoiceUsage;
};
type UserState = {
  version: 1;
  principal: string | null;
  day: string;
  questions: number;
  voiceSeconds: number;
  conversation: Conversation | null;
  cleanup: Cleanup[];
};
const day = () => new Date().toISOString().slice(0, 10);

export class AssistantUser extends DurableObject<Env> {
  private state!: UserState;
  private pumping = false;
  private sideband: WebSocket | null = null;
  private sidebandId: string | null = null;
  private attaching: Promise<void> | null = null;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.state = (await ctx.storage.get<UserState>("state")) ?? {
        version: 1,
        principal: null,
        day: day(),
        questions: 0,
        voiceSeconds: 0,
        conversation: null,
        cleanup: [],
      };
      if (this.state.version !== 1)
        throw new Error("unsupported_assistant_state");
    });
  }
  private limits() {
    return parseLimits(this.env.ASSISTANT_LIMITS);
  }
  private async save(): Promise<void> {
    await this.ctx.storage.put("state", this.state);
    await this.scheduleAlarm();
  }
  private async scheduleAlarm(): Promise<void> {
    const now = Date.now();
    const c = this.state.conversation;
    const limits = this.limits();
    const deadlines = [
      now + (c || this.state.cleanup.length ? 15000 : 86400000),
    ];
    if (c) {
      deadlines.push(c.activity + limits.idleMs, c.seen + limits.reconnectMs);
      if (c.pending)
        deadlines.push(now + 1000, c.pending.started + limits.turnMs);
      if (c.live && !c.live.stopping)
        deadlines.push(c.live.usage.started + c.live.usage.reserved * 1000);
    }
    const next = Math.max(now, Math.min(...deadlines));
    // Storage transactions serialize competing saves; traffic may advance, never defer, an alarm.
    await this.ctx.storage.transaction(async (tx) => {
      const existing = await tx.getAlarm();
      if (existing === null || next < existing) await tx.setAlarm(next);
    });
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
    const auth = await this.env.ASSISTANT_AUTH.getByName(c.authId).material();
    if (auth.principal !== c.principal)
      throw new AssistantError("identity_changed", 403);
    const key = auth.material.appKey;
    if (key.length !== 2) throw new AssistantError("invalid_delegation", 401);
    const identity = restoreKinicIdentity(
      { ...auth.material, appKey: [key[0], key[1]] },
      this.env.ASSISTANT_DERIVATION_ORIGIN,
      Date.now(),
    );
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
      voice: c.live ? (c.live.stopping ? "stopping" : "connected") : "off",
      progress: c.pending
        ? { calls: c.pending.tools.calls, stage: c.pending.stage }
        : null,
    };
  }
  private broadcast(): void {
    const c = this.state.conversation;
    const payload = JSON.stringify(
      c ? { type: "snapshot", ...this.snapshot(c) } : { type: "ended" },
    );
    for (const socket of this.ctx.getWebSockets()) {
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
            consent: z.literal("2026-09-14"),
          })
          .strict()
          .parse(await readJson(request));
        if (this.state.conversation)
          throw new AssistantError("conversation_already_active", 409);
        if (this.state.cleanup.length)
          throw new AssistantError("cleanup_pending", 409);
        const c: Conversation = {
          id: crypto.randomUUID(),
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
      await (await this.reader(c)).authorize();
      if (this.state.conversation !== c)
        throw new AssistantError("conversation_ended", 410);
      c.seen = Date.now();
      if (
        path === "/events" &&
        request.headers.get("upgrade") === "websocket"
      ) {
        if (this.ctx.getWebSockets().length >= 2)
          throw new AssistantError("connection_limit", 429);
        const pair = new WebSocketPair();
        this.ctx.acceptWebSocket(pair[1]);
        pair[1].serializeAttachment({ conversationId: c.id, authId });
        pair[1].send(JSON.stringify({ type: "snapshot", ...this.snapshot(c) }));
        await this.save();
        return new Response(null, { status: 101, webSocket: pair[0] });
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
      if (path === "/voice" && request.method === "POST") {
        const { sdp } = z
          .object({ sdp: z.string().min(1).max(60000) })
          .strict()
          .parse(await readJson(request));
        return json(await this.startVoice(c, sdp), 201);
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
      requestId: input.requestId,
      question: input.question,
      answer: null,
      error: null,
    });
    await this.save();
    this.broadcast();
    this.ctx.waitUntil(this.pump());
  }
  private valid(c: Conversation, p: Pending): boolean {
    return (
      this.state.conversation === c &&
      c.pending === p &&
      c.generation === p.generation
    );
  }
  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    const startedConversation = this.state.conversation;
    const startedPending = startedConversation?.pending;
    try {
      const c = this.state.conversation;
      const p = c?.pending;
      if (!c || !p || !this.valid(c, p)) return;
      const api = client(this.env.OPENAI_API_KEY);
      if (Date.now() - p.started > this.limits().turnMs) {
        c.error = "turn_timeout";
        await this.cancel(c);
        return;
      }
      await (await this.reader(c)).authorize();
      if (!this.valid(c, p)) return;
      const input = inputText(
        p.input.requestId,
        p.input.question,
        c.scope,
        p.input.selectedPath,
      );
      if (p.stage === "new") {
        p.stage = c.sessionId ? "sending" : "creating";
        await this.save();
        if (!c.sessionId) {
          const result = await createAgent(api, c.id, p.input.requestId, input);
          if (!this.valid(c, p)) {
            const uncertain = this.state.cleanup.find(
              (task) =>
                task.conversationId === c.id &&
                task.requestId === p.input.requestId &&
                task.unknownCreate,
            );
            if (uncertain) {
              uncertain.sessionId = result.id;
              uncertain.unknownCreate = false;
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
        if (!this.valid(c, p)) return;
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
      if (!this.valid(c, p)) return;
      const userMessage = items.find(
        (item) =>
          item.type === "message" &&
          item.role === "user" &&
          messageText(item) === input,
      );
      if (!userMessage) return; // Ambiguous input submission: reconcile, never resubmit.
      p.turnId = userMessage.turn_id;
      const session = await api.beta.agents.sessions.retrieve(sessionId);
      if (!this.valid(c, p)) return;
      if (session.status === "failed")
        throw new AssistantError("agent_failed", 502);
      for (const action of session.required_actions) {
        if (!this.valid(c, p)) return;
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
          if (!this.valid(c, p)) return;
          result = { arguments: signature, output };
          p.results[action.call_id] = result;
          await this.save();
          this.broadcast();
        }
        await (await this.reader(c)).authorize();
        if (!this.valid(c, p)) return;
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
      if (!this.valid(c, p)) return;
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
      if (!this.valid(c, p)) return;
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
            this.sendLive({
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
      if (!c || !startedPending || !this.valid(c, startedPending)) return;
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
        if (error instanceof OpenAI.APIError && c.pending?.stage === "creating")
          c.pending.stage = "running";
        c.error = "agent_response_unavailable";
        await this.cancel(c);
      } else if (c?.pending) {
        // Network errors are reconciled by the alarm, without duplicate input submission.
        c.error = "checking_request_status";
        await this.save();
        this.broadcast();
      }
    } finally {
      this.pumping = false;
    }
  }
  private async cancel(c: Conversation): Promise<void> {
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
      unknownCreate: c.pending?.stage === "creating" && !c.sessionId,
      requestId: c.pending?.input.requestId,
      liveId: null,
    });
    c.sessionId = null;
    c.pending = null;
    c.status = "cancelling";
    this.sendLive({
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
  async endOwned(authId: string, conversationId?: string): Promise<void> {
    const c = this.state.conversation;
    if (
      !c ||
      c.authId !== authId ||
      (conversationId !== undefined && conversationId !== c.id)
    )
      return;
    c.generation++;
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
    for (const ws of this.ctx.getWebSockets())
      ws.close(1000, "Conversation ended");
    await this.cleanup();
  }
  private async cleanup(): Promise<void> {
    const api = client(this.env.OPENAI_API_KEY);
    for (const task of [...this.state.cleanup]) {
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
          const seconds = await this.closeSocketSession(ws);
          if (task.voiceUsage) this.settleVoice(task.voiceUsage, seconds);
          task.liveId = null;
        }
        this.state.cleanup = this.state.cleanup.filter((item) => item !== task);
      } catch (error) {
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
  async alarm(): Promise<void> {
    const c = this.state.conversation;
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
        await (await this.reader(c)).authorize();
        if (this.state.conversation !== c) return;
      } catch {
        await this.endOwned(c.authId, c.id);
        return;
      }
      if (c.live?.id && !c.live.stopping) {
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
    if (this.state.cleanup.length) await this.cleanup();
    if (
      !this.state.conversation &&
      !this.state.cleanup.length &&
      this.state.day !== day()
    ) {
      await this.ctx.storage.deleteAll();
      this.state.questions = 0;
      this.state.voiceSeconds = 0;
      this.state.day = day();
    } else await this.save();
  }
  async webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    if (message !== "heartbeat") {
      ws.close(1008, "Unsupported message");
      return;
    }
    const c = this.state.conversation;
    const attachment = ws.deserializeAttachment() as {
      conversationId: string;
      authId: string;
    } | null;
    if (
      !c ||
      attachment?.conversationId !== c.id ||
      attachment.authId !== c.authId
    ) {
      ws.close(1008, "Conversation ended");
      return;
    }
    try {
      await (await this.reader(c)).authorize();
      c.seen = Date.now();
      await this.save();
    } catch {
      await this.endOwned(c.authId);
    }
  }
  async webSocketClose(ws: WebSocket): Promise<void> {
    ws.close();
    await this.save();
  }
  async webSocketError(ws: WebSocket): Promise<void> {
    ws.close(1011, "Connection failed");
    await this.save();
  }

  private async startVoice(c: Conversation, sdp: string) {
    if (c.live || c.pending || c.status !== "ready")
      throw new AssistantError("voice_or_turn_in_progress", 409);
    this.resetDay();
    const limits = this.limits();
    const reserved = Math.min(
      limits.connectionSeconds,
      limits.voiceSeconds - this.state.voiceSeconds,
    );
    if (reserved < 15) throw new AssistantError("voice_limit", 429);
    this.state.voiceSeconds += reserved;
    c.activity = Date.now();
    const usage: VoiceUsage = {
      started: Date.now(),
      reserved,
      usageDay: this.state.day,
      settled: false,
    };
    c.live = { id: null, usage, stopping: false };
    c.transcripts = [];
    c.delegations = [];
    await this.save();
    try {
      const result = await client(this.env.OPENAI_API_KEY).live.create({
        session: {
          model: "gpt-live-1",
          instructions: voiceInstructions,
          delegation: { type: "client" },
          store: false,
          client: {
            data_channel: {
              allowed_client_events: ["session.close"],
              allowed_server_events: [
                "session.started",
                "session.closed",
                "session.input_transcript.delta",
                "session.output_transcript.delta",
                "error",
              ].map((type) => ({ type })),
            },
          },
        },
        transport: { type: "webrtc", sdp },
      });
      if (this.state.conversation !== c || !c.live) {
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
      return { sdp: result.transport.sdp };
    } catch {
      if (c.live?.id) await this.stopVoice(c);
      else {
        c.live = null;
        await this.save();
      } // Keep the reservation if creation outcome is unknown.
      throw new AssistantError("voice_connection_failed", 502);
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
    if (!id) return;
    if (this.sidebandId === id && this.sideband?.readyState === WebSocket.OPEN)
      return;
    this.sideband?.close();
    const ws = await attachLive(this.env.OPENAI_API_KEY!, id);
    if (this.state.conversation !== c || c.live?.id !== id) {
      ws.send(JSON.stringify({ type: "session.close" }));
      ws.close();
      return;
    }
    this.sideband = ws;
    this.sidebandId = id;
    ws.addEventListener("message", (event) => {
      if (typeof event.data === "string")
        this.ctx.waitUntil(this.liveEvent(c, id, event.data));
    });
    ws.addEventListener("close", () => {
      if (this.sideband === ws) {
        this.sideband = null;
        this.sidebandId = null;
      }
    });
    ws.addEventListener("error", () => {
      ws.close();
    });
    this.sendLive({
      type: "session.thinking.append",
      event_id: crypto.randomUUID(),
      delegation_id: null,
      content: `Selected Wiki scope: ${c.scope}. Use the backend for every Wiki claim.`,
    });
  }
  private sendLive(value: unknown): void {
    if (this.sideband?.readyState === WebSocket.OPEN)
      this.sideband.send(JSON.stringify(value));
  }
  private async liveEvent(
    c: Conversation,
    id: string,
    data: string,
  ): Promise<void> {
    if (
      this.state.conversation !== c ||
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
    if (c.live.stopping) return;
    if (
      (event.type === "session.input_transcript.delta" ||
        event.type === "session.output_transcript.delta") &&
      typeof event.delta === "string" &&
      typeof event.start_ms === "number" &&
      typeof event.end_ms === "number"
    ) {
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
        await this.stopVoice(c);
        return;
      }
      await this.save();
    }
    if (event.type === "session.delegation.created") {
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
        question: `音声会話の最新の質問・訂正に答えてください。曖昧なら確認してください。\n${transcript.slice(-3600)}`,
      },
      id,
    );
  }
  private finishVoice(c: Conversation, reportedSeconds?: unknown): void {
    const live = c.live;
    if (!live) return;
    this.settleVoice(live.usage, reportedSeconds);
    c.live = null;
    c.deferred = null;
    c.transcripts = [];
    c.delegations = [];
    this.sideband?.close();
    this.sideband = null;
    this.sidebandId = null;
  }
  private settleVoice(usage: VoiceUsage, reportedSeconds?: unknown): void {
    if (usage.settled) return;
    usage.settled = true;
    const seconds =
      typeof reportedSeconds === "number" &&
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
  private async closeSocketSession(ws: WebSocket): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        ws.removeEventListener("message", handler);
        ws.close();
        reject(new Error("voice_close_unconfirmed"));
      }, 5000);
      const handler = (event: MessageEvent) => {
        if (typeof event.data !== "string") return;
        let seconds: unknown;
        try {
          const data = JSON.parse(event.data);
          if (data.type !== "session.closed") return;
          seconds = data.usage?.seconds;
        } catch {
          return;
        }
        clearTimeout(timer);
        ws.removeEventListener("message", handler);
        ws.close();
        resolve(seconds);
      };
      ws.addEventListener("message", handler);
      try {
        ws.send(JSON.stringify({ type: "session.close" }));
      } catch (error) {
        clearTimeout(timer);
        ws.removeEventListener("message", handler);
        ws.close();
        reject(error);
      }
    });
  }
  private async stopVoice(
    c: Conversation,
    cancelPending = true,
  ): Promise<void> {
    if (!c.live) return;
    c.live.stopping = true;
    c.deferred = null;
    await this.save();
    this.broadcast();
    if (cancelPending && c.pending?.delegationId) await this.cancel(c);
    if (c.live?.id) {
      try {
        await this.ensureSideband(c);
        if (!this.sideband) throw new Error("voice_close_unconfirmed");
        const seconds = await this.closeSocketSession(this.sideband);
        this.finishVoice(c, seconds);
      } catch (error) {
        if (
          error instanceof AssistantError &&
          error.code === "voice_session_gone"
        )
          this.finishVoice(c);
        else c.error = "voice_close_pending";
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
      ? "注意：根拠不足・矛盾・未確認事項があります。画面の詳細を確認してください。\n"
      : "詳細と出典は画面で確認できます。\n";
  const encoder = new TextEncoder();
  let content = caveat;
  for (const character of answer.answer) {
    if (encoder.encode(content + character).length > 450) break;
    content += character;
  }
  return content;
}
