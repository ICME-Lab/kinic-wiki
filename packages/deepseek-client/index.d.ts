export const DEEPSEEK_MODEL: "deepseek-flash";

export class DeepSeekResponseTooLargeError extends Error {}

/** A single authenticated submission; the caller owns timeout and retry policy. */
export function requestDeepSeekCompletion(options: {
  apiKey: string;
  body: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<Response>;

/** Reads at most maxBytes (default 256 KiB), cancelling and releasing the body. */
export function readDeepSeekResponseText(response: Response, maxBytes?: number): Promise<string>;
