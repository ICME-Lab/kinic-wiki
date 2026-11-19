export async function startApplication(load:()=>Promise<unknown>, root:HTMLElement){
 try {await load();} catch {
  root.replaceChildren();
  const title=document.createElement("h1");title.textContent="Vault could not start";
  const message=document.createElement("p");message.textContent="Check your connection and reload to try again.";
  const reload=document.createElement("a");reload.href="";reload.textContent="Reload Vault";
  root.setAttribute("role","alert");root.append(title,message,reload);
 }
}
