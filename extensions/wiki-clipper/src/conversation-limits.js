// Where: extensions/wiki-clipper/src/conversation-limits.js
// What: Shared capture-size guard for provider conversation exports.
// Why: Oversized provider conversations should not consume CPU before evidence-source truncation.
export const MAX_CAPTURE_TEXT_CHARS = 320_000;

export function appendLimitedMessage(messages, state, role, content, maxChars = MAX_CAPTURE_TEXT_CHARS) {
  if (state.done || typeof content !== "string" || content.length === 0) return;
  const remaining = maxChars - state.chars;
  if (remaining <= 0) {
    state.done = true;
    return;
  }
  const limited = content.slice(0, remaining);
  if (!limited) {
    state.done = true;
    return;
  }
  messages.push({ role, content: limited });
  state.chars += limited.length;
  state.done = state.chars >= maxChars;
}
