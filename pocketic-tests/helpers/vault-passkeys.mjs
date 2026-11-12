// Pure test setup: real Ed25519/CBOR, no actors, grants or authorization stubs.
import assert from "node:assert/strict";
import { generateKeyPairSync, sign, createHash } from "node:crypto";
export const b = (n, len = 16) => new Uint8Array(len).fill(n),
  cat = (...x) => Buffer.concat(x.map((v) => Buffer.from(v))),
  hash = (x) => createHash("sha256").update(x).digest(),
  b64 = (x) => Buffer.from(x).toString("base64url");
export const key = () => {
  const pair = generateKeyPairSync("ed25519");
  return {
    ...pair,
    public: Buffer.from(
      pair.publicKey.export({ format: "jwk" }).x,
      "base64url",
    ),
  };
};
export const ok = (x) => {
  assert.ok(
    "Ok" in x,
    JSON.stringify(x, (_, v) => (typeof v === "bigint" ? v.toString() : v)),
  );
  return x.Ok;
};
// Tiny deterministic CBOR encoder for the standard WebAuthn none attestation fixture.
const cb = (major, n) =>
  n < 24
    ? Buffer.from([major * 32 + n])
    : n < 256
      ? Buffer.from([major * 32 + 24, n])
      : Buffer.from([major * 32 + 25, n >> 8, n & 255]);
const cbor = (x) =>
  typeof x === "string"
    ? cat(cb(3, Buffer.byteLength(x)), Buffer.from(x))
    : Buffer.isBuffer(x)
      ? cat(cb(2, x.length), x)
      : cat(
          cb(5, Object.keys(x).length),
          ...Object.entries(x).flatMap(([k, v]) => [cbor(k), cbor(v)]),
        );
function registration(ch, credential) {
  const cose = cat(
    Buffer.from([0xa4, 1, 1, 3, 0x27, 0x20, 6, 0x21, 0x58, 0x20]),
    credential.public,
  );
  const auth = cat(
    hash("vault.kinic.xyz"),
    [0x45],
    [0, 0, 0, 0],
    b(0),
    [0, 16],
    credential.id,
    cose,
  );
  const client = JSON.stringify({
    type: "webauthn.create",
    challenge: b64(ch.bytes),
    origin: "https://vault.kinic.xyz",
    crossOrigin: false,
  });
  return JSON.stringify({
    id: b64(credential.id),
    transports: ["internal"],
    clientDataJSON: b64(Buffer.from(client)),
    attestationObject: b64(cbor({ fmt: "none", attStmt: {}, authData: auth })),
  });
}
export function passkeys(owner, { monotonicCounter = false } = {}) {
  function assertion(ch, credential, explicitCounter) {
    const client = Buffer.from(
      JSON.stringify({
        type: "webauthn.get",
        challenge: b64(ch.bytes),
        origin: "https://vault.kinic.xyz",
        crossOrigin: false,
      }),
    );
    const counter = explicitCounter ?? (monotonicCounter ? (credential.counter = (credential.counter ?? 0) + 1) : 0);
    const count = Buffer.alloc(4);
    count.writeUInt32BE(counter);
    const auth = cat(hash("vault.kinic.xyz"), [5], count);
    return JSON.stringify({
      id: b64(credential.id),
      clientDataJSON: b64(client),
      authenticatorData: b64(auth),
      signature: b64(sign(null, cat(auth, hash(client)), credential.privateKey)),
      userHandle: b64(owner.toUint8Array()),
    });
  }
  return { registration, assertion };
}
