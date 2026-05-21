import {
  LINK_PREVIEW_CONTENT_TYPE,
  LINK_PREVIEW_SIZE,
  renderLinkPreviewImage
} from "../link-preview-image";
import { databasePreviewDescription, loadDatabasePreview } from "@/lib/database-preview";

export const alt = "Kinic Wiki database link preview";
export const size = LINK_PREVIEW_SIZE;
export const contentType = LINK_PREVIEW_CONTENT_TYPE;

export default async function Image({ params }: { params: Promise<{ databaseId: string }> }) {
  const { databaseId } = await params;
  const canisterId = process.env.NEXT_PUBLIC_KINIC_WIKI_CANISTER_ID ?? "";
  const preview = await loadDatabasePreview(canisterId, databaseId);
  return renderLinkPreviewImage({
    eyebrow: "Kinic Wiki database",
    accent: preview.publicReadable ? "Public wiki database" : "Wiki database",
    title: preview.databaseName,
    description: databasePreviewDescription(preview),
    tags: [preview.databaseId, "/Wiki", "Search", "Query"]
  });
}
