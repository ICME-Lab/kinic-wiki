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
    :root {
      color-scheme: light;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      --ink: #1f1f1f;
      --muted: #67676f;
      --stroke: #747775;
    }
    html, body { width: 100%; height: 100%; overflow: hidden; overscroll-behavior: none; }
    body { position: fixed; inset: 0; margin: 0; background: #fff; color: var(--ink); }
    main { width: 100%; height: 100dvh; display: grid; place-items: center; padding: max(20px, env(safe-area-inset-top)) 20px max(20px, env(safe-area-inset-bottom)); box-sizing: border-box; overflow: hidden; }
    section { width: min(100%, 360px); text-align: center; }
    .auth-copy { display: grid; gap: 10px; }
    h1 { margin: 0; font-size: 28px; line-height: 1.15; font-weight: 700; }
    p { margin: 0; color: var(--muted); font-size: 15px; line-height: 1.5; }
    .provider-list { display: grid; gap: 10px; margin-top: 28px; }
    .social-actions { display: grid; gap: 10px; }
    .social-actions[hidden] { display: none; }
    .provider-button {
      position: relative;
      display: flex;
      width: 100%;
      min-height: 56px;
      align-items: center;
      justify-content: center;
      box-sizing: border-box;
      padding: 0 52px;
      border: 1px solid var(--stroke);
      border-radius: 14px;
      background: #fff;
      color: var(--ink);
      font: inherit;
      font-size: 16px;
      font-weight: 600;
      cursor: pointer;
      -webkit-tap-highlight-color: transparent;
    }
    .provider-icon {
      position: absolute;
      top: 50%;
      left: 18px;
      display: grid;
      width: 24px;
      height: 24px;
      place-items: center;
      transform: translateY(-50%);
    }
    .provider-icon img { display: block; width: 100%; height: 100%; object-fit: contain; }
    .provider-icon--ii { left: 16px; width: 28px; }
    .provider-button:hover { background: #f7f8f8; }
    .provider-button:active { background: #eef0f1; }
    .provider-button:focus-visible { outline: 3px solid rgb(47 128 237 / 28%); outline-offset: 2px; }
    .provider-button:disabled { opacity: .52; cursor: default; }
    .status { min-height: 22px; margin-top: 14px; font-size: 14px; }
    @media (max-width: 340px) {
      main { padding-right: 12px; padding-left: 12px; }
      .provider-button { padding-inline: 42px; font-size: 14px; }
      .provider-icon--ii { left: 12px; width: 24px; }
    }
  </style>
</head>
<body>
  <main>
    <section>
      <div class="auth-copy">
        <h1>Sign in to KinicWiki</h1>
        <p>Choose how to continue.</p>
      </div>
      <div class="provider-list">
        <button class="provider-button" id="native-auth-internet-identity" onclick="window.kinicNativeAuthStart && window.kinicNativeAuthStart('internet-identity')" type="button">
          <span class="provider-icon provider-icon--ii" aria-hidden="true"><img data-provider-logo="internet-identity" src="/native-auth/internet-identity.svg" alt=""></span>
          <span>Continue with Internet Identity</span>
        </button>
        <div class="social-actions" id="native-auth-openid-actions" hidden>
          <button class="provider-button" id="native-auth-apple" onclick="window.kinicNativeAuthStart && window.kinicNativeAuthStart('apple')" type="button">
            <span class="provider-icon" aria-hidden="true"><img data-provider-logo="apple" src="/native-auth/apple.svg" alt=""></span>
            <span>Continue with Apple</span>
          </button>
          <button class="provider-button" id="native-auth-google" onclick="window.kinicNativeAuthStart && window.kinicNativeAuthStart('google')" type="button">
            <span class="provider-icon" aria-hidden="true"><img data-provider-logo="google" src="/native-auth/google.svg" alt=""></span>
            <span>Continue with Google</span>
          </button>
        </div>
      </div>
      <p class="status" id="native-auth-message" role="status" aria-live="polite"></p>
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
  const openidActions = document.getElementById("native-auth-openid-actions");
  const buttons = [
    document.getElementById("native-auth-apple"),
    document.getElementById("native-auth-google"),
    document.getElementById("native-auth-internet-identity")
  ].filter(Boolean);
  const openidIssuers = Object.freeze({
    apple: "https://appleid.apple.com",
    google: "https://accounts.google.com"
  });
  const openingMessages = Object.freeze({
    "internet-identity": "Opening Internet Identity…",
    apple: "Opening Apple…",
    google: "Opening Google…"
  });
  let parsed = null;
  let parseFailed = false;
  let started = false;
  let completed = false;
  let requestTimer = null;
  let popupTimer = null;
  let timeoutTimer = null;
  const authorizationTimeoutMs = 5 * 60 * 1000;
  const callbackFallbackDelayMs = 750;

  const setMessage = (value) => {
    if (message) message.textContent = value;
  };
  const setError = (value) => {
    setMessage(value);
    setButtonsDisabled(true);
  };
  const setButtonsDisabled = (disabled) => {
    for (const button of buttons) button.disabled = disabled;
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

  if (parsed && isMainnetIdentityProvider(parsed.identityProvider) && openidActions) {
    openidActions.hidden = false;
  }

  window.kinicNativeAuthStart = (flow) => {
    if (!parsed || started) return;
    if (flow !== "internet-identity" && !Object.hasOwn(openidIssuers, flow)) {
      setError("Sign-in method is invalid.");
      return;
    }
    if (flow !== "internet-identity" && !isMainnetIdentityProvider(parsed.identityProvider)) {
      setError("Apple and Google sign-in are available only with the production Internet Identity service.");
      return;
    }
    started = true;
    setButtonsDisabled(true);
    setMessage(openingMessages[flow]);
    startAuthorization(parsed, flow);
  };

  function startAuthorization(requestParams, flow) {
    const idpWindow = window.open(authorizationURL(requestParams.identityProvider, flow), "kinic-ios-native-auth", "popup,width=520,height=720");
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
      if (requestTimer) window.clearInterval(requestTimer);
      if (popupTimer) window.clearInterval(popupTimer);
      if (timeoutTimer) window.clearTimeout(timeoutTimer);
      query.set("state", requestParams.state);
      const callback = new URL(requestParams.callback.toString());
      callback.search = query.toString();
      if (idpWindow && !idpWindow.closed) {
        try {
          idpWindow.location.href = callback.toString();
          window.setTimeout(() => {
            window.location.href = callback.toString();
          }, callbackFallbackDelayMs);
          return;
        } catch {
          // Fall through to the authentication session's parent window.
        }
      }
      window.location.href = callback.toString();
    };

    const fail = (value) => {
      const query = new URLSearchParams();
      query.set("error", base64URL(new TextEncoder().encode(value)));
      finish(query);
    };

    function handleMessage(event) {
      if (event.origin !== requestParams.identityProvider.origin || event.source !== idpWindow || !isRecord(event.data)) return;
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
    requestTimer = window.setInterval(sendRequest, 500);
    popupTimer = window.setInterval(() => {
      if (!completed && idpWindow.closed) {
        fail("Internet Identity was closed before authorization completed. Please try again.");
      }
    }, 500);
    timeoutTimer = window.setTimeout(() => {
      fail("Internet Identity authorization timed out. Please try again.");
    }, authorizationTimeoutMs);
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
    if (
      url.protocol !== "https:" ||
      url.host !== currentLocation.host ||
      !["/ios-auth-callback", "/android-auth-callback"].includes(url.pathname)
    ) {
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

  function authorizationURL(identityProvider, flow) {
    if (flow === "internet-identity") return identityProvider.toString();
    const issuer = openidIssuers[flow];
    if (!issuer || !isMainnetIdentityProvider(identityProvider)) throw new Error("Sign-in method is not allowed");
    const url = new URL("/authorize", identityProvider.origin);
    url.searchParams.set("openid", issuer);
    return url.toString();
  }

  function isMainnetIdentityProvider(identityProvider) {
    return (
      identityProvider.origin === "https://id.ai" &&
      identityProvider.pathname === "/" &&
      identityProvider.search === ""
    );
  }

  function maxTTL(value) {
    if (!/^[0-9]+$/.test(value)) throw new Error("maxTimeToLive is invalid");
    if (BigInt(value) > BigInt(config.delegationTtlNs)) throw new Error("maxTimeToLive is too large");
    return BigInt(value);
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
