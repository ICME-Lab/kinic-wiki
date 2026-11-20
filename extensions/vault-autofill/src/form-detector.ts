// Where: extensions/vault-autofill/src/form-detector.ts
// What: Pure DOM heuristics for locating login, password, and 2FA fields and capturing login submissions.
// Why: Keep form detection deterministic, framework-agnostic, and thoroughly unit-testable with jsdom.

const EXCLUDED_HOSTS = new Set([
  "id.ai",
  "identity.ic0.app",
  "identity.internetcomputer.org",
  "vault.kinic.xyz",
  "mcx4q-2qaaa-aaaao-qqn3a-cai.icp0.io",
  "wiki.kinic.xyz",
  "6emaw-iyaaa-aaaay-aacka-cai.icp0.io"
]);

const OTP_PATTERN =
  /\b(totp|otp|2fa|mfa|one[-_ ]?time|auth[-_ ]?code|verification[-_ ]?code|security[-_ ]?code|passcode|token)\b/i;
const USERNAME_PATTERN =
  /\b(user(?:name|id)?|e[-_]?mail|login|log[-_ ]?in|account|acct|handle|identifier|member|uid|sign[-_ ]?in)\b/i;
const NON_USERNAME_PATTERN =
  /\b(search|query|filter|coupon|promo|captcha|csrf|comment|message|title|subject|address|city|zip|postal|card|cvv|cvc)\b/i;
const SUBMIT_ACTION_PATTERN =
  /\b(sign[-_ ]?in|log[-_ ]?in|login|continue|next|submit|sign[-_ ]?up|register|create[-_ ]?account|save|update[-_ ]?password|change[-_ ]?password|confirm|verify)\b/i;
const NON_SUBMIT_BUTTON_PATTERN =
  /\b(show|hide|reveal|visibility|toggle|eye|clear|cancel|close|back|forgot|reset|cookie|accept|decline|reject|dismiss|help|info|copy|generate)\b/i;

export type DetectedLoginTarget = {
  form: HTMLFormElement | null;
  usernameInput: HTMLInputElement | null;
  passwordInputs: HTMLInputElement[];
  otpInput: HTMLInputElement | null;
};

export function isWebOriginFillable(rawUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase();
  if (EXCLUDED_HOSTS.has(host)) return false;
  if (url.protocol === "https:") return true;
  if (
    url.protocol === "http:" &&
    (host === "localhost" || host === "127.0.0.1" || host.endsWith(".localhost"))
  ) {
    return true;
  }
  return false;
}

function fieldHints(input: HTMLInputElement): string {
  return [
    input.getAttribute("autocomplete") ?? "",
    input.name ?? "",
    input.id ?? "",
    input.placeholder ?? "",
    input.getAttribute("aria-label") ?? ""
  ].join(" ");
}

export function isVisibleEditableInput(input: HTMLInputElement): boolean {
  if (!input || input.disabled || input.readOnly) return false;
  if (input.type === "hidden" || input.hidden) return false;
  if (input.getAttribute("aria-hidden") === "true") return false;
  const style = input.style;
  if (style.display === "none" || style.visibility === "hidden") return false;
  const win = input.ownerDocument?.defaultView;
  if (win && typeof win.getComputedStyle === "function") {
    const computed = win.getComputedStyle(input);
    if (computed.display === "none" || computed.visibility === "hidden") {
      return false;
    }
  }
  let parent: HTMLElement | null = input.parentElement;
  while (parent) {
    if (parent.hidden || parent.getAttribute("aria-hidden") === "true") {
      return false;
    }
    if (parent.style.display === "none" || parent.style.visibility === "hidden") {
      return false;
    }
    parent = parent.parentElement;
  }
  return true;
}

export function isPasswordInput(input: HTMLInputElement): boolean {
  if (!isVisibleEditableInput(input)) return false;
  if (input.type === "password") return true;
  const ac = (input.getAttribute("autocomplete") ?? "").toLowerCase();
  return ac === "current-password" || ac === "new-password";
}

export function isOtpInput(input: HTMLInputElement): boolean {
  if (!isVisibleEditableInput(input)) return false;
  if (input.type === "password") return false;
  const ac = (input.getAttribute("autocomplete") ?? "").toLowerCase();
  if (ac === "one-time-code") return true;
  if (
    input.type !== "text" &&
    input.type !== "tel" &&
    input.type !== "number"
  ) {
    return false;
  }
  return OTP_PATTERN.test(fieldHints(input));
}

export function isUsernameInput(input: HTMLInputElement): boolean {
  if (!isVisibleEditableInput(input)) return false;
  if (isPasswordInput(input) || isOtpInput(input)) return false;
  const type = (input.type || "text").toLowerCase();
  if (type === "email") return true;
  if (type !== "text" && type !== "tel") return false;
  const ac = (input.getAttribute("autocomplete") ?? "").toLowerCase();
  if (ac === "username" || ac === "email") return true;
  const hints = fieldHints(input);
  if (NON_USERNAME_PATTERN.test(hints)) return false;
  return USERNAME_PATTERN.test(hints);
}

