export type CredentialLogin = { username: string; password: string; url: string };

export const emptyLogin: CredentialLogin = { username: "", password: "", url: "" };

function fields(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("Invalid credential");
  return value as Record<string, unknown>;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function parseLogin(value: unknown): CredentialLogin {
  const login = fields(value);
  return { username: text(login.username), password: text(login.password), url: text(login.URL) };
}

export function parseCredential(json: string) {
  const value = fields(JSON.parse(json));
  const extra = value.additionalLogins ?? [];
  if (!Array.isArray(extra)) throw Error("Invalid credential logins");
  return {
    kind: "credential" as const,
    logins: [parseLogin(value), ...extra.map(parseLogin)],
    notes: text(value.notes),
  };
}

export function serializeCredential(label: string, logins: CredentialLogin[], notes: string) {
  const fieldsFor = ({ username, password, url }: CredentialLogin) => ({ username, password, URL: url });
  const [primary = emptyLogin, ...additional] = logins;
  return JSON.stringify({
    label,
    ...fieldsFor(primary),
    notes,
    ...(additional.length ? { additionalLogins: additional.map(fieldsFor) } : {}),
  });
}
