"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  LinkChallenge,
  LinkStatus,
  VaultTransfer,
  WikiBridgeActor,
} from "@kinic/credit-bridge-candid";
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
import { Button } from "@kinic/ui/button";
import { useAppSession } from "@/app/app-session-provider";
import { AdminPanel, AdminPageHeader, AdminField } from "@/components/admin-ui";
import { StatusPill } from "@/components/ui/status-pill";
import { CheckCircle2, CircleAlert } from "lucide-react";
import { PrincipalText } from "@kinic/ui/principal";
import { AutoTopupPanel } from "./auto-topup-panel";
import { formatCycles, formatRawCycles } from "@kinic/ui/cycles";
import {
  creditOrigins,
  ownerDatabases,
  wikiCreditActor,
} from "@/lib/vault-credit";
type DatabaseChoice = {
  databaseId: string;
  name: string;
  cyclesBalance: string;
};
function cyclesOf(text: string): bigint | null {
  try {
    return BigInt(text);
  } catch {
    return null;
  }
}
/** "1.25T cycles" for display; small or unparsable values stay exact. */
function cyclesLabel(text: string): string {
  const value = cyclesOf(text);
  if (value === null) return `${text} cycles`;
  return value >= 1_000_000n ? `${formatCycles(value)} cycles` : `${formatRawCycles(value)} cycles`;
}
function WikiCredits({ databases }: { databases: DatabaseChoice[] }) {
  if (!databases.length) return null;
  const total = databases.reduce((sum, db) => sum + (cyclesOf(db.cyclesBalance) ?? 0n), 0n);
  return (
    <AdminPanel className="grid min-w-0 gap-3" ariaLabel="Your Wiki credits">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-semibold">Your Wiki credits</h2>
        <span className="font-mono text-sm font-semibold" title={`${formatRawCycles(total)} cycles`}>
          {cyclesLabel(total.toString())} total
        </span>
      </div>
      <ul className="grid divide-y divide-line rounded-lg border border-line bg-white">
        {databases.map((db) => (
          <li key={db.databaseId} className="flex min-w-0 items-center justify-between gap-3 px-3 py-2 text-sm">
            <span className="min-w-0 truncate">{db.name}</span>
            <span className="shrink-0 font-mono" title={`${db.cyclesBalance} cycles`}>
              {cyclesLabel(db.cyclesBalance)}
            </span>
          </li>
        ))}
      </ul>
      <p className="text-xs text-muted">
        Auto top-up pays from one of these databases.
      </p>
    </AdminPanel>
  );
}
// Persist only the opaque server receipt reference in this popup's URL, never amounts or identity.
function rememberTransferReference(
  launch: Launch | null,
  transfer?: VaultTransfer,
) {
  if (launch?.mode !== "fund" || !transfer) return;
  const fragment = new URLSearchParams({
    ...launch,
    id: hex(transfer.offer.operation),
    receipt: "1",
  }).toString();
  if (!parseLaunch(fragment)) throw Error("Invalid receipt identifier");
  window.history.replaceState(
    window.history.state,
    "",
    `${window.location.pathname}${window.location.search}#${fragment}`,
  );
}
export function VaultCreditClient({ canisterId }: { canisterId: string }) {
  const session = useAppSession();
  const identity =
    session.principal && !session.authLoading
      ? session.authClient?.getIdentity()
      : undefined;
  const current = useRef(session);
  current.current = session;
  const live = useRef(false),
    epoch = useRef(0),
    working = useRef(false),
    initialized = useRef(false);
  const [launch, setLaunch] = useState<Launch | null>(null);
  const [launchParsed, setLaunchParsed] = useState(false);
  const [actor, setActor] = useState<WikiBridgeActor>();
  const [link, setLink] = useState<LinkStatus>();
  const [challenge, setChallenge] = useState<LinkChallenge>();
  const [databases, setDatabases] = useState<DatabaseChoice[]>([]);
  const [transfer, setTransfer] = useState<VaultTransfer>();
  // A nonce/window authorizes one authenticated operation, including recovery.
  const channelOperation = useRef<string | undefined>(undefined);
  const transferRef = useRef(transfer);
  transferRef.current = transfer;
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [notice, setNotice] = useState("");
  const [loaded, setLoaded] = useState(false);
  const available = loaded && !!actor;
  const peer = useRef<Window | null>(null);
  const connectedRef = useRef(false);
  const boundIdentity = useRef(identity);
  const readSession = () => {
    const s = current.current;
    return live.current &&
      !s.authLoading &&
      s.principal &&
      s.authClient &&
      s.authClient.getIdentity() === boundIdentity.current
      ? {
          identity: s.authClient.getIdentity(),
          client: s.authClient,
          epoch: epoch.current,
        }
      : null;
  };
  const fence = () => sessionFence(readSession);
  const update = useCallback(
    (value: VaultTransfer) => {
      const operation = hex(value.offer.operation);
      if (channelOperation.current && channelOperation.current !== operation)
        throw Error("This window is bound to another transfer");
      channelOperation.current = operation;
      rememberTransferReference(launch, value);
      setTransfer(value);
      transferRef.current = value;
      setUncertain(false);
    },
    [launch],
  );
  useEffect(() => {
    setLaunch(parseLaunch(window.location.hash));
    setLaunchParsed(true);
  }, []);
  useEffect(() => {
    live.current = true;
    epoch.current++;
    boundIdentity.current = identity;
    working.current = false;
    initialized.current = false;
    setActor(undefined);
    setTransfer(undefined);
    setChallenge(undefined);
    setLink(undefined);
    setLoaded(false);
    setUncertain(false);
    setBusy(false);
    setConnected(false);
    connectedRef.current = false;
    const invalidate = () => {
      live.current = false;
      initialized.current = false;
      epoch.current++;
      connectedRef.current = false;
    };
    if (!identity || !launchParsed) return invalidate;
    const check = sessionFence(() => {
      const s = current.current;
      return live.current &&
        !s.authLoading &&
        s.principal &&
        s.authClient &&
        s.authClient.getIdentity() === identity
        ? {
            identity: s.authClient.getIdentity(),
            client: s.authClient,
            epoch: epoch.current,
          }
        : null;
    });
    let disposed = false;
    const origins = creditOrigins();
    peer.current = launch ? window.opener : null;
    const opener = peer.current;
    let acknowledged = false;
    let channelActive = true;
    const started = Date.now();
    const sendHello = () => {
      if (opener && launch && !opener.closed)
        opener.postMessage(
          message("hello", launch.id, launch.nonce),
          origins.vault,
        );
    };
    const receive = (event: MessageEvent) => {
      try {
        check();
      } catch {
        return;
      }
      if (!channelActive || !launch || !opener || opener.closed) return;
      const m = acceptMessage(event, {
        origin: origins.vault,
        source: opener,
        nonce: launch.nonce,
      });
      if (!m) return;
      if (m.type === "ack" && m.id === launch.id) {
        acknowledged = true;
        connectedRef.current = true;
        setConnected(true);
      }
    };
    window.addEventListener("message", receive);
    sendHello();
    const timer = window.setInterval(() => {
      try {
        check();
        if (
          channelActive &&
          opener &&
          (opener.closed || Date.now() - started > 10 * 60_000)
        ) {
          channelActive = false;
          window.removeEventListener("message", receive);
          connectedRef.current = false;
          setConnected(false);
          setNotice(
            "Vault window closed or timed out. Saved transfers remain available for status checks and reconciliation. Continue in Vault to reconnect.",
          );
        }
        if (channelActive && !acknowledged) sendHello();
      } catch {
        window.removeEventListener("message", receive);
        window.clearInterval(timer);
        connectedRef.current = false;
        setConnected(false);
        if (!disposed) {
          initialized.current = false;
          setLoaded(false);
          setActor(undefined);
          setTransfer(undefined);
          setNotice("Wiki session changed. Reload to recover saved status.");
        }
      }
    }, 500);
    void (async () => {
      // This marker only restricts reuse. Backend authentication still gates the receipt.
      if (launch?.receipt === "1") {
        if (channelOperation.current && channelOperation.current !== launch.id)
          throw Error("Receipt mismatch");
        channelOperation.current = launch.id;
      }
      const a = await wikiCreditActor(canisterId, identity);
      check();
      const status = bridgeOk(await a.get_vault_link());
      check();
      setLink(status[0]);
      // A valid saved receipt takes precedence over another tab's pending transfer.
      let savedTransfer: VaultTransfer | undefined;
      const savedId =
        channelOperation.current ??
        (launch?.mode === "fund" ? launch.id : undefined);
      if (savedId) {
        const saved = await a.get_vault_transfer(bytes(savedId));
        check();
        if ("Ok" in saved) {
          if (hex(saved.Ok.offer.operation) !== savedId)
            throw Error("Receipt mismatch");
          savedTransfer = saved.Ok;
        } else if (!("NotFound" in saved.Err)) bridgeOk(saved);
      }
      if (!savedTransfer && !channelOperation.current) {
        savedTransfer = bridgeOk(await a.get_pending_vault_transfer([]))[0];
        check();
      }
      if (savedTransfer) {
        update(savedTransfer);
      } else if (channelOperation.current) {
        setNotice(
          "The saved receipt is no longer available. Return to Vault and open a new Wiki window for another transfer.",
        );
      }
      const dbs = await ownerDatabases(canisterId, identity);
      check();
      setDatabases(dbs);
      if (launch?.mode === "link") {
        const preview = bridgeOk(await a.preview_vault_link(bytes(launch.id)));
        check();
        setChallenge(preview);
      }
      // Publish action capability only after all initialization checks succeed.
      initialized.current = true;
      setActor(a);
      setLoaded(true);
    })().catch(() => {
      try {
        check();
        initialized.current = false;
        setActor(undefined);
        setLoaded(false);
        setNotice(
          "Could not load credit bridge status. Reload to recover before starting a transfer.",
        );
      } catch {
        /* stale */
      }
    });
    return () => {
      disposed = true;
      invalidate();
      window.removeEventListener("message", receive);
      window.clearInterval(timer);
    };
  }, [canisterId, identity, launch, launchParsed, update]);
  const post = (type: "linked" | "offer" | "result", id: string) => {
    if (
      !initialized.current ||
      !launch ||
      !peer.current ||
      peer.current.closed ||
      !connectedRef.current
    )
      throw Error("Open Vault first");
    peer.current.postMessage(
      message(type, id, launch.nonce),
      creditOrigins().vault,
    );
  };
  const work = (
    fn: (check: () => void) => Promise<void>,
    mayChangeTransfer = false,
  ) => {
    if (working.current || !initialized.current || !available || !actor) return;
    const check = fence();
    try {
      check();
    } catch {
      setNotice("Session changed. Reload before continuing.");
      return;
    }
    working.current = true;
    setBusy(true);
    setNotice("");
    void fn(check)
      .catch(() => {
        try {
          check();
          if (mayChangeTransfer) setUncertain(true);
          setNotice(
            "Request did not complete. Refresh saved status before retrying. Unknown transfers must be reconciled.",
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
  const offered = transfer && "Offered" in transfer.phase;
  const quoted = transfer && "Quoted" in transfer.phase;
  const terminal =
    transfer && ("Paid" in transfer.phase || "Refunded" in transfer.phase);
  const handoff = bridgeUrl(
    "vault",
    {
      mode: "fund",
      id: transfer
        ? hex(transfer.offer.operation)
        : (launch?.id ?? "0".repeat(32)),
      nonce: launch?.nonce ?? "0".repeat(64),
    },
    creditOrigins(),
  );
  const linkMode = launch?.mode === "link";
  const linkPill = link?.active
    ? ({ tone: "positive", label: "Linked" } as const)
    : link
      ? ({ tone: "warn", label: "Link revoked" } as const)
      : ({ tone: "neutral", label: "Not linked" } as const);
  return (
    <div className="mx-auto grid w-full max-w-2xl min-w-0 gap-5 p-4 sm:p-6 [&_button]:min-h-11">
      <AdminPageHeader
        title={linkMode ? "Link to Vault" : "Vault auto top-up"}
        description={
          linkMode
            ? undefined
            : "Refill your Vault from a Wiki database automatically, within limits you set."
        }
      />
      {!identity ? (
        <AdminPanel>
          <p className="mb-3 text-sm">
            Sign in to Wiki to review the source database and recipient.
          </p>
          <Button
            disabled={session.authLoading}
            onClick={() => void session.login()}
          >
            Sign in with Internet Identity
          </Button>
        </AdminPanel>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            {connected ? (
              <output>
                <StatusPill dot tone="positive" label="Connected to your Vault window" />
              </output>
            ) : linkMode ? (
              <StatusPill dot tone="warn" label="Vault window not connected" />
            ) : (
              <span />
            )}
            <Button variant="ghost" size="sm" onClick={() => void session.logout()}>
              Sign out of Wiki
            </Button>
          </div>
          {/* Linking needs the Vault window; settings and recovery do not. */}
          {!connected && (linkMode || (loaded && !link?.active)) ? (
            <AdminPanel className="grid gap-3 border-warnLine bg-warnSoft">
              <p className="flex items-start gap-2 text-sm text-warnText">
                <CircleAlert aria-hidden className="mt-0.5 shrink-0" size={16} />
                <span>
                  Start in Vault: open Account settings and choose Link Wiki
                  account.
                </span>
              </p>
              <a
                className="inline-flex min-h-11 items-center justify-self-start rounded-lg border border-line bg-white px-4 text-sm font-semibold text-ink"
                href={handoff}
                target="_self"
              >
                Continue in Vault
              </a>
            </AdminPanel>
          ) : null}
          <AdminPanel className="grid min-w-0 gap-3" ariaLabel="Account link">
            {challenge ? (
              <>
                <p className="text-sm">
                  Let this Wiki account send credits to Vault{" "}
                  <PrincipalText value={challenge.vault_owner.toText()} />?
                </p>
                <p className="text-xs text-muted">No credits move now. You can revoke this later.</p>
                <Button
                  className="justify-self-start"
                  disabled={busy || !available || !connected}
                  onClick={() =>
                    work(async (check) => {
                      const approved = bridgeOk(
                        await actor!.approve_vault_link(challenge.challenge),
                      );
                      check();
                      setLink(approved);
                      setChallenge(undefined);
                      post("linked", launch!.id);
                    })
                  }
                >
                  Approve account link
                </Button>
              </>
            ) : (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                {linkMode && link?.active ? (
                  <p className="flex items-center gap-2 text-sm font-semibold text-okText">
                    <CheckCircle2 aria-hidden size={18} />
                    Accounts linked. You can close this window.
                  </p>
                ) : (
                  <StatusPill dot tone={linkPill.tone} label={linkPill.label} />
                )}
                {link && !(linkMode && link.active) ? (
                  <span className="text-sm">
                    Vault <PrincipalText value={link.vault_owner.toText()} />
                  </span>
                ) : null}
                {link?.active ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="ml-auto text-dangerText"
                    disabled={busy || !available}
                    onClick={() =>
                      work(async (check) => {
                        bridgeOk(await actor!.revoke_vault_link());
                        check();
                        setLink({ ...link, active: false });
                        setNotice(
                          "Link revoked. Dispatched transfers remain recoverable.",
                        );
                      })
                    }
                  >
                    Revoke account link
                  </Button>
                ) : null}
              </div>
            )}
          </AdminPanel>
          {link?.active && !challenge ? (
            <AutoTopupPanel actor={actor} databases={databases} disabled={busy || !available} />
          ) : null}
          {link?.active && !challenge ? <WikiCredits databases={databases} /> : null}
          {transfer ? (
            <AdminPanel className="grid min-w-0 gap-3" ariaLabel="Transfer to Vault">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="font-semibold">Transfer to Vault</h2>
                <output aria-live="polite">
                  <StatusPill
                    dot
                    tone={
                      "Paid" in transfer.phase
                        ? "positive"
                        : "Unknown" in transfer.phase || "Refunded" in transfer.phase
                          ? "warn"
                          : "info"
                    }
                    label={Object.keys(transfer.phase)[0]}
                  />
                </output>
              </div>
              <div className="grid min-w-0 gap-3 rounded-lg border border-line bg-white p-3">
                <AdminField
                  label="Source database"
                  value={databases.find((db) => db.databaseId === transfer.database_id)?.name ?? transfer.database_id}
                />
                <AdminField
                  label="Vault recipient"
                  value={<PrincipalText value={transfer.offer.vault_owner.toText()} />}
                />
                <AdminField
                  label="Amount"
                  value={`${cyclesLabel(transfer.offer.amount_cycles.toString())} (${transfer.offer.amount_cycles.toLocaleString()} cycles)`}
                />
              </div>
              {"Unknown" in transfer.phase ? (
                <p className="text-sm">
                  The send outcome is unknown. Keep this transfer held and
                  reconcile its receipt. Do not create a replacement
                  transfer; cancellation is unavailable.
                </p>
              ) : null}
              {transfer.receiver_cleanup_pending ? (
                <p className="text-sm">
                  Receiver receipt cleanup is pending. Reconcile to release
                  the pending slot.
                </p>
              ) : null}
              {terminal && !transfer.receiver_cleanup_pending ? (
                <p className="text-sm text-muted">
                  This transfer is finished. Auto top-up handles future
                  refills.
                </p>
              ) : null}
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy || !available}
                  onClick={() =>
                    work(async (check) => {
                      const value = bridgeOk(
                        await actor!.get_vault_transfer(transfer.offer.operation),
                      );
                      check();
                      update(value);
                    })
                  }
                >
                  Refresh transfer status
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy || !available}
                  onClick={() =>
                    work(async (check) => {
                      const value = bridgeOk(
                        await actor!.reconcile_vault_transfer(transfer.offer.operation),
                      );
                      check();
                      update(value);
                      if (connectedRef.current)
                        post("result", hex(value.offer.operation));
                    })
                  }
                >
                  Reconcile transfer
                </Button>
                {quoted || offered ? (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy || !available || uncertain}
                    onClick={() =>
                      work(async (check) => {
                        const value = bridgeOk(
                          await actor!.cancel_vault_transfer(transfer.offer.operation),
                        );
                        check();
                        update(value);
                      }, true)
                    }
                  >
                    Cancel unsent transfer
                  </Button>
                ) : null}
              </div>
            </AdminPanel>
          ) : null}
        </>
      )}
      {notice ? <output className="text-sm">{notice}</output> : null}
    </div>
  );
}
