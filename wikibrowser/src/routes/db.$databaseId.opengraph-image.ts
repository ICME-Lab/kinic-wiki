import { createFileRoute } from "@tanstack/react-router";
import { env } from "cloudflare:workers";
import { readCachedDatabaseLinkPreviewImage, type LinkPreviewImageBucket, type LinkPreviewQueue } from "@/lib/link-preview-images";
import { canonicalDatabaseId } from "@/lib/paths";

export const Route = createFileRoute("/db/$databaseId/opengraph-image")({
  server: { handlers: { GET: ({ request, params }) => readCachedDatabaseLinkPreviewImage(request, canonicalDatabaseId(params.databaseId), "/opengraph-image.png", env.LINK_PREVIEW_IMAGES as unknown as LinkPreviewImageBucket, { queue: env.LINK_PREVIEW_QUEUE as unknown as LinkPreviewQueue, canisterId: env.KINIC_WIKI_CANISTER_ID }) } }
});
