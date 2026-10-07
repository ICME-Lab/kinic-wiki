// Log only fixed categories; upstream errors can contain credentials or wiki text.
export function failureKind(error: unknown): string {
  if (!(error instanceof Error)) return "unknown";
  if (error.message.includes("Cannot perform I/O on behalf of a different request")) return "cross_request_io";
  if (error.message.includes("Network connection lost")) return "network_connection_lost";
  if (error.message.includes("Too many subrequests")) return "subrequest_limit";
  if (error.message.includes("Too many API requests")) return "api_request_limit";
  if (error.message.includes("Too many concurrent")) return "connection_limit";
  if (error.message.includes("D1_ERROR")) return "d1_error";
  if (error.message.includes("waitUntil")) return "wait_until";
  if (error.message.includes("lease_lost")) return "lease_lost";
  if (error.name === "ZodError") return "response_schema";
  if (error instanceof SyntaxError) return "response_json";
  if (error.name === "AbortError" || error.name === "TimeoutError") return "aborted";
  if (error instanceof TypeError) return "type_error";
  const cause = error.cause as { code?: { name?: string } } | undefined;
  const code = cause?.code?.name;
  if (code && /^(?:[A-Za-z]+ErrorCode)$/.test(code)) return code;
  return "other";
}
