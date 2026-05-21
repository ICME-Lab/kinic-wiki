import {
  LINK_PREVIEW_ALT,
  LINK_PREVIEW_CONTENT_TYPE,
  LINK_PREVIEW_SIZE,
  renderLinkPreviewImage
} from "./link-preview-image";

export const alt = LINK_PREVIEW_ALT;
export const size = LINK_PREVIEW_SIZE;
export const contentType = LINK_PREVIEW_CONTENT_TYPE;

export default async function Image() {
  return renderLinkPreviewImage();
}
