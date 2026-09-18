export const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const JEV_MODEL = "jev-latest";
export const JEV_MAX_CANDIDATES = 20;
export const JEV_DEFAULT_SELECTIONS = 5;
export const JEV_TIMEOUT_MS = 3_000;

export type JevCandidate = {
  path: string;
  preview: string;
};

export type JevWorkflow = "generator" | "ask_ai";

export type JevMetric = {
  workflow: JevWorkflow;
  candidateCount: number;
  selectedCount: number;
  jevDurationMs: number;
  inputCharacters: number;
  httpStatus: number | null;
};

export type JevRerankResult<T extends JevCandidate> = {
  candidates: T[];
  durationMs: number;
  inputCharacters: number;
  httpStatus: number | null;
  bypassed: boolean;
};

export class JevError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly httpStatus: number | null;
  readonly durationMs: number;
  readonly inputCharacters: number;

  constructor(
    code: string,
    retryable: boolean,
    httpStatus: number | null,
    durationMs: number,
    inputCharacters: number,
  ) {
    super(code);
    this.name = "JevError";
    this.code = code;
    this.retryable = retryable;
    this.httpStatus = httpStatus;
    this.durationMs = durationMs;
    this.inputCharacters = inputCharacters;
  }
}

type Fetch = typeof fetch;
type LogMetric = (metric: JevMetric) => void;

export type JevRerankOptions<T extends JevCandidate> = {
  intent: string;
  candidates: readonly T[];
  apiKey: string;
  workflow: JevWorkflow;
  selectionCount?: number;
  timeoutMs?: number;
  fetchImpl?: Fetch;
  logMetric?: LogMetric;
};

export async function rerankWithJev<T extends JevCandidate>(
  options: JevRerankOptions<T>,
): Promise<JevRerankResult<T>> {
  const candidates = options.candidates.slice(0, JEV_MAX_CANDIDATES);
  const selectionCount = Math.min(
    JEV_DEFAULT_SELECTIONS,
    Math.max(1, options.selectionCount ?? JEV_DEFAULT_SELECTIONS),
  );
  const inputCharacters =
    options.intent.length +
    candidates.reduce(
      (total, candidate) => total + candidate.path.length + candidate.preview.length,
      0,
    );
  if (candidates.length <= selectionCount) {
    log(options, {
      workflow: options.workflow,
      candidateCount: candidates.length,
      selectedCount: candidates.length,
      jevDurationMs: 0,
      inputCharacters,
      httpStatus: null,
    });
    return {
      candidates: [...candidates],
      durationMs: 0,
      inputCharacters,
      httpStatus: null,
      bypassed: true,
    };
  }
  if (!options.apiKey.trim()) {
    const error = new JevError(
      "jev_configuration",
      false,
      null,
      0,
      inputCharacters,
    );
    log(options, {
      workflow: options.workflow,
      candidateCount: candidates.length,
      selectedCount: 0,
      jevDurationMs: 0,
      inputCharacters,
      httpStatus: null,
    });
    throw error;
  }

  const started = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? JEV_TIMEOUT_MS,
  );
  let httpStatus: number | null = null;
  try {
    const questions = Object.fromEntries(
      candidates.map((candidate, index) => [
        `candidate_${index}`,
        {
          type: "noul",
          instructions: {
            question: "Is this candidate semantically relevant to the search intent?",
            candidate_id: `candidate_${index}`,
            candidate_path: candidate.path,
          },
          criteria: {
            true: "The candidate would help answer or substantiate the search intent.",
            false: "The candidate is unrelated or would not help answer the search intent.",
          },
        },
      ]),
    );
    const response = await (options.fetchImpl ?? fetch)(JEV_ENDPOINT, {
      method: "POST",
      headers: {
        authorization: `Bearer ${options.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: JEV_MODEL,
        state: {
          search_intent: options.intent,
          candidates: candidates.map((candidate, index) => ({
            id: `candidate_${index}`,
            path: candidate.path,
            preview: candidate.preview,
          })),
        },
        questions,
      }),
      signal: controller.signal,
    });
    httpStatus = response.status;
    if (!response.ok) {
      throw new JevError(
        `jev_http_${response.status}`,
        response.status === 429 || response.status === 529 || response.status >= 500,
        response.status,
        Date.now() - started,
        inputCharacters,
      );
    }
    const body = await readBoundedJson(response);
    const probabilities = parseProbabilities(body, candidates.length);
    const selected = candidates
      .map((candidate, index) => ({ candidate, index, probability: probabilities[index]! }))
      .sort((left, right) => right.probability - left.probability || left.index - right.index)
      .slice(0, selectionCount)
      .map(({ candidate }) => candidate);
    const durationMs = Date.now() - started;
    log(options, {
      workflow: options.workflow,
      candidateCount: candidates.length,
      selectedCount: selected.length,
      jevDurationMs: durationMs,
      inputCharacters,
      httpStatus,
    });
    return {
      candidates: selected,
      durationMs,
      inputCharacters,
      httpStatus,
      bypassed: false,
    };
  } catch (error) {
    const durationMs = Date.now() - started;
    const classified =
      error instanceof JevError
        ? new JevError(
            error.code,
            error.retryable,
            error.httpStatus,
            durationMs,
            inputCharacters,
          )
        : new JevError(
            controller.signal.aborted || isAbortError(error)
              ? "jev_timeout"
              : "jev_unavailable",
            true,
            httpStatus,
            durationMs,
            inputCharacters,
          );
    log(options, {
      workflow: options.workflow,
      candidateCount: candidates.length,
      selectedCount: 0,
      jevDurationMs: classified.durationMs,
      inputCharacters,
      httpStatus: classified.httpStatus,
    });
    throw classified;
  } finally {
    clearTimeout(timeout);
  }
}

function log<T extends JevCandidate>(
  options: JevRerankOptions<T>,
  metric: JevMetric,
): void {
  (options.logMetric ?? ((value) => console.log(JSON.stringify(value))))(metric);
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const maximumBytes = 256 * 1024;
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new JevError("jev_incomplete_response", true, response.status, 0, 0);
  }
  if (!response.body) {
    throw new JevError("jev_incomplete_response", true, response.status, 0, 0);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maximumBytes) {
      await reader.cancel();
      throw new JevError("jev_incomplete_response", true, response.status, 0, 0);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new JevError("jev_incomplete_response", true, response.status, 0, 0);
  }
}

function parseProbabilities(value: unknown, count: number): number[] {
  if (!isRecord(value) || !isRecord(value.answers)) {
    throw new JevError("jev_incomplete_response", true, 200, 0, 0);
  }
  const probabilities: number[] = [];
  for (let index = 0; index < count; index++) {
    const answer = value.answers[`candidate_${index}`];
    if (
      !isRecord(answer) ||
      answer.type !== "noul" ||
      typeof answer.noul !== "number" ||
      !Number.isFinite(answer.noul) ||
      answer.noul < 0 ||
      answer.noul > 1
    ) {
      throw new JevError("jev_incomplete_response", true, 200, 0, 0);
    }
    probabilities.push(answer.noul);
  }
  return probabilities;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
