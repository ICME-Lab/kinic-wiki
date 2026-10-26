export const DEEPSEEK_MODEL = "deepseek-flash";

export class DeepSeekResponseTooLargeError extends Error {
  constructor() {
    super("DeepSeek response exceeded byte limit");
    this.name = "DeepSeekResponseTooLargeError";
  }
}

// One submission only. Retry policy and response validation belong to callers.
export async function requestDeepSeekCompletion({ apiKey, body, signal, fetchImpl = globalThis.fetch }) {
  signal?.throwIfAborted();
  return fetchImpl("https://api.deepseek.com/chat/completions", {
    method: "POST",
    redirect: "manual",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body,
    signal,
  });
}

export async function readDeepSeekResponseText(response, maxBytes = 256 * 1024) {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null && Number(declaredLength) > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new DeepSeekResponseTooLargeError();
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new DeepSeekResponseTooLargeError();
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    // Cancellation failure must not replace an upstream or size-limit error.
    try { await reader.cancel(); } catch { /* errored/already cancelled stream */ }
    reader.releaseLock();
  }
}
