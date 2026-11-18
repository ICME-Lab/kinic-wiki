// Synthetic browser checks only: never operates on a real canister or real funds.
import {chromium,expect} from "../../wikibrowser/node_modules/@playwright/test/index.mjs";
const browser=await chromium.launch({headless:true});
try {
 const page=await browser.newPage({viewport:{width:375,height:812}});
 const origin=process.env.VAULT_FIXTURE_URL??"http://127.0.0.1:3023";
 const errors=[];page.on("pageerror",error=>errors.push(error.message));
 await page.goto(`${origin}/?state=opened`);await page.getByLabel("Document title").waitFor();
 if(!await page.evaluate(()=>!!window.syntheticNetwork))throw Error("Synthetic fixture required");
 await page.getByLabel("Document title").fill("Unsaved draft");
 await page.evaluate(()=>{window.parityRoot=window.syntheticVault.session.root;});
 await page.getByRole("button",{name:"Account settings"}).click();await page.waitForURL("**/settings");
 await expect(page.getByRole("region",{name:"Account settings"})).toBeVisible();
 await page.goBack();await expect(page.getByLabel("Document title")).toHaveValue("Unsaved draft");
 await page.goForward();await expect(page.getByRole("region",{name:"Account settings"})).toBeVisible();
 await page.getByRole("button",{name:"Back to Vault",exact:true}).click();
 if(!await page.evaluate(()=>window.parityRoot===window.syntheticVault.session.root))throw Error("Route navigation replaced root");
 await expect(page.getByRole("button",{name:"Permanently delete document and history",exact:true})).toHaveCount(0);
 await page.getByRole("button",{name:"New document",exact:true}).click();
 let dialog=page.getByRole("dialog",{name:"Discard unsaved changes?"});await expect(dialog).toBeVisible();
 await dialog.getByRole("button",{name:"Keep editing"}).click();await expect(page.getByLabel("Document title")).toHaveValue("Unsaved draft");
 let unload=false;page.once("dialog",async d=>{unload=d.type()==="beforeunload";await d.dismiss();});
 await page.reload({timeout:5000}).catch(()=>{});if(!unload)throw Error("Dirty reload did not ask for confirmation");
 await expect(page.getByLabel("Document title")).toHaveValue("Unsaved draft");
 await page.getByRole("button",{name:"Close Vault",exact:true}).click();
 dialog=page.getByRole("dialog",{name:"Discard unsaved changes?"});await expect(dialog).toBeVisible();
 await page.evaluate(()=>window.syntheticVault.session.lock());
 await expect(dialog).toHaveCount(0);await expect(page.getByLabel("Document title")).toHaveCount(0);
 await page.goto(`${origin}/settings`);await expect(page.getByRole("region",{name:"Account settings"})).toBeVisible();
 await expect(page.getByRole("button",{name:"Permanently delete this Vault"})).toHaveCount(0);
 await page.goto(`${origin}/help`);await expect(page.getByRole("heading",{name:"Vault help",exact:true})).toBeVisible();
 await expect(page.getByRole("link",{name:"Contact support"})).toHaveAttribute("referrerpolicy","no-referrer");
 await page.goto(`${origin}/missing-page`);await expect(page.getByRole("heading",{name:"Page not found"})).toBeVisible();
 if(errors.length)throw Error(errors.join("\n"));
 console.log("PASS: SPA history/deep links, draft preservation/cancel, native beforeunload, automatic-lock dialog cancellation, private root retention, settings isolation, help/404; zero page errors. Synthetic UI only.");
} finally {await browser.close();}
