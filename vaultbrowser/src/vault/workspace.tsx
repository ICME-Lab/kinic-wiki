"use client";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  ChevronRight,
  CircleAlert,
  CircleHelp,
  CloudOff,
  FolderLock,
  Info,
  LockKeyhole,
  Plus,
  RefreshCw,
  RotateCw,
  Settings,
  Wallet,
} from "lucide-react";
import { createPortal } from "react-dom";
import { WikiCreditFunding } from "../wiki-credit";
import { parseLaunch } from "@kinic/credit-bridge-candid/browser";
import { Funding } from "../funding";
import {VaultNavigationScope,useVaultNavigation} from "../navigation";
import {VaultHelp,VaultNotFound} from "../help";
import { DraftGuardProvider, useDraftGuard } from "../draft-guard";
import { CycleBalance } from "@kinic/ui/cycle-balance";
import { formatRawCycles } from "@kinic/ui/cycles";
import { StatusPill } from "@kinic/ui/status-pill";
import { EmptyState } from "@kinic/ui/empty-state";
import { VaultActions, vaultDisplayName } from "./vault-actions";
import { bytes, ok, type Item, type VaultClient } from "@kinic/vault-client";
import type {
  Header,
  VaultAccess,
  SpendingStatus,
  GlobalCapacity,
  AccountInitialization,
  PendingUploadSummary,
} from "@kinic/vault-client/contracts";
import { b64 } from "@kinic/vault-crypto/documents";
import { VaultButton, VaultPanel, vaultError } from "./ui";
import { VaultDocuments } from "./documents";
import { VaultSettings, VaultSharedUploads } from "./management";

