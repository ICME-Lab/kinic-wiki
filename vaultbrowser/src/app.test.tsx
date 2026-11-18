// @vitest-environment jsdom
import {cleanup,fireEvent,render,screen,within} from "@testing-library/react";
import {afterEach,expect,it,vi} from "vitest";
const state=vi.hoisted(()=>({logout:vi.fn(),scope:{session:{addLockCleanup:()=>()=>{}}}}));
vi.mock("./auth",()=>({useVaultAuth:()=>({identity:{},loading:false,ready:true,login:()=>{},logout:state.logout})}));
vi.mock("./vault/page",()=>({default:()=>{useDirtyDraft(true,state.scope);return <main>Private editor</main>;}}));
import {useDirtyDraft,DraftGuardProvider} from "./draft-guard";
import {VaultNavigationScope} from "./navigation";
import {App} from "./app";
HTMLDialogElement.prototype.showModal=function(){this.open=true;};HTMLDialogElement.prototype.close=function(){this.open=false;};
afterEach(()=>{cleanup();vi.clearAllMocks();});
it("requires explicit discard before manual sign out and lets the user cancel",()=>{
 render(<VaultNavigationScope><DraftGuardProvider><App/></DraftGuardProvider></VaultNavigationScope>);
 fireEvent.click(screen.getByRole("button",{name:"Sign out"}));
 fireEvent.click(within(screen.getByRole("dialog")).getByRole("button",{name:"Keep editing"}));
 expect(state.logout).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole("button",{name:"Sign out"}));
 fireEvent.click(within(screen.getByRole("dialog")).getByRole("button",{name:"Discard changes"}));
 expect(state.logout).toHaveBeenCalledOnce();
});
