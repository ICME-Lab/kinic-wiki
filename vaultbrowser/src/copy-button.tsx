import {useLayoutEffect,useRef,useState} from "react";
import {Check,Copy,X} from "lucide-react";
import {VaultButton} from "./vault/ui";
export function CopyPasswordButton({value,disabled}:{value:string;disabled:boolean}){
 const [status,setStatus]=useState("Copy password");
 const lifecycle=useRef<{epoch:number;timer:number|undefined}>({epoch:0,timer:undefined});
 useLayoutEffect(()=>{const owned=lifecycle.current;owned.epoch++;setStatus("Copy password");return()=>{owned.epoch++;window.clearTimeout(owned.timer);};},[value]);
 const copy=async()=>{
  const owned=lifecycle.current;const ticket=++owned.epoch;window.clearTimeout(owned.timer);setStatus("Copying…");
  try{await navigator.clipboard.writeText(value);if(owned.epoch===ticket)setStatus("Copied");}
  catch{if(owned.epoch===ticket)setStatus("Copy failed");}
  finally{if(owned.epoch===ticket)owned.timer=window.setTimeout(()=>setStatus("Copy password"),3000);}
 };
 const Icon=status==="Copied"?Check:status==="Copy failed"?X:Copy;
 return <VaultButton size="icon" tone="ghost" className="vault-icon-button" title={status} disabled={disabled||status==="Copying…"} onClick={()=>{void copy();}}><Icon aria-hidden/><span className="sr-only" aria-live="polite">{status}</span></VaultButton>;
}
