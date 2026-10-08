import { sha256 } from "@kinic/ii-server/crypto";
import { AssistantAuth } from "./auth";
import { failureKind } from "./failure";
import { AssistantStore } from "./store";
import { Leases, type Lease, RENEW_MS } from "./leases";
import { z } from "zod";
import { restoreKinicIdentity } from "@kinic/ii-server/internet-identity";
import {
  AssistantError,
  DEFAULT_LIMITS,
  questionSchema,
  scopeSchema,
  type QuestionSubject,
} from "./contracts";
import {
  createReadActor,
  emptyToolState,
  KinicReader,
} from "./kinic";
import {
  cancelAgent,
  client,
  deleteAgent,
} from "./openai";
import {
  boundedRoutingHistory,
  clarificationFor,
  routeAskAiIntent,
  type AskAiRoute,
} from "./routing";
import { failure, json, readJson } from "./http";
import { requireEnabled } from "./auth";
import type { Env } from "./env";

import { runTextTurn, textTurnFailure } from "./text-turn";
import { runAgentTurn, agentTurnFailure } from "./agent-turn";
import type { TurnContext, TurnResult } from "./turn-context";

import type { Question, Pending, Conversation, UserState } from "./state";
import { boundedHistoryPage, type HistoryEntry } from "./history-page";
export type { UserState } from "./state";

const day = () => new Date().toISOString().slice(0, 10);
const safeJson = (value: string): unknown => {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
};

function questionSubject(
  input: Question,
  selectedPath?: string,
): QuestionSubject {
  if (input.subject) return input.subject;
  const path = input.selectedPath ?? selectedPath;
  return path ? { kind: "node", path } : { kind: "database" };
}

