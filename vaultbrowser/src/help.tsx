import {useLayoutEffect,useRef} from "react";
import {VaultButton,VaultPanel} from "./vault/ui";
import {useVaultNavigation} from "./navigation";
export function VaultHelp(){
 const nav=useVaultNavigation();const heading=useRef<HTMLHeadingElement>(null);
 useLayoutEffect(()=>{heading.current?.focus();},[]);
 return <section className="vault-settings" aria-labelledby="vault-help-title">
  <div className="vault-settings-header"><VaultButton tone="ghost" onClick={()=>nav.go("/")}>Back to Vault</VaultButton><h2 id="vault-help-title" ref={heading} tabIndex={-1}>Vault help</h2></div>
  <VaultPanel label="Using Vault"><h3>Documents and browser keys</h3><p>Documents are encrypted in your browser before upload. Saved browser keys let this browser reopen a Vault without another key retrieval. Account settings lets you remove saved keys from this browser. This keeps your documents but may require a paid retrieval next time.</p><h3>Closing and signing out</h3><p>Close Vault clears private views and active keys from memory. Sign out also ends this browser’s Internet Identity session. Saved browser keys remain until you delete them in Settings. Automatic expiry clears unsaved edits immediately.</p><h3>Unsaved changes</h3><p>Save your edits before replacing a document or leaving. Settings and Help preserve your current draft. Reloading cannot restore an unsaved draft.</p></VaultPanel>
  <VaultPanel label="Payments and storage"><h3>Payment recovery</h3><p>Check an uncertain payment or retry that same payment. Do not send a replacement while its result is unknown. Review the current quote and fees before approving.</p><h3>Storage maintenance and deletion</h3><p>Expired uploads and history beyond the retention limit are cleaned up automatically. Account settings also offers manual maintenance. Open a Vault’s actions menu to manage or permanently delete that Vault. Document actions let you permanently delete a document’s entire history. Permanent deletion cannot be undone.</p></VaultPanel>
  <a href="https://wiki.kinic.xyz/support" target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">Contact support</a>
 </section>;
}
export function VaultNotFound(){const nav=useVaultNavigation();return <section className="vault-settings"><h2>Page not found</h2><VaultButton onClick={()=>nav.go("/")}>Back to Vault</VaultButton></section>;}
