// @vitest-environment jsdom
import {cleanup,fireEvent,render,screen,waitFor} from "@testing-library/react";
import {afterEach,expect,it,vi} from "vitest";
import {CopyPasswordButton} from "./copy-button";
afterEach(()=>{cleanup();vi.restoreAllMocks();});
it("reports clipboard failure and lets the same copy be retried",async()=>{
 Object.defineProperty(navigator,"clipboard",{configurable:true,value:{writeText:vi.fn().mockRejectedValueOnce(Error("denied")).mockResolvedValue(undefined)}});
 render(<CopyPasswordButton value="private secret" disabled={false}/>);
 fireEvent.click(screen.getByRole("button",{name:"Copy password"}));
 await screen.findByRole("button",{name:"Copy failed"});
 fireEvent.click(screen.getByRole("button",{name:"Copy failed"}));
 await screen.findByRole("button",{name:"Copied"});
 expect(screen.queryByText("private secret")).toBeNull();
});
it("does not report an earlier copy as successful after the credential changes",async()=>{
 let finish!:()=>void;
 Object.defineProperty(navigator,"clipboard",{configurable:true,value:{writeText:()=>new Promise<void>(resolve=>{finish=resolve;})}});
 const view=render(<CopyPasswordButton value="old" disabled={false}/>);
 fireEvent.click(screen.getByRole("button",{name:"Copy password"}));
 view.rerender(<CopyPasswordButton value="new" disabled={false}/>);finish();
 await waitFor(()=>expect(screen.getByRole("button",{name:"Copy password"})).toBeTruthy());
 expect(screen.queryByRole("button",{name:"Copied"})).toBeNull();
});
