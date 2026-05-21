// Where: extensions/wiki-clipper/scripts/generate-store-assets.mjs
// What: Render Chrome Web Store promotional and screenshot PNGs.
// Why: Store assets should match the Kinic-branded extension UI without entering the upload zip.
import { mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const playwrightPath = new URL("../../../wikibrowser/node_modules/@playwright/test/index.js", import.meta.url);
const playwright = await import(playwrightPath.href);
const chromium = playwright.chromium ?? playwright.default?.chromium;
const logoDataUri = `data:image/png;base64,${await readFile(resolve(root, "icons/icon-128.png"), "base64")}`;

await mkdir(resolve(root, "store-listing/assets"), { recursive: true });
await mkdir(resolve(root, "store-listing/screenshots"), { recursive: true });

const browser = await chromium.launch({ headless: true });
try {
  await renderAsset(promoHtml(), "store-listing/assets/promo-small-440x280.png", 440, 280);
  await renderAsset(marqueeHtml(), "store-listing/assets/marquee-1400x560.png", 1400, 560);
  await renderAsset(optionsHtml(), "store-listing/screenshots/options-1280x800.png", 1280, 800);
  await renderAsset(chatGptHtml(), "store-listing/screenshots/chatgpt-export-1280x800.png", 1280, 800);
} finally {
  await browser.close();
}

console.log("generated Chrome Web Store assets");

async function renderAsset(html, outputPath, width, height) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  await page.setContent(html, { waitUntil: "load" });
  await page.screenshot({ path: resolve(root, outputPath), fullPage: false });
  await page.close();
}

function shell(content, width, height, extraCss = "") {
  return `<!doctype html><html><head><meta charset="utf-8"><style>${baseCss()}body{width:${width}px;height:${height}px;overflow:hidden}${extraCss}</style></head><body>${content}</body></html>`;
}

function promoHtml() {
  return shell(
    `<div class="promo-wrap"><img class="mark" src="${logoDataUri}" alt=""><h1>Kinic Wiki<br>Clipper</h1><p>Save web pages and ChatGPT conversations into your Kinic Wiki database.</p><div class="decor"><span></span><span></span><span></span></div><div class="stripe"></div></div>`,
    440,
    280,
    `.promo-wrap{position:relative;width:440px;height:280px;padding:34px;background:#fff}.promo-wrap h1{margin:20px 0 8px;font-size:32px;line-height:1.05;letter-spacing:0}.promo-wrap p{width:270px;margin:0;font-size:15px;line-height:1.45;color:#636161}.decor{display:grid;gap:7px;margin-top:22px}.decor span{height:5px;border-radius:999px;background:#ff2686}.decor span:nth-child(1){width:188px;background:#ff81be26}.decor span:nth-child(2){width:148px;background:#ffcde5}.decor span:nth-child(3){width:108px}.stripe{position:absolute;right:-28px;top:0;width:150px;height:280px;background:linear-gradient(180deg,#ff81be26 0%,#ffcde5 44%,#ff2686 100%);clip-path:polygon(34% 0,100% 0,68% 50%,100% 100%,34% 100%,62% 50%)}`
  );
}

