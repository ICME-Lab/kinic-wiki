// Browser-facing HTML for the Private MCP OAuth flow.
// Every page shares PAGE_STYLE, which the CSP allows only through PAGE_STYLE_HASH.
// Update the hash whenever the CSS changes; auth.worker.test.ts verifies that they match.

export type PageLocale = "en" | "ja";

export const LOCALE_COOKIE_NAME = "__Host-kinic-mcp-locale";

export const PAGE_STYLE = `:root{color-scheme:light dark;--bg:#f6f5f4;--card:#fff;--text:#111;--muted:#6b6b70;--line:#e6e3e1;--accent:rgb(184 20 89);--button:#111;--button-text:#fff;--field:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#0e0e10;--card:#18181b;--text:#f1f1f3;--muted:#a1a1aa;--line:#2c2c31;--accent:rgb(255 92 156);--button:#f1f1f3;--button-text:#111;--field:#0e0e10}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px 16px;background:var(--bg);color:var(--text);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Hiragino Sans","Noto Sans JP",sans-serif}
main{width:100%;max-width:400px;background:var(--card);border:1px solid var(--line);border-radius:16px;padding:32px 28px;box-shadow:0 1px 2px rgb(0 0 0/.04),0 8px 24px rgb(0 0 0/.06)}
.mark{width:40px;height:40px;border-radius:10px;background:var(--accent);color:#fff;display:grid;place-items:center;font-weight:700;font-size:20px;margin-bottom:20px}
h1{font-size:22px;line-height:1.3;margin:0 0 6px;letter-spacing:-.01em}
.lead{margin:0 0 20px;color:var(--muted)}
.scope{margin:0 0 20px;padding:10px 12px;border-radius:8px;font-size:13px;background:color-mix(in srgb,var(--text) 5%,transparent)}
.scope strong{display:block;margin-bottom:2px}
button{width:100%;border:0;border-radius:10px;padding:12px 16px;font:inherit;font-weight:600;cursor:pointer;background:var(--button);color:var(--button-text)}
button:hover{opacity:.88}
button:focus-visible,input:focus-visible,summary:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.note{margin:12px 0 0;font-size:13px;color:var(--muted);text-align:center}
details{margin-top:28px;padding-top:16px;border-top:1px solid var(--line)}
summary{cursor:pointer;font-size:13px;color:var(--muted);list-style:none;text-align:center}
summary::-webkit-details-marker{display:none}
details:not([open]) form{display:none}
details[open] summary{margin-bottom:16px;color:var(--text);font-weight:600}
label{display:block;font-size:13px;font-weight:500;margin-bottom:12px}
input{display:block;width:100%;margin-top:6px;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:var(--field);color:var(--text);font:inherit}
.secondary{background:transparent;color:var(--text);border:1px solid var(--line);margin-top:4px}
.alert{margin:0 0 12px;padding:8px 12px;border-radius:8px;font-size:13px;color:var(--accent);background:color-mix(in srgb,var(--accent) 10%,transparent)}
.status{margin:0;color:var(--muted)}
.status.failed{color:var(--accent)}`;
export const PAGE_STYLE_HASH = "sha256-1xsLBI0mMvA1KgBdBT32GP3Xl8nUuZbfAPdY4PMTSL4=";

const STRINGS = {
  en: {
    title: "Connect Kinic Wiki",
    lead: "Sign in to let this app access your Kinic Wiki.",
    scopeHeading: "This app is requesting access to",
    scopeRead: "Read your wiki content.",
    scopeWrite: "Read and edit your wiki content.",
    scopeNote: "You choose the final access level in Internet Identity.",
    continueIi: "Continue with Internet Identity",
    iiNote: "Secure, passwordless sign-in with a passkey.",
    connectingTitle: "Connecting Kinic Wiki",
    connecting: "Completing secure connection…",
    connectMissing: "Connection data is missing. Start again from your AI client.",
    connectFailed: "Connection failed. Start again from your AI client.",
    invalid_connection: "Connection data is invalid or expired. Start again from your AI client.",
    registration_rejected: "Internet Identity rejected this connection. Check the trusted connector and reconnect.",
    temporarily_unavailable: "Internet Identity is temporarily unavailable. Start a fresh connection and try again.",
    errorTitle: "Couldn't connect",
    expired: "This sign-in link has expired or was already used. Close this page and connect again from your AI client.",
    rateLimited: "Too many sign-in attempts. Wait a minute, then try again.",
    unavailable: "Sign-in is temporarily unavailable. Try again in a few minutes."
  },
  ja: {
    title: "Kinic Wiki に接続",
    lead: "サインインすると、このアプリから Kinic Wiki にアクセスできるようになります。",
    scopeHeading: "このアプリが求めている権限",
    scopeRead: "Wiki の内容の読み取り",
    scopeWrite: "Wiki の内容の読み取りと編集",
    scopeNote: "最終的な権限は Internet Identity で選択します。",
    continueIi: "Internet Identity で続ける",
    iiNote: "パスキーを使った、パスワード不要の安全なサインインです。",
    connectingTitle: "Kinic Wiki に接続中",
    connecting: "安全な接続を完了しています…",
    connectMissing: "接続情報が見つかりません。AI クライアントからもう一度接続してください。",
    connectFailed: "接続に失敗しました。AI クライアントからもう一度接続してください。",
    invalid_connection: "接続情報が無効か、有効期限が切れています。AI クライアントからもう一度接続してください。",
    registration_rejected: "Internet Identity がこの接続を拒否しました。信頼済みコネクタを確認して、もう一度接続してください。",
    temporarily_unavailable: "Internet Identity が一時的に利用できません。新しく接続し直してください。",
    errorTitle: "接続できませんでした",
    expired: "このサインインの有効期限が切れたか、すでに使用されています。このページを閉じて、AI クライアントからもう一度接続してください。",
    rateLimited: "サインインの試行回数が多すぎます。1分ほど待ってから、もう一度お試しください。",
    unavailable: "サインインが一時的に利用できません。数分後にもう一度お試しください。"
  }
} as const;

