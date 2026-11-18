import {useLayoutEffect,useRef,useState} from "react";
import {Copy} from "lucide-react";
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
 return <VaultButton size="sm" disabled={disabled||status==="Copying…"} onClick={()=>{void copy();}}><Copy size={14} aria-hidden/><span aria-live="polite">{status}</span></VaultButton>;
}
