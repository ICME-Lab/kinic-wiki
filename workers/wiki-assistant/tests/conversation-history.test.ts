import { describe, expect, it } from "vitest";
import { conversationHistory } from "../src/conversation-history";
import type { Conversation } from "../src/state";

function message(id: string, answer: string | null, error: string | null = null): Conversation["messages"][number] {
  return { requestId: id, voice: false, question: id, error, kind: null, trace: null,
    answer: answer === null ? null : { answer, citations: [], insufficient: false, contradictions: [], unverified: [] } };
}
describe("provider handoff history", () => {
  it("includes completed dialogue but excludes unfinished, failed and current requests", () => {
    const result = conversationHistory({ history: [{ role: "user", text: "Initial" }], messages: [
      message("typed", "Friday"), message("unfinished", null), message("failed", "Not usable", "cancel_requested"), message("current", "Exclude"),
    ] }, "current");
    expect(result).toEqual([{ role: "user", text: "Initial" }, { role: "user", text: "typed" }, { role: "assistant", text: "Friday" }]);
  });
  it("keeps the most recent six messages", () => {
    const result = conversationHistory({ history: [], messages: Array.from({ length: 10 }, (_, i) => message(`q${i}`, `a${i}`)) });
    expect(result.map((item) => item.text)).toEqual(["q7", "a7", "q8", "a8", "q9", "a9"]);
  });
  it("caps multibyte dialogue at 4,000 Unicode characters", () => {
    const result = conversationHistory({ history: [], messages: [message("long", "😀".repeat(5000))] });
    expect(result.reduce((sum, item) => sum + Array.from(item.text).length, 0)).toBe(4000);
    expect(result[0].text).toBe("😀".repeat(4000));
  });
});
