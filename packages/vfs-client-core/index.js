export function unwrapCandidResult(result, errorFactory = (message) => new Error(message)) {
  if (result && typeof result === "object" && "Err" in result) {
    throw errorFactory(String(result.Err));
  }
  if (!result || typeof result !== "object" || !("Ok" in result)) {
    throw new TypeError("invalid Candid result");
  }
  return result.Ok;
}

export function candidOptional(value) {
  return value === null || value === undefined ? [] : [value];
}

export function variantName(value) {
  if (!value || typeof value !== "object") return undefined;
  return Object.keys(value)[0];
}

export function isLocalReplicaHost(value) {
  try {
    const parsed = new URL(value);
    const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    return (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "::1" ||
      hostname === "0.0.0.0"
    );
  } catch {
    return false;
  }
}
