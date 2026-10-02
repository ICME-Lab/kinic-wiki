// The verifying ICP HTTP gateway authenticates this response. No HttpAgent or
// query-signature crypto runs in the SSR Worker. Browser VFS reads stay unchanged.
export type PublicSeoPayload = {
  database: { metadata: { name: string; description: string } } | null;
  node: { content: string; metadataJson: string } | null;
  children: { path: string; name: string }[];
  childrenTruncated: boolean;
  hasContent: boolean;
};

export async function fetchPublicSeoPayload(
  canisterId: string,
  databaseId: string,
  nodePath: string,
): Promise<PublicSeoPayload | null> {
  if (!/^[a-z0-9-]+-cai$/.test(canisterId)) return null;
  const path = nodePath
    .split("/")
    .filter(Boolean)
    .map(encodeURIComponent)
    .join("/");
  const url = `https://${canisterId}.icp0.io/api/wiki-seo/${encodeURIComponent(databaseId)}/${path}`;
  try {
    const response = await fetch(url, {
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 404) return null;
    if (!response.ok)
      throw new Error(`Public SEO gateway returned ${response.status}`);
    if (!response.headers.get("content-type")?.startsWith("application/json"))
      throw new Error("Invalid public SEO content type");
    const text = await response.text();
    if (text.length > 128_000) throw new Error("Public SEO response too large");
    const payload: PublicSeoPayload = JSON.parse(text);
    if (
      typeof payload.hasContent !== "boolean" ||
      typeof payload.childrenTruncated !== "boolean" ||
      !Array.isArray(payload.children) ||
      payload.children.length > 100
    )
      throw new Error("Invalid public SEO response");
    if (
      payload.node &&
      (typeof payload.node.content !== "string" ||
        typeof payload.node.metadataJson !== "string" ||
        payload.node.content.length > 32_000 ||
        payload.node.metadataJson.length > 32_000)
    )
      throw new Error("Invalid public SEO node");
    if (
      payload.database &&
      (typeof payload.database.metadata?.name !== "string" ||
        typeof payload.database.metadata?.description !== "string")
    )
      throw new Error("Invalid public SEO database");
    if (
      payload.children.some(
        (child) =>
          typeof child.path !== "string" ||
          !child.path.startsWith(`${nodePath.replace(/\/$/, "")}/`) ||
          typeof child.name !== "string",
      )
    )
      throw new Error("Invalid public SEO children");
    return payload;
  } catch (error) {
    console.warn(
      "Public SEO read failed",
      error instanceof Error ? error.message : "unknown error",
    );
    return null;
  }
}
