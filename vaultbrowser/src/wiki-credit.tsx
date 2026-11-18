import { useLayoutEffect, useRef, useState } from "react";
import type { VaultClient } from "@kinic/vault-client";
import type { LinkStatus, VaultBridgeActor } from "@kinic/credit-bridge-candid";
import {
  acceptMessage,
  bridgeOk,
  bridgeUrl,
  bytes,
  hex,
  message,
  parseLaunch,
  sessionFence,
  type Launch,
} from "@kinic/credit-bridge-candid/browser";
import { vaultCreditActor, creditOrigins } from "./wiki-credit-actor";
import { VaultButton } from "./vault/ui";
const randomId = () => hex(crypto.getRandomValues(new Uint8Array(16)));
export function WikiCreditFunding({
  client,
  onFunded,
}: {
  client: VaultClient;
  onFunded: () => Promise<void>;
}) {
  const [actor, setActor] = useState<VaultBridgeActor>();
  const [link, setLink] = useState<LinkStatus>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("Checking Wiki link…");
  const [channelOpen, setChannelOpen] = useState(false);
  const [handoff] = useState(() =>
    typeof window === "undefined" ? null : parseLaunch(window.location.hash),
  );
  const handoffUsed = useRef(false);
  // Funding follows authentication/client lifetime, never the decryption-root lock.
  const current = useRef(client);
  current.current = client;
  const live = useRef(false),
    epoch = useRef(0),
    working = useRef(false);
  const stopChannel = useRef<() => void>(() => {});
  const funded = useRef(onFunded);
  funded.current = onFunded;
  const fence = () =>
    sessionFence(() =>
      live.current
        ? {
            identity: current.current.identity,
            client: current.current,
            epoch: epoch.current,
          }
        : null,
    );
  useLayoutEffect(() => {
    live.current = true;
    epoch.current++;
    working.current = false;
    setActor(undefined);
    setLink(undefined);
    setBusy(false);
    const check = sessionFence(() =>
      live.current
        ? {
            identity: current.current.identity,
            client: current.current,
            epoch: epoch.current,
          }
        : null,
    );
    void (async () => {
      const a = await vaultCreditActor(client);
      check();
      setActor(a);
      const status = bridgeOk(await a.wiki_link_status());
      check();
      setLink(status[0]);
      setNotice("");
    })().catch(() => {
      try {
        check();
        setNotice("Wiki link unavailable. Refresh status to try again.");
      } catch {
        /* stale */
      }
    });
    return () => {
      live.current = false;
      // The current epoch fences requests that resolve after this session closes.
      // oxlint-disable-next-line react-hooks/exhaustive-deps
      epoch.current++;
      // The channel closer changes when a popup opens; cleanup must use the latest one.
      // oxlint-disable-next-line react-hooks/exhaustive-deps
      stopChannel.current();
    };
  }, [client]);
  const work = (fn: (check: () => void) => Promise<void>) => {
    if (working.current) return;
    const check = fence();
    working.current = true;
    setBusy(true);
    setNotice("");
    void fn(check)
      .catch(() => {
        try {
          check();
          setNotice(
            "Request did not complete. Open Wiki to recover the saved transfer before trying another charge.",
          );
        } catch {
          /* stale */
        }
      })
      .finally(() => {
        try {
          check();
          working.current = false;
          setBusy(false);
        } catch {
          /* stale */
        }
      });
  };
  const openWiki = (mode: Launch["mode"]) => {
    if (!actor || working.current) return;
    stopChannel.current();
    // This must remain synchronous within the user's click, before any await.
    const popup = window.open("about:blank", "_blank");
    if (!popup) {
      setNotice("Allow popups, then try again. No transfer was started.");
      return;
    }
    const check = fence();
    const nonce = hex(crypto.getRandomValues(new Uint8Array(32)));
    const origins = creditOrigins();
    let active = true,
      launchId = "",
      operation: string | undefined,
      preparing = false;
    const started = Date.now();
    const channelCheck = () => {
      check();
      if (!active || popup.closed) throw Error("Channel closed");
    };
    const stop = () => {
      if (!active) return;
      active = false;
      window.removeEventListener("message", receive);
      window.clearInterval(timer);
      popup.close();
      if (live.current) setChannelOpen(false);
    };
    const receive = (event: MessageEvent) => {
      try {
        channelCheck();
      } catch {
        stop();
        return;
      }
      const m = acceptMessage(event, {
        origin: origins.wiki,
        source: popup,
        nonce,
      });
      if (!m) return;
      // A reloaded Wiki page can carry its authenticated backend receipt ID.
      // ACK only establishes the same owned channel; prepare remains pinned below.
      if (
        m.type === "hello" &&
        (m.id === launchId ||
          (mode === "fund" && (!operation || m.id === operation)))
      ) {
        popup.postMessage(message("ack", m.id, nonce), origins.wiki);
        return;
      }
      if (m.type === "linked" && mode === "link" && m.id === launchId) {
        work(async (checkWork) => {
          const status = bridgeOk(await actor.wiki_link_status());
          checkWork();
          channelCheck();
          setLink(status[0]);
          setNotice(
            status[0]?.active
              ? "Wiki account linked. Choose Charge from Wiki credits here to open a new funding window."
              : "Link approval is incomplete. Resume from Wiki.",
          );
        });
      }
      if (
        m.type === "offer" &&
        mode === "fund" &&
        !preparing &&
        (!operation || operation === m.id)
      ) {
        operation = m.id;
        preparing = true;
        void (async () => {
          const receipt = bridgeOk(
            await actor.prepare_wiki_credit(bytes(m.id)),
          );
          channelCheck();
          if (
            hex(receipt.offer.operation) !== m.id ||
            receipt.offer.vault_owner.toText() !==
              client.identity.getPrincipal().toText() ||
            !("Prepared" in receipt.status || "Accepted" in receipt.status)
          )
            throw Error("Invalid receipt");
          popup.postMessage(message("ready", m.id, nonce), origins.wiki);
          setNotice(
            "Vault is ready. Review the held amount and send from the Wiki window.",
          );
        })()
          .catch(() => {
            try {
              channelCheck();
              setNotice(
                "Preparation did not complete. Retry preparation from the Wiki window.",
              );
            } catch {
              /* stale */
            }
          })
          .finally(() => {
            preparing = false;
          });
      }
      if (m.type === "result" && mode === "fund" && m.id === operation) {
        void (async () => {
          channelCheck();
          await funded.current();
          channelCheck();
          setNotice(
            "Wiki transfer status changed. Review the receipt in Wiki and the refreshed Vault balance.",
          );
        })().catch(() => {});
      }
    };
    window.addEventListener("message", receive);
    const timer = window.setInterval(() => {
      try {
        channelCheck();
        if (Date.now() - started > 10 * 60_000) throw Error("Timeout");
      } catch {
        stop();
        try {
          check();
          setNotice(
            "Wiki window closed or timed out. Reopen it to recover the saved transfer.",
          );
        } catch {
          /* stale */
        }
      }
    }, 500);
    stopChannel.current = stop;
    setChannelOpen(true);
    work(async (checkWork) => {
      if (mode === "link") {
        const challenge = bridgeOk(
          await actor.begin_wiki_link(bytes(randomId())),
        );
        checkWork();
        channelCheck();
        launchId = hex(challenge.challenge);
      } else {
        launchId =
          handoff?.mode === "fund" && !handoffUsed.current
            ? handoff.id
            : randomId();
        handoffUsed.current = true;
      }
      channelCheck();
      popup.location.replace(
        bridgeUrl("wiki", { mode, id: launchId, nonce }, origins),
      );
      setNotice(
        mode === "link"
          ? "Approve the account link in the Wiki window."
          : "Choose a database and review a manual charge in the Wiki window.",
      );
    });
  };
  return (
    <section
      aria-label="Wiki credit funding"
      className="grid min-w-0 gap-3 border-t border-line pt-4 [&_button]:min-h-11"
    >
      <h3 className="font-semibold">Use Wiki database credits</h3>
      <p className="text-sm">
        Link your independently signed-in Wiki account, then manually move
        database credits to this Vault account. Linking never charges a
        database. The account pairing is permanent; revocation disables future
        transfers.
      </p>
      {link ? (
        <p className="break-all text-sm">
          Wiki principal: {link.wiki_owner.toText()} ·{" "}
          {link.active ? "Linked" : "Revoked"}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <VaultButton disabled={!actor || busy} onClick={() => openWiki("link")}>
          {link?.active ? "Review Wiki link" : "Link Wiki account"}
        </VaultButton>
        <VaultButton
          disabled={!actor || busy || !link?.active}
          tone="primary"
          onClick={() => openWiki("fund")}
        >
          Charge from Wiki credits
        </VaultButton>
        <VaultButton
          disabled={!actor || busy}
          onClick={() =>
            work(async (check) => {
              const status = bridgeOk(await actor!.wiki_link_status());
              check();
              setLink(status[0]);
              setNotice(
                status[0]?.active
                  ? "Wiki link is active."
                  : "No active Wiki link. Link an account to charge from its databases.",
              );
            })
          }
        >
          Refresh Wiki link
        </VaultButton>
        {link?.active ? (
          <VaultButton
            disabled={busy}
            onClick={() => {
              stopChannel.current();
              work(async (check) => {
                bridgeOk(await actor!.revoke_wiki_link());
                check();
                setLink({ ...link, active: false });
                setNotice(
                  "Link revoked. Existing dispatched transfers can still settle.",
                );
              });
            }}
          >
            Revoke Wiki link
          </VaultButton>
        ) : null}
        {channelOpen ? (
          <VaultButton
            onClick={() => {
              stopChannel.current();
              setNotice(
                "Window closed. Existing holds remain recoverable from Wiki.",
              );
            }}
          >
            Close Wiki window
          </VaultButton>
        ) : null}
      </div>
      {notice ? (
        <output className="text-sm">
          {notice}
        </output>
      ) : null}
    </section>
  );
}
