import { it, expect, vi } from "vitest";
import { Session } from "../src/session.ts";
it("invalidates pending generations and wipes the raw key on every lock", () => {
  const s = new Session();
  s.raw = new Uint8Array(32).fill(7);
  const raw = s.raw,
    g = s.capture();
  s.lock();
  expect(raw.every((x) => x === 0)).toBe(true);
  expect(s.raw).toBeUndefined();
  expect(() => s.check(g)).toThrow("Locked");
});
it("recomputes inactivity and hidden deadlines on resume", () => {
  let time = 1000;
  const spy = vi.spyOn(Date, "now").mockImplementation(() => time);
  try {
    const s = new Session(),
      g = s.capture();
    s.visible(true);
    time += 60000;
    s.visible(false);
    expect(() => s.check(g)).toThrow("Locked");
    const next = s.capture();
    time += 300000;
    s.activity();
    expect(() => s.check(next)).toThrow("Locked");
  } finally {
    spy.mockRestore();
  }
});
it("keeps the hidden-tab deadline armed when a new generation starts while hidden", () => {
  let time = 1000;
  const spy = vi.spyOn(Date, "now").mockImplementation(() => time);
  try {
    const session = new Session();
    session.visible(true);
    session.lock();
    const generation = session.capture();
    time += 60000;
    expect(() => session.check(generation)).toThrow("Locked");
  } finally {
    spy.mockRestore();
  }
});
it("wipes keys and continues cleanup even when a detached UI cleanup throws", () => {
  const s = new Session(),
    raw = new Uint8Array(32).fill(9),
    done = vi.fn();
  s.raw = raw;
  s.root = {} as CryptoKey;
  s.addLockCleanup(() => {
    throw Error("detached");
  });
  s.addLockCleanup(done);
  expect(() => s.lock()).not.toThrow();
  expect(done).toHaveBeenCalled();
  expect(s.raw).toBeUndefined();
  expect(s.root).toBeUndefined();
  expect(raw.every((x) => x === 0)).toBe(true);
});
