import {
  useLayoutEffect,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import type { Identity } from "@icp-sdk/core/agent";
import type { VaultClient } from "@kinic/vault-client";
import { createPrivateVaultClient } from "./actor";

// A refreshed delegation may have the same principal and a different identity object.
const identityIds = new WeakMap<Identity, number>();
let nextIdentityId = 0;
export function identityKey(identity: Identity) {
  let id = identityIds.get(identity);
  if (id === undefined) {
    id = ++nextIdentityId;
    identityIds.set(identity, id);
  }
  return id;
}

export function PrivateVaultClient({
  identity,
  children,
  failed,
  fallback,
}: {
  identity: Identity;
  children: (client: VaultClient) => ReactNode;
  failed: ReactNode;
  fallback: ReactNode;
}) {
  const [client, setClient] = useState<VaultClient>();
  const [error, setError] = useState(false);
  useLayoutEffect(() => {
    let disposed = false;
    let current: VaultClient | undefined;
    void createPrivateVaultClient(identity)
      .then((value) => {
        if (disposed) {
          value.destroy();
          return;
        }
        current = value;
        setClient(value);
      })
      .catch(() => {
        if (!disposed) setError(true);
      });
    return () => {
      disposed = true;
      current?.destroy();
    };
  }, [identity]);
  return client ? children(client) : error ? failed : fallback;
}

export function useIsolatedVaultSession(
  client: VaultClient,
  content: RefObject<HTMLElement | null>,
  onLock: () => void,
  checkResource?: () => Promise<unknown>,
) {
  useLayoutEffect(() => {
    const detach = client.session.addLockCleanup(() => {
      if (content.current) {
        const walker = document.createTreeWalker(
          content.current,
          NodeFilter.SHOW_TEXT,
        );
        while (walker.nextNode()) walker.currentNode.nodeValue = "";
      }
      onLock();
    });
    const activity = () => client.session.activity();
    const revalidate = () => {
      if (document.hidden || !client.session.root) return;
      const ticket = client.session.capture();
      void (checkResource ? checkResource() : client.refreshHeader()).catch(
        () => {
          if (ticket === client.session.capture()) client.session.lock();
        },
      );
    };
    const visible = () => {
      client.session.visible(document.hidden);
      revalidate();
    };
    const hide = () => client.session.lock();
    const activityEvents = ["pointerdown", "pointermove", "keydown", "scroll"];
    for (const event of activityEvents)
      window.addEventListener(event, activity, { capture: true, passive: true });
    window.addEventListener("pagehide", hide);
    window.addEventListener("focus", revalidate);
    document.addEventListener("visibilitychange", visible);
    visible();
    const expiry = window.setInterval(() => client.session.expire(), 1000);
    const access = window.setInterval(revalidate, 30_000);
    return () => {
      detach();
      client.session.lock();
      window.clearInterval(expiry);
      window.clearInterval(access);
      for (const event of activityEvents)
        window.removeEventListener(event, activity, true);
      window.removeEventListener("pagehide", hide);
      window.removeEventListener("focus", revalidate);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [client, content, onLock, checkResource]);
}
