// Where: database Twitter image route.
// What: serves cached per-database preview PNGs from R2.
// Why: bot-facing image requests must never generate PNGs on the Worker path.

import { readCachedDatabaseLinkPreviewImage } from "@/lib/link-preview-images";

export async function GET(request: Request, { params }: { params: Promise<{ databaseId: string }> }): Promise<Response> {
  const { databaseId } = await params;
  return readCachedDatabaseLinkPreviewImage(request, databaseId, "/twitter-image");
}
