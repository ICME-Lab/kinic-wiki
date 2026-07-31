import { createRequire } from "node:module";
import { readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validatePng } from "./screenshot-image-validation.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "../../..");
const listingDirectory = path.join(repositoryRoot, "mobile/ios/store-listing");
const defaultBuildDirectory = path.join(
  repositoryRoot,
  "mobile/ios/build/AppStoreScreenshots",
);

const options = parseOptions(process.argv.slice(2));
const rawDirectory = path.resolve(options.rawDirectory ?? path.join(defaultBuildDirectory, "raw"));
const outputDirectory = path.resolve(
  options.outputDirectory ?? path.join(defaultBuildDirectory, "output"),
);

const [manifestSource, template, styles] = await Promise.all([
  readFile(path.join(listingDirectory, "screenshots.json"), "utf8"),
  readFile(path.join(listingDirectory, "screenshot-template.html"), "utf8"),
  readFile(path.join(listingDirectory, "screenshot-template.css"), "utf8"),
]);
const manifest = JSON.parse(manifestSource);

validateManifest(manifest);

const jobs = Object.entries(manifest.devices).flatMap(([device, dimensions]) =>
  manifest.scenes.map((scene, index) => ({
    device,
    dimensions,
    index,
    scene,
    sourcePath: path.join(rawDirectory, scene.sources[device]),
    outputPath: path.join(outputDirectory, `${device}-${scene.id}.png`),
  })),
);

const missingInputs = [];
const sourceByPath = new Map();
for (const job of jobs) {
  try {
    sourceByPath.set(job.sourcePath, await readFile(job.sourcePath));
  } catch (error) {
    if (error?.code === "ENOENT") {
      missingInputs.push(path.relative(repositoryRoot, job.sourcePath));
      continue;
    }
    throw error;
  }
}

if (missingInputs.length > 0) {
  throw new Error(
    `Missing ${missingInputs.length} App Store screenshot input(s):\n${missingInputs
      .map((input) => `- ${input}`)
      .join("\n")}`,
  );
}

for (const job of jobs) {
  validatePng(sourceByPath.get(job.sourcePath), job.dimensions, job.sourcePath, "Raw screenshot");
}

const requireFromWikiBrowser = createRequire(
  path.join(repositoryRoot, "wikibrowser/package.json"),
);
const { chromium } = requireFromWikiBrowser("@playwright/test");

await mkdir(outputDirectory, { recursive: true });
const browser = await chromium.launch({ headless: true });

try {
  for (const job of jobs) {
    const source = sourceByPath.get(job.sourcePath);
    const html = fillTemplate(template, {
      STYLES: styles,
      DEVICE_CLASS: escapeHtml(job.device),
      TITLE: escapeHtml(job.scene.title),
      SOURCE_DATA_URL: `data:image/png;base64,${source.toString("base64")}`,
    });

    const page = await browser.newPage({
      deviceScaleFactor: 1,
      viewport: job.dimensions,
    });
    await page.setContent(html, { waitUntil: "load" });
    await page.evaluate(async () => {
      await Promise.all(
        Array.from(document.images, (image) =>
          image.complete
            ? undefined
            : new Promise((resolve, reject) => {
                image.addEventListener("load", resolve, { once: true });
                image.addEventListener("error", reject, { once: true });
              }),
        ),
      );
      await document.fonts.ready;
    });
    await page.screenshot({
      animations: "disabled",
      fullPage: false,
      omitBackground: false,
      path: job.outputPath,
      type: "png",
    });
    await page.close();

    const output = await readFile(job.outputPath);
    validatePng(output, job.dimensions, job.outputPath, "Generated output");
    process.stdout.write(
      `${job.index + 1}. ${job.device} — ${job.scene.title} -> ${path.relative(repositoryRoot, job.outputPath)}\n`,
    );
  }
} finally {
  await browser.close();
}

function parseOptions(argumentsList) {
  const parsed = {};

  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    const value = argumentsList[index + 1];

    if (argument === "--raw-dir" || argument === "--output-dir") {
      if (!value || value.startsWith("--")) {
        throw new Error(`${argument} requires a directory path`);
      }
      const key = argument === "--raw-dir" ? "rawDirectory" : "outputDirectory";
      parsed[key] = value;
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${argument}`);
  }

  return parsed;
}

function validateManifest(value) {
  const expectedDevices = {
    iphone: { width: 1320, height: 2868 },
    ipad: { width: 2064, height: 2752 },
  };

  if (!Array.isArray(value.scenes) || value.scenes.length !== 5) {
    throw new Error("screenshots.json must contain exactly five scenes");
  }

  if (new Set(value.scenes.map((scene) => scene.id)).size !== value.scenes.length) {
    throw new Error("screenshots.json scene IDs must be unique");
  }

  for (const [device, expected] of Object.entries(expectedDevices)) {
    const actual = value.devices?.[device];
    if (actual?.width !== expected.width || actual?.height !== expected.height) {
      throw new Error(
        `${device} output must be ${expected.width} × ${expected.height}`,
      );
    }

    for (const scene of value.scenes) {
      if (!scene.title?.trim() || !scene.sources?.[device]) {
        throw new Error(`Scene ${scene.id ?? "<unknown>"} is missing ${device} copy or source`);
      }
    }
  }
}

function fillTemplate(source, replacements) {
  return Object.entries(replacements).reduce(
    (result, [key, value]) => result.replaceAll(`{{${key}}}`, value),
    source,
  );
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
