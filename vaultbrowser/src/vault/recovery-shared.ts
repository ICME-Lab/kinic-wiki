import { Principal } from "@icp-sdk/core/principal";
import type { VaultClient } from "@kinic/vault-client";
import { bytes } from "@kinic/vault-client";
import type {
  Generation,
  IncidentCredential,
} from "@kinic/vault-client/contracts";
import { b64, unb64 } from "@kinic/vault-crypto/documents";
import { generationBytes } from "@kinic/vault-crypto";
import { strictJSON } from "../../../packages/vault-crypto/src/strict-json";
import { openArchive, headerGeneration } from "@kinic/vault-backup";
import type { Session } from "@kinic/vault-client/session";
import type { VaultWork } from "./workspace";
export interface RecoveryProps {
  client: VaultClient;
  disabled: boolean;
  enabled: boolean;
  credential?: Uint8Array;
  run: VaultWork;
  onChanged: () => Promise<void>;
}
export const sameBytes = (a: Uint8Array | number[], b: Uint8Array | number[]) =>
  b64(bytes(a)) === b64(bytes(b));
export const generationLabel = (g: Generation) =>
  `Vault ${b64(bytes(g.vault)).slice(0, 10)} · generation ${g.epoch.toString()} · instance ${b64(bytes(g.nonce)).slice(0, 10)}`;
export const clientArguments = (
  client: VaultClient,
  rpId = client.recoveryConfiguration.rpId,
) =>
  [
    client.actor,
    client.identity.getPrincipal(),
    Principal.fromText(client.canister),
    rpId,
    client.recoveryConfiguration.local,
    client.session,
  ] as const;
export function covers(c: IncidentCredential, g: Generation) {
  return (
    "Global" in c.scope ||
    c.scope.Instances.some(
      (i) => sameBytes(i.vault, g.vault) && sameBytes(i.nonce, g.nonce),
    )
  );
}
/** Full archive verification precedes admission; the kit must name the archived generation. */
export async function sourceKit(
  archive: Uint8Array,
  kit: Uint8Array,
  session: Session,
  track: (b: Uint8Array) => Uint8Array,
) {
  if (kit.length > 4096) throw Error("InvalidKit");
  const k = strictJSON(
    new TextDecoder("utf-8", { fatal: true }).decode(kit),
  ) as Record<string, unknown>;
  if (
    !k ||
    Object.keys(k).sort().join(",") !== "generation,secret,version" ||
    k.version !== 2 ||
    typeof k.secret !== "string" ||
    typeof k.generation !== "string"
  )
    throw Error("InvalidKit");
  const ticket = session.capture(),
    secret = track(unb64(k.secret));
  try {
    if (secret.length !== 32) throw Error("InvalidKit");
    const opened = await openArchive(archive, secret);
    try {
      session.check(ticket);
      const g = headerGeneration(opened.header);
      if (!g || k.generation !== b64(generationBytes(g)))
        throw Error("InvalidKit");
      return { secret, header: opened.header };
    } finally {
      opened.rootRaw.fill(0);
    }
  } catch (e) {
    secret.fill(0);
    throw e;
  }
}
/** Original v1 kits were raw, unpadded base64url secrets, never v2 JSON kits. */
export async function legacySource(
  archive: Uint8Array,
  text: string,
  session: Session,
  track: (b: Uint8Array) => Uint8Array,
) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(text)) throw Error("InvalidKit");
  const ticket = session.capture(),
    secret = track(unb64(text));
  try {
    if (secret.length !== 32 || b64(secret) !== text) throw Error("InvalidKit");
    const opened = await openArchive(archive, secret);
    try {
      session.check(ticket);
      if (opened.header.version !== 1) throw Error("InvalidKit");
      return { secret, header: opened.header };
    } finally {
      opened.rootRaw.fill(0);
    }
  } catch (e) {
    secret.fill(0);
    throw e;
  }
}
/** Bind every UI-to-helper/actor call to this mounted view. Helpers may deliberately lock internally. */
export function bindRecovery<T extends object>(
  service: T,
  session: Session,
): T {
  const ticket = session.capture();
  return new Proxy(service, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        session.check(ticket);
        return Reflect.apply(value, target, args);
      };
    },
  });
}
