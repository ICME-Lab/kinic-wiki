// Where: wikibrowser/scripts/generate-link-preview-images.mjs
// What: Generates static top-level and DB-specific link preview PNGs outside the Worker bundle.
// Why: next/og pulls WASM assets into Workers when imported by app routes, which exceeds the Free plan size limit.
import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import React from "react";
import { ImageResponse } from "next/og.js";

export const LINK_PREVIEW_SIZE = {
  width: 1200,
  height: 630
};
export const LINK_PREVIEW_CONTENT_TYPE = "image/png";
export const LINK_PREVIEW_CACHE_CONTROL = "public, max-age=300, s-maxage=86400";
export const LINK_PREVIEW_BUCKET = "kinic-wiki-link-preview-images";
export const PRODUCTION_CANISTER_ID = "6emaw-iyaaa-aaaay-aacka-cai";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const wikibrowserDir = resolve(scriptDir, "..");
const repoRoot = resolve(wikibrowserDir, "..");
const publicDir = resolve(wikibrowserDir, "public");

export function databaseLinkPreviewImageKey(databaseId) {
  return `db-link-preview/v1/${encodeURIComponent(databaseId.trim())}.png`;
}

export function activePublicDatabases(databases) {
  if (!Array.isArray(databases)) throw new Error("database list JSON must be an array");
  return databases
    .filter((database) => database && database.status === "active")
    .map((database) => {
      const databaseId = database.database_id;
      if (typeof databaseId !== "string" || databaseId.trim() === "") {
        throw new Error("database_id is required for active database");
      }
      const metadata = isRecord(database.metadata) ? database.metadata : {};
      const name = typeof metadata.name === "string" && metadata.name.trim() ? metadata.name : database.name;
      const description = typeof metadata.description === "string" ? metadata.description : "";
      return {
        databaseId: databaseId.trim(),
        title: typeof name === "string" && name.trim() ? name.trim() : databaseId.trim(),
        description: description.trim()
      };
    });
}

export function wranglerObjectPutArgs(bucket, key, filePath) {
  return [
    "exec",
    "wrangler",
    "r2",
    "object",
    "put",
    `${bucket}/${key}`,
    "--remote",
    "--file",
    filePath,
    "--content-type",
    LINK_PREVIEW_CONTENT_TYPE,
    "--cache-control",
    LINK_PREVIEW_CACHE_CONTROL
  ];
}

export async function renderLinkPreviewImage(input = {}) {
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

export async function writePng(response, filePath) {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, Buffer.from(await response.arrayBuffer()));
}

function kinicPreviewMark() {
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

function element(type, props, ...children) {
  return React.createElement(type, props, ...children);
}

function shortenPreviewText(value, maxLength) {
  const trimmed = value.trim();
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseArgs(argv) {
  const args = {
    canisterId: PRODUCTION_CANISTER_ID,
    upload: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--upload") {
      args.upload = true;
      continue;
    }
    if (arg === "--canister-id") {
      const value = argv[index + 1];
      if (!value) throw new Error("--canister-id requires a value");
      args.canisterId = value;
      index += 1;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

async function generateTopImages() {
  const response = await renderLinkPreviewImage();
  const imageBytes = await response.arrayBuffer();
  await mkdir(publicDir, { recursive: true });
  await writeFile(resolve(publicDir, "opengraph-image.png"), Buffer.from(imageBytes));
  await writeFile(resolve(publicDir, "twitter-image.png"), Buffer.from(imageBytes));
  console.log("generated top link preview images");
}

function listDatabases(canisterId) {
  const result = spawnSync(
    "cargo",
    ["run", "-p", "kinic-vfs-cli", "--", "--identity-mode", "anonymous", "--canister-id", canisterId, "database", "list", "--json"],
    {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"]
    }
  );
  if (result.status !== 0) throw new Error(`database list failed with exit code ${result.status}`);
  return activePublicDatabases(JSON.parse(result.stdout));
}

async function generateDatabaseImage(database, filePath) {
  const title = database.title;
  const description = database.description || `Browse, search, and query the ${title} wiki database.`;
  await writePng(
    await renderLinkPreviewImage({
      eyebrow: "Kinic Wiki database",
      accent: "Public wiki database",
      title,
      description,
      tags: [database.databaseId, "/Knowledge", "Search", "Query"]
    }),
    filePath
  );
}

function uploadObject(key, filePath) {
  const result = spawnSync("pnpm", wranglerObjectPutArgs(LINK_PREVIEW_BUCKET, key, filePath), {
    cwd: wikibrowserDir,
    encoding: "utf8",
    stdio: "inherit"
  });
  if (result.status !== 0) throw new Error(`R2 upload failed for ${key}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await generateTopImages();
  if (!args.upload) return;

  const databases = listDatabases(args.canisterId);
  const outputDir = resolve(tmpdir(), `kinic-wiki-link-preview-${Date.now()}`);
  await mkdir(outputDir, { recursive: true });
  console.log(`generating ${databases.length} database link preview images`);
  for (const database of databases) {
    const key = databaseLinkPreviewImageKey(database.databaseId);
    const filePath = resolve(outputDir, `${encodeURIComponent(database.databaseId)}.png`);
    await generateDatabaseImage(database, filePath);
    uploadObject(key, filePath);
    console.log(`uploaded ${key}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
