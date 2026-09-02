// Where: workers/wiki-generator/src/link-preview.ts
// What: Renders database link preview PNGs from queued jobs.
// Why: WikiBrowser must stay under the Free Worker bundle limit while new DB previews are generated asynchronously.
// Why: satori (SVG layout) + @resvg/resvg-wasm (rasterize) are used directly instead of next/og or @vercel/og,
//      both of which load a default font via `new URL(..., import.meta.url)` at module scope and cannot
//      initialize in the Workers runtime, where `import.meta.url` is undefined.
import satori from "satori";
import type { Resvg as ResvgClass } from "@resvg/resvg-wasm";
import type { PublicDatabaseSummary } from "./types.js";
import {
  decodeBase64,
  FALLBACK_FONT_BASE64,
  PLACEHOLDER_PNG_BASE64
} from "./assets.js";

export const LINK_PREVIEW_SIZE = {
  width: 1200,
  height: 630
};
export const LINK_PREVIEW_CONTENT_TYPE = "image/png";
export const LINK_PREVIEW_CACHE_CONTROL = "public, max-age=300, s-maxage=86400";

const PREVIEW_FONT_URL = "https://cdn.jsdelivr.net/npm/@fontsource/noto-sans-jp/files/noto-sans-jp-japanese-400-normal.woff";
const PREVIEW_FONT_NAME = "Kinic";

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
  const fontData = await previewFontData();
  const fonts: { name: string; data: ArrayBuffer; weight: 400; style: "normal" }[] = fontData
    ? [{ name: PREVIEW_FONT_NAME, data: fontData, weight: 400, style: "normal" }]
    : [];
  try {
    const svg = await satori(
    element(
      "div",
      {
        style: {
          width: "100%",
          height: "100%",
          display: "flex",
          background: "#161616",
          color: "#ffffff",
          fontFamily: PREVIEW_FONT_NAME,
          fontStyle: "normal"
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
    { ...LINK_PREVIEW_SIZE, fonts }
    );
    const { Resvg } = (await resvgLoader()) as Rasterizer;
    const png = new Resvg(svg, { fitTo: { mode: "width", value: LINK_PREVIEW_SIZE.width } }).render().asPng();
    return previewResponse(png);
  } catch (error) {
    // The preview is best-effort. A transient CDN font failure, wasm load
    // failure, or layout error must not 500 the worker; serve a static
    // placeholder instead.
    console.error("link preview render failed, serving placeholder", error);
    return previewResponse(decodeBase64(PLACEHOLDER_PNG_BASE64));
  }
}

function previewResponse(bytes: Uint8Array | ArrayBuffer): Response {
  return new Response(bytes, {
    headers: {
      "content-type": LINK_PREVIEW_CONTENT_TYPE,
      "cache-control": LINK_PREVIEW_CACHE_CONTROL
    }
  });
}

function kinicPreviewMark(): PreviewElement {
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

type PreviewElement = {
  type: string;
  props: { style?: Record<string, unknown>; [key: string]: unknown };
  key: null;
};

function element(type: string, props: Record<string, unknown> | null, ...children: (PreviewElement | string)[]): PreviewElement {
  const normalizedChildren = children.length === 0 ? undefined : children.length === 1 ? children[0] : children;
  return { type, props: normalizedChildren === undefined ? { ...(props ?? {}) } : { ...(props ?? {}), children: normalizedChildren }, key: null };
}

function shortenPreviewText(value: string, maxLength: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

let resvgPromise: Promise<{ Resvg: typeof ResvgClass }> | null = null;
let previewFontPromise: Promise<ArrayBuffer | null> | null = null;
let fetchImpl: typeof fetch = globalThis.fetch;
let resvgLoader: () => Promise<unknown> = loadResvg;

export type Rasterizer = {
  Resvg: new (svg: string, options?: unknown) => { render(): { asPng(): Uint8Array } };
};

export function setLinkPreviewDepsForTest(deps: { fetch?: typeof fetch; loadResvg?: () => Promise<unknown> } = {}) {
  fetchImpl = deps.fetch || globalThis.fetch;
  resvgLoader = deps.loadResvg || loadResvg;
  previewFontPromise = null;
}

type ResvgModule = { Resvg: typeof ResvgClass; initWasm: (input: unknown) => Promise<void> };

async function loadResvg(): Promise<{ Resvg: typeof ResvgClass }> {
  if (!resvgPromise) {
    resvgPromise = (async () => {
      const [resvg, wasm] = await Promise.all([
        import("@resvg/resvg-wasm"),
        import("@resvg/resvg-wasm/index_bg.wasm")
      ]);
      const module = resvg as unknown as ResvgModule;
      await module.initWasm((wasm as { default: unknown }).default);
      return { Resvg: module.Resvg };
    })();
  }
  return resvgPromise;
}

async function previewFontData(): Promise<ArrayBuffer | null> {
  if (!previewFontPromise) {
    previewFontPromise = (async () => {
      try {
        const response = await fetchImpl(PREVIEW_FONT_URL);
        if (response.ok) return await response.arrayBuffer();
      } catch {
        // Fall through to the bundled fallback font.
      }
      // The fallback font is bundled at build time, so previews render even when
      // the CDN is unreachable. It covers Latin text; Japanese glyphs degrade to
      // the layout engine's missing-glyph box until the CDN is reachable again.
      return decodeBase64(FALLBACK_FONT_BASE64);
    })();
  }
  return previewFontPromise;
}
