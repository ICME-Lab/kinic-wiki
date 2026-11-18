import { PaymentFailure } from "./errors";
import { normalizePaymentScope } from "./terms";
import type { PaymentScope, RecoveryRecord } from "./types";

const stages: readonly RecoveryRecord["stage"][] = [
  "quote-dispatched", "approval-dispatched", "approved", "purchase-dispatched", "paid",
];

function storageFailure(): never {
  throw new PaymentFailure("StorageUnavailable");
}

function exactKeys(value: unknown, keys: string[]): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function canonicalScope(value: unknown): PaymentScope {
  if (!exactKeys(value, ["origin", "host", "ledger", "spender", "payer", "target"])
    || !exactKeys(value.payer, ["owner", "provider"])
    || typeof value.payer.provider !== "string" || !["ii", "plug", "oisy"].includes(value.payer.provider)
    || typeof value.payer.owner !== "string"
    || typeof value.origin !== "string" || typeof value.host !== "string"
    || typeof value.ledger !== "string" || typeof value.spender !== "string") return storageFailure();
  const target = value.target;
  if (!(exactKeys(target, ["kind", "beneficiary"]) && target.kind === "vault" && typeof target.beneficiary === "string")
    && !(exactKeys(target, ["kind", "databaseId"]) && target.kind === "wiki" && typeof target.databaseId === "string" && target.databaseId))
    return storageFailure();
  try {
    const scope = normalizePaymentScope(value as PaymentScope);
    if (scope.origin === "null" || scope.host === "null") return storageFailure();
    return scope;
  } catch {
    return storageFailure();
  }
}

export function recoveryTargetKey(scope: PaymentScope): string {
  const { origin, host, ledger, spender, target } = canonicalScope(scope);
  return "kinic.payments.v1:" + JSON.stringify([origin, host, ledger, spender, target]);
}

export function samePaymentScope(left: PaymentScope, right: PaymentScope): boolean {
  return JSON.stringify(canonicalScope(left)) === JSON.stringify(canonicalScope(right));
}

function isJson(value: unknown): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isSafeInteger(value);
  if (Array.isArray(value)) return Object.keys(value).length === value.length && value.every(isJson);
  if (typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) return false;
  return Object.values(value).every(isJson);
}

function decode(value: unknown, key: string): RecoveryRecord {
  if (!exactKeys(value, ["version", "id", "stage", "scope", "context"]) || value.version !== 1
    || typeof value.id !== "string" || !value.id || !stages.includes(value.stage as RecoveryRecord["stage"])
    || !isJson(value.context)) return storageFailure();
  const scope = canonicalScope(value.scope);
  if (recoveryTargetKey(scope) !== key) return storageFailure();
  return { version: 1, scope, id: value.id, stage: value.stage as RecoveryRecord["stage"], context: value.context };
}

function access<T>(operation: () => T): T {
  try {
    return operation();
  } catch {
    return storageFailure();
  }
}

export function createRecoveryStore(storage: Pick<Storage, "getItem" | "setItem" | "removeItem">) {
  // A single target slot makes the original payer discoverable only to its own
  // adapter while preventing a different funding source from replacing it.
  function read(scope: PaymentScope) {
    const key = recoveryTargetKey(scope);
    return access(() => {
      const raw = storage.getItem(key);
      return raw === null ? null : decode(JSON.parse(raw), key);
    });
  }

  return {
    list(scope: PaymentScope): RecoveryRecord[] {
      const record = read(scope);
      return record && samePaymentScope(record.scope, scope) ? [record] : [];
    },
    hasTargetConflict(scope: PaymentScope): boolean {
      const record = read(scope);
      return record !== null && !samePaymentScope(record.scope, scope);
    },
    put(record: RecoveryRecord, options?: { approvalRejected: true }): void {
      const key = recoveryTargetKey(record.scope);
      const checked = access(() => decode(record, key));
      const existing = read(record.scope);
      if (existing && (!samePaymentScope(existing.scope, checked.scope) || existing.id !== checked.id))
        throw new PaymentFailure("AccountChanged");
      if (existing && stages.indexOf(checked.stage) < stages.indexOf(existing.stage)) {
        const confirmedRefusal = options?.approvalRejected && existing.stage === "approval-dispatched"
          && checked.stage === "quote-dispatched";
        if (!confirmedRefusal) throw new PaymentFailure("InvalidReply");
      }
      access(() => storage.setItem(key, JSON.stringify(checked)));
    },
    remove(scope: PaymentScope, id: string): void {
      const existing = read(scope);
      if (!existing) return;
      if (!samePaymentScope(existing.scope, scope)) throw new PaymentFailure("AccountChanged");
      if (existing.id === id) access(() => storage.removeItem(recoveryTargetKey(scope)));
    },
  };
}

export type RecoveryStore = ReturnType<typeof createRecoveryStore>;
