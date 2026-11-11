// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { assertCredential, register } from "../src/webauthn";
import { Session } from "../src/session";
const challenge = {
  bytes: new Uint8Array(32),
  expires: 0n,
  registration: false,
  credential_ids: [],
};
it("uses the configured RP and cancels an outstanding browser passkey ceremony on lock", async () => {
  const session = new Session();
  const signal = session.signal;
  const get = vi.fn(async (_options: CredentialRequestOptions) => null),
    create = vi.fn(async (_options: CredentialCreationOptions) => null);
  Object.defineProperty(navigator, "credentials", {
    value: { get, create },
    configurable: true,
  });
  await expect(
    assertCredential(challenge, "vault.example", signal),
  ).rejects.toThrow("InvalidProof");
  await expect(
    register(challenge, new Uint8Array([1]), "vault.example", signal),
  ).rejects.toThrow("InvalidProof");
  expect(get.mock.calls[0]?.[0]).toMatchObject({
    publicKey: { rpId: "vault.example" },
    signal,
  });
  expect(create.mock.calls[0]?.[0]).toMatchObject({
    publicKey: { rp: { id: "vault.example" } },
    signal,
  });
  session.lock();
  expect(signal.aborted).toBe(true);
  expect(session.signal.aborted).toBe(false);
});
