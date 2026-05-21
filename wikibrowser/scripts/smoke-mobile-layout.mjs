import { spawnSync } from "node:child_process";

const baseUrl = readBaseUrl();
const databaseId = readDatabaseId();
const viewports = [
  [320, 568],
  [375, 667],
  [390, 844]
];
const browserRoutes = [
  "/Wiki?read=anonymous",
  "/Wiki?read=anonymous&view=raw",
  "/Wiki?read=anonymous&view=edit",
  "/Wiki?read=anonymous&tab=query",
  "/Wiki?read=anonymous&tab=ingest",
  "/Wiki?read=anonymous&tab=sources",
  "/search?q=Wiki&kind=path&read=anonymous",
  "/graph?center=%2FWiki&depth=1&read=anonymous",
  "/graph?read=anonymous"
];

runOptional("close", []);
run("open", [`${baseUrl}/${encodeURIComponent(databaseId)}/Wiki?read=anonymous`]);
for (const [width, height] of viewports) {
  run("resize", [String(width), String(height)]);
  for (const route of browserRoutes) {
    run("goto", [`${baseUrl}/${encodeURIComponent(databaseId)}${route}`]);
    run("eval", [wikiLayoutProbe(route)]);
  }
  run("goto", [baseUrl]);
  run("eval", [dashboardLayoutProbe()]);
  run("goto", [`${baseUrl}/dashboard/${encodeURIComponent(databaseId)}`]);
  run("eval", [genericLayoutProbe()]);
  run("goto", [`${baseUrl}/skills/${encodeURIComponent(databaseId)}`]);
  run("eval", [genericLayoutProbe()]);
}

console.log(`Wiki browser mobile layout smoke OK: ${baseUrl} ${databaseId}`);

function readBaseUrl() {
  const argIndex = process.argv.indexOf("--base-url");
  const value = argIndex >= 0 ? process.argv[argIndex + 1] : process.env.WIKI_BROWSER_BASE_URL;
  return (value ?? "http://localhost:3000").replace(/\/$/, "");
}

function readDatabaseId() {
  const argIndex = process.argv.indexOf("--database-id");
  const value = argIndex >= 0 ? process.argv[argIndex + 1] : process.env.WIKI_BROWSER_DATABASE_ID;
  return value ?? "testdb";
}

