import { createContext, useCallback, useContext, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useModalDialog } from "@kinic/ui/use-modal-dialog";
import { VaultButton } from "./vault/ui";

type Guard = {
  register: (lease: object, dirty: boolean) => void;
  release: (lease: object) => void;
  protect: (action: () => void) => void;
};
const Context = createContext<Guard | null>(null);
export function DraftGuardProvider({ children }: { children: ReactNode }) {
  const parent = useContext(Context);
  return parent ? children : <OwnedGuard>{children}</OwnedGuard>;
}
function OwnedGuard({ children }: { children: ReactNode }) {
  const leases = useRef(new Map<object, boolean>());
  const version = useRef(0);
  const pending = useRef<((discard: boolean) => void) | null>(null);
  const [confirming, setConfirming] = useState(false);
  const finish = useCallback((discard: boolean) => {
    const resolve = pending.current;
    pending.current = null;
    setConfirming(false);
    resolve?.(discard);
  }, []);
  const [guard] = useState<Guard>(() => ({
    register: (lease, dirty) => { leases.current.set(lease, dirty); },
    release: (lease) => {
      if (leases.current.delete(lease)) { version.current++; finish(false); }
    },
    protect: (action) => {
      if (pending.current) return;
      if (![...leases.current.values()].some(Boolean)) { action(); return; }
      const ticket = version.current;
      pending.current = (discard) => { if (discard && version.current === ticket) action(); };
      setConfirming(true);
    },
  }));
  useLayoutEffect(() => {
    const unload = (event: BeforeUnloadEvent) => {
      if (![...leases.current.values()].some(Boolean)) return;
      event.preventDefault(); event.returnValue = "";
    };
    window.addEventListener("beforeunload", unload);
    return () => { window.removeEventListener("beforeunload", unload); pending.current = null; };
  }, []);
  return <Context.Provider value={guard}>{children}{confirming ? <DiscardDialog finish={finish} /> : null}</Context.Provider>;
}
function DiscardDialog({ finish }: { finish: (discard: boolean) => void }) {
  const { dialogRef, handleCancel } = useModalDialog(() => finish(false), false);
  return <dialog ref={dialogRef} onCancel={handleCancel} className="vault-confirm-dialog" aria-labelledby="discard-title" aria-describedby="discard-description">
    <h2 id="discard-title">Discard unsaved changes?</h2>
    <p id="discard-description">Your unsaved edits will be lost.</p>
    <div className="vault-disclosure-actions">
      <VaultButton data-modal-initial-focus onClick={() => finish(false)}>Keep editing</VaultButton>
      <VaultButton tone="danger" onClick={() => finish(true)}>Discard changes</VaultButton>
    </div>
  </dialog>;
}
export function useDraftGuard() {
  const guard = useContext(Context);
  if (!guard) throw Error("DraftGuardProviderMissing");
  return guard;
}
export function useDirtyDraft(dirty: boolean, scope: {session:{addLockCleanup:(cleanup:()=>void)=>()=>void}}) {
  const guard = useDraftGuard();
  const lease = useRef({});
  const active=useRef(false);
  useLayoutEffect(() => {
    const token = lease.current;
    active.current=true;
    guard.register(token, false);
    const detach=scope.session.addLockCleanup(()=>{active.current=false;guard.release(token);});
    return () => {active.current=false;detach();guard.release(token);};
  }, [guard, scope]);
  useLayoutEffect(() => { if(active.current) guard.register(lease.current, dirty); }, [guard, scope, dirty]);
}
