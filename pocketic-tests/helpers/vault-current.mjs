// Current II-only actual-Wasm fixture. Funding is synthetic; state controls
// exist only in the separately selected nondeployable boundary fixture.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { startVaultPocketIc } from "./vault-pocketic-server.mjs";
import { createVaultPocketIcWithTestKeys } from "./vault-pocketic-test-keys.mjs";
import { idlFactory } from "../../packages/vault-candid/index.js";
export { idlFactory };
export {
  VaultClient,
  cryptoLib,
  documents,
} from "../../target/vault-ii-acceptance/client/client.mjs";
const local = createRequire(new URL("../package.json", import.meta.url));
const req = createRequire(realpathSync(local.resolve("@dfinity/pic")));
export const { IDL } = req("@icp-sdk/core/candid"),
  { Principal } = req("@icp-sdk/core/principal");
export const root = resolve(import.meta.dirname, "../.."),
  out = resolve(root, "target/vault-ii-acceptance");
export const b = (n, length = 16) => new Uint8Array(length).fill(n);
export const owner = Principal.selfAuthenticating(b(90, 32)),
  other = Principal.selfAuthenticating(b(91, 32));
export const ok = (r) => {
  assert.ok(
    "Ok" in r,
    JSON.stringify(r, (_, v) => (typeof v === "bigint" ? String(v) : v)),
  );
  return r.Ok;
};
export const err = (r, name) => assert.deepEqual(r, { Err: { [name]: null } });
let counter = 0;
export function operation() {
  const value = new Uint8Array(16);
  new DataView(value.buffer).setUint32(12, ++counter);
  return value;
}
export async function fixture({
  wasm = resolve(
    root,
    "target/vault-synthetic-funding-build/wasm32-unknown-unknown/release/vault_canister.wasm",
  ),
  fund = true,
} = {}) {
  const server = await startVaultPocketIc(process.env.POCKET_IC_BIN);
  let pic;
  try {
    pic = await createVaultPocketIcWithTestKeys(server.getUrl(), {
      application: [{ state: { type: "new" } }],
      fiduciary: { state: { type: "new" } },
      icpConfig: { betaFeatures: "Enabled" },
    });
    await pic.setTime(Date.now());
    const install = async (path = wasm, arg = IDL.encode([], [])) => {
      const v = await pic.setupCanister({
        sender: owner,
        idlFactory,
        wasm: path,
        arg,
        cycles: 100_000_000_000_000n,
      });
      v.actor.setPrincipal(owner);
      return v;
    };
    const v = await install();
    ok(
      await v.actor.set_config([
        { key_name: "key_1", minimum_cycles: 100_000_000_000n },
      ]),
    );
    const fake = await pic.setupCanister({
      sender: owner,
      idlFactory: () =>
        IDL.Service({ configure: IDL.Func([IDL.Nat8, IDL.Nat64], [], []) }),
      wasm: resolve(
        root,
        "target/wasm32-unknown-unknown/release/vault_ledger_fixture.wasm",
      ),
      cycles: 100_000_000_000_000n,
    });
    fake.actor.setPrincipal(owner);
    await fake.actor.configure(0, 10n);
    const actorFor = (principal, canister = v.canisterId) => {
      const a = pic.createActor(idlFactory, canister);
      a.setPrincipal(principal);
      return a;
    };
    const fundOwner = async (
      principal = owner,
      credits = 2_000_000_000_000n,
      target = v,
    ) => {
      const admin = actorFor(owner, target.canisterId);
      ok(
        await admin.set_funding_config([
          {
            ledger: fake.canisterId,
            recipient: target.canisterId,
            cycles_per_kinic: credits,
          },
        ]),
      );
      const a = actorFor(principal, target.canisterId),
        op = operation();
      ok(
        await a.quote_purchase({
          operation: op,
          beneficiary: principal,
          amount_e8s: 100_000_000n,
          min_credits: credits,
          created_at_time: BigInt(await pic.getTime()) * 1_000_000n,
        }),
      );
      assert.ok("Paid" in ok(await a.pay_purchase(op)).status);
    };
    if (fund) await fundOwner();
    const controls = pic.createActor(
      () =>
        IDL.Service({
          fixture_execute: IDL.Func([IDL.Text], [], []),
          fixture_read: IDL.Func([IDL.Text], [IDL.Text], ["query"]),
        }),
      v.canisterId,
    );
    controls.setPrincipal(owner);
    const upgrade = async (path = wasm, target = v) => {
      await pic.tick(150);
      await pic.upgradeCanister({
        sender: owner,
        canisterId: target.canisterId,
        wasm: path,
        arg: IDL.encode([], []),
      });
    };
    return {
      ...v,
      pic,
      fake,
      wasm,
      install,
      actorFor,
      fundOwner,
      controls,
      upgrade,
      close: async () => {
        try {
          await pic.tearDown();
        } finally {
          await server.stop();
        }
      },
    };
  } catch (error) {
    try {
      await pic?.tearDown();
    } finally {
      await server.stop();
    }
    throw error;
  }
}
// Calls reach the real actor. A selected successful response is discarded afterward.
export function lossy(actor) {
  const calls = [];
  let drop;
  const proxy = new Proxy(actor, {
    get(target, name) {
      const value = target[name];
      if (typeof value !== "function") return value;
      return async (...args) => {
        const request = structuredClone(args);
        const result = await value.apply(target, args);
        calls.push({ name, args: request, result: structuredClone(result) });
        if (drop?.(name, args)) {
          ok(result);
          drop = undefined;
          throw Error("LostResponse");
        }
        return result;
      };
    },
  });
  return {
    actor: proxy,
    calls,
    dropNext: (predicate) => {
      drop = predicate;
    },
  };
}
