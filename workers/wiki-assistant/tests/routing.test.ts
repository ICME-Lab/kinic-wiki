import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ASK_AI_ROUTING_HISTORY_CHARACTERS,
  ASK_AI_ROUTING_HISTORY_MESSAGES,
  ASK_AI_ROUTE_MARGIN,
  ASK_AI_ROUTE_MINIMUM,
  boundedRoutingHistory,
  clarificationFor,
  routeAskAiIntent,
} from "../src/routing";

const routeResponse = (values: Record<string, number>) =>
  new Response(
    JSON.stringify({
      answers: Object.fromEntries(
        Object.entries(values).map(([key, noul]) => [
          key,
          { type: "noul", noul },
        ]),
      ),
    }),
  );

afterEach(() => vi.unstubAllGlobals());

describe("Jev semantic routing", () => {
  it("routes a database-wide Japanese question to overview", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        routeResponse({
          database_overview: 0.95,
          focused_search: 0.1,
          selected_node_summary: 0.05,
          conversation: 0.03,
        }),
      ),
    );
    await expect(
      routeAskAiIntent({
        question: "これどんな内容がある？",
        subject: { kind: "database" },
        apiKey: "key",
      }),
    ).resolves.toMatchObject({ route: "database_overview" });
  });

  it("sends only bounded recent conversation text for contextual routing", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      routeResponse({
        database_overview: 0.05,
        focused_search: 0.05,
        selected_node_summary: 0.05,
        conversation: 0.95,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const history = Array.from({ length: 10 }, (_, index) => ({
      role: index % 2 ? ("assistant" as const) : ("user" as const),
      text: `${index}:` + "x".repeat(900),
    }));

    await routeAskAiIntent({
      question: "それを英訳して",
      subject: { kind: "database" },
      history,
      apiKey: "key",
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]?.body));
    const sent = body.state.recent_conversation as { role: string; text: string }[];
    expect(sent.length).toBeLessThanOrEqual(ASK_AI_ROUTING_HISTORY_MESSAGES);
    expect(sent.at(-1)?.text).toMatch(/^9:/);
    expect(sent.reduce((total, item) => total + Array.from(item.text).length, 0)).toBe(
      ASK_AI_ROUTING_HISTORY_CHARACTERS,
    );
    expect(JSON.stringify(body)).not.toContain("citationId");
  });

  it("preserves chronological order after dropping older routing history", () => {
    expect(
      boundedRoutingHistory(
        Array.from({ length: 8 }, (_, index) => ({
          role: "user" as const,
          text: String(index),
        })),
      ).map((item) => item.text),
    ).toEqual(["2", "3", "4", "5", "6", "7"]);
  });

  it.each([
    ["focused_search", "承認済みの公開日は？", { kind: "database" }],
    [
      "selected_node_summary",
      "このページを要約して",
      { kind: "node", path: "/Knowledge/release.md" },
    ],
    ["conversation", "こんにちは", { kind: "database" }],
  ] as const)("routes a confident %s classification", async (expected, question, subject) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        routeResponse({
          database_overview: 0.04,
          focused_search: expected === "focused_search" ? 0.96 : 0.04,
          selected_node_summary:
            expected === "selected_node_summary" ? 0.96 : 0.04,
          conversation: expected === "conversation" ? 0.96 : 0.04,
        }),
      ),
    );
    await expect(
      routeAskAiIntent({ question, subject, apiKey: "key" }),
    ).resolves.toMatchObject({ route: expected });
  });

  it("returns an ambiguous route below the confidence or margin boundary", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        routeResponse({
          database_overview: ASK_AI_ROUTE_MINIMUM,
          focused_search:
            ASK_AI_ROUTE_MINIMUM - ASK_AI_ROUTE_MARGIN + 0.01,
          selected_node_summary: 0.05,
          conversation: 0.03,
        }),
      ),
    );
    await expect(
      routeAskAiIntent({
        question: "これを見て",
        subject: { kind: "database" },
        apiKey: "key",
      }),
    ).resolves.toMatchObject({ route: null });
  });

  it("fails closed when Jev is unavailable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("busy", { status: 529 })),
    );
    await expect(
      routeAskAiIntent({
        question: "what is recorded?",
        subject: { kind: "database" },
        apiKey: "key",
      }),
    ).rejects.toThrow("jev_unavailable");
  });

  it("returns localized clarification text", () => {
    expect(clarificationFor("これを見て")).toContain("DB全体");
    expect(clarificationFor("take a look at this")).toContain("whole database");
  });
});
