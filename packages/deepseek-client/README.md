# DeepSeek client

Shared server-side transport for Ask AI, Wiki generation, and browser query answers.
`DEEPSEEK_MODEL` is the default model name, `deepseek-flash`.

`requestDeepSeekCompletion` sends one authenticated Chat Completions POST with
manual redirect handling. Pass the serialized request body and a caller-owned
abort signal. It returns the original response, including status and Retry-After.
It never retries or logs keys, prompts, or provider responses.

`readDeepSeekResponseText` enforces a 256 KiB default response limit against both
Content-Length and actual streamed bytes. It cancels and releases the reader,
including on oversized or interrupted responses.

Keep the abort signal active through body consumption. Callers retain their
timeout, error mapping, retry policy, usage accounting, and domain validation.