function scoreUsernameCandidate(
  input: HTMLInputElement,
  passwordInput: HTMLInputElement | null,
  allInputs: HTMLInputElement[]
): number {
  let score = 0;
  const ac = (input.getAttribute("autocomplete") ?? "").toLowerCase();
  if (ac === "username") score += 100;
  if (ac === "email") score += 90;
  if (input.type === "email") score += 80;
  if (isUsernameInput(input)) score += 50;
  if (passwordInput) {
    const pwIndex = allInputs.indexOf(passwordInput);
    const idx = allInputs.indexOf(input);
    if (idx >= 0 && pwIndex >= 0 && idx < pwIndex) {
      // Strongly prefer the closest text/email input immediately preceding the password field.
      score += Math.max(0, 40 - (pwIndex - idx) * 5);
    }
  }
  return score;
}

function collectTargetInScope(
  scope: ParentNode,
  form: HTMLFormElement | null
): DetectedLoginTarget | null {
  const inputs = Array.from(scope.querySelectorAll("input")).filter(
    (el): el is HTMLInputElement => isVisibleEditableInput(el)
  );
  const passwordInputs = inputs.filter(isPasswordInput);
  const otpInput = inputs.find(isOtpInput) ?? null;

  const primaryPassword = passwordInputs[0] ?? null;
  let usernameInput: HTMLInputElement | null = null;
  let bestScore = -1;

  for (const input of inputs) {
    if (isPasswordInput(input) || isOtpInput(input)) continue;
    const type = (input.type || "text").toLowerCase();
    if (type !== "text" && type !== "email" && type !== "tel") continue;
    if (NON_USERNAME_PATTERN.test(fieldHints(input))) continue;

    // Allow a generic text input right before a password field even if unnamed.
    const precedingPassword =
      primaryPassword !== null &&
      inputs.indexOf(input) >= 0 &&
      inputs.indexOf(input) < inputs.indexOf(primaryPassword);
    if (!isUsernameInput(input) && !precedingPassword) continue;

    const score = scoreUsernameCandidate(input, primaryPassword, inputs);
    if (score > bestScore) {
      bestScore = score;
      usernameInput = input;
    }
  }

  if (!usernameInput && passwordInputs.length === 0 && !otpInput) {
    return null;
  }
  return {
    form,
    usernameInput,
    passwordInputs,
    otpInput
  };
}

export function findLoginTarget(doc: Document): DetectedLoginTarget | null {
  // 1. Prefer the form containing the currently focused element if it has login fields.
  const active = doc.activeElement;
  const InputCtor = doc.defaultView?.HTMLInputElement;
  if (
    (InputCtor && active instanceof InputCtor) ||
    (active && active.tagName === "INPUT")
  ) {
    const activeInput = active as HTMLInputElement;
    if (activeInput.form) {
      const focusedTarget = collectTargetInScope(activeInput.form, activeInput.form);
      if (focusedTarget && (focusedTarget.passwordInputs.length > 0 || focusedTarget.usernameInput || focusedTarget.otpInput)) {
        return focusedTarget;
      }
    }
  }

  // 2. Inspect explicit <form> elements, preferring one with a password field.
  let fallbackFormTarget: DetectedLoginTarget | null = null;
  for (const form of Array.from(doc.forms)) {
    const target = collectTargetInScope(form, form);
    if (!target) continue;
    if (target.passwordInputs.length > 0) {
      return target;
    }
    if (!fallbackFormTarget && (target.usernameInput || target.otpInput)) {
      fallbackFormTarget = target;
    }
  }

  // 3. Fallback to document-level inputs for SPA logins without a <form> wrapper.
  const documentTarget = collectTargetInScope(doc, null);
  if (documentTarget && documentTarget.passwordInputs.length > 0) {
    return documentTarget;
  }
  return fallbackFormTarget ?? documentTarget;
}

export function extractSubmittedCredentials(
  scope: ParentNode,
  preferredPasswordInput?: HTMLInputElement | null
): { username: string; password: string } | null {
  const form =
    typeof HTMLFormElement !== "undefined" && scope instanceof HTMLFormElement
      ? scope
      : null;
  const target = collectTargetInScope(scope, form);
  const passwordInput =
    preferredPasswordInput && isPasswordInput(preferredPasswordInput)
      ? preferredPasswordInput
      : target?.passwordInputs.find((input) => input.value.length > 0) ??
        target?.passwordInputs[0] ??
        null;

  const password = passwordInput?.value ?? "";
  if (!password || !password.trim()) {
    return null;
  }
  const username = target?.usernameInput?.value.trim() ?? "";
  return { username, password };
}

export function isLikelyLoginSubmitTrigger(
  el: Element,
  form: HTMLFormElement | null
): boolean {
  const tag = el.tagName.toUpperCase();
  const explicitType = (el.getAttribute("type") ?? "").toLowerCase();
  if (explicitType === "reset") return false;

  const buttonLabel = [
    el.getAttribute("aria-label") ?? "",
    el.getAttribute("title") ?? "",
    el.getAttribute("name") ?? "",
    el.id ?? "",
    el.getAttribute("value") ?? "",
    el.textContent ?? ""
  ]
    .join(" ")
    .trim();

  if (NON_SUBMIT_BUTTON_PATTERN.test(buttonLabel)) {
    return false;
  }

  if (form) {
    if (tag === "INPUT" && explicitType === "submit") return true;
    if (tag === "BUTTON" && (explicitType === "" || explicitType === "submit")) {
      return true;
    }
    return SUBMIT_ACTION_PATTERN.test(buttonLabel);
  }

  // Outside a <form> (SPA views), require an explicit submit/login label.
  if (tag === "INPUT" && explicitType === "submit") return true;
  return SUBMIT_ACTION_PATTERN.test(buttonLabel);
}
