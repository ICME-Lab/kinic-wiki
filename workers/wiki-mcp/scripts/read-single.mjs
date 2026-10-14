// Client-side convenience only: the public MCP contract is always read_paths.
// Promote item failures so existing smoke/cleanup code fails closed before writes.
export async function readSingle(client, databaseId, path, options) {
  const result = await client.callTool(
    {
      name: "read_paths",
      arguments: { database_id: databaseId, paths: [path] },
    },
    undefined,
    options,
  );
  if (result.isError === true) return result;
  const payload = result.structuredContent;
  const items = payload?.results;
  if (
    payload?.metadata?.batch_error != null ||
    !Array.isArray(items) ||
    items.length !== 1
  ) {
    throw new Error("read_paths did not return one valid item");
  }
  const item = items[0];
  if (item?.is_error === true) {
    if (item.path !== path || typeof item.error !== "string") {
      throw new Error("read_paths returned an invalid item error");
    }
    return {
      isError: true,
      content: [{ type: "text", text: JSON.stringify({ error: item.error }) }],
    };
  }
  if (item?.metadata?.path !== path || typeof item.text !== "string") {
    throw new Error("read_paths returned an invalid node or mismatched path");
  }
  return { ...result, structuredContent: item };
}
