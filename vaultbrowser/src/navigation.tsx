import {VaultFailure} from "./error-boundary";
import {createContext,useContext,useState,useLayoutEffect,type ReactNode} from "react";
import {createRootRoute,createRoute,createRouter,RouterProvider,Outlet,useNavigate,useRouterState,createBrowserHistory} from "@tanstack/react-router";
export type VaultView="workspace"|"settings"|"vault-settings"|"help"|"not-found";
export type VaultPath="/"|"/settings"|"/vault-settings"|"/help";
type Navigation={view:VaultView;go:(path:VaultPath)=>void};
const Context=createContext<Navigation|null>(null);
const viewFor=(path:string):VaultView=>path==="/"?"workspace":path==="/settings"?"settings":path==="/vault-settings"?"vault-settings":path==="/help"?"help":"not-found";
export function VaultRouter({children,history}:{children:ReactNode;history?:ReturnType<typeof createBrowserHistory>}) {
 const [router]=useState(()=>{
  const root=createRootRoute({component:()=> <RouterFrame>{children}<Outlet/></RouterFrame>,notFoundComponent:()=>null,errorComponent:VaultFailure});
  const routes=(["/","/settings","/vault-settings","/help"] as const).map(path=>createRoute({getParentRoute:()=>root,path,component:()=>null}));
  return createRouter({routeTree:root.addChildren(routes),history,scrollRestoration:false});
 });
 return <RouterProvider router={router}/>;
}
function RouterFrame({children}:{children:ReactNode}) {
 const pathname=useRouterState({select:s=>s.location.pathname});
 const navigate=useNavigate();
 useLayoutEffect(()=>{document.getElementById((pathname==="/settings"||pathname==="/vault-settings")?"vault-settings-title":pathname==="/help"?"vault-help-title":"vault-main")?.focus();},[pathname]);
 return <Context.Provider value={{view:viewFor(pathname),go:path=>{void navigate({to:path});}}}>{children}</Context.Provider>;
}
// Isolated component hosts can own navigation without browser history; the app and fixture use VaultRouter.
export function VaultNavigationScope({children}:{children:ReactNode}) {
 const existing=useContext(Context);
 return existing?children:<LocalNavigation>{children}</LocalNavigation>;
}
function LocalNavigation({children}:{children:ReactNode}) {
 const [view,setView]=useState<VaultView>("workspace");
 return <Context.Provider value={{view,go:path=>setView(viewFor(path))}}>{children}</Context.Provider>;
}
export function useVaultNavigation(){const nav=useContext(Context);if(!nav)throw Error("VaultNavigationMissing");return nav;}
