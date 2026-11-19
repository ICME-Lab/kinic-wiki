import { BrowserDeviceKeys, type DeviceKeys } from "./device-keys.ts";
import type { Identity } from "@icp-sdk/core/agent";
import type { Principal } from "@icp-sdk/core/principal";
import { TransportSecretKey, randomBytes } from "@kinic/vault-crypto";
import {
  copyVaultContext,
  contextInput,
  verifiedRoot,
  validateRootHeader,
  type VaultContext,
} from "@kinic/vault-crypto/context";
import {
  encryptDocumentV3,
  decryptDocumentV3,
  readManifestV3,
  b64,
  hash,
  type Metadata,
} from "@kinic/vault-crypto/documents";
import type {
  Action,
  BeginRevision,
  Header,
  Mutation,
  MutationResult,
  Revision,
  VaultActor,
  VaultAccess,
} from "./contracts.ts";
import { Session, equal } from "./session.ts";
export const bytes = (x: Uint8Array | number[]) => new Uint8Array(x);
export function isValidVaultName(value: string) {
  const characters = Array.from(value.trim());
  return characters.length > 0 && characters.length <= 64 && !characters.some(character => {
    const code = character.codePointAt(0)!;
    return code < 32 || (code >= 127 && code <= 159);
  });
}
export function ok<T>(r: { Ok: T } | { Err: unknown }): T {
  if ("Ok" in r) return r.Ok;
  throw Error(
    r.Err && typeof r.Err === "object"
      ? Object.keys(r.Err)[0]
      : "RequestFailed",
  );
}
export type Item = {
  revision: Revision;
  metadata: Metadata;
};
export type VaultRole = "Owner" | "Editor" | "Viewer";
type EvictKeys = () => Promise<void>;
type OpenOptions = {
  allowDerive?: boolean;
  beforeDerive?: (header: Header) => Promise<void>;
};
export type MemberRole = Exclude<VaultRole, "Owner">;
type Save = {
  request: BeginRevision;
  chunks: Uint8Array[];
  phase: number;
  operation: Uint8Array;
  ticket: number;
  revision?: Revision;
  contextHash?: Uint8Array;
  uncertain?: boolean;
};
type RequestState =
  | { kind: "idle" }
  | { kind: "sending" | "ambiguous"; mutation: Mutation; shared: boolean };
type SaveState =
  | { kind: "idle" }
  | { kind: "preparing" }
  | { kind: "ready" | "sending" | "cancelling"; job: Save };
type CleanupJob = {
  vault: Uint8Array;
  operation: Uint8Array;
} & (
  | { kind: "cancel"; upload: Uint8Array; job: Uint8Array; shared: boolean }
  | { kind: "delete" }
);

