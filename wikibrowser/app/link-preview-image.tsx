import { ImageResponse } from "next/og";

export const LINK_PREVIEW_ALT = "Kinic Wiki Database Dashboard";
export const LINK_PREVIEW_SIZE = {
  width: 1200,
  height: 630
};
export const LINK_PREVIEW_CONTENT_TYPE = "image/png";

export type LinkPreviewImageInput = {
  eyebrow?: string;
  accent?: string;
  title?: string;
  description?: string;
  tags?: string[];
};

export async function renderLinkPreviewImage(input: LinkPreviewImageInput = {}) {
  const eyebrow = input.eyebrow ?? "Kinic Wiki";
  const accent = input.accent ?? "Canister database dashboard";
  const title = input.title ?? "Browse, search, edit, and manage wiki databases.";
  const description = input.description ?? "A focused browser and operator UI for Kinic Wiki canisters.";
  const tags = input.tags ?? ["/Wiki", "/Sources", "Access", "Query"];
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          background: "#161616",
          color: "#ffffff",
          fontFamily: "Arial, Helvetica, sans-serif"
        }}
      >
        <div
          style={{
            width: "100%",
            height: "100%",
            display: "flex",
            padding: 72,
            border: "1px solid #ff2686"
          }}
        >
          <div
            style={{
              flex: 1,
              display: "flex",
              flexDirection: "column",
              justifyContent: "space-between"
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 22 }}>
              <div
                style={{
                  width: 72,
                  height: 72,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  borderRadius: 16,
                  background: "#ffffff",
                  boxShadow: "0 10px 28px rgba(0, 0, 0, 0.10)",
                  overflow: "hidden"
                }}
              >
                <KinicPreviewMark />
              </div>
              <div style={{ display: "flex", flexDirection: "column" }}>
                <div style={{ color: "#d8d8d8", fontSize: 24, fontWeight: 700 }}>{eyebrow}</div>
                <div style={{ color: "#ff2686", fontSize: 20, fontWeight: 700 }}>{accent}</div>
              </div>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 28 }}>
              <div style={{ display: "flex", fontSize: 74, fontWeight: 800, lineHeight: 1.02, maxWidth: 900 }}>
                {shortenPreviewText(title, 78)}
              </div>
              <div style={{ display: "flex", color: "#e6e6e6", fontSize: 30, lineHeight: 1.35, maxWidth: 820 }}>
                {shortenPreviewText(description, 110)}
              </div>
            </div>
            <div style={{ display: "flex", gap: 12, color: "#ff81be", fontSize: 22, fontWeight: 700 }}>
              {tags.slice(0, 4).map((tag) => (
                <span key={tag}>{shortenPreviewText(tag, 32)}</span>
              ))}
            </div>
          </div>
        </div>
      </div>
    ),
    LINK_PREVIEW_SIZE
  );
}

function KinicPreviewMark() {
  return (
    <div
      aria-hidden
      style={{
        width: 72,
        height: 72,
        display: "flex",
        flexDirection: "column",
        gap: 6,
        padding: 12,
        background: "#161616"
      }}
    >
      <div style={{ display: "flex", flex: 1, gap: 6 }}>
        <div style={{ width: 12, background: "#ffffff", borderRadius: 4 }} />
        <div style={{ flex: 1, background: "#ff2686", borderRadius: 4 }} />
      </div>
      <div style={{ display: "flex", flex: 1, gap: 6 }}>
        <div style={{ flex: 1, background: "#ff81be", borderRadius: 4 }} />
        <div style={{ width: 12, background: "#ffffff", borderRadius: 4 }} />
      </div>
      <div style={{ display: "flex", flex: 1, gap: 6 }}>
        <div style={{ width: 30, background: "#ffffff", borderRadius: 4 }} />
        <div style={{ flex: 1, background: "#ff2686", borderRadius: 4 }} />
      </div>
    </div>
  );
}

function shortenPreviewText(value: string, maxLength: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}
