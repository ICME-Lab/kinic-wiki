import { Ed25519KeyIdentity, type JsonnableEd25519KeyIdentity } from "@icp-sdk/core/identity";
import { Principal } from "@icp-sdk/core/principal";

export function restoreReviewServiceIdentity(
  keyJson: string | undefined,
  expectedPrincipalText: string | undefined
): Ed25519KeyIdentity {
  const keyText = keyJson?.trim();
  const principalText = expectedPrincipalText?.trim();
  if (!keyText || !principalText) {
    throw new Error("Review service identity is not configured");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(keyText);
  } catch {
    throw new Error("Review service identity key is invalid");
  }
  if (!isEd25519KeyJson(parsed)) {
    throw new Error("Review service identity key is invalid");
  }

  let identity: Ed25519KeyIdentity;
  let expectedPrincipal: Principal;
  try {
    identity = Ed25519KeyIdentity.fromParsedJson(parsed);
    expectedPrincipal = Principal.fromText(principalText);
  } catch {
    throw new Error("Review service identity configuration is invalid");
  }
  if (
    expectedPrincipal.toText() !== principalText ||
    identity.getPrincipal().toText() !== expectedPrincipal.toText()
  ) {
    throw new Error("Review service identity principal does not match");
  }
  return identity;
}

function isEd25519KeyJson(value: unknown): value is JsonnableEd25519KeyIdentity {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    value.every((part) => typeof part === "string" && /^[0-9a-f]+$/iu.test(part))
  );
}
