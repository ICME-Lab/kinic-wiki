// @vitest-environment jsdom
import {cleanup,render,screen} from "@testing-library/react";
import {afterEach,expect,it,vi} from "vitest";
import {useLayoutEffect} from "react";
import {VaultErrorBoundary} from "./error-boundary";
afterEach(()=>{cleanup();vi.restoreAllMocks();});
it("unmounts private state and renders a generic recovery instead of the thrown content",()=>{
 vi.spyOn(console,"error").mockImplementation(()=>{});
 const dispose=vi.fn();
 function Private({fail}:{fail:boolean}){useLayoutEffect(()=>dispose,[]);if(fail)throw Error("private document contents");return <input aria-label="Private editor" defaultValue="private document contents"/>;}
 const view=render(<VaultErrorBoundary><Private fail={false}/></VaultErrorBoundary>);
 view.rerender(<VaultErrorBoundary><Private fail/></VaultErrorBoundary>);
 expect(dispose).toHaveBeenCalledOnce();expect(screen.queryByLabelText("Private editor")).toBeNull();
 expect(screen.getByRole("alert").textContent).not.toContain("private document contents");
 expect(screen.getByRole("link",{name:"Reload Vault"})).toBeTruthy();
});
