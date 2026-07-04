import { DELEGATION_TTL_NS, derivationOriginUrl, identityProviderUrl } from "@/lib/auth";

export function GET() {
  const config = {
    delegationTtlNs: DELEGATION_TTL_NS.toString(),
    derivationOrigin: derivationOriginUrl(),
    identityProvider: identityProviderUrl()
  };
  return new Response(nativeAuthHTML(config), {
    headers: {
      "cache-control": "no-store",
      "content-type": "text/html; charset=utf-8"
    }
  });
}

function nativeAuthHTML(config: { delegationTtlNs: string; derivationOrigin: string; identityProvider: string }): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>KinicWikiApp Sign In</title>
  <style>
    :root { color-scheme: light; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    html, body { width: 100%; height: 100%; overflow: hidden; overscroll-behavior: none; }
    body { position: fixed; inset: 0; margin: 0; background: #fff; color: #0b0b0f; }
    main { width: 100%; height: 100dvh; display: grid; place-items: center; padding: max(20px, env(safe-area-inset-top)) 20px max(20px, env(safe-area-inset-bottom)); box-sizing: border-box; overflow: hidden; }
    section { width: min(100%, 360px); display: grid; gap: 14px; text-align: center; }
    h1 { margin: 0; font-size: 28px; line-height: 1.15; font-weight: 700; }
    p { margin: 0; color: #66666f; font-size: 15px; line-height: 1.55; }
    button { min-height: 56px; border: 0; border-radius: 16px; background: #000; color: #fff; font: inherit; font-size: 16px; font-weight: 700; }
    button:disabled { opacity: .55; }
  </style>
</head>
<body>
  <main>
    <section>
      <h1>KinicWikiApp Sign In</h1>
      <p id="native-auth-message">Continue with Internet Identity to finish native sign in.</p>
      <button id="native-auth-continue" onclick="window.kinicNativeAuthStart && window.kinicNativeAuthStart()" type="button">Continue</button>
    </section>
  </main>
  <script>
${nativeAuthScript(config)}
  </script>
</body>
</html>`;
}

function nativeAuthScript(config: { delegationTtlNs: string; derivationOrigin: string; identityProvider: string }): string {
  const jsonConfig = JSON.stringify(config);
  return `
(() => {
  const config = ${jsonConfig};
  const message = document.getElementById("native-auth-message");
  const button = document.getElementById("native-auth-continue");
  let parsed = null;
  let parseFailed = false;
  let started = false;
  let completed = false;
  let timer = null;

  const setMessage = (value) => {
    if (message) message.textContent = value;
  };
  const setError = (value) => {
    setMessage(value);
    if (button) button.disabled = true;
  };

  try {
    parsed = parseNativeAuthLocation(location);
  } catch (cause) {
    parseFailed = true;
    setError(cause instanceof Error ? cause.message : "Native auth request is invalid.");
  }

  if (!parsed && !parseFailed) {
    setError("Native auth request is missing.");
  }

  window.kinicNativeAuthStart = () => {
    if (!parsed || started) return;
    started = true;
    if (button) {
      button.disabled = true;
      button.textContent = "Opening Internet Identity...";
    }
    startAuthorization(parsed);
  };

  function startAuthorization(requestParams) {
    const idpWindow = window.open(requestParams.identityProvider.toString(), "kinic-ios-native-auth", "popup,width=520,height=720");
    const request = {
      kind: "authorize-client",
      sessionPublicKey: new Uint8Array(requestParams.sessionPublicKey),
      maxTimeToLive: requestParams.maxTimeToLive,
      derivationOrigin: config.derivationOrigin
    };

    const finish = (query) => {
      if (completed) return;
      completed = true;
      window.removeEventListener("message", handleMessage);
      if (timer) window.clearInterval(timer);
      query.set("state", requestParams.state);
      const callback = new URL(requestParams.callback.toString());
      callback.search = query.toString();
      if (idpWindow && !idpWindow.closed) {
        idpWindow.location.href = callback.toString();
      } else {
        window.location.href = callback.toString();
      }
    };

    const fail = (value) => {
      const query = new URLSearchParams();
      query.set("error", base64URL(new TextEncoder().encode(value)));
      finish(query);
    };

    function handleMessage(event) {
      if (event.origin !== requestParams.identityProvider.origin || !isRecord(event.data)) return;
      if (event.data.kind === "authorize-client-success") {
        try {
          const payload = normalizeInternetIdentityResponseForNative(event.data);
          const query = new URLSearchParams();
          query.set("result", base64URL(new TextEncoder().encode(JSON.stringify(payload))));
          finish(query);
        } catch (cause) {
          fail(cause instanceof Error ? cause.message : "Internet Identity response is invalid.");
        }
        return;
      }
      if (event.data.kind === "authorize-client-failure") {
        const query = new URLSearchParams();
        query.set("error", base64URL(new TextEncoder().encode(JSON.stringify(event.data))));
        finish(query);
      }
    }

    if (!idpWindow) {
      fail("Internet Identity window could not open.");
      return;
    }

    window.addEventListener("message", handleMessage);
    const sendRequest = () => idpWindow.postMessage(request, requestParams.identityProvider.origin);
    sendRequest();
    timer = window.setInterval(sendRequest, 500);
  }

  function parseNativeAuthLocation(currentLocation) {
    const params = nativeAuthParams(currentLocation);
    const state = required(params, "state");
    const callback = callbackURL(required(params, "callback"), currentLocation);
    const sessionPublicKey = base64URLBytes(required(params, "sessionPublicKey"));
    const maxTimeToLive = maxTTL(required(params, "maxTimeToLive"));
    const identityProvider = providerURL(required(params, "identityProvider"));
    return { callback, identityProvider, maxTimeToLive, sessionPublicKey, state };
  }

  function nativeAuthParams(currentLocation) {
    if (currentLocation.search) return new URLSearchParams(currentLocation.search);
    const marker = "#/native-auth";
    if (currentLocation.hash.startsWith(marker)) {
      const queryStart = currentLocation.hash.indexOf("?");
      if (queryStart >= 0) return new URLSearchParams(currentLocation.hash.slice(queryStart + 1));
    }
    const stored = storedNativeAuthQuery();
    if (stored) return new URLSearchParams(stored);
    return new URLSearchParams();
  }

  function storedNativeAuthQuery() {
    try {
      const value = sessionStorage.getItem("kinicNativeAuthQuery");
      sessionStorage.removeItem("kinicNativeAuthQuery");
      return value;
    } catch {
      return null;
    }
  }

  function required(params, key) {
    const value = params.get(key)?.trim();
    if (!value) throw new Error(key + " is required");
    return value;
  }

  function callbackURL(value, currentLocation) {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.host !== currentLocation.host || url.pathname !== "/ios-auth-callback") {
      throw new Error("callback is not allowed");
    }
    return url;
  }

  function providerURL(value) {
    const configured = new URL(config.identityProvider);
    const url = new URL(value);
    if (
      url.protocol !== configured.protocol ||
      url.host !== configured.host ||
      url.pathname !== configured.pathname ||
      url.search !== configured.search
    ) {
      throw new Error("identityProvider is not allowed");
    }
    url.hash = "authorize";
    return url;
  }

  function maxTTL(value) {
    if (!/^[0-9]+$/.test(value)) throw new Error("maxTimeToLive is invalid");
    if (BigInt(value) > BigInt(config.delegationTtlNs)) throw new Error("maxTimeToLive is too large");
    return value;
  }

  function base64URLBytes(value) {
    const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    const binary = atob(padded);
    return Array.from(binary, (character) => character.charCodeAt(0));
  }

  function base64URL(data) {
    let binary = "";
    for (const byte of data) binary += String.fromCharCode(byte);
    return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  }

  function normalizeInternetIdentityResponseForNative(value) {
    const response = requiredRecord(value, "Internet Identity response");
    if (response.kind !== "authorize-client-success") throw new Error("Internet Identity response kind is invalid");
    const container = isRecord(response.delegation) ? response.delegation : response;
    const publicKey = bytesHex(container.userPublicKey ?? container.publicKey, "userPublicKey");
    const rawDelegations = container.delegations;
    if (!Array.isArray(rawDelegations) || rawDelegations.length === 0) throw new Error("delegations are missing");
    return {
      kind: "authorize-client-success",
      userPublicKey: publicKey,
      delegations: rawDelegations.map((raw) => signedDelegation(raw))
    };
  }

  function signedDelegation(value) {
    const record = requiredRecord(value, "signed delegation");
    const delegation = requiredRecord(record.delegation, "delegation");
    const normalized = {
      pubkey: bytesHex(delegation.pubkey ?? delegation.publicKey, "delegation pubkey"),
      expiration: decimalString(delegation.expiration, "delegation expiration")
    };
    if (delegation.targets !== undefined) {
      if (!Array.isArray(delegation.targets)) throw new Error("delegation targets are invalid");
      normalized.targets = delegation.targets.map((target) => bytesHex(target, "delegation target"));
    }
    return {
      delegation: normalized,
      signature: bytesHex(record.signature, "delegation signature")
    };
  }

  function bytesHex(value, fieldName) {
    if (typeof value === "string") {
      const trimmed = value.trim().replace(/^0x/i, "");
      if (trimmed.length > 0 && trimmed.length % 2 === 0 && /^[0-9a-f]+$/i.test(trimmed)) return trimmed.toLowerCase();
    }
    if (value instanceof Uint8Array) return bytesToHex(Array.from(value));
    if (value instanceof ArrayBuffer) return bytesToHex(Array.from(new Uint8Array(value)));
    if (Array.isArray(value)) {
      const bytes = [];
      for (const item of value) {
        if (!Number.isInteger(item) || item < 0 || item > 255) throw new Error(fieldName + " contains invalid byte");
        bytes.push(item);
      }
      return bytesToHex(bytes);
    }
    throw new Error(fieldName + " is invalid");
  }

  function decimalString(value, fieldName) {
    if (typeof value === "bigint") {
      if (value < 0n) throw new Error(fieldName + " is invalid");
      return value.toString();
    }
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (/^[0-9]+$/.test(trimmed)) return trimmed;
      if (/^0x[0-9a-f]+$/i.test(trimmed)) return BigInt(trimmed).toString();
    }
    throw new Error(fieldName + " is invalid");
  }

  function bytesToHex(bytes) {
    return bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  function requiredRecord(value, fieldName) {
    if (!isRecord(value)) throw new Error(fieldName + " is invalid");
    return value;
  }

  function isRecord(value) {
    return typeof value === "object" && value !== null;
  }
})();
`;
}
