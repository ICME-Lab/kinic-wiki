import { ZodError } from "zod";
import { AssistantError } from "./contracts";
export async function readJson(request: Request): Promise<unknown> {
  if (!request.headers.get("content-type")?.startsWith("application/json"))
    throw new AssistantError("json_required", 415);
  const reader = request.body?.getReader();
  if (!reader) throw new AssistantError("body_required");
  const decoder = new TextDecoder();
  let text = "";
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 65536) throw new AssistantError("body_too_large", 413);
      text += decoder.decode(value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } finally {
    await reader.cancel();
  }
}
export function json(
  value: unknown,
  status = 200,
  extra?: HeadersInit,
): Response {
  const headers = new Headers(extra);
  headers.set("cache-control", "no-store");
  return Response.json(value, { status, headers });
}
export function failure(error: unknown): Response {
  if (error instanceof ZodError || error instanceof SyntaxError)
    return json({ error: "invalid_request" }, 400);
  if (error instanceof AssistantError)
    return json({ error: error.code }, error.status);
  // RPC errors preserve Error.message, but not custom subclasses/properties.
  const code = error instanceof Error ? error.message : "";
  const known = [
    "authentication_required",
    "invitation_required",
    "identity_changed",
    "invalid_auth_state",
    "choose_questions_only",
  ];
  if (known.includes(code)) return json({ error: code }, 403);
  return json({ error: "request_failed" }, 502);
}
export function readCookie(
  request: Request,
): { id: string; token: string } | null {
  const value = request.headers
    .get("cookie")
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("__Host-kinic-assistant="))
    ?.split("=")[1];
  const match = value?.match(/^([a-f0-9-]{36})\.([A-Za-z0-9_-]{43})$/);
  return match ? { id: match[1], token: match[2] } : null;
}
export function cookie(value: string, maxAge = 3600): string {
  return `__Host-kinic-assistant=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}
