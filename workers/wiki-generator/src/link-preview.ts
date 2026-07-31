// Where: workers/wiki-generator/src/link-preview.ts
// What: Renders database link preview PNGs from queued jobs.
// Why: WikiBrowser must stay under the Free Worker bundle limit while new DB previews are generated asynchronously.
import React from "react";
import { ImageResponse } from "@vercel/og";
import type { PublicDatabaseSummary } from "./types.js";

export const LINK_PREVIEW_SIZE = {
  width: 1200,
  height: 630
};
export const LINK_PREVIEW_CONTENT_TYPE = "image/png";
export const LINK_PREVIEW_CACHE_CONTROL = "public, max-age=300, s-maxage=86400";

type RenderInput = {
  eyebrow?: string;
  accent?: string;
  title?: string;
  description?: string;
  tags?: string[];
};

export function databaseLinkPreviewImageKey(databaseId: string): string {
  return `db-link-preview/v1/${encodeURIComponent(databaseId.trim())}.png`;
}

export async function generateDatabaseLinkPreviewImage(database: PublicDatabaseSummary): Promise<Response> {
  const title = database.title;
  const description = database.description || `Browse, search, and query the ${title} wiki database.`;
  return renderLinkPreviewImage({
    eyebrow: "Kinic Wiki database",
    accent: "Public wiki database",
    title,
    description,
    tags: [database.databaseId, "/Knowledge", "Search", "Query"]
  });
}

export async function renderLinkPreviewImage(input: RenderInput = {}): Promise<Response> {
  const eyebrow = input.eyebrow ?? "Kinic Wiki";
  const accent = input.accent ?? "Canister database dashboard";
  const title = input.title ?? "Browse, search, edit, and manage wiki databases.";
  const description = input.description ?? "A focused browser and operator UI for Kinic Wiki canisters.";
  const tags = input.tags ?? ["/Knowledge", "/Sources", "Access", "Query"];
  return new ImageResponse(
    element(
      "div",
      {
        style: {
          width: "100%",
          height: "100%",
          display: "flex",
          background: "#161616",
          color: "#ffffff",
          fontFamily: "Arial, Helvetica, sans-serif"
        }
      },
      element(
        "div",
        {
          style: {
            width: "100%",
            height: "100%",
            display: "flex",
            padding: 72,
            border: "1px solid #ff2686"
          }
        },
        element(
          "div",
          {
            style: {
              flex: 1,
              display: "flex",
              flexDirection: "column",
              justifyContent: "space-between"
            }
          },
          element(
            "div",
            { style: { display: "flex", alignItems: "center", gap: 22 } },
            kinicPreviewMark(),
            element(
              "div",
              { style: { display: "flex", flexDirection: "column" } },
              element("div", { style: { color: "#d8d8d8", fontSize: 24, fontWeight: 700 } }, eyebrow),
              element("div", { style: { color: "#ff2686", fontSize: 20, fontWeight: 700 } }, accent)
            )
          ),
          element(
            "div",
            { style: { display: "flex", flexDirection: "column", gap: 28 } },
            element(
              "div",
              { style: { display: "flex", fontSize: 74, fontWeight: 800, lineHeight: 1.02, maxWidth: 900 } },
              shortenPreviewText(title, 78)
            ),
            element(
              "div",
              { style: { display: "flex", color: "#e6e6e6", fontSize: 30, lineHeight: 1.35, maxWidth: 820 } },
              shortenPreviewText(description, 110)
            )
          ),
          element(
            "div",
            { style: { display: "flex", gap: 12, color: "#ff81be", fontSize: 22, fontWeight: 700 } },
            ...tags.slice(0, 4).map((tag) => element("span", { key: tag }, shortenPreviewText(tag, 32)))
          )
        )
      )
    ),
    LINK_PREVIEW_SIZE
  );
}

function kinicPreviewMark(): ReturnType<typeof React.createElement> {
  return element(
    "div",
    {
      "aria-hidden": true,
      style: {
        width: 72,
        height: 72,
        display: "flex",
        flexDirection: "column",
        gap: 6,
        padding: 12,
        borderRadius: 16,
        background: "#161616",
        boxShadow: "0 10px 28px rgba(0, 0, 0, 0.10)",
        overflow: "hidden"
      }
    },
    element(
      "div",
      { style: { display: "flex", flex: 1, gap: 6 } },
      element("div", { style: { width: 12, background: "#ffffff", borderRadius: 4 } }),
      element("div", { style: { flex: 1, background: "#ff2686", borderRadius: 4 } })
    ),
    element(
      "div",
      { style: { display: "flex", flex: 1, gap: 6 } },
      element("div", { style: { flex: 1, background: "#ff81be", borderRadius: 4 } }),
      element("div", { style: { width: 12, background: "#ffffff", borderRadius: 4 } })
    ),
    element(
      "div",
      { style: { display: "flex", flex: 1, gap: 6 } },
      element("div", { style: { width: 30, background: "#ffffff", borderRadius: 4 } }),
      element("div", { style: { flex: 1, background: "#ff2686", borderRadius: 4 } })
    )
  );
}

function element(type: string, props: Record<string, unknown> | null, ...children: React.ReactNode[]): ReturnType<typeof React.createElement> {
  return React.createElement(type, props, ...children);
}

function shortenPreviewText(value: string, maxLength: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}
