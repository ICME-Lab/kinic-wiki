/** One fresh WebAuthn grant handshake; caller-specific authority and reuse remain local. */
import type { Challenge, GrantRequest, VaultActor } from "./contracts";
import type { Session } from "./session";
import { ephemeralSigner } from "./signed";
import { assertCredential } from "./webauthn";
import { randomBytes } from "../../vault-crypto/src/index";
import { ok } from "./wire";

export async function grantProof(
  session: Session,
  rpId: string,
  request: Pick<GrantRequest, "credential" | "purpose" | "generations">,
  begin: (
    ...args: Parameters<VaultActor["begin_grant"]>
  ) => ReturnType<VaultActor["begin_grant"]>,
  finish: (
    ...args: Parameters<VaultActor["finish_grant"]>
  ) => ReturnType<VaultActor["finish_grant"]>,
  checkChallenge?: (challenge: Challenge) => void,
) {
  const ticket = session.capture(),
    keys = await ephemeralSigner();
  session.check(ticket);
  const operation = randomBytes(16);
  const challenge = ok(
    await begin({ ...request, operation, public_key: keys.publicKey }),
  );
  session.check(ticket);
  checkChallenge?.(challenge);
  const proof = await assertCredential(challenge, rpId, session.signal);
  session.check(ticket);
  const grant = ok(await finish(operation, proof));
  session.check(ticket);
  return { grant, keys: keys.keys };
}
