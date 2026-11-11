import { expect, it } from "vitest";
import { verifyIncidentKit, encodeIncidentKit } from "../src/incident";
import {
  randomBytes,
  importKey,
  deriveKey,
  sealV2,
  generationAAD,
  recoveryVerifier,
} from "../../vault-crypto/src/index";
import { Principal } from "@icp-sdk/core/principal";
import type { IncidentTarget } from "../src/contracts";
it("requires the saved new secret and matching normal/recovery roots before a kit acknowledgment", async () => {
  const g = {
    version: 2 as const,
    canister: Principal.selfAuthenticating(randomBytes(32)),
    owner: Principal.selfAuthenticating(randomBytes(32)),
    vault: randomBytes(16),
    epoch: 1n,
    nonce: randomBytes(32),
    key_name: "key_1",
  };
  const cryptoG = {
    ...g,
    canister: g.canister.toText(),
    owner: g.owner.toText(),
  };
  const root = randomBytes(32),
    secret = randomBytes(32),
    kek = await importKey(randomBytes(32));
  const normal = await sealV2(
    kek,
    root,
    generationAAD(cryptoG, new Uint8Array(16), 0n, "normal"),
  );
  const recovery = await sealV2(
    await deriveKey(secret, "recovery"),
    root,
    generationAAD(cryptoG, new Uint8Array(16), 0n, "recovery"),
  );
  const t = {
    target: [g],
    normal: [normal],
    recovery: [recovery],
    recovery_verifier: await recoveryVerifier(secret),
  } as unknown as IncidentTarget;
  await expect(
    verifyIncidentKit(t, kek, encodeIncidentKit(g, secret)),
  ).resolves.toEqual(root);
  await expect(
    verifyIncidentKit(t, kek, encodeIncidentKit(g, randomBytes(32))),
  ).rejects.toThrow();
  await expect(verifyIncidentKit(t, kek, new Uint8Array())).rejects.toThrow();
  t.recovery = [
    await sealV2(
      await deriveKey(secret, "recovery"),
      randomBytes(32),
      generationAAD(cryptoG, new Uint8Array(16), 0n, "recovery"),
    ),
  ];
  await expect(
    verifyIncidentKit(t, kek, encodeIncidentKit(g, secret)),
  ).rejects.toThrow("RootMismatch");
});

it("a missing or wrong reselected kit sends no confirmation; lock blocks a late acknowledgment", async () => {
  const { IncidentClient } = await import("../src/incident"),
    { vi } = await import("vitest");
  const g = {
    version: 2,
    canister: Principal.selfAuthenticating(randomBytes(32)),
    owner: Principal.selfAuthenticating(randomBytes(32)),
    vault: randomBytes(16),
    epoch: 1n,
    nonce: randomBytes(32),
    key_name: "key_1",
  };
  const kek = await importKey(randomBytes(32));
  for (const mode of ["missing", "wrong", "lock", "saved"]) {
    const t = {
      target: [g],
      attempt: randomBytes(16),
      source: { id: g.vault },
      phase: { Allocated: null },
      envelope_digest: randomBytes(32),
    } as unknown as IncidentTarget;
    const j = {
      targets: [t],
      job: randomBytes(16),
      vector_digest: randomBytes(32),
    };
    const client = new IncidentClient(
      { incident_status: async () => ({ Ok: [j] }) } as never,
      g.owner,
      g.canister,
      "localhost",
      true,
    );
    const send = vi.fn(async (op: any) => {
      if (op.IncidentStage) {
        Object.assign(t, {
          normal: [op.IncidentStage.normal],
          recovery: [op.IncidentStage.recovery],
          recovery_verifier: op.IncidentStage.recovery_verifier,
          phase: { EnvelopesStaged: null },
        });
      }
      return { Unit: null };
    });
    Object.assign(client, {
      kek: async () => kek,
      signer: { send, destroy: () => {} },
    });
    let saved: Uint8Array | undefined;
    const pending = client.prepare(
      g.vault,
      async (file) => {
        saved = file;
        if (mode === "lock") client.session.lock();
      },
      async () => {
        if (mode === "missing") throw Error("FileNotSelected");
        return mode === "wrong"
          ? encodeIncidentKit(g, randomBytes(32))
          : saved!.slice();
      },
    );
    if (mode === "saved") await pending;
    else await expect(pending).rejects.toThrow();
    expect(send.mock.calls.some(([op]) => "IncidentConfirmKit" in op)).toBe(
      mode === "saved",
    );
    saved?.fill(0);
    client.session.lock();
  }
});