export type VaultWork = (operation: () => Promise<void>) => void;
const id = (h: Header) => b64(bytes(h.id));
const storageUnits = ["B", "KB", "MB", "GB", "TB"];
function formatStorage(value: bigint): string {
  let amount = Number(value);
  let unit = 0;
  while (amount >= 1000 && unit < storageUnits.length - 1) { amount /= 1000; unit++; }
  return `${unit === 0 ? amount : amount.toFixed(amount < 10 ? 1 : 0)} ${storageUnits[unit]}`;
}
type WorkspaceState = {
  selection:
    | { kind: "none" }
    | { kind: "selected" | "open"; header: Header; owner: boolean };
  // An unresolved create survives selecting another Vault and list refreshes.
  creation: "idle" | "unresolved";
};
export function VaultWorkspace({ client }: { client: VaultClient }) {
  return <VaultNavigationScope><DraftGuardProvider><Workspace client={client} /></DraftGuardProvider></VaultNavigationScope>;
}
function Workspace({ client }: { client: VaultClient }) {
  const guard = useDraftGuard();
  const [navigationOpen, setNavigationOpen] = useState(false);
  const nav=useVaultNavigation();
  const settingsOpen=nav.view === "settings" || nav.view === "vault-settings";
  const [settingsTarget, setSettingsTarget] = useState<{ id: string; members: boolean }>();
  const accountDetails = useRef<HTMLDetailsElement>(null);
  const [wikiCreditLaunch] = useState(() => !!parseLaunch(window.location.hash));
  const launchHandled = useRef(false);
  useEffect(() => {
    if (wikiCreditLaunch && !launchHandled.current) {
      launchHandled.current = true;
      nav.go("/settings");
    }
  }, [nav, wikiCreditLaunch]);
  // The page chrome owns a slot for session controls; tests render without it.
  const [chromeSlot, setChromeSlot] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    setChromeSlot(document.getElementById("vault-chrome-slot"));
  }, []);
  const [vaults, setVaults] = useState<VaultAccess[]>([]);
  const [vaultAfter, setVaultAfter] = useState<Uint8Array>();
  const loadedPages = useRef(1);
  const subscribeAccess = useCallback(
    (listener: () => void) => client.subscribeAccess(listener),
    [client],
  );
  const role = useSyncExternalStore(subscribeAccess, () => client.accessRole);
  const [pendingUploads, setPendingUploads] = useState<PendingUploadSummary[]>(
    [],
  );
  const [uploadAfter, setUploadAfter] = useState<Uint8Array>();
  const [workspace, setWorkspace] = useState<WorkspaceState>({
    selection: { kind: "none" },
    creation: "idle",
  });
  const workspaceRef = useRef(workspace);
  const updateWorkspace = useCallback(
    (update: (state: WorkspaceState) => WorkspaceState) => {
      workspaceRef.current = update(workspaceRef.current);
      setWorkspace(workspaceRef.current);
    },
    [],
  );
  const select = useCallback(
    (header?: Header, kind?: "selected" | "open", owner?: boolean) => {
      updateWorkspace((state) => ({
        ...state,
        selection: header
          ? {
              kind: kind ?? (state.selection.kind === "open" ? "open" : "selected"),
              header,
              owner: owner ?? (state.selection.kind === "none" || state.selection.owner),
            }
          : { kind: "none" },
      }));
    },
    [updateWorkspace],
  );
  const selected =
    workspace.selection.kind === "none" ? undefined : workspace.selection.header;
  const opened = workspace.selection.kind === "open";
  const selectedOwner = workspace.selection.kind !== "none" && workspace.selection.owner;
  const canEdit = role === "Owner" || role === "Editor";
  const [items, setItems] = useState<Item[]>([]);
  const [generation, setGeneration] = useState(client.session.capture());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [spending, setSpending] = useState<SpendingStatus>();
  const [balance, setBalance] = useState(0n);
  const [accountReady, setAccountReady] = useState(false);
  const [keyCost, setKeyCost] = useState<bigint>();
  const [firstKeyFree, setFirstKeyFree] = useState(false);
  const [needsKeyFunding, setNeedsKeyFunding] = useState(false);
  const [selectedKeyCost, setSelectedKeyCost] = useState<bigint>();
  const accountInitialization = useRef<Promise<AccountInitialization> | undefined>(undefined);
  const [capacity, setCapacity] = useState<GlobalCapacity>();
  const privateDOM = useRef<HTMLDivElement>(null);
  const alive = useRef(true);
  const busyRef = useRef(false);
  const workId = useRef(0);
  const configurationRequest = useRef(0);
  const balanceRequest = useRef(0);
  const refreshBalance = useCallback(async () => {
    const request = ++balanceRequest.current;
    const ticket = client.session.capture();
    // Admission can settle accrued storage before the balance is read.
    const status = ok(await client.actor.get_spending_status());
    client.session.check(ticket);
    const [balance, cost] = await Promise.all([
      client.actor.account_balance(), client.actor.vault_key_cost([]),
    ]);
    const value = ok(balance);
    const firstFree = "Ok" in cost && cost.Ok.first_key_free;
    client.session.check(ticket);
    if (alive.current && request === balanceRequest.current) {
      setSpending(status);
      setBalance(value);
      setKeyCost("Ok" in cost ? cost.Ok.fee : undefined);
      setFirstKeyFree(firstFree);
    }
    return { balance: value, firstKeyFree: firstFree, status };
  }, [client]);
  const refreshId = useRef(0);
  useLayoutEffect(() => {
    alive.current = true;
    client.session.onLock = () => {
      if (!alive.current) return;
      workId.current++;
      busyRef.current = false;
      setBusy(false);
      select(undefined);
      setSettingsTarget(undefined);
      setNeedsKeyFunding(false);
      setSelectedKeyCost(undefined);
      setItems([]);
      setGeneration(client.session.capture());
      setError("");
    };
    const unsubscribeDenial = client.subscribeVaultDenial((vault) => {
      if (!alive.current) return;
      const deniedId = b64(vault);
      setVaults((current) => current.filter(({ header, role }) => "Owner" in role || id(header) !== deniedId));
    });
    const detach = client.session.addLockCleanup(() => {
      for (const panel of privateDOM.current?.querySelectorAll(
        "[data-vault-sensitive]",
      ) ?? []) {
        const walker = document.createTreeWalker(panel, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) walker.currentNode.nodeValue = "";
      }
      for (const input of privateDOM.current?.querySelectorAll(
        "input, textarea",
      ) ?? []) {
        (input as HTMLInputElement).value = "";
        input.removeAttribute("value");
      }
    });
    const activity = () => client.session.activity();
    const visible = () => client.session.visible(document.hidden);
    const hide = () => client.session.lock();
    for (const event of ["pointerdown", "pointermove", "keydown", "scroll"])
      window.addEventListener(event, activity, { capture: true, passive: true });
    document.addEventListener("visibilitychange", visible);
    window.addEventListener("pagehide", hide);
    visible();
    const interval = window.setInterval(() => client.session.expire(), 1000);
    return () => {
      alive.current = false;
      client.session.onLock = () => {};
      client.session.lock();
      unsubscribeDenial();
      detach();
      window.clearInterval(interval);
      for (const event of ["pointerdown", "pointermove", "keydown", "scroll"])
        window.removeEventListener(event, activity, true);
      document.removeEventListener("visibilitychange", visible);
      window.removeEventListener("pagehide", hide);
    };
  }, [client, select]);
  const run = (operation: Parameters<VaultWork>[0], ownerPays = false) => {
    if (busyRef.current || !alive.current) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    // create/open may synchronously close the old context before their first await.
    const pending = operation();
    const request = ++workId.current;
    busyRef.current = true;
    setBusy(true);
    const ticket = client.session.capture();
    const current = () =>
      alive.current &&
      client.session.capture() === ticket &&
      workId.current === request;
    void pending
      .catch((cause) => {
        if (current()) setError(vaultError(cause, ownerPays));
      })
      .finally(() => {
        if (alive.current && workId.current === request) {
          busyRef.current = false;
          setBusy(false);
        }
        if (current() && !ownerPays && operation !== refreshConfiguration) {
          const refresh = refreshBalance();
          const balanceCheck = balanceRequest.current;
          void refresh.catch(() => {
            if (current() && balanceCheck === balanceRequest.current)
              setError((previous) => previous || vaultError(Error("BalanceUnavailable")));
          });
        }
      });
  };
  const runDocument: VaultWork = (operation) => run(operation, !selectedOwner);
  const refreshLists = useCallback(async () => {
    const ticket = client.session.capture();
    let page = await client.listAccessibleVaults();
    const list = [...page.entries];
    for (let count = 1; count < loadedPages.current && page.next[0]; count++) {
      client.session.check(ticket);
      page = await client.listAccessibleVaults(bytes(page.next[0]));
      list.push(...page.entries);
    }
    client.session.check(ticket);
    if (!alive.current) return;
    const selection = workspaceRef.current.selection;
    const previous = selection.kind === "none" ? undefined : selection.header;
    const listed = previous
      ? list.find(({ header }) => id(header) === id(previous))?.header
      : undefined;
    setVaults(list);
    setVaultAfter(page.next[0] ? bytes(page.next[0]) : undefined);
    // A later page may contain the selection. Sequence changes alone are harmless.
    const selectionChanged = previous && (listed
      ? listed.key_name !== previous.key_name ||
        b64(bytes(listed.nonce)) !== b64(bytes(previous.nonce)) ||
        b64(bytes(listed.public_key)) !== b64(bytes(previous.public_key)) ||
        ("Active" in previous.state && !("Active" in listed.state))
      : page.next.length === 0);
    // A list refresh must validate, never directly install a header into the root binding.
    if (client.header && client.session.root) {
      let h: Header;
      try {
        h = await client.refreshHeader();
      } catch (cause) {
        // Exact denial evicts the saved key in the client. If the exact request
        // fails and the listing contradicts the open binding, close this view.
        if (selectionChanged && alive.current && client.session.capture() === ticket)
          client.session.lock();
        throw cause;
      }
      client.session.check(ticket);
      if (!alive.current) return;
      select(h);
    } else if (selectionChanged) client.session.lock();
    else if (listed) select(listed);
  }, [client, select]);
  const refreshOwnerUploads = useCallback(async () => {
    const ticket = client.session.capture();
    const uploads = await client.ownerPendingUploads();
    client.session.check(ticket);
    if (!alive.current) return;
    setPendingUploads(uploads.entries);
    setUploadAfter(uploads.next[0] ? bytes(uploads.next[0]) : undefined);
  }, [client]);
  const refreshOwnerWorkspace = useCallback(async () => {
    await Promise.all([refreshLists(), refreshOwnerUploads()]);
  }, [refreshLists, refreshOwnerUploads]);
  const loadMoreVaults = async () => {
    const ticket = client.session.capture();
    const page = await client.listAccessibleVaults(vaultAfter);
    client.session.check(ticket);
    loadedPages.current++;
    setVaults((previous) => [
      ...previous,
      ...page.entries.filter(({ header }) => !previous.some((entry) => id(entry.header) === id(header))),
    ]);
    setVaultAfter(page.next[0] ? bytes(page.next[0]) : undefined);
  };
  const refresh = async () => {
    const request = ++refreshId.current;
    const ticket = client.session.capture();
    const [list, header] = await Promise.all([
      client.items(),
      client.refreshHeader(),
    ]);
    client.session.check(ticket);
    if (!alive.current) return;
    if (refreshId.current !== request) return;
    setItems(list);
    select(header, "open");
    if (workspaceRef.current.selection.kind === "open" && workspaceRef.current.selection.owner)
      await refreshOwnerWorkspace();
  };
  const refreshConfiguration = useCallback(async () => {
    const request = ++configurationRequest.current;
    const ticket = client.session.capture();
    const initialization = accountInitialization.current ??= client.actor.initialize_vault_account()
      .then(ok).catch((cause) => { accountInitialization.current = undefined; throw cause; });
    const account = await initialization;
    // A deferred, unclaimed grant must be retryable after pending payments or
    // refunds settle. Permanent exclusions are idempotent zero-grant responses.
    if (account.grant_cycles === 0n && accountInitialization.current === initialization)
      accountInitialization.current = undefined;
    client.session.check(ticket);
    if (request !== configurationRequest.current) return;
    const [, cap] = await Promise.all([
      refreshBalance(),
      client.actor.global_capacity(),
    ]);
    client.session.check(ticket);
    if (!alive.current || request !== configurationRequest.current) return;
    setAccountReady(true);
    setCapacity(ok(cap));
  }, [client, refreshBalance]);
  useEffect(() => {
    const ticket = client.session.capture();
    void refreshOwnerWorkspace().catch((cause) => {
      if (alive.current && ticket === client.session.capture())
        setError(vaultError(cause));
    });
  }, [client, refreshOwnerWorkspace]);
  useEffect(() => {
    const ticket = client.session.capture();
    const refresh = refreshConfiguration();
    const request = configurationRequest.current;
    void refresh.catch((cause) => {
      if (alive.current && ticket === client.session.capture() && request === configurationRequest.current)
        setError(vaultError(cause));
    });
  }, [client, refreshConfiguration, generation]);
  useEffect(() => {
    if (!opened || (role !== "Editor" && role !== "Viewer")) return;
    const revalidate = () => {
      if (!document.hidden && client.session.root)
        void client.refreshHeader().catch(() => {});
    };
    const interval = window.setInterval(revalidate, 30_000);
    document.addEventListener("visibilitychange", revalidate);
    window.addEventListener("focus", revalidate);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", revalidate);
      window.removeEventListener("focus", revalidate);
    };
  }, [client, generation, opened, role]);
  const open = async (header: Header, owner: boolean) => {
    if (!("Active" in header.state)) {
      client.session.lock();
      select(header, "selected", owner);
      return;
    }
    const pending = owner ? client.open(header, {
      beforeDerive: async (currentHeader) => {
        const ticket = client.session.capture();
        const cost = ok(await client.actor.vault_key_cost([currentHeader.key_name]));
        client.session.check(ticket);
        const available = await refreshBalance();
        client.session.check(ticket);
        if (!alive.current) throw Error("Locked");
        setSelectedKeyCost(cost.fee);
        if ("ServiceReserveLow" in available.status) throw Error("ServiceReserveLow");
        if ("Unconfigured" in available.status) throw Error("VaultDisabled");
        const ownerFee = available.firstKeyFree ? 0n : cost.fee;
        if ("AccountCreditLow" in available.status || available.balance < ownerFee + 20_000_000n)
          throw Error("KeyFundingRequired");
      },
    }) : client.openAccess(bytes(header.id));
    // Capture after the synchronous switch; keep the header selectable on key failure.
    const ticket = client.session.capture();
    select(header, undefined, owner);
    try {
      await pending;
      client.session.check(ticket);
      if (!alive.current) return;
      setNeedsKeyFunding(false);
      await refresh();
    }
    catch (cause) {
      if (alive.current && ticket === client.session.capture()) {
        if (client.session.root) {
          client.session.lock();
          select(header, "selected", owner);
          setError(vaultError(cause, !owner));
        } else if (owner && cause instanceof Error && cause.message === "KeyFundingRequired") {
          setNeedsKeyFunding(true);
        }
      }
      throw cause;
    }
  };
  const createVault = () =>
    run(async () => {
      updateWorkspace((state) => ({ ...state, creation: "unresolved" }));
      const pending = client.create();
      const ticket = client.session.capture();
      const header = await pending;
      client.session.check(ticket);
      if (!alive.current) return;
      updateWorkspace((state) => ({ ...state, creation: "idle" }));
      select(header, "selected", true);
      await refreshLists();
      client.session.check(ticket);
      await open(header, true);
    });
  const eligible = accountReady && !!spending && "Available" in spending
    && balance >= 20_000_000n;
  const ownerCreditLow = !!spending && "AccountCreditLow" in spending;
  const serviceReserveLow = !!spending && "ServiceReserveLow" in spending;
  const serviceUnconfigured = !!spending && "Unconfigured" in spending;
  // New Vault creation and initial key retrieval are separate charged updates.
  const ownerKeyCost = firstKeyFree ? 0n : selectedKeyCost;
  const canRetrieveKey = eligible && ownerKeyCost !== undefined
    && balance >= ownerKeyCost + 20_000_000n;
  // An unresolved create replays its retained operation instead of charging
  // another creation; keep enough credit for its first key retrieval.
  const creationExecutionBudget = workspace.creation === "unresolved" ? 20_000_000n : 40_000_000n;
  const creationKeyCost = firstKeyFree ? 0n : keyCost;
  const canAffordCreation = eligible && creationKeyCost !== undefined
    && balance >= creationKeyCost + creationExecutionBudget;
  const canCreateVault = client.hasUncertainCreation || canAffordCreation;
  const balanceRequirementKnown = (eligible || ownerCreditLow) && (
    (selected
      ? selectedOwner && (opened || ("Active" in selected.state && ownerKeyCost !== undefined))
      : keyCost !== undefined)
  );
  const canAffordCurrentOperation = opened
    ? eligible
    : selected ? canRetrieveKey : canAffordCreation;
  const inlineFunding = nav.view === "workspace" && !settingsOpen
    && (eligible || ownerCreditLow) && !!capacity && !opened
    && (selected ? selectedOwner && needsKeyFunding && !canRetrieveKey : keyCost !== undefined && !canCreateVault);
  const retryable = client.hasInterruptedChange;
  const retryButton = (className = "") => (
    <VaultButton
      size="sm"
      className={className}
      disabled={busy}
      onClick={() =>
        run(async () => {
          const ticket = client.session.capture();
          await client.retryInterruptedChange();
          if (client.session.root) {
            client.session.check(ticket);
            await refresh();
          } else {
            await refreshOwnerWorkspace();
          }
        })
      }
    >
      <RotateCw size={13} aria-hidden />
      Retry interrupted change
    </VaultButton>
  );
  const sessionControls = (
    <div className="vault-session-controls" aria-label="Vault session status">
      <VaultButton id="vault-settings-toggle" size="sm" tone="ghost" aria-label="Account settings" aria-pressed={nav.view === "settings"} onClick={() => nav.go("/settings")}>
        <Settings size={16} aria-hidden /><span className="vault-settings-label">Account</span>
      </VaultButton>
      <VaultButton size="sm" tone="ghost" aria-label="Vault help" onClick={() => nav.go("/help")}><CircleHelp size={16} aria-hidden/><span className="vault-help-label">Help</span></VaultButton>
      {busy ? (
        <output><StatusPill className="vault-session-state" title="Processing Vault operation…" icon={<RefreshCw size={14} className="animate-spin" aria-hidden />} label="Processing Vault operation…" /></output>
      ) : (
        <StatusPill className="vault-session-state" title={opened ? "Vault open" : "Vault closed"} dot tone={opened ? "positive" : "neutral"} label={opened ? "Vault open" : "Vault closed"} />
      )}
      {selected ? (
        <VaultButton
          size="sm"
          className="vault-close"
          title="Close Vault"
          onClick={() => guard.protect(() => client.session.lock())}
        >
          <LockKeyhole size={14} aria-hidden />
          Close Vault
        </VaultButton>
      ) : null}
    </div>
  );

  const settingsIndex = vaults.findIndex(({ header, role }) => "Owner" in role && id(header) === settingsTarget?.id);
  const settingsVault = vaults[settingsIndex]?.header;
  const ownedCount = vaults.filter(({ role }) => "Owner" in role).length;
  const usedPercent =
    capacity && capacity.limit > 0n
      ? Number((capacity.used * 1000n) / capacity.limit) / 10
      : 0;
  return (
    <div ref={privateDOM} className="vault-workspace">
      <h1 className="sr-only">Private Vault</h1>
      {chromeSlot ? createPortal(sessionControls, chromeSlot) : sessionControls}
      {!accountReady ? (
        <div className="vault-notice vault-notice--info">
          <output>Preparing your Vault account…</output>
          {error ? <VaultButton onClick={() => run(refreshConfiguration)}>Retry account setup</VaultButton> : null}
        </div>
      ) : null}
      {accountReady && serviceUnconfigured ? (
        <p className="vault-notice vault-notice--info">
          <Info size={16} aria-hidden />
          Vault creation is unavailable until the service is configured. Cleanup
          remains available.
        </p>
      ) : null}
      {serviceReserveLow ? (
        <output className="vault-notice vault-notice--info">
          <Info size={16} aria-hidden />
          New paid operations are paused because the service cycles reserve is low.
          Cached reads and cleanup are still available.
        </output>
      ) : null}
      {error ? (
        <div role="alert" className="vault-notice vault-notice--danger">
          <CircleAlert size={16} aria-hidden />
          <span>{error}</span>
          {retryable ? retryButton("vault-notice-action") : null}
        </div>
      ) : retryable ? (
        <div className="vault-notice vault-notice--warn">
          <span>An interrupted change is waiting for confirmation.</span>
          {retryButton("vault-notice-action")}
        </div>
      ) : null}
      <div hidden={nav.view !== "workspace"}>
      <div
        className={`vault-workspace-grid ${navigationOpen ? "vault-navigation-open" : ""}`}
      >
        <VaultButton
          className="vault-navigation-toggle"
          id="vault-navigation-toggle"
          aria-label="Toggle Vault navigation"
          aria-expanded={navigationOpen}
          aria-controls="vault-navigation"
          onClick={() => setNavigationOpen((open) => !open)}
        >
          <FolderLock size={16} aria-hidden />
          Vaults
          <ChevronRight size={14} aria-hidden />
        </VaultButton>
        <div id="vault-navigation" className="vault-navigation">
          <VaultPanel label="Vaults" className="vault-sidebar">
            <div className="vault-sidebar-title">
              <h2>Vaults</h2>
              <span title="Owned Vaults">{ownedCount}/3</span>
              <VaultButton
                tone="ghost"
                size="icon"
                className="vault-text-hidden"
                title="Refresh Vaults"
                disabled={busy}
                onClick={() => run(selected && !selectedOwner ? refreshLists : refreshOwnerWorkspace)}
              >
                <RefreshCw size={14} aria-hidden />
                Refresh Vaults
              </VaultButton>
            </div>
            <VaultButton
              tone="primary"
              className="vault-sidebar-create"
              disabled={busy || !canCreateVault}
              onClick={()=>guard.protect(createVault)}
            >
              <Plus size={16} aria-hidden />
              {workspace.creation === "unresolved"
                ? "Retry Vault creation"
                : "Create Vault"}
            </VaultButton>
            <div className="vault-sidebar-list">
              {vaults.map(({ header: h, role: grant }, index) => {
                const owner = "Owner" in grant;
                const name = vaultDisplayName(h, `Vault ${index + 1}`);
                const memberRole = selected && id(selected) === id(h) && role ? role : Object.keys(grant)[0];
                return (
                <div className="vault-switcher-card" key={id(h)}>
                <VaultButton
                  className="vault-switcher"
                  title={name}
                  disabled={busy}
                  aria-pressed={selected ? id(selected) === id(h) : false}
                  onClick={() => {
                    setNavigationOpen(false);
                    if (navigationOpen)
                      document
                        .getElementById("vault-navigation-toggle")
                        ?.focus();
                    guard.protect(() => run(() => open(h, owner), !owner));
                  }}
                >
                  <FolderLock size={16} aria-hidden />
                  <span>
                    {name}{"Active" in h.state ? "" : ` · ${Object.keys(h.state)[0]}`}{owner ? "" : ` · ${memberRole}`}
                  </span>
                </VaultButton>
                {owner ? <VaultActions
                  key={`${id(h)}:${h.name?.[0] ?? ""}`}
                  header={h}
                  fallback={`Vault ${index + 1}`}
                  client={client}
                  disabled={busy}
                  canRename={eligible && !client.hasPendingSave}
                  onSettings={(members) => {
                    setSettingsTarget({ id: id(h), members });
                    nav.go("/vault-settings");
                  }}
                  onRename={name => run(async () => {
                    const ticket = client.session.capture();
                    await client.renameVault(h, name);
                    client.session.check(ticket);
                    await refreshLists();
                  })}
                /> : null}
                </div>
              );})}
              {vaultAfter ? (
                <VaultButton disabled={busy} onClick={() => run(loadMoreVaults)}>
                  Load more Vaults
                </VaultButton>
              ) : null}
            </div>
          </VaultPanel>
        </div>
        <div className="vault-main" id="vault-content" tabIndex={-1}>
          {pendingUploads.length > 0 || uploadAfter ? (
            <VaultPanel label="Interrupted uploads" className="grid gap-3">
              <h2 className="flex items-center gap-2 font-semibold"><CloudOff size={17} aria-hidden /> Upload interrupted</h2>
              <p>
                Cancel unfinished uploads with zero prepaid balance. If a change
                was interrupted, retry it before starting another one.
              </p>
              <div className="vault-disclosure-actions">
                <VaultButton
                  size="sm"
                  disabled={busy}
                  onClick={() => run(refreshOwnerUploads)}
                >
                  <RefreshCw size={14} aria-hidden />
                  Refresh interrupted uploads
                </VaultButton>
                {pendingUploads.map((upload, index) => (
                  <VaultButton
                    size="sm"
                    key={b64(bytes(upload.upload))}
                    disabled={busy || client.hasPendingSave}
                    onClick={() =>
                      run(async () => {
                        const ticket = client.session.capture();
                        try {
                          await client.cancelOwnedUpload(
                            bytes(upload.vault),
                            bytes(upload.upload),
                            upload.cancel_job[0]
                              ? bytes(upload.cancel_job[0])
                              : undefined,
                          );
                        } catch (cause) {
                          client.session.check(ticket);
                          if (
                            cause instanceof Error &&
                            ["Conflict", "NotFound"].includes(cause.message)
                          )
                            await refreshOwnerUploads();
                          throw cause;
                        }
                        client.session.check(ticket);
                        await refreshOwnerUploads();
                      })
                    }
                  >
                    Cancel interrupted upload {index + 1}
                  </VaultButton>
                ))}
                {uploadAfter ? (
                  <VaultButton
                    size="sm"
                    tone="ghost"
                    disabled={busy}
                    onClick={() =>
                      run(async () => {
                        const ticket = client.session.capture();
                          const page = await client.ownerPendingUploads(
                          new Uint8Array(uploadAfter),
                        );
                        client.session.check(ticket);
                        setPendingUploads((previous) => [
                          ...previous,
                          ...page.entries,
                        ]);
                        setUploadAfter(
                          page.next[0] ? bytes(page.next[0]) : undefined,
                        );
                      })
                    }
                  >
                    Load more interrupted uploads
                  </VaultButton>
                ) : null}
              </div>
            </VaultPanel>
          ) : null}
          {selected ? (
            !opened ? (
              <VaultPanel label="Open Vault" className="vault-empty">
                <EmptyState
                  icon={<LockKeyhole size={26} aria-hidden />}
                  title={"Active" in selected.state ? "This Vault is closed" : "Cleanup needed"}
                  description={"Active" in selected.state
                    ? "Select this Vault to open it with Internet Identity. If the key service was unavailable, retry opening the same Vault."
                    : `This Vault is ${Object.keys(selected.state)[0].toLowerCase()}. Use this Vault’s actions menu to remove its unfinished data.`}
                  action={"Active" in selected.state ? (
                    <VaultButton
                      tone="primary"
                      disabled={busy || (selectedOwner && needsKeyFunding && !canRetrieveKey)}
                      onClick={() => run(() => open(selected, selectedOwner), !selectedOwner)}
                    >Retry opening Vault</VaultButton>
                  ) : undefined}
                />
                {"Active" in selected.state && inlineFunding ? (
                  <Funding key={`setup-funding-${generation}`} client={client} onFunded={refreshConfiguration} />
                ) : null}
              </VaultPanel>
            ) : (
              <>
                <VaultDocuments
                  key={`documents-${generation}-${role}`}
                  client={client}
                  items={items}
                  disabled={busy}
                  canEdit={canEdit}
                  canPurge={role === "Owner"}
                  writesDisabled={serviceReserveLow || serviceUnconfigured || (role === "Owner" && !eligible)}
                  run={runDocument}
                  refresh={refresh}
                />
                {role === "Editor" ? (
                  <VaultSharedUploads client={client} disabled={busy || client.hasPendingSave} run={runDocument} />
                ) : null}
              </>
            )
          ) : (
            <VaultPanel label="Choose a Vault" className="vault-empty">
              <EmptyState
                icon={<FolderLock size={26} aria-hidden />}
                title="Choose or create a Vault"
                description={canCreateVault
                  ? "Create your Vault to start saving private documents."
                  : inlineFunding ? "Add prepaid balance here, then create your Vault." : undefined}
                action={canCreateVault ? (
                  <VaultButton tone="primary" disabled={busy} onClick={()=>guard.protect(createVault)}>
                    <Plus size={16} aria-hidden />
                    {workspace.creation === "unresolved" ? "Retry creating your Vault" : "Create your Vault"}
                  </VaultButton>
                ) : undefined}
              />
              {inlineFunding ? (
                <Funding
                  key={`setup-funding-${generation}`}
                  client={client}
                  onFunded={refreshConfiguration}
                />
              ) : null}
            </VaultPanel>
          )}
        </div>
      </div>
      {selectedOwner && ownerCreditLow ? (
        <div className="vault-notice vault-notice--info">
          <Info size={16} aria-hidden />
          <span>Creating a Vault requires prepaid balance.</span>
          <VaultButton
            size="sm"
            onClick={() => {
              nav.go("/settings");
              const details = accountDetails.current;
              if (!details) return;
              details.open = true;
              requestAnimationFrame(() => details.querySelector("summary")?.focus());
            }}
          >
            Add balance to create a Vault
          </VaultButton>
        </div>
      ) : null}

      </div>
      <div hidden={nav.view !== "settings"}><WikiCreditFunding client={client} onFunded={refreshConfiguration} /></div>
      <VaultSettings
          key={`settings-${generation}-${settingsTarget?.id ?? ""}-${settingsTarget?.members ?? false}`}
          scope={nav.view === "vault-settings" ? "vault" : "account"}
          active={settingsOpen}
          account={
            <details ref={accountDetails} className="vault-disclosure">
              <summary>
                <span className="vault-disclosure-icon" aria-hidden>
                  <Wallet size={17} />
                </span>
                <span className="vault-disclosure-label">
                  Account &amp; storage
                  <small aria-hidden>Balance, capacity and funding</small>
                </span>
                <ChevronRight size={16} aria-hidden />
              </summary>
              <div className="vault-disclosure-body">
                <VaultPanel label="Vault account">
                  <div className="vault-stat-row">
                    <div className="vault-stat vault-stat--primary">
                      <span>Prepaid balance</span>
                      <CycleBalance
                        cycles={accountReady ? balance : null}
                        title={accountReady ? `Prepaid balance: ${formatRawCycles(balance)} cycles` : "Prepaid balance unavailable"}
                        tone={!balanceRequirementKnown ? "neutral" : canAffordCurrentOperation ? "positive" : "warn"}
                      />
                    </div>
                    <div className="vault-stat">
                      <span aria-hidden>Shared capacity</span>
                      {capacity ? (
                        <>
                          <strong title={`${capacity.used.toLocaleString()} / ${capacity.limit.toLocaleString()} bytes`}>
                            {formatStorage(capacity.used)} <small>of {formatStorage(capacity.limit)}</small>
                          </strong>
                          <div className="vault-meter" aria-hidden>
                            <span
                              style={{ width: `${Math.min(100, usedPercent)}%` }}
                            />
                          </div>
                        </>
                      ) : (
                        <output>Checking shared storage capacity…</output>
                      )}
                    </div>
                  </div>
                  <dl className="vault-account-meta">
                    <dt>Vault principal</dt>
                    <dd><code>{client.identity.getPrincipal().toText()}</code></dd>
                  </dl>
                  {capacity?.overcommitted ? (
                    <p className="vault-notice vault-notice--warn">
                      Capacity is overcommitted; cleanup remains available.
                    </p>
                  ) : null}
                  <div className="vault-disclosure-actions">
                    <VaultButton
                      size="sm"
                      disabled={busy}
                      onClick={() => run(refreshConfiguration)}
                    >
                      <RefreshCw size={14} aria-hidden />
                      Refresh balance
                    </VaultButton>
                  </div>
                  {client.deviceKeyStatus === "memory" ? (
                    <p className="vault-notice vault-notice--warn">
                      Browser key storage is unavailable. Your next session will need a paid key retrieval.
                    </p>
                  ) : null}
                  {capacity && nav.view === "settings" && !inlineFunding ? (
                    <Funding
                      key={`funding-${generation}`}
                      client={client}
                      onFunded={refreshConfiguration}
                    />
                  ) : null}
                </VaultPanel>
              </div>
            </details>
          }
          client={client}
          selected={settingsVault}
          vaultName={settingsVault ? vaultDisplayName(settingsVault, `Vault ${settingsIndex + 1}`) : "Vault"}
          showMembers={settingsTarget?.members}
          disabled={busy}
          run={run}
          onChanged={refreshOwnerWorkspace}
          onForgetKeys={()=>guard.protect(()=>run(()=>client.forgetDeviceKeys()))}
          onBack={() => {
            nav.go("/");
            const focusId = nav.view === "vault-settings" && settingsVault
              ? `vault-actions-${Array.from(bytes(settingsVault.id)).join("-")}` : "vault-settings-toggle";
            requestAnimationFrame(() => document.getElementById(focusId)?.focus());
          }}
        />
      {nav.view === "help" ? <VaultHelp/> : null}
      {nav.view === "not-found" ? <VaultNotFound/> : null}
    </div>
  );
}
