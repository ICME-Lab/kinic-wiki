import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { chromium, expect } from "@playwright/test";
import { build } from "esbuild";

// Exercise the real popup module and markup; only Chrome messaging is replaced.
test("settings persist both generation folders, reject invalid paths, and recover from save errors", async () => {
  const root = new URL("../", import.meta.url);
  const html = await readFile(new URL("popup/popup.html", root), "utf8");
  const bundle = await build({ entryPoints: [new URL("popup/popup.js", root).pathname], bundle: true, write: false, format: "esm", define: { "process.env.KINIC_CAPTURE_DATABASE_ID": '""' } });
  const server = createServer(async (req, res) => {
    if (req.url === "/popup/popup.html") { res.setHeader("content-type", "text/html"); res.end(html); }
    else if (req.url === "/dist/popup.js") { res.setHeader("content-type", "text/javascript"); res.end(bundle.outputFiles[0].text); }
    else {
      try { res.end(await readFile(new URL(req.url.slice(1), root))); }
      catch { res.writeHead(404); res.end(); }
    }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  let browser;
  try {
    browser = await chromium.launch();
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(() => {
      window.chrome = { runtime: { sendMessage: async message => {
        const config = JSON.parse(localStorage.getItem("test-config") || "{}");
        if (message.type === "load-config") return { ok: true, config };
        if (message.type === "save-config") {
          if (Object.hasOwn(message.config, "showSaveControls")) return { ok: false, error: "fixture save failure" };
          localStorage.setItem("test-config", JSON.stringify({ ...config, ...message.config }));
        }
        return { ok: true, value: null };
      } } };
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/popup/popup.html`);
    await expect(page.locator("#principal")).toHaveText("Not logged in");
    const web = page.getByLabel("Web page generation folder", { exact: true });
    const conversation = page.getByLabel("AI conversation generation folder", { exact: true });
    await expect(web).toHaveValue("/Knowledge/web");
    await web.fill("/Knowledge/articles/");
    await conversation.fill("/Knowledge/会話/");
    await page.getByRole("button", { name: "Save generation folders" }).click();
    await expect(page.locator("#status")).toHaveText("Generation folders saved.");
    await page.reload();
    await expect(web).toHaveValue("/Knowledge/articles");
    await expect(conversation).toHaveValue("/Knowledge/会話");
    await web.fill("/Knowledge/../private");
    await page.getByRole("button", { name: "Save generation folders" }).click();
    await expect(page.locator("#status")).toContainText("below /Knowledge/");
    await page.reload();
    await expect(web).toHaveValue("/Knowledge/articles");
    await page.locator("#show-save-controls").click();
    await expect(page.locator("#status")).toHaveText("fixture save failure");
    await expect(page.locator("#show-save-controls")).toBeChecked();
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
});
