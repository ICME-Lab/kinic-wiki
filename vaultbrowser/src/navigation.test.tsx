// @vitest-environment jsdom
import {cleanup,fireEvent,render,screen,waitFor} from "@testing-library/react";
import {afterEach,beforeEach,expect,it,vi} from "vitest";
import {useState} from "react";
import {createMemoryHistory} from "@tanstack/react-router";
import {VaultRouter,useVaultNavigation} from "./navigation";
beforeEach(()=>{vi.spyOn(window,"scrollTo").mockImplementation(()=>{});});
afterEach(()=>{cleanup();vi.restoreAllMocks();});
function Views(){const n=useVaultNavigation();const [text,setText]=useState("");return <><output>{n.view}</output><input aria-label="Draft" value={text} onChange={e=>setText(e.target.value)}/><button onClick={()=>n.go("/settings")}>Settings</button></>}
it("routes settings and browser history without remounting the draft owner",async()=>{
 const history=createMemoryHistory({initialEntries:["/"]});
 render(<VaultRouter history={history}><Views/></VaultRouter>);
 fireEvent.change(await screen.findByLabelText("Draft"),{target:{value:"private draft"}});
 fireEvent.click(screen.getByText("Settings")); await screen.findByText("settings");
 expect(history.location.pathname).toBe("/settings");
 history.back(); await screen.findByText("workspace");
 expect(screen.getByLabelText("Draft")).toHaveProperty("value","private draft");
 history.forward();await screen.findByText("settings");
});
it("loads a deep settings URL without private selection state in the URL",async()=>{
 const history=createMemoryHistory({initialEntries:["/settings"]});
 render(<VaultRouter history={history}><Views/></VaultRouter>);
 await screen.findByText("settings");expect(screen.getByLabelText("Draft")).toHaveProperty("value","");
 await waitFor(()=>expect(history.location.pathname).toBe("/settings"));
});
