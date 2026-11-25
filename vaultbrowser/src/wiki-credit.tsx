import { useEffect, useLayoutEffect, useRef, useState } from "react";
import "./wiki-credit.css";
import { Link2, RefreshCw } from "lucide-react";
import { StatusPill, type StatusTone } from "@kinic/ui/status-pill";
import { PrincipalText } from "@kinic/ui/principal";
import { formatCycles, formatRawCycles } from "@kinic/ui/cycles";
import type { VaultClient } from "@kinic/vault-client";
import type { AutoTopupStatus, LinkStatus, VaultBridgeActor } from "@kinic/credit-bridge-candid";
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
import { useConfirm } from "./vault/confirm";
const randomId = () => hex(crypto.getRandomValues(new Uint8Array(16)));
/** The refill policy, or undefined when Wiki cannot say; never fails the card. */
async function loadAuto(actor: VaultBridgeActor): Promise<AutoTopupStatus | null | undefined> {
  try {
    const reply = await actor.wiki_auto_topup_status();
    return "Ok" in reply ? (reply.Ok[0] ?? null) : undefined;
  } catch {
    return undefined;
  }
}
type LinkView = { label: string; tone: StatusTone; description: string };
function linkView(
  checking: boolean,
  unavailable: boolean,
  link: LinkStatus | undefined,
): LinkView {
  if (unavailable)
    return {
      label: "Unavailable",
      tone: "danger",
      description: "Wiki link status could not be loaded. Check again in a moment.",
    };
  if (checking)
    return { label: "Checking…", tone: "neutral", description: "Checking whether a Wiki account is linked." };
  if (link?.active)
    return {
      label: "Linked",
      tone: "positive",
      description: "Move credits from one of your Wiki databases into this Vault. You review and confirm each transfer in Wiki.",
    };
  if (link)
    return {
      label: "Link revoked",
      tone: "warn",
      description: "Transfers are turned off. You can link the same Wiki account again.",
    };
  return {
    label: "Not linked",
    tone: "neutral",
    description: "Link your Wiki account once to pay for Vault with Wiki database credits. Linking moves no credits.",
  };
}
export function WikiCreditFunding({
  client,
  onFunded,
  balance = null,
}: {
  client: VaultClient;
  onFunded: () => Promise<void>;
  /** The Vault prepaid balance, so a finished charge is visible here. */
  balance?: bigint | null;
}) {
  const [actor, setActor] = useState<VaultBridgeActor>();
  const [link, setLink] = useState<LinkStatus>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [unavailable, setUnavailable] = useState(false);
  // undefined: not loaded; null: no standing refill policy in Wiki.
  const [auto, setAuto] = useState<AutoTopupStatus | null>();
  const autoRun = useRef({ running: false, lastAt: 0 });
  // True only after wiki_link_status answered, so "Not linked" never shows while checking.
  const [loaded, setLoaded] = useState(false);
  const [channelOpen, setChannelOpen] = useState(false);
  const [handoff] = useState(() =>
    typeof window === "undefined" ? null : parseLaunch(window.location.hash),
  );
  const handoffUsed = useRef(false);
  const [confirm, confirmDialog] = useConfirm();
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
    setAuto(undefined);
    setUnavailable(false);
    setLoaded(false);
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
      setLoaded(true);
      setNotice("");
      if (status[0]?.active) setAuto(await loadAuto(a));
      check();
    })().catch(() => {
      try {
        check();
        setUnavailable(true);
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
            "Vault is ready. Wiki is sending the held amount.",
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
  // A standing Wiki policy refills this Vault without a window once the
  // balance drops below its threshold. Wiki enforces the limits; this only asks.
  useEffect(() => {
    if (!actor || !link?.active || !auto || balance === null) return;
    if (balance >= auto.policy.threshold_cycles) return;
    const run = autoRun.current;
    if (run.running || Date.now() - run.lastAt < 60_000) return;
    run.running = true;
    run.lastAt = Date.now();
    const check = fence();
    void (async () => {
      const reply = bridgeOk(await actor.request_wiki_auto_topup());
      check();
      const receipt = reply[0];
      if (!receipt) return;
      const amount = formatCycles(receipt.offer.amount_cycles);
      if ("Accepted" in receipt.status) {
        setNotice(`Refilled ${amount} cycles from Wiki.`);
        await funded.current();
      } else if ("Prepared" in receipt.status) {
        setNotice(`A ${amount} refill from Wiki is still settling. Check it in Wiki.`);
      }
      const policy = await loadAuto(actor);
      check();
      setAuto(policy);
    })()
      .catch(() => {
        try {
          check();
          setNotice("Automatic refill from Wiki did not run. Charge manually or check the policy in Wiki.");
        } catch {
          /* stale */
        }
      })
      .finally(() => {
        run.running = false;
      });
    // fence() reads refs only; re-running on its identity would retrigger refills.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [actor, link, auto, balance]);
  const refresh = () =>
    work(async (check) => {
      const a = actor ?? (await vaultCreditActor(current.current));
      check();
      setActor(a);
      const status = bridgeOk(await a.wiki_link_status());
      check();
      setUnavailable(false);
      setLink(status[0]);
      setLoaded(true);
      setAuto(status[0]?.active ? await loadAuto(a) : undefined);
      check();
    });
  const view = linkView(!loaded && !unavailable, unavailable, link);
  const wikiOwner = link?.wiki_owner.toText();
  return (
    <div className="vault-settings-group">
    <h3 className="vault-settings-group-title">Wiki credits</h3>
    <section
      aria-label="Wiki credit funding"
      className="vault-panel vault-wiki-credit"
    >
      <div className="vault-wiki-credit-head">
        <span className="vault-wiki-credit-icon" aria-hidden><Link2 size={16} /></span>
        <div className="vault-wiki-credit-title">
          <h4>Wiki account</h4>
          {wikiOwner ? (
            <PrincipalText value={wikiOwner} />
          ) : null}
        </div>
        <output className="vault-wiki-credit-status" aria-live="polite">
          <StatusPill dot tone={view.tone} label={view.label} />
        </output>
      </div>
      <p className="vault-wiki-credit-description">{view.description}</p>
      {link?.active ? (
        <dl className="vault-wiki-credit-balance">
          <dt>Vault balance</dt>
          <dd title={balance === null ? "Balance unavailable" : `${formatRawCycles(balance)} cycles`}>
            {balance === null ? "--" : `${formatCycles(balance)} cycles`}
          </dd>
        </dl>
      ) : null}
      {link?.active && auto !== undefined ? (
        <div className="vault-wiki-credit-auto">
          <StatusPill
            dot
            tone={auto ? "positive" : "neutral"}
            label={auto ? "Auto top-up on" : "Auto top-up off"}
          />
          <span className="vault-wiki-credit-auto-text">
            {auto
              ? `Adds ${formatCycles(auto.policy.amount_cycles)} from ${auto.database_name} when the balance is below ${formatCycles(auto.policy.threshold_cycles)} · ${formatCycles(auto.sent_today_cycles)} of ${formatCycles(auto.policy.daily_limit_cycles)} used today`
              : "Refill this Vault from a Wiki database automatically when the balance runs low."}
          </span>
          <VaultButton
            size="sm"
            tone="ghost"
            disabled={!actor || busy}
            onClick={() => openWiki("fund")}
          >
            {auto ? "Change in Wiki" : "Set up in Wiki"}
          </VaultButton>
        </div>
      ) : null}
      {channelOpen ? (
        <div className="vault-notice vault-notice--info vault-wiki-credit-window">
          <span>Wiki window is open. Finish there, then come back.</span>
          <VaultButton
            size="sm"
            onClick={() => {
              stopChannel.current();
              setNotice(
                "Window closed. Existing holds remain recoverable from Wiki.",
              );
            }}
          >
            Close Wiki window
          </VaultButton>
        </div>
      ) : null}
      <div className="vault-wiki-credit-actions">
        {link?.active ? (
          <VaultButton
            disabled={!actor || !loaded || busy}
            tone="primary"
            onClick={() => openWiki("fund")}
          >
            Charge from Wiki credits
          </VaultButton>
        ) : (
          <VaultButton
            disabled={!actor || !loaded || busy}
            tone="primary"
            onClick={() => openWiki("link")}
          >
            Link Wiki account
          </VaultButton>
        )}
        <VaultButton
          tone="ghost"
          size="icon"
          aria-label="Refresh Wiki link"
          title="Refresh Wiki link"
          disabled={busy}
          onClick={refresh}
        >
          <RefreshCw size={15} aria-hidden />
        </VaultButton>
        {link?.active ? (
          <VaultButton
            tone="ghost"
            className="vault-wiki-credit-revoke"
            disabled={busy}
            onClick={() => {
              void confirm({
                title: "Revoke Wiki link?",
                description: "Charging from Wiki credits stops for this Vault account. Transfers already sent can still settle. You can link the same Wiki account again later.",
                confirmLabel: "Revoke link",
              }).then((confirmed) => {
                if (!confirmed) return;
                stopChannel.current();
                work(async (check) => {
                  bridgeOk(await actor!.revoke_wiki_link());
                  check();
                  setLink({ ...link, active: false });
                  setNotice(
                    "Link revoked. Existing dispatched transfers can still settle.",
                  );
                });
              });
            }}
          >
            Revoke Wiki link
          </VaultButton>
        ) : null}
      </div>
      {notice ? (
        <output className="vault-wiki-credit-notice">
          {notice}
        </output>
      ) : null}
      {confirmDialog}
    </section>
    </div>
  );
}