function marqueeHtml() {
  return shell(
    `<div class="marquee"><div class="copy"><img class="mark" src="${logoDataUri}" alt=""><h1>Kinic Wiki Clipper</h1><p>Capture web pages and ChatGPT conversations into your Kinic Wiki database with Internet Identity authentication.</p><div class="actions"><span>Web URL ingest</span><span>ChatGPT export</span><span>Writable databases</span></div></div><div class="preview"><div class="browser"><div class="bar"><i></i><i></i><i></i></div><div class="rows"><b></b><b></b><b></b><b></b></div><div class="panel"><strong>Kinic Wiki Clipper</strong><p>Export complete. Success 10.</p><button>Saved to wiki</button></div></div></div><div class="stripe"></div></div>`,
    1400,
    560,
    `.marquee{position:relative;width:1400px;height:560px;overflow:hidden;background:#fff;padding:72px 86px}.copy{position:relative;z-index:2;width:560px}.copy .mark{width:64px;height:64px;border-radius:18px}.copy h1{margin:26px 0 14px;font-size:58px;line-height:1.02;letter-spacing:0}.copy p{margin:0;width:540px;color:#4d4d4d;font-size:24px;line-height:1.42}.actions{display:flex;gap:12px;margin-top:34px}.actions span{border:1px solid #ffcde5;border-radius:999px;background:#ff81be26;color:#ff2686;padding:11px 15px;font-size:16px;font-weight:800}.preview{position:absolute;right:90px;top:72px;z-index:2;width:610px;height:416px}.browser{height:416px;border:1px solid #e6e6e6;border-radius:22px;background:#f8f8f8;box-shadow:0 28px 70px rgb(0 0 0 / 15%);overflow:hidden}.bar{height:54px;background:#fff;border-bottom:1px solid #e6e6e6;display:flex;gap:8px;align-items:center;padding-left:22px}.bar i{width:12px;height:12px;border-radius:999px;background:#d0d0d0}.rows{padding:34px 38px}.rows b{display:block;height:18px;border-radius:999px;background:#e6e6e6;margin-bottom:18px}.rows b:nth-child(1){width:420px}.rows b:nth-child(2){width:320px}.rows b:nth-child(3){width:455px}.rows b:nth-child(4){width:260px}.panel{position:absolute;right:34px;bottom:32px;width:360px;background:#fff;border:1px solid #e6e6e6;border-radius:18px;padding:22px;box-shadow:0 22px 55px rgb(0 0 0 / 18%)}.panel strong{font-size:22px}.panel p{font-size:16px;color:#636161;margin:8px 0 18px}.panel button{background:#000;color:#fff;border:0;border-radius:14px;padding:13px 18px;font-weight:800}.stripe{position:absolute;right:-64px;top:0;width:300px;height:560px;background:linear-gradient(180deg,#ff81be26 0%,#ffcde5 44%,#ff2686 100%);clip-path:polygon(32% 0,100% 0,70% 50%,100% 100%,32% 100%,62% 50%)}`
  );
}

function optionsHtml() {
  return shell(
    `<div class="stage"><div class="top"><div class="brand"><img class="mark" src="${logoDataUri}" alt=""><div><h1>Kinic Wiki Clipper</h1><p class="muted">Authenticated destination settings</p></div></div><span class="pill">Internet Identity</span></div><section class="card panel"><div class="row"><div><strong>Internet Identity</strong><p class="principal muted">principal-2vxsx-fae...</p></div><span class="pill">Connected</span></div><div class="actions"><button class="primary">Login</button><button class="secondary">Logout</button></div><span class="label">Database</span><div class="field select"><span>db_d36yep4rv43e (Writer)</span><span class="muted">Hot</span></div><div class="actions"><button class="secondary">Refresh</button><button class="primary">Save settings</button></div><div class="latest"><strong>Latest URL ingest</strong><p class="muted">ok: /Sources/ingest-requests/example.md</p></div><div class="status">Databases loaded</div></section><div class="hero"><div class="stripe"></div></div></div>`,
    1280,
    800,
    `.stage{position:relative;height:800px;padding:72px 88px;background:linear-gradient(180deg,#fff 0%,#fff 58%,#f8f8f8 100%)}.top{display:flex;align-items:center;justify-content:space-between;margin-bottom:42px}.brand{display:flex;align-items:center;gap:18px}.brand h1{margin:0;font-size:36px;letter-spacing:0}.brand p{margin:5px 0 0;font-size:18px}.panel{width:520px;padding:22px}.row{display:flex;align-items:center;justify-content:space-between;gap:18px}.principal{font-family:ui-monospace,Menlo,monospace;font-size:15px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:300px}.actions{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:18px}.label{display:block;margin:26px 0 9px;font-size:15px;font-weight:800}.select{height:52px;display:flex;align-items:center;justify-content:space-between}.latest{margin-top:18px;padding:18px;border-radius:16px;background:#f8f8f8;border:1px solid #e6e6e6}.status{margin-top:18px;color:#4d4d4d;font-weight:700}.hero{position:absolute;right:96px;bottom:80px;width:400px;height:300px}.stripe{position:absolute;right:0;top:0;width:170px;height:300px;background:linear-gradient(180deg,#ff81be26 0%,#ffcde5 44%,#ff2686 100%);clip-path:polygon(35% 0,100% 0,70% 50%,100% 100%,35% 100%,65% 50%);opacity:.95}`
  );
}

