// All response paths use the same UTF-16 budget and Unicode-safe boundary.
export function clipText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  if (maxChars <= 3) return ".".repeat(Math.max(0, maxChars));
  return `${text.slice(0, clippedTextPrefixEnd(text, maxChars))}...`;
}

// Used only when text is longer than a budget above three units. Exposing the
// boundary lets response sizing inspect the original string without allocating
// a fresh clipped body at every binary-search step.
export function clippedTextPrefixEnd(text: string, maxChars: number): number {
  let end = maxChars - 3;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  while (end > 0 && /\s/u.test(text.charAt(end - 1))) end--;
  return end;
}