function traceFor(
  pending: Pending,
  route: AskAiRoute | "clarification",
): NonNullable<Conversation["messages"][number]["trace"]> {
  return {
    route,
    calls: pending.tools.calls,
    characters: pending.tools.characters,
    inventoryObserved: pending.tools.inventoryObserved,
    inventoryTruncated: pending.tools.inventoryTruncated,
    readCount: pending.tools.readPaths.length,
    jevRouteDurationMs: pending.tools.jevRouteDurationMs,
    jevRerankDurationMs: pending.tools.jevRerankDurationMs,
  };
}
export class AssistantUser {
  private state!: UserState;
  private revision = 0;
  private pumping = false;
  private textAbort: AbortController | null = null;
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
  private loadedMessages = true;
  private nextStatePoll = 0;
  private controlResponses = 0;
  private broadcastDeferred = false;
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
  async initialize(includeMessages = true) {
    this.loadedMessages = includeMessages;
    const loaded = await this.store.load(this.principal, includeMessages);
    this.state = loaded.state;
    this.revision = loaded.revision;
    this.state.cleanup = this.state.cleanup.filter((task) => !task.liveId && !task.voiceUsage);
    const stored = this.state.conversation;
    if (stored && (stored.live || stored.pending?.delegationId ||
      (stored.native && stored.nativeTextProvider !== "deepseek"))) {
      // Retired voice state is dropped locally; no provider termination or billing.
      this.state.conversation = null;
    }
    // Format 3 adds semantic routing and retrieval traces. Retire earlier
    // temporary sessions once. Native sessions must use the current provider
    // contract; retire legacy native sessions before reconnecting to DeepSeek.
    if (
      this.state.conversation &&
      this.state.conversation.format !== 3
    ) {
      await this.endOwned(this.state.conversation.authId, this.state.conversation.id);
    }
    this.nextWake = this.wakeDeadline();
    if (this.state.endRequested !== undefined && this.state.conversation)
      await this.endOwned(
        this.state.conversation.authId,
        this.state.conversation.id,
      );
    return this;
  }
  private async save(): Promise<void> {
    // Partial metadata/history readers must never replace persisted messages.
    if (!this.loadedMessages && this.state.conversation)
      throw new AssistantError("partial_state_write", 500);
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
    }
    if (c) {
      deadlines.push(c.activity + limits.idleMs, c.seen + limits.reconnectMs);
      if (c.pending)
        deadlines.push(now + 1000, c.pending.started + limits.turnMs);
    }
    return Math.max(now, Math.min(...deadlines));
  }
  private limits() {
    return DEFAULT_LIMITS;
  }
  private resetDay(): void {
    if (this.state.day !== day()) {
      this.state.day = day();
      this.state.questions = 0;
      }
  }
  private current(): Conversation {
    const c = this.state.conversation;
    if (!c) throw new AssistantError("conversation_ended", 410);
    return c;
  }
  private async identity(c: Conversation) {
    const auth = await new AssistantAuth(this.env, c.authId).material();
    if (auth.principal !== c.principal)
      throw new AssistantError("identity_changed", 403);
    const key = auth.material.appKey;
    if (key.length !== 2) throw new AssistantError("invalid_delegation", 401);
    return restoreKinicIdentity(
      { ...auth.material, appKey: [key[0], key[1]] },
      this.env.ASSISTANT_DERIVATION_ORIGIN,
      Date.now(),
    );
  }
  private async reader(
    c: Conversation,
    tools = emptyToolState(),
    route?: AskAiRoute,
  ): Promise<KinicReader> {
    const identity = await this.identity(c);
    return new KinicReader(
      createReadActor(this.env.KINIC_WIKI_CANISTER_ID, identity, {
        verifyQuerySignatures: !c.native,
      }),
      c.databaseId,
      c.scope,
      tools,
      this.limits().characters,
      this.limits().calls,
      this.env.TYPESAFE_API_KEY!,
      route,
      // Each native tool's actual canister read enforces current DB access.
      // Metadata/history, heartbeat and answer publication still authorize().
      !c.native,
    );
  }
  private snapshot(c: Conversation) {
    return {
      revision: c.viewRevision ?? this.revision,
      id: c.id,
      databaseId: c.databaseId,
      scope: c.scope,
      status: c.status,
      error: c.error,
      generation: c.generation,
      reconnectGraceMs: this.limits().reconnectMs,
      // Older native clients still require these snapshot fields.
      voice: "off",
      voiceDeadline: null,
      voiceId: null,
      progress: c.pending
        ? { calls: c.pending.tools.calls, stage: c.pending.stage }
        : null,
    };
  }
  private historyPage(c: Conversation, revision: number, cursor: number) {
    if (revision !== (c.viewRevision ?? this.revision)) throw new AssistantError("stale_state", 409);
    const entries: HistoryEntry[] = [
      ...c.messages.map((value) => ({ kind: "message" as const, value })),
      ...c.utterances.map(({ id, role, text }) => ({
        kind: "utterance" as const, value: { id, role, text },
      })),
    ];
    return boundedHistoryPage(revision, cursor, entries.length, entries.slice(cursor, cursor + 10));
  }

  private broadcast(): void {
    if (this.controlResponses) {
      this.broadcastDeferred = true;
      return;
    }
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
            consent: z.literal(request.headers.get("x-assistant-client") === "native" ? "2026-09-29" : "2026-09-22"),
            selectedPath: z.string().max(512).optional(),
            history: z.array(z.object({role: z.enum(["user", "assistant"]), text: z.string().max(4000)}).strict()).max(20).refine((items) => new TextEncoder().encode(JSON.stringify(items)).length <= 12000).default([]),
          })
          .strict()
          .parse(await readJson(request));
        if (this.state.conversation)
          throw new AssistantError("conversation_already_active", 409);
        if (this.state.cleanup.length)
          throw new AssistantError("cleanup_pending", 409);
        if (request.headers.get("x-assistant-client") === "native" && !this.env.DEEPSEEK_API_KEY)
          throw new AssistantError("assistant_not_configured", 503);
        const c: Conversation = {
          format: 3,
          id: crypto.randomUUID(),
          native: request.headers.get("x-assistant-client") === "native",
          nativeTextProvider: request.headers.get("x-assistant-client") === "native" ? "deepseek" : undefined,
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
        await this.store.touch(this.principal, c.id);
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
        if (this.sockets.length >= 2)
          throw new AssistantError("connection_limit", 429);
        return await this.openControl(c);
      }
      if (path === "/conversation" && request.method === "GET") {
        await this.store.touch(this.principal, c.id);
        const snapshot = this.snapshot(c);
        const query = new URL(request.url).searchParams;
        if (query.get("includeHistory") === "1" && query.get("knownRevision") !== String(snapshot.revision)) {
          const historyPage = this.loadedMessages
            ? this.historyPage(c, snapshot.revision, 0)
            : await this.store.historyPage(this.principal, c, snapshot.revision, 0, this.revision);
          return json({ ...snapshot, historyPage });
        }
        return json(snapshot);
      }
      if (path === "/history" && request.method === "GET") {
        const url = new URL(request.url);
        const revision = Number(url.searchParams.get("revision"));
        const cursorValue = url.searchParams.get("cursor") ?? "0";
        if (!Number.isSafeInteger(revision) || !/^\d+$/.test(cursorValue))
          throw new AssistantError("invalid_cursor", 400);
        if (revision !== (c.viewRevision ?? this.revision)) throw new AssistantError("stale_state", 409);
        return json(this.loadedMessages
          ? this.historyPage(c, revision, Number(cursorValue))
          : await this.store.historyPage(this.principal, c, revision, Number(cursorValue), this.revision));
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
    this.textAbort?.abort();
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
      route: "pending",
    };
    c.messages.push({
      voice: delegationId !== null,
      requestId: input.requestId,
      question: input.question,
      answer: null,
      error: null,
      kind: null,
      trace: null,
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
      if (Date.now() - p.started > this.limits().turnMs) {
        c.error = "turn_timeout";
        await this.cancel(c);
        return;
      }
      if (c.native && !p.delegationId && c.nativeTextProvider !== "deepseek")
        throw new AssistantError("consent_required", 409);
      await (await this.reader(c)).authorize();
      if (!(await this.valid(c, p))) return;
      const subject = questionSubject(p.input, c.selectedPath);
      const route = await this.routeTurn(c, p, subject);
      if (!route) return;
      const context: TurnContext = {
        conversation: c,
        pending: p,
        route,
        subject,
        valid: () => this.valid(c, p),
        reader: (tools, route) => this.reader(c, tools, route),
        checkpoint: async () => {
          await this.save();
          this.broadcast();
        },
      };
      const result = await this.runTurn(context);
      if (!result) return; // Agents may still be running or reconciling submission.
      await this.publishTurn(context, result);
    } catch (error) {
      const c = startedConversation;
      console.error(JSON.stringify({ event: "assistant_turn_failure", kind: failureKind(error),
        code: error instanceof AssistantError ? error.code : "turn_failed" }));
      if (!c || !startedPending || !(await this.valid(c, startedPending)))
        return;
      if (c && error instanceof AssistantError) {
        c.error = error.code;
        if (error.status === 401 || error.status === 403)
          await this.endOwned(c.authId);
        else await this.cancel(c);
      } else {
        const failure = this.isTextTurn(c, startedPending)
          ? textTurnFailure(error)
          : await agentTurnFailure(error, {
              conversation: c,
              pending: startedPending,
              store: this.store,
              lease: this.questionLease,
            });
        if (!(await this.valid(c, startedPending))) return;
        c.error = failure.code;
        if (failure.action === "cancel") await this.cancel(c, failure.unknownCreate);
        else {
          await this.save();
          this.broadcast();
        }
      }
    } finally {
      clearInterval(renewal);
      await this.leases.release(lease);
      this.questionLease = null;
      this.textAbort = null;
      this.pumping = false;
    }
  }
  private async routeTurn(
    c: Conversation,
    p: Pending,
    subject: QuestionSubject,
  ): Promise<AskAiRoute | undefined> {
    if (p.route !== "pending") return p.route;
    const routingHistory = boundedRoutingHistory([
      ...c.history,
      ...c.messages
        .filter(
          (message) =>
            message.requestId !== p.input.requestId && message.answer !== null,
        )
        .flatMap((message) => [
          { role: "user" as const, text: message.question },
          { role: "assistant" as const, text: message.answer!.answer },
        ]),
    ]);
    const routed = await routeAskAiIntent({
      question: p.input.question,
      subject,
      history: routingHistory,
      apiKey: this.env.TYPESAFE_API_KEY!,
    });
    if (!(await this.valid(c, p))) return;
    p.tools.jevDurationMs += routed.durationMs;
    p.tools.jevRouteDurationMs += routed.durationMs;
    if (!routed.route) {
      const message = c.messages.find(
        (item) => item.requestId === p.input.requestId,
      )!;
      message.kind = "clarification";
      message.answer = {
        answer: clarificationFor(p.input.question),
        citations: [],
        insufficient: false,
        contradictions: [],
        unverified: [],
      };
      message.trace = traceFor(p, "clarification");
      c.pending = null;
      c.status = "ready";
      c.error = null;
      await this.save();
      this.broadcast();
      console.log(
        JSON.stringify({
          event: "assistant_clarification",
          route: "clarification",
          durationMs: Date.now() - p.started,
          jevRouteDurationMs: p.tools.jevRouteDurationMs,
        }),
      );
      return;
    }
    p.route = routed.route;
    if (
      p.route === "selected_node_summary" &&
      subject.kind !== "database" &&
      !p.tools.discoveredPaths.includes(subject.path)
    )
      p.tools.discoveredPaths.push(subject.path);
    await this.save();
    return p.route;
  }
  private async publishTurn(context: TurnContext, result: TurnResult): Promise<void> {
    const { conversation: c, pending: p } = context;
    const { answer, inputTokens, outputTokens } = result;
    await (await this.reader(c)).authorize();
    if (!(await this.valid(c, p))) return;
    const message = c.messages.find(
      (item) => item.requestId === p.input.requestId,
    )!;
    message.answer = answer;
    message.kind =
      p.route === "conversation" ? "conversation" : "grounded_answer";
    message.trace = traceFor(p, context.route);
    c.pending = null;
    c.status = "ready";
    c.error = null;
    await this.save();
    this.broadcast();
    console.log(
      JSON.stringify({
        event: "assistant_answer",
        route: p.route,
        durationMs: Date.now() - p.started,
        calls: p.tools.calls,
        characters: p.tools.characters,
        jevDurationMs: p.tools.jevDurationMs,
        jevRouteDurationMs: p.tools.jevRouteDurationMs,
        jevRerankDurationMs: p.tools.jevRerankDurationMs,
        inputTokens,
        outputTokens,
        providerDurationMs: result.providerDurationMs,
        retrievalDurationMs: result.retrievalDurationMs,
        authorizationDurationMs: result.authorizationDurationMs,
        providerRounds: result.providerRounds,
      }),
    );
  }
  private isTextTurn(c: Conversation, p: Pending): boolean {
    return c.native === true && p.delegationId === null;
  }
  private async runTurn(context: TurnContext): Promise<TurnResult | undefined> {
    const { conversation: c, pending: p } = context;
    if (this.isTextTurn(c, p)) {
      this.textAbort = new AbortController();
      return runTextTurn(context, {
        apiKey: this.env.DEEPSEEK_API_KEY,
        deadline: p.started + this.limits().turnMs,
        signal: this.textAbort.signal,
      });
    }
    return runAgentTurn(context, {
      apiKey: this.env.OPENAI_API_KEY,
      principal: this.principal,
      store: this.store,
      orphanCreatedSession: async (sessionId) => {
        const uncertain = this.state.cleanup.find((task) =>
          task.conversationId === c.id &&
          task.requestId === p.input.requestId && task.unknownCreate,
        );
        if (uncertain) {
          uncertain.sessionId = sessionId;
          uncertain.unknownCreate = false;
          uncertain.nextAttempt = 0;
        } else {
          this.state.cleanup.push({ sessionId, conversationId: c.id, unknownCreate: false, liveId: null });
        }
        await this.save();
      },
    });
  }
  private async cancel(
    c: Conversation,
    unknownCreateOverride?: boolean,
  ): Promise<void> {
    this.textAbort?.abort();
    c.generation++;
    if (c.pending) {
      const message = c.messages.find(
        (m) => m.requestId === c.pending?.input.requestId,
      );
      if (message) message.error = c.error ?? "cancel_requested";
    }
    if (c.pending && this.isTextTurn(c, c.pending)) {
      c.pending = null;
      c.status = "ready";
      await this.save();
      this.broadcast();
      return;
    }
    c.deferred = null;
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
    await this.save();
    this.broadcast();
    await this.cleanup();
  }
  async endOwned(
    authId: string,
    conversationId?: string,
  ): Promise<void> {
    const c = this.state.conversation;
    if (
      !c ||
      c.authId !== authId ||
      (conversationId !== undefined && conversationId !== c.id)
    )
      return;
    this.textAbort?.abort();
    c.generation++;
    this.state.cleanup.push({
      sessionId: c.sessionId,
      conversationId: c.id,
      unknownCreate: c.pending?.stage === "creating" && !c.sessionId,
      requestId: c.pending?.input.requestId,
      liveId: null,
    });
    this.state.conversation = null; // Drop transcripts, excerpts, and answers before remote cleanup.
    await this.save();
    this.broadcast();
    for (const ws of this.sockets) ws.close(1000, "Conversation ended");
    await this.cleanup();
  }
  private async cleanup(): Promise<void> {
    for (const task of this.state.cleanup.slice()) {
      if ((task.nextAttempt ?? 0) > Date.now()) continue;
      try {
        if (task.unknownCreate) {
          const api = client(this.env.OPENAI_API_KEY);
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
          const api = client(this.env.OPENAI_API_KEY);
          try {
            await cancelAgent(api, task.sessionId);
          } catch {
            /* Deletion below is authoritative. */
          }
          await deleteAgent(api, task.sessionId);
          task.sessionId = null;
        }
        this.state.cleanup = this.state.cleanup.filter((item) => item !== task);
      } catch {
        task.attempts = (task.attempts ?? 0) + 1;
        task.nextAttempt =
          Date.now() +
          Math.min(1800000, 60000 * 2 ** Math.min(task.attempts - 1, 5));
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
    if (c) {
      try {
        const now = Date.now();
        if (
          now - c.activity >= this.limits().idleMs ||
          now - c.seen >= this.limits().reconnectMs
        ) {
          await this.endOwned(c.authId, c.id);
          return;
        }
        requireEnabled(this.env);
        if (c.pending && now - c.pending.started >= this.limits().turnMs) {
          c.error = "turn_timeout";
          await this.cancel(c);
        }
        if (this.pumping) {
          // The active turn persists its own checkpoints. Re-saving unchanged
          // history every second invalidates revision-bound iOS page requests.
          this.nextWake = now + 5_000;
          await this.store.schedule(this.principal, c.id, this.revision, this.nextWake);
          return;
        }
        await (await this.reader(c)).authorize();
        if (this.state.conversation !== c) return;
      } catch (error) {
        console.error(JSON.stringify({ event: "assistant_authorization_failure", kind: failureKind(error),
          code: error instanceof AssistantError ? error.code : "authorization_unavailable" }));
        if (error instanceof AssistantError && (error.status === 401 || error.status === 403 || error.code === "assistant_disabled")) {
          await this.endOwned(c.authId, c.id);
        } else {
          this.nextWake = Date.now() + 5_000;
          await this.store.schedule(this.principal, c.id, this.revision, this.nextWake);
        }
        return;
      }
      if (c.pending) await this.pump();
    }
    if (this.state.cleanup.length) await this.cleanup();
    if (
      !this.state.conversation &&
      !this.state.cleanup.length &&
      this.state.day !== day()
    ) {
      await this.store.db
        .prepare("DELETE FROM assistant_cleanup WHERE principal=?")
        .bind(this.principal)
        .run();
      this.state.questions = 0;
      this.state.day = day();
    } else if (this.state.conversation && !this.state.conversation.pending && !this.state.cleanup.length) {
      // Idle maintenance changes no answer or control state. Updating its wake
      // time must not re-encrypt all messages or invalidate history revisions.
      this.nextWake = this.wakeDeadline();
      await this.store.schedule(this.principal, this.state.conversation.id, this.revision, this.nextWake);
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
            if (!ok) {
              pair[1].close(1008, "Connection lease expired");
              close();
            }
          }).catch(() => {
            pair[1].close(1011, "Reconnect required");
            close();
          }),
        ),
      RENEW_MS,
    );
    const pair = new WebSocketPair();
    pair[1].accept();
    this.sockets.push(pair[1]);
    pair[1].addEventListener("message", (event) =>
      this.background(this.controlMessage(pair[1], c, event.data).catch((error) => {
        console.error(JSON.stringify({ event: "assistant_control_failure",
          kind: failureKind(error),
          code: error instanceof AssistantError ? error.code : "connection_failed" }));
        pair[1].close(1011, "Reconnect required");
        close();
      })),
    );
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      this.sockets = [];
      clearInterval(this.timer);
      clearInterval(this.connectionRenewal);
      this.background(this.leases.release(lease));
      this.connectionLease = null;
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
      if (Date.now() < this.nextStatePoll) {
        if (Date.now() >= this.nextWake) await this.tick();
        return;
      }
      this.nextStatePoll = Date.now() + 5_000;
      const expectedRevision = this.revision;
      const current = await this.store.db
        .prepare("SELECT revision FROM assistant_users WHERE principal=?")
        .bind(this.principal)
        .first<{ revision: number }>();
      if (current && current.revision !== this.revision) {
        const loaded = await this.store.load(this.principal);
        if (this.revision !== expectedRevision) return;
        this.state = loaded.state;
        this.revision = loaded.revision;
        this.broadcast();
      }
      if (Date.now() >= this.nextWake) await this.tick();
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
    let deferringBroadcast = false;
    try {
      if (typeof message !== "string" || message.length > 65536)
        throw new AssistantError("invalid_command", 400);
      const command = z
        .object({
          type: z.literal("command"),
          requestId: z.string().uuid(),
          action: z.enum([
            "questions",
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
      // iOS consumes messages sequentially and loads history for snapshots.
      // A snapshot before this reply can strand the accepted command behind
      // a failing history read and turn it into a networkConnectionLost error.
      this.controlResponses++;
      deferringBroadcast = true;
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
      const responseBody = await response.json();
      const result = {
        status: response.status,
        body:
          response.ok ? { revision: c.viewRevision ?? this.revision } : responseBody,
      };
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
    } finally {
      if (deferringBroadcast) {
        this.controlResponses--;
        if (!this.controlResponses && this.broadcastDeferred) {
          this.broadcastDeferred = false;
          this.broadcast();
        }
      }
    }
  }
}