function wikiLayoutProbe(route) {
  const expectsTallDocument = route.startsWith("/Wiki?");
  return `async () => {
    const failures = [];
    const documentPanel = document.querySelector('[data-tid="wiki-document-panel"]');
    const documentHeader = documentPanel?.firstElementChild;
    const explorerPanel = document.querySelector('[data-tid="wiki-explorer-panel"]');
    const inspectorPanel = document.querySelector('[data-tid="wiki-inspector-panel"]');
    const mobileMenuButton = document.querySelector('[data-tid="mobile-sidebar-toggle"]');
    const brandLink = document.querySelector('[aria-label="Back to database dashboard"]');
    const graphLink = document.querySelector('a[aria-label="Graph"]');
    const graphLabel = graphLink?.querySelector("span");
    const searchForm = document.querySelector('form[aria-label], form');
    if (!documentPanel) failures.push("missing document panel");
    if (${JSON.stringify(expectsTallDocument)} && /node|directory|\\/Wiki|skill-categories/i.test(documentHeader?.textContent ?? "")) failures.push("document header shows node path metadata");
    if (!explorerPanel) failures.push("missing explorer panel");
    if (!mobileMenuButton) failures.push("missing mobile sidebar toggle");
    if (!isVisible(brandLink)) failures.push("brand link is not visible before mobile menu opens");
    if (!graphLink) failures.push("missing graph link");
    if (isVisible(graphLabel)) failures.push("graph text is visible on mobile");
    if (mobileMenuButton?.querySelector("svg")?.getAttribute("width") !== graphLink?.querySelector("svg")?.getAttribute("width")) {
      failures.push("menu and graph icon sizes differ");
    }
    if (graphLink?.getBoundingClientRect().height !== document.querySelector('a[title="Share on X"]')?.getBoundingClientRect().height) {
      failures.push("graph and share button heights differ");
    }
    if (location.pathname.endsWith("/graph") && !graphLink?.getAttribute("href")?.includes("/Wiki")) {
      failures.push("graph link does not close graph view");
    }
    if (isVisible(explorerPanel)) failures.push("explorer panel is visible before mobile menu opens");
    if (isVisible(inspectorPanel)) failures.push("inspector panel is visible on mobile");
    if (documentPanel && explorerPanel && isVisible(explorerPanel) && documentPanel.getBoundingClientRect().top > explorerPanel.getBoundingClientRect().top) {
      failures.push("document panel is not first on mobile");
    }
    if (${JSON.stringify(expectsTallDocument)} && documentPanel && documentPanel.getBoundingClientRect().height < 220) {
      failures.push("document panel is compressed");
    }
    if (${JSON.stringify(expectsTallDocument)} && document.scrollingElement && document.scrollingElement.scrollHeight <= window.innerHeight) {
      failures.push("page is not vertically scrollable");
    }
    if (document.documentElement.scrollWidth > document.documentElement.clientWidth + 1) {
      failures.push("page overflows horizontally");
    }
    if (searchForm) {
      const formRect = searchForm.getBoundingClientRect();
      for (const child of searchForm.children) {
        const rect = child.getBoundingClientRect();
        if (rect.left < formRect.left - 1 || rect.right > formRect.right + 1) {
          failures.push("search control escapes form");
        }
      }
    } else {
      failures.push("missing search form");
    }
    mobileMenuButton?.click();
    await new Promise((resolve) => requestAnimationFrame(resolve));
    if (!isVisible(explorerPanel)) failures.push("explorer panel does not open from mobile menu");
    if (!isVisible(brandLink)) failures.push("brand link disappears after mobile menu opens");
    if (mobileMenuButton?.getAttribute("aria-expanded") !== "true") failures.push("mobile menu button is not expanded after click");
    const visibleTabs = Array.from(document.querySelectorAll('[aria-label="Left sidebar mode"] a')).filter((link) => isVisible(link)).map((link) => link.textContent?.trim()).join(",");
    if (visibleTabs !== "explorer,query,ingest,sources") failures.push("mobile sidebar tabs are not visible");
    const sourcesLink = Array.from(document.querySelectorAll('[aria-label="Left sidebar mode"] a')).find((link) => link.textContent?.trim() === "sources");
    sourcesLink?.click();
    await new Promise((resolve) => requestAnimationFrame(resolve));
    if (!isVisible(explorerPanel)) failures.push("explorer panel closes after mobile sidebar navigation");
    if (mobileMenuButton?.getAttribute("aria-expanded") !== "true") failures.push("mobile menu button collapses after sidebar navigation");
    if (isVisible(inspectorPanel)) failures.push("inspector panel becomes visible after mobile menu opens");
    if (document.documentElement.scrollWidth > document.documentElement.clientWidth + 1) {
      failures.push("page overflows horizontally after mobile menu opens");
    }
    if (failures.length > 0) throw new Error(failures.join("; "));
    return true;

    function isVisible(element) {
      if (!element) return false;
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    }
  }`;
}

function dashboardLayoutProbe() {
  return `() => {
    const failures = [];
    const table = document.querySelector("table");
    if (table && table.getBoundingClientRect().width > 0) {
      failures.push("database table is visible on mobile");
    }
    const databaseLinks = Array.from(document.querySelectorAll('a[href*="/Wiki"]')).filter((link) => link.textContent?.includes("Open"));
    if (databaseLinks.length > 0) {
      const readableCards = databaseLinks.some((link) => {
        const card = link.closest("article");
        return card && card.getBoundingClientRect().width <= document.documentElement.clientWidth;
      });
      if (!readableCards) failures.push("database rows are not rendered as mobile cards");
    }
    if (document.documentElement.scrollWidth > document.documentElement.clientWidth + 1) {
      failures.push("dashboard overflows horizontally");
    }
    if (failures.length > 0) throw new Error(failures.join("; "));
    return true;
  }`;
}

function genericLayoutProbe() {
  return `() => {
    const failures = [];
    if (document.documentElement.scrollWidth > document.documentElement.clientWidth + 1) {
      failures.push("page overflows horizontally");
    }
    if (failures.length > 0) throw new Error(failures.join("; "));
    return true;
  }`;
}

function run(command, args) {
  const result = spawnSync("playwright-cli", [command, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  const output = `${result.stdout}${result.stderr}`;
  if (result.status !== 0) {
    throw new Error(output);
  }
  return output;
}

function runOptional(command, args) {
  spawnSync("playwright-cli", [command, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
}