export class VaultClient {
  readonly session = new Session();
  readonly actor: VaultActor;
  readonly identity: Identity;
  readonly canister: string;
  private local: boolean;
  private readonly deviceKeys: DeviceKeys;
  private unsubscribeDevice: () => void;
  deviceKeyStatus: "saved" | "memory" | "none" = "none";
  private searchReads = new Set<Promise<void>>();
  private live = true;
  header?: Header;
  private sharedVault?: Uint8Array;
  private selectedOwnerVault?: Uint8Array;
  private access?: VaultAccess;
  private accessCheck?: { ticket: number; pending: Promise<Header> };
  private accessListeners = new Set<() => void>();
  private vaultDenialListeners = new Set<(vault: Uint8Array) => void>();
  private pinnedPublicKey?: Uint8Array;
  private rootEpoch?: number;
  private creating?: { operation: Uint8Array; ambiguous: boolean };
  private keyAttempt?: {
    binding: string;
    vault: Uint8Array;
    operation: Uint8Array;
    transport: TransportSecretKey;
  };
  private request: RequestState = { kind: "idle" };
  private saveState: SaveState = { kind: "idle" };
  private cleanupState: { kind: "idle" } | CleanupJob = { kind: "idle" };
  constructor(options: {
    actor: VaultActor;
    identity: Identity;
    canister: string;
    local: boolean;
    deviceKeys?: DeviceKeys;
  }) {
    if (options.identity.getPrincipal().isAnonymous())
      throw Error("Unauthorized");
    this.actor = options.actor;
    this.identity = options.identity;
    this.canister = options.canister;
    this.local = options.local;
    this.deviceKeys =
      options.deviceKeys ??
      new BrowserDeviceKeys(
        `${this.canister}:${this.identity.getPrincipal().toText()}`,
      );
    this.unsubscribeDevice = this.deviceKeys.subscribe(() => {
      this.deviceKeyStatus = "none";
      this.session.lock();
    });
    this.session.addLockCleanup(() => {
      this.deviceKeyStatus = "none";
      this.selectedOwnerVault = undefined;
      this.keyAttempt = undefined;
      this.pinnedPublicKey = undefined;
      this.rootEpoch = undefined;
      this.clearWriteState();
      this.accessCheck = undefined;
      this.updateAccess(undefined);
    });
  }
  destroy() {
    if (!this.live) return;
    this.live = false;
    this.unsubscribeDevice();
    this.session.lock();
    this.header = undefined;
    this.creating = undefined;
    this.accessListeners.clear();
    this.vaultDenialListeners.clear();
  }
  async forgetDeviceKeys() {
    this.checkLive();
    this.session.lock();
    await this.deviceKeys.forget();
    this.deviceKeyStatus = "none";
  }
  private checkLive() {
    if (!this.live) throw Error("NotSignedIn");
  }
  private async discardVaultKeys(vault: Uint8Array, epoch?: number) {
    try {
      await this.deviceKeys.removeVault(vault, epoch);
    } catch {
      /* All later opens must still pass live authorization. */
    }
  }
  private context(h: Header): VaultContext {
    return copyVaultContext({
      canister: this.canister,
      owner: (this.access?.owner ?? this.identity.getPrincipal()).toText(),
      vault: bytes(h.id),
      nonce: bytes(h.nonce),
      key_name: h.key_name,
    });
  }
  get accessRole(): VaultRole | undefined {
    if (this.sharedVault)
      return this.access ? roleName(this.access.role) : undefined;
    return this.header ? "Owner" : undefined;
  }
  subscribeAccess(listener: () => void) {
    this.accessListeners.add(listener);
    return () => {
      this.accessListeners.delete(listener);
    };
  }
  subscribeVaultDenial(listener: (vault: Uint8Array) => void) {
    this.vaultDenialListeners.add(listener);
    return () => {
      this.vaultDenialListeners.delete(listener);
    };
  }
  private clearWriteState() {
    this.request = { kind: "idle" };
    this.cleanupState = { kind: "idle" };
    this.pendingSave?.chunks.forEach((x) => x.fill(0));
    this.saveState = { kind: "idle" };
  }
  private updateAccess(next?: VaultAccess) {
    const before = this.accessRole;
    this.access = next;
    const after = this.accessRole;
    if (before === after) return;
    if (after === "Viewer") {
      if (this.request.kind !== "idle" && this.request.shared)
        this.request = { kind: "idle" };
      if (this.cleanupState.kind === "cancel" && this.cleanupState.shared)
        this.cleanupState = { kind: "idle" };
      this.pendingSave?.chunks.forEach((chunk) => chunk.fill(0));
      this.saveState = { kind: "idle" };
    }
    for (const listener of this.accessListeners) listener();
  }
  private checkWriter(ownerOnly = false) {
    if (!this.sharedVault) return;
    const role = this.accessRole;
    if (role !== "Owner" && (ownerOnly || role !== "Editor"))
      throw Error("Unauthorized");
  }
  private get memberProtocol() {
    return !!this.sharedVault && this.accessRole !== "Owner";
  }
  async listAccessibleVaults(after: Uint8Array = new Uint8Array()) {
    this.checkLive();
    const t = this.session.capture();
    const page = await this.actor.list_accessible_vaults(after);
    this.session.check(t);
    return ok(page);
  }
  private async withMemberManagement<T>(
    fn: (vault: Uint8Array) => Promise<{ Ok: T } | { Err: unknown }>,
    explicitTarget?: Uint8Array,
  ): Promise<T> {
    const t = this.session.capture();
    this.checkLive();
    this.session.check(t);
    const target =
      explicitTarget ?? this.sharedVault ?? this.selectedOwnerVault;
    const usesSelection =
      !explicitTarget ||
      (this.sharedVault && equal(explicitTarget, this.sharedVault));
    if (!target || (usesSelection && this.accessRole !== "Owner"))
      throw Error("Unauthorized");
    if (target.length !== 16) throw Error("InvalidVault");
    // Each owner endpoint authenticates the exact Vault without a decryption key.
    const result = await fn(bytes(target));
    this.session.check(t);
    return ok(result);
  }
  listMembers(target?: Uint8Array) {
    return this.withMemberManagement(
      (vault) => this.actor.list_vault_members(vault),
      target,
    );
  }
  setMember(principal: Principal, role: MemberRole, target?: Uint8Array) {
    const grant = role === "Editor" ? { Editor: null } : { Viewer: null };
    return this.withMemberManagement(
      (vault) => this.actor.set_vault_member(vault, principal, grant),
      target,
    );
  }
  removeMember(principal: Principal, target?: Uint8Array) {
    return this.withMemberManagement(
      (vault) => this.actor.remove_vault_member(vault, principal),
      target,
    );
  }
  private async denyTarget(
    vault: Uint8Array,
    reason: string,
    evict?: EvictKeys,
  ): Promise<never> {
    const epoch = this.rootEpoch;
    this.session.lock();
    if (evict) await evict();
    else await this.discardVaultKeys(vault, epoch);
    throw Error(reason);
  }
  private async checkedResult<T>(
    ticket: number,
    result: { Ok: T } | { Err: unknown },
    { evict, vaultAccess = false }: { evict?: EvictKeys; vaultAccess?: boolean } = {},
  ) {
    if (this.rootEpoch !== undefined)
      await this.checkEpoch(ticket, this.rootEpoch);
    this.session.check(ticket);
    if (
      this.sharedVault &&
      "Err" in result &&
      result.Err &&
      typeof result.Err === "object" &&
      "Unauthorized" in result.Err
    ) {
      const vault = bytes(this.sharedVault);
      // Lock and start eviction before notifying any UI. Only endpoints whose
      // Unauthorized result denies the Vault itself opt in to notification.
      const denied = this.denyTarget(vault, "Unauthorized", evict);
      if (vaultAccess) {
        for (const listener of this.vaultDenialListeners) {
          if (!this.live || this.session.capture() !== ticket + 1) break;
          try {
            listener(bytes(vault));
          } catch {
            // An observer must never interrupt the denial cleanup.
          }
        }
      }
      return denied;
    }
    return ok(result);
  }
  private async readAccess(
    vault: Uint8Array,
    ticket: number,
    fresh = false,
    evict?: EvictKeys,
  ): Promise<Header> {
    if (this.accessCheck?.ticket === ticket) {
      if (!fresh) return this.accessCheck.pending;
      // A request started before key lookup or persistence cannot attest to
      // access after it. Serialize with overlapping focus and interval reads.
      await this.accessCheck.pending;
      this.session.check(ticket);
      return this.readAccess(vault, ticket, false, evict);
    }
    const pending = this.actor
      .get_vault_access(vault)
      .then(async (reply) => {
        this.session.check(ticket);
        if (
          "Err" in reply &&
          ("NotFound" in reply.Err || "Conflict" in reply.Err)
        )
          return this.denyTarget(vault, "TargetChanged", evict);
        const access = await this.checkedResult(ticket, reply, { evict, vaultAccess: true });
        this.session.check(ticket);
        const role = roleName(access.role);
        const isCaller =
          access.owner.toText() === this.identity.getPrincipal().toText();
        if (
          !equal(vault, bytes(access.header.id)) ||
          !("Active" in access.header.state) ||
          access.owner.isAnonymous() ||
          (this.access &&
            access.owner.toText() !== this.access.owner.toText()) ||
          (role === "Owner") !== isCaller
        ) {
          return this.denyTarget(vault, "TargetChanged", evict);
        }
        this.updateAccess(access);
        return structuredClone(access.header);
      })
      .finally(() => {
        if (this.accessCheck?.pending === pending) this.accessCheck = undefined;
      });
    this.accessCheck = { ticket, pending };
    return pending;
  }
  async reconcilePurchase(operation: Uint8Array) {
    this.checkLive();
    const ticket = this.session.capture();
    const owner = this.identity.getPrincipal().toText();
    const request = new Uint8Array(operation);
    const result = await this.actor.reconcile_purchase(request);
    this.session.check(ticket);
    this.checkLive();
    if (owner !== this.identity.getPrincipal().toText())
      throw Error("TargetChanged");
    const progress = ok(result);
    if (
      progress.payment.wallet.toText() !== owner ||
      !equal(bytes(progress.payment.request.operation), request)
    )
      throw Error("InvalidReceipt");
    return progress;
  }
  async listVaults() {
    this.checkLive();
    const t = this.session.capture();
    const list = ok(await this.actor.list_vaults());
    this.session.check(t);
    return list;
  }
  get hasUncertainCreation() {
    return this.creating?.ambiguous ?? false;
  }
  async create() {
    this.checkLive();
    if (!this.creating || this.header || this.sharedVault) {
      this.session.lock();
      this.header = undefined;
      this.sharedVault = undefined;
    }
    const t = this.session.capture();
    const previouslyUncertain = this.hasUncertainCreation;
    const attempt = {
      operation: this.creating?.operation ?? randomBytes(16),
      ambiguous: true,
    };
    // A lock can prevent this session from consuming even a successful reply.
    this.creating = attempt;
    const result = await this.actor.create_vault({
      operation: bytes(attempt.operation),
    });
    this.session.check(t);
    if (this.creating !== attempt) throw Error("Busy");
    if (
      !previouslyUncertain &&
      "Err" in result &&
      ("QuotaExceeded" in result.Err ||
        "Unauthorized" in result.Err ||
        "InvalidInput" in result.Err)
    ) {
      // A first refusal is definite; a retry cannot rule out an earlier
      // in-flight creation. Retain its operation ID and uncertainty.
      attempt.ambiguous = false;
    }
    const h = ok(result);
    if (bytes(h.id).length !== 16) throw Error("TargetChanged");
    this.header = structuredClone(h);
    this.creating = undefined;
    return structuredClone(h);
  }
  selectOwnedVault(header: Header) {
    this.checkLive();
    if (
      this.sharedVault ||
      !this.header ||
      !equal(bytes(this.header.id), bytes(header.id))
    ) {
      this.session.lock();
      this.sharedVault = undefined;
      this.header = structuredClone(header);
    }
    this.selectedOwnerVault = bytes(header.id);
  }
  async open(header: Header, options: OpenOptions = {}): Promise<void> {
    this.selectOwnedVault(header);
    const t = this.session.capture();
    const target = bytes(header.id);
    return this.openTarget(
      target,
      (evict) => this.readOwnedHeader(target, t, evict),
      t,
      options,
    );
  }
  private async readOwnedHeader(
    target: Uint8Array,
    ticket: number,
    evict?: EvictKeys,
  ) {
    const reply = await this.actor.get_vault_header(target);
    this.session.check(ticket);
    if (
      "Err" in reply &&
      ("NotFound" in reply.Err ||
        "Conflict" in reply.Err ||
        "Unauthorized" in reply.Err)
    )
      return this.denyTarget(target, "TargetChanged", evict);
    return structuredClone(ok(reply));
  }
  async openAccess(
    vault: Uint8Array,
    options: OpenOptions = {},
  ): Promise<void> {
    this.checkLive();
    if (vault.length !== 16) throw Error("InvalidVault");
    if (!this.sharedVault || !equal(this.sharedVault, vault)) {
      this.session.lock();
      this.header = undefined;
      this.sharedVault = bytes(vault);
    }
    const t = this.session.capture();
    const target = bytes(vault);
    return this.openTarget(
      target,
      (evict) => this.readAccess(target, t, true, evict),
      t,
      options,
    );
  }
  private async checkEpoch(ticket: number, epoch: number | undefined) {
    this.session.check(ticket);
    if (epoch === undefined) return;
    const current = await this.deviceKeys.epoch().catch(() => undefined);
    this.session.check(ticket);
    if (current !== epoch) {
      this.session.lock();
      throw Error("Locked");
    }
  }
  private async openTarget(
    target: Uint8Array,
    readHeader: (evict: EvictKeys) => Promise<Header>,
    t: number,
    options: OpenOptions,
  ) {
    const epoch = await this.deviceKeys.epoch().catch(() => undefined);
    this.session.check(t);
    let evict = () => this.discardVaultKeys(target, epoch);
    const h = await readHeader(evict);
    this.session.check(t);
    if (!equal(bytes(h.id), target) || !("Active" in h.state))
      return this.denyTarget(target, "TargetChanged", evict);
    let context: VaultContext;
    try {
      context = this.context(h);
    } catch {
      return this.denyTarget(target, "TargetChanged", evict);
    }
    await this.checkEpoch(t, epoch);
    this.session.check(t);
    const publicKey = bytes(h.public_key);
    if (this.session.root) {
      if (this.rootEpoch !== epoch) {
        this.session.lock();
        throw Error("Locked");
      }
      if (
        !this.session.matchesContext(context) ||
        !this.pinnedPublicKey ||
        !equal(this.pinnedPublicKey, publicKey)
      )
        return this.denyTarget(target, "TargetChanged", evict);
      this.header = h;
      return;
    }
    const binding = JSON.stringify([
      Array.from(contextInput(context)),
      Array.from(publicKey),
      "root/v3",
    ]);
    const revalidate = async () => {
      const current = await readHeader(evict);
      this.session.check(t);
      try {
        if (
          !("Active" in current.state) ||
          !equal(publicKey, bytes(current.public_key)) ||
          !equalContext(context, this.context(current))
        )
          throw Error("TargetChanged");
      } catch {
        return this.denyTarget(target, "TargetChanged", evict);
      }
      await this.checkEpoch(t, epoch);
      this.session.check(t);
      return current;
    };
    let current = h;
    let root: CryptoKey | undefined;
    if (epoch !== undefined) {
      root = await this.deviceKeys.get(binding, epoch).catch(() => undefined);
      await this.checkEpoch(t, epoch);
      this.session.check(t);
      current = await revalidate();
      this.session.check(t);
    }
    let saved = !!root;
    if (root) {
      try {
        validateRootHeader(context, publicKey, this.local);
      } catch {
        return this.denyTarget(target, "InvalidKeyContext", evict);
      }
    } else {
      // A member's first key is paid for by the stored owner. Only owners
      // authorize their own new debit. An ambiguous reply reuses its request.
      if (this.keyAttempt && this.keyAttempt.binding !== binding)
        return this.denyTarget(target, "TargetChanged", evict);
      const authorize = !this.memberProtocol && !this.keyAttempt;
      if (authorize && options.allowDerive === false)
        throw Error("KeyFundingRequired");
      if (authorize && options.beforeDerive) {
        await options.beforeDerive(structuredClone(current));
        this.session.check(t);
        await revalidate();
        this.session.check(t);
      }
      const attempt = (this.keyAttempt ??= {
        binding,
        vault: bytes(target),
        operation: randomBytes(16),
        transport: TransportSecretKey.random(),
      });
      const request = {
        vault: attempt.vault,
        operation: attempt.operation,
        transport: attempt.transport.publicKeyBytes(),
      };
      const result = this.memberProtocol
        ? await this.actor.shared_derive_vault_key(request)
        : await this.actor.derive_vault_key(request);
      // Paused key operations can deny derivation while the grant remains valid.
      const reply = await this.checkedResult(t, result, { evict });
      this.session.check(t);
      root = await verifiedRoot(
        context,
        publicKey,
        {
          input: bytes(reply.input),
          public_key: bytes(reply.public_key),
          encrypted_key: bytes(reply.encrypted_key),
        },
        attempt.transport,
        this.local,
      );
      this.session.check(t);
      current = await revalidate();
      this.session.check(t);
    }
    if (!saved && epoch !== undefined) {
      const writeId = crypto.randomUUID();
      saved = await this.deviceKeys
        .put(binding, root, epoch, this.session.signal, writeId)
        .catch(() => false);
      if (saved)
        evict = () =>
          this.deviceKeys.rollback(binding, writeId).catch(() => {});
      try {
        this.session.check(t);
        current = await revalidate();
        this.session.check(t);
      } catch (cause) {
        // A delayed transaction can finish after lock, switch or revocation.
        if (saved) await evict();
        throw cause;
      }
    }
    this.session.bindRoot(root, context);
    this.rootEpoch = epoch;
    this.deviceKeyStatus = saved ? "saved" : "memory";
    this.pinnedPublicKey = publicKey;
    this.header = structuredClone(current);
    this.keyAttempt = undefined;
  }
  async refreshHeader() {
    this.checkLive();
    const t = this.session.capture();
    if (!this.header || !this.session.root) throw Error("Locked");
    if (this.rootEpoch !== undefined) await this.checkEpoch(t, this.rootEpoch);
    this.session.check(t);
    const target = this.sharedVault ?? bytes(this.header.id);
    const h = this.sharedVault
      ? await this.readAccess(target, t)
      : await this.readOwnedHeader(target, t);
    if (this.rootEpoch !== undefined) await this.checkEpoch(t, this.rootEpoch);
    this.session.check(t);
    try {
      if (
        !("Active" in h.state) ||
        !this.pinnedPublicKey ||
        !equal(this.pinnedPublicKey, bytes(h.public_key)) ||
        !this.session.matchesContext(this.context(h))
      )
        throw Error("TargetChanged");
    } catch {
      return this.denyTarget(target, "TargetChanged");
    }
    this.header = structuredClone(h);
    return structuredClone(h);
  }
  private cachedContext(ticket: number) {
    this.checkLive();
    this.session.check(ticket);
    if (!this.header || !this.session.root) throw Error("Locked");
    if (
      !("Active" in this.header.state) ||
      !this.pinnedPublicKey ||
      !equal(this.pinnedPublicKey, bytes(this.header.public_key))
    ) {
      this.session.lock();
      throw Error("TargetChanged");
    }
    let context: VaultContext;
    try {
      context = this.context(this.header);
    } catch {
      this.session.lock();
      throw Error("TargetChanged");
    }
    return this.session.requireContext(context);
  }
  private async checkedContext() {
    const t = this.session.capture();
    const h = await this.refreshHeader();
    this.session.check(t);
    return this.session.requireContext(this.context(h));
  }
  async mutate(
    action: Action,
    operation: Uint8Array = randomBytes(16),
  ): Promise<MutationResult> {
    // Owners may rename any of their Vaults without switching the active
    // selection. The owner endpoint verifies the exact target in the request.
    if ("RenameVault" in action) {
      if (
        this.sharedVault &&
        equal(this.sharedVault, bytes(action.RenameVault.vault))
      )
        this.checkWriter(true);
      return this.sendMutation(action, operation, false);
    }
    const scoped = !("Collect" in action || "DeleteVault" in action);
    if (
      "PurgeObject" in action ||
      ("DeleteVault" in action &&
        this.sharedVault &&
        equal(this.sharedVault, bytes(action.DeleteVault.vault)))
    ) {
      this.checkWriter(true);
    }
    return this.sendMutation(action, operation, scoped && this.memberProtocol);
  }
  private async sendMutation(
    action: Action,
    operation: Uint8Array,
    shared: boolean,
  ): Promise<MutationResult> {
    this.checkLive();
    if (shared) this.checkWriter();
    const proposed = structuredClone({ action, operation });
    const previous = this.request;
    if (
      previous.kind !== "idle" &&
      (previous.shared !== shared ||
        stable(previous.mutation) !== stable(proposed))
    )
      throw Error("ResolvePendingMutation");
    if (previous.kind === "sending") throw Error("MutationInProgress");
    const mutation = previous.kind === "idle" ? proposed : previous.mutation;
    const t = this.session.capture();
    const sending: RequestState = { kind: "sending", mutation, shared };
    this.request = sending;
    const keyless =
      "RenameVault" in action ||
      "DeleteVault" in action ||
      "Collect" in action ||
      "CancelUpload" in action;
    const epoch = keyless ? undefined : this.rootEpoch;
    try {
      if (epoch !== undefined) {
        await this.checkEpoch(t, epoch);
        this.session.check(t);
        if (this.request !== sending) throw Error("Unauthorized");
      }
      const result = shared
        ? await this.actor.shared_mutate(this.sharedVault!, mutation)
        : await this.actor.mutate(mutation);
      if (epoch !== undefined) await this.checkEpoch(t, epoch);
      this.session.check(t);
      if (this.request !== sending) throw Error("Unauthorized");
      this.request = { kind: "idle" };
      if (shared && "Err" in result && "Unauthorized" in result.Err)
        await this.refreshHeader();
      this.session.check(t);
      return ok(result);
    } finally {
      // A transport failure preserves the exact request; a delivered Err clears it.
      // An older callback must never replace a newer session's request.
      if (this.request === sending)
        this.request = { kind: "ambiguous", mutation, shared };
    }
  }
  async retryMutation() {
    if (this.request.kind === "idle") throw Error("NoPendingMutation");
    const { mutation } = this.request;
    return this.sendMutation(
      mutation.action,
      bytes(mutation.operation),
      this.request.shared,
    );
  }
  private get pendingSave() {
    return "job" in this.saveState ? this.saveState.job : undefined;
  }
  get hasPendingSave() {
    return !!this.pendingSave;
  }
  get hasPendingMutation() {
    return this.request.kind !== "idle";
  }
  get hasInterruptedChange() {
    return (
      !this.hasPendingSave &&
      (this.request.kind === "ambiguous" || this.cleanupState.kind !== "idle")
    );
  }
  async retryInterruptedChange() {
    if (this.hasPendingSave) throw Error("SavePending");
    const cleanup = this.cleanupState;
    const request = this.request;
    // A cleanup can be queued behind an older request with an unknown result.
    if (
      cleanup.kind === "idle" ||
      (request.kind !== "idle" &&
        !equal(cleanup.operation, bytes(request.mutation.operation)))
    ) {
      await this.retryMutation();
      return;
    }
    if (cleanup.kind === "delete") return this.deleteVault(cleanup.vault);
    return this.cancelUploadWith(
      cleanup.vault,
      cleanup.upload,
      cleanup.job,
      cleanup.shared,
    );
  }
  async renameVault(header: Header, name: string) {
    if (this.hasPendingSave) throw Error("SavePending");
    const trimmed = name.trim();
    if (!isValidVaultName(trimmed)) throw Error("InvalidInput");
    return this.mutate({
      RenameVault: {
        vault: header.id,
        name: trimmed,
        expected_sequence: header.sequence,
      },
    });
  }
  async save(
    metadata: Metadata,
    plaintext: Uint8Array,
    item?: Item,
    progress: (n: number) => void = () => {},
  ) {
    if (this.saveState.kind !== "idle") throw Error("SavePending");
    if (this.request.kind !== "idle") throw Error("ResolvePendingMutation");
    const preparing: SaveState = { kind: "preparing" };
    this.saveState = preparing;
    const detach = this.session.addLockCleanup(() => plaintext.fill(0));
    try {
      const t = this.session.capture();
      const inline = plaintext.length <= 256 * 1024;
      if (inline && !this.sharedVault && this.rootEpoch !== undefined)
        await this.checkEpoch(t, this.rootEpoch);
      const context =
        inline && !this.sharedVault
          ? this.cachedContext(t)
          : await this.checkedContext();
      this.session.check(t);
      if (this.saveState !== preparing) throw Error("Unauthorized");
      this.checkWriter();
      if (item && !equal(context.vault, bytes(item.revision.vault)))
        throw Error("TargetChanged");
      const object = item ? bytes(item.revision.object) : randomBytes(16),
        expected = item?.revision.revision ?? 0n;
      const doc = await encryptDocumentV3(
        this.session.root!,
        context,
        object,
        expected + 1n,
        metadata,
        plaintext,
      );
      this.session.check(t);
      const request = {
        vault: bytes(context.vault),
        object,
        expected_revision: expected,
        operation: randomBytes(16),
        plain_size: BigInt(plaintext.length),
        manifest: doc.manifest,
        chunk_hashes: doc.hashes,
      };
      const contextHash = inline
        ? await hash(contextInput(context))
        : undefined;
      this.session.check(t);
      if (this.saveState !== preparing) throw Error("Unauthorized");
      this.checkWriter();
      this.saveState = {
        kind: "ready",
        job: {
          request,
          chunks: doc.chunks,
          phase: inline ? doc.chunks.length : -1,
          contextHash,
          operation: randomBytes(16),
          ticket: t,
        },
      };
    } finally {
      detach();
      if (this.saveState === preparing) this.saveState = { kind: "idle" };
    }
    return this.resumeSave(progress);
  }
  async resumeSave(progress: (n: number) => void = () => {}) {
    const j = this.pendingSave;
    if (!j) throw Error("NoPendingSave");
    if (this.saveState.kind !== "ready") throw Error("SaveInProgress");
    const sending: SaveState = { kind: "sending", job: j };
    this.saveState = sending;
    try {
      if (j.contextHash && !this.sharedVault) this.cachedContext(j.ticket);
      else await this.checkedContext();
      this.session.check(j.ticket);
      if (this.saveState !== sending) throw Error("Unauthorized");
      this.checkWriter();
      while (j.phase <= j.chunks.length) {
        const action: Action = j.contextHash
          ? {
              SaveInline: {
                request: j.request,
                bytes: j.chunks[0],
                context_hash: j.contextHash,
              },
            }
          : j.phase === -1
            ? { BeginRevision: j.request }
            : j.phase < j.chunks.length
              ? {
                  PutChunk: {
                    upload: j.request.operation,
                    index: j.phase,
                    bytes: j.chunks[j.phase],
                  },
                }
              : { CommitRevision: { upload: j.request.operation } };
        const wasAmbiguous = j.uncertain || this.request.kind === "ambiguous";
        let r: MutationResult;
        try {
          r = await this.mutate(action, j.operation);
        } catch (error) {
          // A retry's rejection cannot establish the historical outcome of a
          // request whose earlier response was lost, even after receipt GC.
          const unresolvedReceipt = !!wasAmbiguous;
          j.uncertain ||=
            this.request.kind === "ambiguous" || unresolvedReceipt;
          if (j.contextHash && unresolvedReceipt) {
            try {
              const ownedRequest = this.ownedInlineRequest(j);
              const revision = await this.reconciledInline(j);
              if (this.rootEpoch !== undefined)
                await this.checkEpoch(j.ticket, this.rootEpoch);
              this.session.check(j.ticket);
              if (this.saveState !== sending) throw Error("Unauthorized");
              if (this.request === ownedRequest)
                this.request = { kind: "idle" };
              this.saveState = { kind: "idle" };
              progress(100);
              return revision;
            } catch {
              this.session.check(j.ticket);
            }
          }
          if (
            j.contextHash &&
            this.request.kind === "idle" &&
            this.saveState === sending &&
            !unresolvedReceipt
          ) {
            j.chunks.forEach((chunk) => chunk.fill(0));
            this.saveState = { kind: "idle" };
          }
          throw error;
        }
        this.session.check(j.ticket);
        if (
          (j.phase === -1 && !("Upload" in r)) ||
          (j.phase >= 0 && j.phase < j.chunks.length && !("Done" in r)) ||
          (j.phase === j.chunks.length && !("Revision" in r))
        )
          throw Error("InvalidReceipt");
        if (
          "Upload" in r &&
          !equal(bytes(r.Upload.id), bytes(j.request.operation))
        )
          throw Error("InvalidReceipt");
        if ("Revision" in r) {
          if (
            !equal(bytes(r.Revision.vault), bytes(j.request.vault)) ||
            !equal(bytes(r.Revision.object), bytes(j.request.object)) ||
            r.Revision.revision !== j.request.expected_revision + 1n
          )
            throw Error("InvalidReceipt");
          j.revision = r.Revision;
        }
        j.phase++;
        j.operation = randomBytes(16);
        progress(
          Math.round(
            (Math.min(j.chunks.length, Math.max(0, j.phase)) /
              j.chunks.length) *
              100,
          ),
        );
      }
      const revision = j.revision;
      if (!revision) throw Error("InvalidReceipt");
      this.saveState = { kind: "idle" };
      return revision;
    } finally {
      if (this.saveState === sending)
        this.saveState = { kind: "ready", job: j };
    }
  }
  private ownedInlineRequest(j: Save): RequestState | undefined {
    const request = this.request;
    if (request.kind === "sending") return undefined;
    if (request.kind === "idle") return request;
    const expected = {
      action: {
        SaveInline: {
          request: j.request,
          bytes: j.chunks[0],
          context_hash: j.contextHash,
        },
      },
      operation: j.operation,
    };
    return stable(request.mutation) === stable(expected) ? request : undefined;
  }
  // Authenticated immutable revision lookup remains usable after both kinds
  // of receipt are collected. Match the full encrypted payload, not just IDs.
  private async reconciledInline(j: Save): Promise<Revision> {
    const r = await this.manifest(
      j.request.vault,
      j.request.object,
      j.request.expected_revision + 1n,
      j.ticket,
    );
    if (
      r.deleted ||
      r.sequence <= 0n ||
      !sameObject(r, j.request) ||
      r.revision !== j.request.expected_revision + 1n ||
      r.plain_size !== j.request.plain_size ||
      !equal(bytes(r.manifest), bytes(j.request.manifest)) ||
      r.chunk_hashes.length !== j.request.chunk_hashes.length ||
      r.chunk_hashes.some(
        (h, i) => !equal(bytes(h), bytes(j.request.chunk_hashes[i])),
      )
    )
      throw Error("InvalidReceipt");
    return r;
  }
  private async manifest(
    vault: Header["id"],
    object: Revision["object"],
    revision: bigint,
    ticket: number,
  ) {
    const reply = this.sharedVault
      ? await this.actor.shared_get_manifest(vault, object, revision)
      : await this.actor.get_manifest(vault, object, revision);
    return this.checkedResult(ticket, reply, { vaultAccess: true });
  }
  async latest(object: Uint8Array) {
    const t = this.session.capture();
    const c = await this.checkedContext();
    this.session.check(t);
    const revision = await this.manifest(c.vault, object, 0n, t);
    this.session.check(t);
    if (revision.deleted || !sameObject(revision, { vault: c.vault, object }))
      throw Error("NotFound");
    return revision;
  }
  async readItem(revision: Revision): Promise<Item> {
    const t = this.session.capture();
    if (this.rootEpoch !== undefined) await this.checkEpoch(t, this.rootEpoch);
    const context = this.cachedContext(t);
    const root = this.session.root!;
    if (revision.deleted || !equal(context.vault, bytes(revision.vault)))
      throw Error("TargetChanged");
    const { metadata } = await readManifestV3(
      root,
      context,
      bytes(revision.object),
      revision.revision,
      bytes(revision.manifest),
    );
    if (this.rootEpoch !== undefined) await this.checkEpoch(t, this.rootEpoch);
    this.checkReadContext(context, root, t);
    if (this.sharedVault) {
      await this.refreshHeader();
      this.checkReadContext(context, root, t);
    }
    return { revision, metadata };
  }
  private async historyPage(
    vault: Header["id"],
    object: Revision["object"],
    before: bigint,
    ticket: number,
  ) {
    const reply = this.sharedVault
      ? await this.actor.shared_list_history(vault, object, before)
      : await this.actor.list_history(vault, object, before);
    const page = await this.checkedResult(ticket, reply, { vaultAccess: true });
    this.session.check(ticket);
    let boundary = before;
    for (const entry of page.entries) {
      if (
        !sameObject(entry, { vault, object }) ||
        entry.revision <= 0n ||
        entry.revision >= boundary
      )
        throw Error("InvalidReceipt");
      boundary = entry.revision;
    }
    if (page.next.length && (!page.entries.length || page.next[0] !== boundary))
      throw Error("InvalidReceipt");
    return page;
  }
  async items({ includeDeleted = true } = {}) {
    const t = this.session.capture();
    const c = await this.checkedContext();
    this.session.check(t);
    const root = this.session.root!;
    const items: Item[] = [];
    let after = new Uint8Array();
    do {
      this.checkReadContext(c, root, t);
      const reply = this.sharedVault
        ? await this.actor.shared_list_objects(c.vault, after)
        : await this.actor.list_objects(c.vault, after);
      const page = await this.checkedResult(t, reply, { vaultAccess: true });
      this.session.check(t);
      for (const r of page.entries) {
        if (!equal(c.vault, bytes(r.vault))) throw Error("TargetChanged");
        let source = r;
        if (r.deleted) {
          if (!includeDeleted) continue;
          const history = await this.historyPage(
            r.vault,
            r.object,
            18446744073709551615n,
            t,
          );
          this.session.check(t);
          const previous = history.entries.find((x) => !x.deleted);
          if (!previous) {
            items.push({
              revision: r,
              metadata: { kind: "note", title: "Deleted document" },
            });
            continue;
          }
          source = previous;
        }
        if (this.rootEpoch !== undefined)
          await this.checkEpoch(t, this.rootEpoch);
        this.checkReadContext(c, root, t);
        const parsed = await readManifestV3(
          root,
          c,
          bytes(source.object),
          source.revision,
          bytes(source.manifest),
        );
        this.session.check(t);
        items.push({ revision: r, metadata: parsed.metadata });
      }
      after = page.next[0] ? bytes(page.next[0]) : new Uint8Array();
    } while (after.length);
    if (this.sharedVault) await this.refreshHeader();
    else if (this.rootEpoch !== undefined)
      await this.checkEpoch(t, this.rootEpoch);
    this.checkReadContext(c, root, t);
    return items;
  }
  // Explicit note-only search. Results contain metadata/revisions, never body text.
  // Shared slots also bound requests left in flight by a cancelled search.
  async searchNotes(
    items: readonly Item[],
    query: string,
    options: {
      signal?: AbortSignal;
      onProgress?: (progress: { completed: number; total: number }) => void;
    } = {},
  ): Promise<Item[]> {
    const ticket = this.session.capture();
    if (this.rootEpoch !== undefined)
      await this.checkEpoch(ticket, this.rootEpoch);
    this.cachedContext(ticket);
    const controller = new AbortController();
    const sessionSignal = this.session.signal;
    const stop = () => controller.abort();
    options.signal?.addEventListener("abort", stop, { once: true });
    sessionSignal.addEventListener("abort", stop, { once: true });
    if (options.signal?.aborted || sessionSignal.aborted) stop();
    const check = () => {
      this.session.check(ticket);
      if (controller.signal.aborted) throw Error("SearchCancelled");
    };
    let rejectAbort!: (cause: Error) => void;
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAbort = reject;
    });
    const onAbort = () => {
      rejectAbort(
        Error(this.session.capture() !== ticket ? "Locked" : "SearchCancelled"),
      );
    };
    controller.signal.addEventListener("abort", onAbort, { once: true });
    const notes = items.filter(
      (item) => item.metadata.kind === "note" && !item.revision.deleted,
    );
    const needle = query.trim().toLocaleLowerCase();
    const matches = new Set<Item>();
    let next = 0,
      completed = 0;
    const worker = async () => {
      while (next < notes.length && needle) {
        check();
        while (this.searchReads.size >= 2) {
          await Promise.race([...this.searchReads, aborted]);
          check();
        }
        const item = notes[next++];
        if (!item) return;
        const pending = this.read(item.revision, { signal: controller.signal });
        const slot = pending.then(
          () => {},
          () => {},
        );
        this.searchReads.add(slot);
        void slot.then(() => this.searchReads.delete(slot));
        const doc = await pending;
        try {
          check();
          if (
            new TextDecoder()
              .decode(doc.plaintext)
              .toLocaleLowerCase()
              .includes(needle)
          )
            matches.add(item);
        } finally {
          doc.plaintext.fill(0);
        }
        check();
        options.onProgress?.({ completed: ++completed, total: notes.length });
      }
    };
    try {
      check();
      options.onProgress?.({ completed: 0, total: needle ? notes.length : 0 });
      await Promise.race([Promise.all([worker(), worker()]), aborted]);
      if (this.rootEpoch !== undefined)
        await this.checkEpoch(ticket, this.rootEpoch);
      check();
      return notes.filter((item) => matches.has(item));
    } finally {
      options.signal?.removeEventListener("abort", stop);
      sessionSignal.removeEventListener("abort", stop);
      controller.signal.removeEventListener("abort", onAbort);
      controller.abort();
      matches.clear();
    }
  }
  private checkReadContext(c: VaultContext, root: CryptoKey, t: number) {
    this.session.check(t);
    this.checkLive();
    this.session.requireContext(c);
    if (this.session.root !== root) throw Error("TargetChanged");
  }
  async read(r: Revision, options: { signal?: AbortSignal } = {}) {
    const t = this.session.capture();
    const check = () => {
      this.session.check(t);
      if (options.signal?.aborted) throw Error("SearchCancelled");
    };
    check();
    const c = await this.checkedContext();
    const root = this.session.root!;
    check();
    this.checkReadContext(c, root, t);
    if (!equal(c.vault, bytes(r.vault))) throw Error("TargetChanged");
    const chunks: Uint8Array[] = [];
    for (let i = 0; i < r.chunk_hashes.length; i++) {
      this.checkReadContext(c, root, t);
      const reply = this.sharedVault
        ? await this.actor.shared_get_chunk(r.vault, r.object, r.revision, i)
        : await this.actor.get_chunk(r.vault, r.object, r.revision, i);
      this.checkReadContext(c, root, t);
      chunks.push(bytes(await this.checkedResult(t, reply, { vaultAccess: true })));
      check();
    }
    if (this.rootEpoch !== undefined) await this.checkEpoch(t, this.rootEpoch);
    this.checkReadContext(c, root, t);
    const doc = await decryptDocumentV3(
      root,
      c,
      bytes(r.object),
      r.revision,
      bytes(r.manifest),
      chunks,
      r.chunk_hashes.map(bytes),
    );
    const detach = this.session.addLockCleanup(() => doc.plaintext.fill(0));
    try {
      this.checkReadContext(c, root, t);
      check();
      if (this.sharedVault) await this.refreshHeader();
      else if (this.rootEpoch !== undefined)
        await this.checkEpoch(t, this.rootEpoch);
      this.checkReadContext(c, root, t);
      check();
      return doc;
    } catch (e) {
      doc.plaintext.fill(0);
      throw e;
    } finally {
      detach();
    }
  }
  async deleteObject(r: Revision) {
    if (this.saveState.kind !== "idle") throw Error("SavePending");
    const t = this.session.capture();
    const c = await this.checkedContext();
    this.session.check(t);
    if (!equal(c.vault, bytes(r.vault))) throw Error("TargetChanged");
    return this.mutate({
      DeleteObject: {
        vault: r.vault,
        object: r.object,
        expected_revision: r.revision,
      },
    });
  }
  async purgeObject(r: Revision) {
    if (this.saveState.kind !== "idle") throw Error("SavePending");
    const t = this.session.capture();
    const c = await this.checkedContext();
    this.session.check(t);
    if (!equal(c.vault, bytes(r.vault))) throw Error("TargetChanged");
    return this.mutate({
      PurgeObject: {
        vault: r.vault,
        object: r.object,
        expected_revision: r.revision,
      },
    });
  }
  async history(r: Revision, before = 18446744073709551615n) {
    const t = this.session.capture();
    const c = await this.checkedContext();
    this.session.check(t);
    if (!equal(c.vault, bytes(r.vault))) throw Error("TargetChanged");
    return this.historyPage(r.vault, r.object, before, t);
  }
  async quota() {
    const t = this.session.capture();
    const c = await this.checkedContext();
    this.session.check(t);
    const reply = this.sharedVault
      ? await this.actor.shared_get_quota(c.vault)
      : await this.actor.get_quota(c.vault);
    return this.checkedResult(t, reply, { vaultAccess: true });
  }
  async pendingUploads(after = new Uint8Array()) {
    this.checkLive();
    if (!this.memberProtocol) return this.ownerPendingUploads(after);
    const t = this.session.capture();
    const reply = await this.actor.shared_list_pending_uploads(
      this.sharedVault!,
      after,
    );
    return this.checkedResult(t, reply, { vaultAccess: true });
  }
  async ownerPendingUploads(after = new Uint8Array()) {
    this.checkLive();
    const t = this.session.capture();
    const result = ok(await this.actor.list_pending_uploads(after));
    this.session.check(t);
    return result;
  }
  async uploadStatus(upload: Uint8Array) {
    this.checkLive();
    const t = this.session.capture();
    const reply = this.memberProtocol
      ? await this.actor.shared_get_upload_status(this.sharedVault!, upload)
      : await this.actor.get_upload_status(upload);
    return this.checkedResult(t, reply);
  }
  async cancelSave() {
    const j = this.pendingSave;
    if (!j) throw Error("NoPendingSave");
    if (this.saveState.kind !== "ready") throw Error("SaveInProgress");
    const cancelling: SaveState = { kind: "cancelling", job: j };
    this.saveState = cancelling;
    const cleanup = this.cleanupState;
    try {
      const t = this.session.capture();
      const check = () => {
        this.session.check(t);
        if (this.saveState !== cancelling) throw Error("Unauthorized");
      };
      if (j.contextHash && (j.uncertain || this.request.kind === "ambiguous")) {
        const ownedRequest = this.ownedInlineRequest(j);
        const revision = await this.reconciledInline(j);
        check();
        if (this.request === ownedRequest) this.request = { kind: "idle" };
        j.chunks.forEach((chunk) => chunk.fill(0));
        this.saveState = { kind: "idle" };
        return {
          Committed: {
            vault: revision.vault,
            object: revision.object,
            revision: revision.revision,
            sequence: revision.sequence,
          },
        };
      }
      if (this.request.kind !== "idle") {
        await this.retryMutation();
        check();
      }
      const status = await this.uploadStatus(bytes(j.request.operation));
      check();
      if (
        "Committed" in status &&
        (!sameObject(status.Committed, j.request) ||
          status.Committed.revision !== j.request.expected_revision + 1n ||
          status.Committed.sequence <= 0n)
      )
        throw Error("InvalidReceipt");
      if ("Pending" in status) {
        if (!sameBeginRequest(status.Pending.request, j.request))
          throw Error("InvalidReceipt");
        await this.cancelUpload(
          bytes(j.request.vault),
          bytes(j.request.operation),
          status.Pending.cancel_job[0]
            ? bytes(status.Pending.cancel_job[0])
            : undefined,
        );
      }
      check();
      j.chunks.forEach((x) => x.fill(0));
      if (this.saveState === cancelling) this.saveState = { kind: "idle" };
      // Replaying a lost final CancelUpload can report a terminal status without
      // re-entering cleanup(). Release that job, never another resource's retry.
      if (
        this.cleanupState === cleanup &&
        cleanup.kind === "cancel" &&
        equal(cleanup.vault, bytes(j.request.vault)) &&
        equal(cleanup.upload, bytes(j.request.operation))
      )
        this.cleanupState = { kind: "idle" };
      return status;
    } finally {
      if (this.saveState === cancelling)
        this.saveState = { kind: "ready", job: j };
    }
  }
  async cancelUpload(vault: Uint8Array, upload: Uint8Array, job?: Uint8Array) {
    const shared = this.memberProtocol;
    if (shared && !equal(this.sharedVault!, vault))
      throw Error("TargetChanged");
    return this.cancelUploadWith(vault, upload, job, shared);
  }
  async cancelOwnedUpload(
    vault: Uint8Array,
    upload: Uint8Array,
    job?: Uint8Array,
  ) {
    return this.cancelUploadWith(vault, upload, job, false);
  }
  private async cancelUploadWith(
    vault: Uint8Array,
    upload: Uint8Array,
    job: Uint8Array | undefined,
    shared: boolean,
  ) {
    this.checkLive();
    if (shared) this.checkWriter();
    if (this.cleanupState.kind === "idle")
      this.cleanupState = {
        kind: "cancel",
        shared,
        vault: bytes(vault),
        upload: bytes(upload),
        job: job ? bytes(job) : randomBytes(16),
        operation: randomBytes(16),
      };
    const j = this.cleanupState;
    if (
      j.kind !== "cancel" ||
      j.shared !== shared ||
      !equal(j.vault, vault) ||
      !equal(j.upload, upload) ||
      (job && !equal(j.job, job))
    )
      throw Error("ResolvePendingMutation");
    try {
      await this.cleanup(j);
    } catch (error) {
      if (this.request.kind === "idle" && this.cleanupState === j)
        this.cleanupState = { kind: "idle" };
      throw error;
    }
  }
  async deleteVault(vault: Uint8Array) {
    this.checkLive();
    if (this.sharedVault && equal(this.sharedVault, vault))
      this.checkWriter(true);
    const t = this.session.capture();
    if (this.cleanupState.kind === "idle")
      this.cleanupState = {
        kind: "delete",
        vault: bytes(vault),
        operation: randomBytes(16),
      };
    const j = this.cleanupState;
    if (j.kind !== "delete" || !equal(j.vault, vault))
      throw Error("ResolvePendingMutation");
    try {
      await this.cleanup(j);
    } catch (error) {
      if (this.request.kind === "idle" && this.cleanupState === j)
        this.cleanupState = { kind: "idle" };
      throw error;
    }
    this.session.check(t);
    if (this.header && equal(bytes(this.header.id), vault)) {
      await this.discardVaultKeys(vault);
      this.session.check(t);
      this.session.lock();
      this.header = undefined;
    }
  }
  private async cleanup(j: CleanupJob) {
    const t = this.session.capture();
    for (;;) {
      const action: Action =
        j.kind === "cancel"
          ? { CancelUpload: { vault: j.vault, upload: j.upload, job: j.job } }
          : { DeleteVault: { vault: j.vault } };
      const r = await this.sendMutation(
        action,
        j.operation,
        j.kind === "cancel" && j.shared,
      );
      this.session.check(t);
      if (!("Progress" in r)) throw Error("InvalidReceipt");
      if (r.Progress) {
        this.cleanupState = { kind: "idle" };
        return;
      }
      j.operation = randomBytes(16);
    }
  }
  async collect() {
    try {
      return await this.mutate(
        { Collect: null },
        this.request.kind !== "idle" &&
          "Collect" in this.request.mutation.action
          ? bytes(this.request.mutation.operation)
          : undefined,
      );
    } catch (e) {
      if (e instanceof Error && e.message === "NotFound") return undefined;
      throw e;
    }
  }
}
function roleName(role: VaultAccess["role"]): VaultRole {
  if ("Owner" in role) return "Owner";
  return "Editor" in role ? "Editor" : "Viewer";
}
type ObjectTarget = Pick<Revision, "vault" | "object">;
function sameObject(a: ObjectTarget, b: ObjectTarget) {
  return (
    equal(bytes(a.vault), bytes(b.vault)) &&
    equal(bytes(a.object), bytes(b.object))
  );
}
function sameBeginRequest(a: BeginRevision, b: BeginRevision) {
  return (
    sameObject(a, b) &&
    equal(bytes(a.operation), bytes(b.operation)) &&
    a.expected_revision === b.expected_revision &&
    a.plain_size === b.plain_size &&
    equal(bytes(a.manifest), bytes(b.manifest)) &&
    a.chunk_hashes.length === b.chunk_hashes.length &&
    a.chunk_hashes.every((hash, index) =>
      equal(bytes(hash), bytes(b.chunk_hashes[index])),
    )
  );
}
function equalContext(a: VaultContext, b: VaultContext) {
  return (
    a.canister === b.canister &&
    a.owner === b.owner &&
    a.key_name === b.key_name &&
    equal(a.vault, b.vault) &&
    equal(a.nonce, b.nonce)
  );
}
function stable(value: unknown): string {
  return JSON.stringify(value, (_k, v) =>
    typeof v === "bigint" ? `${v}n` : v instanceof Uint8Array ? b64(v) : v,
  );
}
