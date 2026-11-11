import { useEffect, useRef, useState } from "react";
import type { Session } from "@kinic/vault-client/session";
import { VaultButton, VaultField, VaultPanel } from "./ui";
type Prompt = {
  label: string;
  limit: number;
  ticket: number;
  resolve: (data: Uint8Array) => void;
  reject: (error: Error) => void;
};
/** Files are read only after a fresh user selection; no browser persistence or retained File objects. */
export function useRecoveryFiles(session: Session) {
  const [prompt, setPrompt] = useState<Prompt>();
  const mountedTicket = useRef(session.capture());
  const current = useRef<Prompt | undefined>(undefined),
    buffers = useRef(new Set<Uint8Array>());
  const clear = () => {
    for (const b of buffers.current) b.fill(0);
    buffers.current.clear();
  };
  const stop = (reason = "FileSelectionCancelled") => {
    const p = current.current;
    current.current = undefined;
    p?.reject(Error(reason));
    setPrompt(undefined);
    clear();
  };
  useEffect(() => {
    const detach = session.addLockCleanup(() => stop("Locked"));
    return () => {
      detach();
      stop("Locked");
    };
  }, [session]);
  const select = (label: string, limit = 256 * 1024 * 1024) =>
    new Promise<Uint8Array>((resolve, reject) => {
      session.check(mountedTicket.current);
      if (current.current) {
        reject(Error("Busy"));
        return;
      }
      const p = { label, limit, ticket: session.capture(), resolve, reject };
      current.current = p;
      setPrompt(p);
    });
  const read = async (file: File) => {
    const p = current.current;
    if (!p) return;
    let raw: Uint8Array | undefined;
    try {
      if (file.size > p.limit) throw Error("RecoveryFileTooLarge");
      raw = new Uint8Array(await file.arrayBuffer());
      session.check(p.ticket);
      if (current.current !== p) throw Error("Locked");
      buffers.current.add(raw);
      current.current = undefined;
      setPrompt(undefined);
      p.resolve(raw);
    } catch (e) {
      raw?.fill(0);
      if (current.current === p) {
        current.current = undefined;
        setPrompt(undefined);
        p.reject(e instanceof Error ? e : Error("InvalidKit"));
      }
    }
  };
  return {
    prompt,
    select,
    read,
    stop,
    clear,
    track: (b: Uint8Array) => {
      try {
        session.check(mountedTicket.current);
      } catch (error) {
        b.fill(0);
        throw error;
      }
      buffers.current.add(b);
      return b;
    },
    save: async (data: Uint8Array, name: string) => {
      session.check(mountedTicket.current);
      session.download(data, name);
    },
  };
}
export function RecoveryFilePrompt({
  files,
}: {
  files: ReturnType<typeof useRecoveryFiles>;
}) {
  if (!files.prompt) return null;
  return (
    <VaultPanel label="Recovery file selection">
      <p className="text-sm">
        Choose the saved file from disk. Verification checks its contents; your
        browser cannot attest durable storage.
      </p>
      <VaultField
        key={files.prompt.label}
        label={files.prompt.label}
        type="file"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) void files.read(f);
        }}
      />
      <VaultButton onClick={() => files.stop()}>
        Stop file selection
      </VaultButton>
    </VaultPanel>
  );
}
