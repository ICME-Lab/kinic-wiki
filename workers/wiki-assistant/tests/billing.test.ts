import { beforeEach, expect, it, vi } from "vitest";
import { reserveVoice, VoiceBillingRejected } from "../src/billing";
import type { Env } from "../src/env";

const reserve = vi.hoisted(() => vi.fn());
vi.mock("@icp-sdk/core/agent", () => ({
  Actor: { createActor: () => ({ reserve_voice: reserve }) },
  HttpAgent: { createSync: () => ({}) },
}));
vi.mock("@kinic/ii-server/internet-identity", () => ({ restoreIiKey: () => ({}) }));
const env = { ASSISTANT_BILLING_KEY: "{}", KINIC_WIKI_CANISTER_ID: "canister" } as Env;
beforeEach(() => { reserve.mockReset(); });
it("marks an explicit canister reservation rejection as definitive", async () => {
  reserve.mockResolvedValue({ Err: "insufficient database cycles" });
  await expect(reserveVoice(env, "id", "db", "owner", "1", 60)).rejects.toBeInstanceOf(VoiceBillingRejected);
  await expect(reserveVoice(env, "id", "db", "owner", "1", 60)).rejects.toMatchObject({ code: "voice_balance_insufficient" });
});
it("preserves an ambiguous transport error without marking it as rejection", async () => {
  const error = new Error("update response lost");
  reserve.mockRejectedValue(error);
  await expect(reserveVoice(env, "id", "db", "owner", "1", 60)).rejects.toBe(error);
  expect(error).not.toBeInstanceOf(VoiceBillingRejected);
});
