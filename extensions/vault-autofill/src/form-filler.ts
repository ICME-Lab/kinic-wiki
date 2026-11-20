// Where: extensions/vault-autofill/src/form-filler.ts
// What: Pure DOM autofill helpers compatible with React, Vue, Angular, Svelte, and standard HTML forms.
// Why: Dispatching native value setters + input/change events ensures SPA state stays synchronized.
import { findLoginTarget, isVisibleEditableInput } from "./form-detector.ts";

export type FillCredentialsPayload = {
  username?: string;
  password?: string;
  totp?: string;
};

export type FillCredentialsResult = {
  filledUsername: boolean;
  filledPassword: boolean;
  filledTotp: boolean;
};

export function setNativeInputValue(input: HTMLInputElement, value: string): boolean {
  if (!isVisibleEditableInput(input)) return false;
  const win = input.ownerDocument?.defaultView;
  const proto = win?.HTMLInputElement?.prototype ?? HTMLInputElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(proto, "value");

  input.focus?.();
  if (descriptor?.set) {
    descriptor.set.call(input, value);
  } else {
    input.value = value;
  }

  const EventCtor = win?.Event ?? Event;
  input.dispatchEvent(new EventCtor("input", { bubbles: true }));
  input.dispatchEvent(new EventCtor("change", { bubbles: true }));
  input.dispatchEvent(new EventCtor("blur", { bubbles: true }));
  return true;
}

export function fillLoginFields(
  doc: Document,
  payload: FillCredentialsPayload
): FillCredentialsResult {
  const target = findLoginTarget(doc);
  if (!target) {
    return {
      filledUsername: false,
      filledPassword: false,
      filledTotp: false
    };
  }

  let filledUsername = false;
  let filledPassword = false;
  let filledTotp = false;

  if (payload.username && target.usernameInput) {
    filledUsername = setNativeInputValue(target.usernameInput, payload.username);
  }

  if (payload.password && target.passwordInputs.length > 0) {
    // On login forms fill the primary password input; do not overwrite unrelated fields.
    const currentPassword =
      target.passwordInputs.find(
        (input) =>
          (input.getAttribute("autocomplete") ?? "").toLowerCase() ===
          "current-password"
      ) ?? target.passwordInputs[0];
    filledPassword = setNativeInputValue(currentPassword, payload.password);
  }

  if (payload.totp && target.otpInput) {
    filledTotp = setNativeInputValue(target.otpInput, payload.totp);
  }

  return { filledUsername, filledPassword, filledTotp };
}

export function fillGeneratedPassword(
  doc: Document,
  password: string
): { filledCount: number } {
  if (!password) return { filledCount: 0 };
  const target = findLoginTarget(doc);
  if (!target || target.passwordInputs.length === 0) {
    return { filledCount: 0 };
  }

  // On signup / change-password forms, fill both new-password and confirm-password fields
  // (up to 2 password fields, skipping an explicit current-password field if a new-password field exists).
  const newPasswordFields = target.passwordInputs.filter(
    (input) =>
      (input.getAttribute("autocomplete") ?? "").toLowerCase() !==
      "current-password"
  );
  const fieldsToFill =
    newPasswordFields.length > 0
      ? newPasswordFields.slice(0, 2)
      : target.passwordInputs.slice(0, 1);

  let filledCount = 0;
  for (const field of fieldsToFill) {
    if (setNativeInputValue(field, password)) {
      filledCount += 1;
    }
  }
  return { filledCount };
}