function chatGptHtml() {
  return shell(
    `<div class="chat"><div class="chatline"></div><div class="chatline short"></div><div class="chatline"></div><div class="chatline short"></div></div><section class="panel"><div class="header"><div class="brand"><img class="mark" src="${logoDataUri}" alt=""><div><h1>Kinic Wiki Clipper</h1><p class="muted">Export ChatGPT conversations into your wiki</p></div></div><span class="pill">ChatGPT export</span></div><div class="body"><div class="settings"><div class="row"><strong>Database ID</strong><div class="field input">db_d36yep4rv43e</div></div><div class="export"><strong>Export recent chats</strong><p class="muted">Processing takes about 10 seconds per chat.</p><div class="control"><div class="field count">10</div><button class="primary">Export</button></div></div></div><div class="logs"><strong>Logs</strong><p class="muted">Export complete. Success 10.</p><div class="log"><span class="ok">K</span><div><strong>Saved conversation source</strong><div class="muted">ChatGPT</div></div></div></div></div></section><button class="fab"><img class="mark small" src="${logoDataUri}" alt=""> Kinic Wiki Clipper</button>`,
    1280,
    800,
    `body{background:#fff}.chat{position:absolute;inset:0;background:#f8f8f8;padding:70px 100px;color:#636161}.chatline{width:680px;height:20px;border-radius:999px;background:#e6e6e6;margin:20px 0}.chatline.short{width:420px}.fab{position:absolute;right:72px;bottom:64px;display:flex;align-items:center;gap:10px;border-radius:999px;background:#000;color:#fff;border:0;padding:13px 18px;font-weight:800;box-shadow:0 4px 10px #14142b0a}.small{width:24px;height:24px;border-radius:8px}.panel{position:absolute;right:72px;bottom:128px;width:660px;background:#fff;color:#000;border:1px solid #e6e6e6;border-radius:16px;box-shadow:0 30px 80px rgb(0 0 0 / 18%);overflow:hidden}.header{display:flex;align-items:center;justify-content:space-between;padding:18px 22px;border-bottom:1px solid #e6e6e6}.brand{display:flex;align-items:center;gap:14px}.brand h1{margin:0;font-size:20px}.brand p{margin:3px 0 0;font-size:13px}.body{padding:18px}.settings{border:1px solid #e6e6e6;border-radius:16px;background:#f8f8f8;padding:18px}.row{display:flex;align-items:center;justify-content:space-between}.input{width:270px;text-align:left}.export{margin-top:16px;background:#fff;border:1px solid #e6e6e6;border-radius:16px;padding:18px}.control{display:flex;justify-content:space-between;align-items:center;margin-top:14px}.count{width:68px;text-align:center}.logs{margin-top:14px;border:1px solid #e6e6e6;border-radius:16px;padding:16px}.log{display:flex;gap:12px;align-items:center;padding:12px;background:#f8f8f8;border-radius:16px}.ok{width:38px;height:38px;border-radius:12px;background:#def2e6;color:#11845b;display:grid;place-items:center;font-weight:900}`
  );
}

function baseCss() {
  return `*{box-sizing:border-box}body{margin:0;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#000}.mark{display:block;width:48px;height:48px;border-radius:14px;object-fit:cover;box-shadow:0 4px 10px #14142b0a}.primary{background:#000;color:#fff;border:1px solid #000;border-radius:16px;padding:13px 18px;font-weight:800;box-shadow:none}.primary:hover{background:#ff2686;border-color:#ff2686}.secondary{background:#fff;color:#000;border:1px solid #e6e6e6;border-radius:16px;padding:12px 16px;font-weight:750;box-shadow:0 4px 10px #14142b0a}.card{background:#fff;border:1px solid #e6e6e6;border-radius:20px;box-shadow:none}.muted{color:#636161}.pill{border:1px solid #ffcde5;border-radius:999px;background:#ff81be26;color:#ff2686;padding:7px 12px;font-size:14px;font-weight:800}.field{border:1px solid #d0d0d0;border-radius:12px;background:#fff;padding:14px 16px;color:#000}`;
}
