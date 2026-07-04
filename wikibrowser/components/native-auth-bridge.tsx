// Where: wikibrowser/components/native-auth-bridge.tsx
// What: Browser bridge used by iOS ASWebAuthenticationSession native login.
// Why: Native clients receive Internet Identity delegations through a production HTTPS callback.

"use client";

import { useEffect, useRef, useState } from "react";
import { DELEGATION_TTL_NS, derivationOriginUrl, identityProviderUrl } from "@/lib/auth";
import { normalizeInternetIdentityResponseForNative } from "@/lib/native-auth-payload";

type ParsedNativeAuth = {
  callback: URL;
  identityProvider: URL;
  maxTimeToLive: string;
  sessionPublicKey: number[];
  state: string;
};

type BridgeState =
  | { status: "idle" }
  | { status: "ready"; parsed: ParsedNativeAuth }
  | { status: "error"; message: string };

export function NativeAuthBridge() {
  const [bridgeState] = useState<BridgeState>(() => initialBridgeState());
  const [started, setStarted] = useState(false);
  const cleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    return () => {
      cleanupRef.current?.();
    };
  }, []);

  const startAuthorization = () => {
    if (bridgeState.status !== "ready" || started) return;
    setStarted(true);
    cleanupRef.current?.();
    let completed = false;
    let timer: number | null = null;
    const parsed = bridgeState.parsed;
    const idpWindow = window.open(parsed.identityProvider.toString(), "kinic-ios-native-auth", "popup,width=520,height=720");
    const request = {
      kind: "authorize-client",
      sessionPublicKey: new Uint8Array(parsed.sessionPublicKey),
      maxTimeToLive: parsed.maxTimeToLive,
      derivationOrigin: derivationOriginUrl()
    };

    const finish = (query: URLSearchParams) => {
      if (completed) return;
      completed = true;
      cleanupRef.current?.();
      query.set("state", parsed.state);
      const callback = new URL(parsed.callback.toString());
      callback.search = query.toString();
      if (idpWindow && !idpWindow.closed) {
        idpWindow.location.href = callback.toString();
      } else {
        window.location.href = callback.toString();
      }
    };

    const fail = (message: string) => {
      const query = new URLSearchParams();
      query.set("error", base64URL(new TextEncoder().encode(message)));
      finish(query);
    };

    if (!idpWindow) {
      fail("Internet Identity window could not open.");
      return;
    }

    cleanupRef.current = () => {
      window.removeEventListener("message", handleMessage);
      if (timer) window.clearInterval(timer);
      cleanupRef.current = null;
    };

    const sendRequest = () => {
      idpWindow.postMessage(request, parsed.identityProvider.origin);
    };
    const handleMessage = (event: MessageEvent<unknown>) => {
      if (event.origin !== parsed.identityProvider.origin || !isRecord(event.data)) return;
      const kind = event.data.kind;
      if (kind === "authorize-client-success") {
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
      if (kind === "authorize-client-failure") {
        const query = new URLSearchParams();
        query.set("error", base64URL(new TextEncoder().encode(JSON.stringify(event.data))));
        finish(query);
      }
    };

    window.addEventListener("message", handleMessage);
    sendRequest();
    timer = window.setInterval(sendRequest, 500);
  };

  if (bridgeState.status === "idle") return null;

  return (
    <main className="fixed inset-0 z-50 grid place-items-center bg-white px-5 text-ink">
      <section className="grid max-w-sm gap-3 text-center">
        <h1 className="text-2xl font-semibold">KinicWikiApp Sign In</h1>
        <p className="text-sm leading-6 text-muted">
          {bridgeState.status === "error" ? bridgeState.message : "Continue with Internet Identity to finish native sign in."}
        </p>
        {bridgeState.status === "ready" ? (
          <button
            className="rounded-lg bg-black px-4 py-3 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
            disabled={started}
            onClick={startAuthorization}
            type="button"
          >
            {started ? "Opening Internet Identity..." : "Continue"}
          </button>
        ) : null}
      </section>
    </main>
  );
}

function initialBridgeState(): BridgeState {
  if (typeof window === "undefined") {
    return { status: "idle" };
  }
  try {
    const parsed = parseNativeAuthLocation(window.location);
    return parsed ? { status: "ready", parsed } : { status: "idle" };
  } catch (cause) {
    return {
      status: "error",
      message: cause instanceof Error ? cause.message : "Native auth request is invalid."
    };
  }
}

function parseNativeAuthLocation(location: Location): ParsedNativeAuth | null {
  const isNativeAuthPath = location.pathname === "/native-auth" || location.pathname === "/native-auth/";
  if (!isNativeAuthPath && !location.hash.startsWith("#/native-auth")) {
    return null;
  }
  const params = nativeAuthParams(location);
  const state = required(params, "state");
  const callback = callbackURL(required(params, "callback"), location);
  const sessionPublicKey = base64URLBytes(required(params, "sessionPublicKey"));
  const maxTimeToLive = maxTTL(required(params, "maxTimeToLive"));
  const identityProvider = providerURL(required(params, "identityProvider"));
  return { callback, identityProvider, maxTimeToLive, sessionPublicKey, state };
}

function nativeAuthParams(location: Location): URLSearchParams {
  if (location.search) {
    return new URLSearchParams(location.search);
  }
  const marker = "#/native-auth";
  if (location.hash.startsWith(marker)) {
    const queryStart = location.hash.indexOf("?");
    if (queryStart >= 0) {
      return new URLSearchParams(location.hash.slice(queryStart + 1));
    }
  }
  const stored = storedNativeAuthQuery();
  if (stored) {
    return new URLSearchParams(stored);
  }
  return new URLSearchParams();
}

function storedNativeAuthQuery(): string | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    const value = window.sessionStorage.getItem("kinicNativeAuthQuery");
    window.sessionStorage.removeItem("kinicNativeAuthQuery");
    return value;
  } catch {
    return null;
  }
}

function required(params: URLSearchParams, key: string): string {
  const value = params.get(key)?.trim();
  if (!value) {
    throw new Error(`${key} is required`);
  }
  return value;
}

function callbackURL(value: string, location: Location): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.host !== location.host || url.pathname !== "/ios-auth-callback") {
    throw new Error("callback is not allowed");
  }
  return url;
}

function providerURL(value: string): URL {
  const configured = new URL(identityProviderUrl());
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

function maxTTL(value: string): string {
  if (!/^[0-9]+$/.test(value)) {
    throw new Error("maxTimeToLive is invalid");
  }
  if (BigInt(value) > DELEGATION_TTL_NS) {
    throw new Error("maxTimeToLive is too large");
  }
  return value;
}

function base64URLBytes(value: string): number[] {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  return Array.from(binary, (character) => character.charCodeAt(0));
}

function base64URL(data: Uint8Array): string {
  let binary = "";
  for (const byte of data) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
