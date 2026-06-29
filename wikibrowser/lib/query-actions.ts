export type QueryIdentityMode = "anonymous" | "user";

export type QueryAction =
  | { kind: "lint"; targetPath: string; sideEffect: "none"; identityMode: QueryIdentityMode }
  | { kind: "sql"; targetPath: "current database"; sideEffect: "none"; identityMode: QueryIdentityMode; sql: string }
  | { kind: "search"; targetPath: "current database"; sideEffect: "none"; identityMode: QueryIdentityMode; query: string }
  | { kind: "queue_url"; targetPath: "/Sources/ingest-requests"; sideEffect: "queue request"; identityMode: "user"; url: string }
  | { kind: "ask"; targetPath: "/Knowledge"; sideEffect: "none"; identityMode: QueryIdentityMode; question: string };

export function classifyQueryInput(value: string, selectedPath: string, identityMode: QueryIdentityMode): QueryAction | null {
  const text = value.trim();
  if (!text) return null;
  const sqlText = prefixedText(text, "sql");
  if (sqlText) return { kind: "sql", targetPath: "current database", sideEffect: "none", identityMode, sql: sqlText };
  const url = firstHttpUrl(text);
  if (url) return { kind: "queue_url", targetPath: "/Sources/ingest-requests", sideEffect: "queue request", identityMode: "user", url };
  if (/(lint|点検|検査)/i.test(text)) {
    return { kind: "lint", targetPath: /facts\.md|facts|事実/i.test(text) ? "/Knowledge/facts.md" : selectedPath, sideEffect: "none", identityMode };
  }
  const askText = prefixedText(text, "ask");
  if (askText) return { kind: "ask", targetPath: "/Knowledge", sideEffect: "none", identityMode, question: askText };
  const searchText = prefixedText(text, "search");
  if (searchText) return { kind: "search", targetPath: "current database", sideEffect: "none", identityMode, query: searchText };
  if (!looksLikeQuestion(text) && looksLikeKeywordSearch(text)) {
    return { kind: "search", targetPath: "current database", sideEffect: "none", identityMode, query: text };
  }
  return { kind: "ask", targetPath: "/Knowledge", sideEffect: "none", identityMode, question: text };
}

export function queryAnswerSearchTerms(value: string): string[] {
  const terms = new Set<string>();
  for (const token of value.match(/[A-Za-z0-9][A-Za-z0-9._+-]{1,}/g) ?? []) {
    const normalized = token.toLowerCase();
    if (!QUERY_ANSWER_STOP_WORDS.has(normalized)) terms.add(token);
  }
  return [...terms].slice(0, 4);
}

function firstHttpUrl(value: string): string | null {
  const match = value.match(/https?:\/\/[^\s]+/i);
  return match?.[0] ?? null;
}

function prefixedText(value: string, prefix: "ask" | "search" | "sql"): string | null {
  const localized = prefix === "ask" ? "質問" : prefix === "search" ? "検索" : "sql";
  const match = value.match(new RegExp(`^(?:${prefix}|${localized})\\s*[:：]\\s*(.+)$`, "i"));
  const text = match?.[1]?.trim();
  return text || null;
}

function looksLikeQuestion(value: string): boolean {
  return /[?？]\s*$/.test(value) || /^(who|what|when|where|why|how|which|can|could|should|is|are|do|does|did)\b/i.test(value) || /(とは|なぜ|どう|どの|どれ|いつ|どこ|誰|何|教えて|説明して)/.test(value);
}

function looksLikeKeywordSearch(value: string): boolean {
  if (value.includes("\n")) return false;
  if (/[。.!?？]/.test(value)) return false;
  if (value.length > 80) return false;
  const tokens = value.split(/\s+/).filter(Boolean);
  return tokens.length <= 6;
}

const QUERY_ANSWER_STOP_WORDS = new Set([
  "about",
  "ask",
  "can",
  "could",
  "does",
  "explain",
  "for",
  "from",
  "how",
  "is",
  "please",
  "say",
  "should",
  "tell",
  "the",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "wiki"
]);
