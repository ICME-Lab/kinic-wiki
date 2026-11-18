import { expect, it } from "vitest";
import { createRecoveryStore } from "../src/recovery-store";
import type { PaymentScope, RecoveryRecord } from "../src/types";

const scope: PaymentScope = {
  origin: "https://wiki.example", host: "https://icp0.io", ledger: "aaaaa-aa", spender: "2vxsx-fae",
  payer: { owner: "aaaaa-aa", provider: "ii" }, target: { kind: "wiki", databaseId: "demo" },
};
const otherPayer: PaymentScope = { ...scope, payer: { owner: "2vxsx-fae", provider: "plug" } };
const record: RecoveryRecord = {
  version: 1, scope, id: "first", stage: "purchase-dispatched", context: { amount: "100000000" },
};

function storageFixture() {
  const data = new Map<string, string>();
  const store = createRecoveryStore({
    getItem: key => data.get(key) ?? null,
    setItem: (key, value) => { data.set(key, value); },
    removeItem: key => { data.delete(key); },
  });
  return { store, data };
}

it("a different funding source sees a conflict only and cannot replace or remove the original", () => {
  const { store } = storageFixture();
  store.put(record);
  expect(store.list(otherPayer)).toEqual([]);
  expect(store.hasTargetConflict(otherPayer)).toBe(true);
  expect(() => store.put({ ...record, scope: otherPayer })).toThrow();
  expect(() => store.remove(otherPayer, record.id)).toThrow();
  expect(store.list(scope)).toEqual([record]);
  const otherHost = { ...otherPayer, host: "https://local.example" };
  expect(store.hasTargetConflict(otherHost)).toBe(false);
  expect(store.list(otherHost)).toEqual([]);
});

it("a second operation cannot overwrite the first even for the same payer", () => {
  const { store } = storageFixture();
  store.put(record);
  expect(() => store.put({ ...record, id: "second" })).toThrow();
  store.remove(scope, "second");
  expect(store.list({ ...scope, host: "HTTPS://ICP0.IO:443/" })).toEqual([record]);
});

it.each([
  "{", JSON.stringify({ ...record, stage: "done" }), JSON.stringify({ ...record, version: 2 }),
  JSON.stringify({ ...record, scope: { ...scope, target: { kind: "wiki", databaseId: "other" } } }),
  JSON.stringify({ ...record, scope: { ...scope, payer: { ...scope.payer, subaccount: "01" } } }),
  JSON.stringify({ ...record, scope: { ...scope, payer: { ...scope.payer, provider: "other" } } }),
  JSON.stringify({ ...record, scope: { ...scope, payer: { ...scope.payer, provider: ["ii"] } } }),
])("corrupt journal entries survive attempts to list, replace, or clear them", raw => {
  const { store, data } = storageFixture();
  store.put(record);
  const key = [...data.keys()][0];
  data.set(key, raw);
  for (const action of [() => store.list(scope), () => store.put(record), () => store.remove(scope, record.id)]) {
    expect(action).toThrow(expect.objectContaining({ code: "StorageUnavailable" }));
  }
  expect(data.get(key)).toBe(raw);
});

it("refuses context values JSON would silently discard or change", () => {
  const { store } = storageFixture();
  for (const context of [{ timestamp: 1n }, { fields: [undefined] }, { receipt: new Set() }, { amount: Infinity }]) {
    expect(() => store.put({ ...record, context })).toThrow();
    expect(store.list(scope)).toEqual([]);
  }
});

it("a stale writer cannot replace a purchase marker with a payable quote", () => {
  const { store } = storageFixture();
  store.put(record);
  expect(() => store.put({ ...record, stage: "quote-dispatched" })).toThrow();
  expect(store.list(scope)).toEqual([record]);
});
