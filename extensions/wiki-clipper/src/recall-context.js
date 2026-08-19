// Where: extensions/wiki-clipper/src/recall-context.js
// What: Recall "Add context" fetch flow with stale-state revalidation.
// Why: A slow recall-fetch must not insert a previous conversation's memory after navigation or config changes.

export function isRecallContextStale(request, state) {
  return (
    request.generation !== state.generation ||
    request.conversationUrl !== state.conversationUrl ||
    request.databaseId !== state.databaseId ||
    state.recallEnabled !== true
  );
}

export async function applyRecallContext({ result, request, send, state, format, insert }) {
  if (isRecallContextStale(request, state())) {
    return { applied: false, reason: "stale" };
  }
  const response = await send({
    type: "recall-fetch",
    requestId: String(request.generation),
    path: result.path,
    charOffset: Number.isInteger(result?.charOffset) ? result.charOffset : null
  });
  if (isRecallContextStale(request, state())) {
    return { applied: false, reason: "stale" };
  }
  const fetched = response.result;
  const context = format(result, fetched?.content || result.snippet);
  const applied = insert(context);
  return { applied, reason: applied ? "inserted" : "unavailable" };
}