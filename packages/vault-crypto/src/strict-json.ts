/** Reject duplicate members before parsing JSON. The scanner is bounded by input size/depth. */
export function strictJSON(text: string): unknown {
  let p = 0;
  const ws = () => {
    while (/\s/.test(text[p] ?? "x")) p++;
  };
  function string(): string {
    const start = p++;
    while (p < text.length) {
      const c = text[p++];
      if (c === '"') return JSON.parse(text.slice(start, p));
      if (c === "\\") p++;
    }
    throw Error("InvalidJSON");
  }
  function value(depth: number): void {
    if (depth > 32) throw Error("InvalidJSON");
    ws();
    const c = text[p];
    if (c === '"') {
      string();
      return;
    }
    if (c === "{" || c === "[") {
      p++;
      ws();
      const end = c === "{" ? "}" : "]",
        keys = new Set<string>();
      if (text[p] === end) {
        p++;
        return;
      }
      while (p < text.length) {
        if (c === "{") {
          ws();
          if (text[p] !== '"') throw Error("InvalidJSON");
          const k = string();
          if (keys.has(k)) throw Error("DuplicateField");
          keys.add(k);
          ws();
          if (text[p++] !== ":") throw Error("InvalidJSON");
        }
        value(depth + 1);
        ws();
        if (text[p] === end) {
          p++;
          return;
        }
        if (text[p++] !== ",") throw Error("InvalidJSON");
      }
      throw Error("InvalidJSON");
    }
    const start = p;
    while (p < text.length && !/[\s,\]}]/.test(text[p])) p++;
    if (p === start) throw Error("InvalidJSON");
    JSON.parse(text.slice(start, p));
  }
  value(0);
  ws();
  if (p !== text.length) throw Error("InvalidJSON");
  return JSON.parse(text);
}