/** Picks the first supported tag from an OAuth `ui_locales` value (space-separated BCP 47 tags). */
export function localeFromUiLocales(value: string | null): PageLocale | null {
  for (const tag of value?.split(/\s+/u) ?? []) {
    const locale = supportedLocale(tag);
    if (locale) return locale;
  }
  return null;
}

/** Picks the highest-weighted supported language from an Accept-Language header. */
export function localeFromAcceptLanguage(header: string | null): PageLocale | null {
  const ranked = (header ?? "")
    .split(",")
    .map((entry, index) => {
      const [tag = "", ...params] = entry.trim().split(";");
      const q = params.map((param) => param.trim()).find((param) => param.startsWith("q="));
      const weight = q ? Number(q.slice(2)) : 1;
      return { tag, weight: Number.isFinite(weight) ? weight : 0, index };
    })
    .filter((entry) => entry.weight > 0)
    .sort((left, right) => right.weight - left.weight || left.index - right.index);
  for (const entry of ranked) {
    const locale = supportedLocale(entry.tag);
    if (locale) return locale;
  }
  return null;
}

export function parseLocaleCookie(value: string | null): PageLocale | null {
  return value === "en" || value === "ja" ? value : null;
}

export function localeCookie(locale: PageLocale): string {
  // Keep the display language after the ten-minute connection cookie expires.
  return `${LOCALE_COOKIE_NAME}=${locale}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=86400`;
}

function supportedLocale(tag: string): PageLocale | null {
  const primary = tag.trim().toLowerCase().split("-", 1)[0];
  return primary === "ja" || primary === "en" ? primary : null;
}

export type AuthorizationChoiceOptions = {
  connectState: string;
  locale: PageLocale;
  writeRequested: boolean;
  reviewEnabled: boolean;
  reviewError?: string;
};

export function authorizationChoicePage(options: AuthorizationChoiceOptions): string {
  const t = STRINGS[options.locale];
  // The reviewer section stays in English so it matches the instructions submitted to OpenAI.
  const reviewerForm = options.reviewEnabled
    ? `<details${options.reviewError ? " open" : ""} lang="en"><summary>OpenAI reviewer sign in</summary>
${options.reviewError ? `<p class="alert" role="alert">${escapeHtml(options.reviewError)}</p>` : ""}<form method="post" action="/oauth/connect/reviewer">
<input type="hidden" name="connect_state" value="${escapeHtml(options.connectState)}">
<label>Username<input name="username" autocomplete="username" required></label>
<label>Password<input type="password" name="password" autocomplete="current-password" required></label>
<button type="submit" class="secondary">Sign in</button></form></details>`
    : "";
  return pageShell(
    options.locale,
    t.title,
    `<h1>${t.title}</h1>
<p class="lead">${t.lead}</p>
<div class="scope"><strong>${t.scopeHeading}</strong>${options.writeRequested ? t.scopeWrite : t.scopeRead}<br>${t.scopeNote}</div>
<form method="post" action="/oauth/connect/internet-identity"><input type="hidden" name="connect_state" value="${escapeHtml(options.connectState)}">
<button type="submit">${t.continueIi}</button></form>
<p class="note">${t.iiNote}</p>${reviewerForm}`
  );
}

export type ConnectErrorKind = "expired" | "rateLimited" | "unavailable";

export function connectErrorPage(locale: PageLocale, kind: ConnectErrorKind): string {
  const t = STRINGS[locale];
  return pageShell(locale, t.errorTitle, `<h1>${t.errorTitle}</h1>
<p class="status failed" role="alert">${t[kind]}</p>`);
}

export function connectCallbackPage(locale: PageLocale): string {
  const t = STRINGS[locale];
  const messages = {
    missing: t.connectMissing,
    failed: t.connectFailed,
    invalid_connection: t.invalid_connection,
    registration_rejected: t.registration_rejected,
    temporarily_unavailable: t.temporarily_unavailable
  };
  // Static strings only; escape "<" so the JSON cannot close the script element.
  const messagesJson = JSON.stringify(messages).replace(/</gu, "\\u003c");
  return pageShell(locale, t.connectingTitle, `<h1>${t.connectingTitle}</h1>
<p class="status" id="status" role="status">${t.connecting}</p>
<script>
(() => {
  const messages = ${messagesJson};
  const status = document.querySelector("#status");
  const fail = (message) => { status.textContent = message; status.className = "status failed"; };
  const p = new URLSearchParams(location.hash.slice(1));
  const delegation = p.get("delegation");
  const state = p.get("state");
  history.replaceState(null, "", location.pathname + location.search);
  if (!delegation || !state) { fail(messages.missing); return; }
  fetch(location.pathname, {
    method: "POST",
    credentials: "same-origin",
    headers: {"content-type": "application/json"},
    body: JSON.stringify({delegation, state})
  }).then(async (response) => {
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.redirect_uri) {
      fail(Object.hasOwn(messages, body.error) ? messages[body.error] : messages.failed);
      return;
    }
    location.replace(body.redirect_uri);
  }).catch(() => fail(messages.failed));
})();
</script>`);
}

function pageShell(locale: PageLocale, title: string, body: string): string {
  return `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><style>${PAGE_STYLE}</style></head>
<body><main><div class="mark" aria-hidden="true">K</div>${body}</main></body></html>`;
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[character]!);
}
