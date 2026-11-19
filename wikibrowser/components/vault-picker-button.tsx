"use client";

import { LockKeyhole } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import { isVaultId, trustedVaultOrigin, vaultReferenceMarkdown } from "@/lib/vault-reference";

export function VaultPickerButton({
  disabled,
  onInsert
}: {
  disabled: boolean;
  onInsert: (reference: string) => void;
}) {
  const cleanup = useRef<() => void>(undefined);
  const insert = useRef(onInsert);
  const [blocked, setBlocked] = useState(false);

  useLayoutEffect(() => {
    insert.current = onInsert;
  }, [onInsert]);

  useLayoutEffect(() => () => cleanup.current?.(), [disabled]);

  function openPicker() {
    cleanup.current?.();
    const origin = trustedVaultOrigin(window.location.origin);
    const opened = window.open(`${origin}/pick`, "_blank", "popup,width=640,height=720");
    setBlocked(!opened);
    if (!opened) return;
    const popup = opened;

    let connected = false;
    function listen(event: MessageEvent<unknown>) {
      if (event.origin !== origin || event.source !== popup) return;
      if (!event.data || typeof event.data !== "object") return;
      const data = event.data as Record<string, unknown>;
      const keys = Object.keys(data);
      if (!keys.includes("type")) return;
      // Reloading keeps the owned WindowProxy but resets the picker's listener.
      if (data.type === "kinic-vault-picker-ready" && keys.length === 1) {
        popup.postMessage({ type: "kinic-vault-picker-connect" }, origin);
        connected = true;
        return;
      }
      if (
        connected && data.type === "kinic-vault-selection" && keys.length === 3
        && keys.includes("vault") && isVaultId(data.vault)
        && keys.includes("object") && isVaultId(data.object)
      ) {
        close();
        insert.current(vaultReferenceMarkdown(`${origin}/embed/${data.vault}/${data.object}`));
      }
    }
    function close() {
      window.removeEventListener("message", listen);
      cleanup.current = undefined;
      popup.close();
    }
    cleanup.current = close;
    window.addEventListener("message", listen);
  }

  return (
    <>
      <button
        type="button"
        className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink hover:border-accent disabled:cursor-not-allowed disabled:opacity-50"
        onClick={openPicker}
        disabled={disabled}
      >
        <LockKeyhole aria-hidden="true" size={15} />
        {blocked ? "Retry Vault picker" : "Insert private document"}
      </button>
      {blocked ? (
        <output className="order-last basis-full text-sm text-warnText">
          Vault picker was blocked. Allow pop-ups for this site and try again.
        </output>
      ) : null}
    </>
  );
}
