// @vitest-environment jsdom
import {expect,it} from "vitest";
import {startApplication} from "./startup";
it("offers a safe reload when the application chunk cannot load",async()=>{
 const root=document.createElement("div");root.textContent="Loading Vault…";
 await startApplication(async()=>{throw Error("private payload must not appear")},root);
 expect(root.textContent).toContain("Vault could not start");
 expect(root.textContent).not.toContain("private payload");
 expect(root.querySelector("a")?.textContent).toBe("Reload Vault");
});
