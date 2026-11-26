"use client";
// Where: /vault-credit, once this Wiki account is linked to a Vault account.
// What: the Wiki owner's standing permission to refill Vault automatically.
// Why: Wiki is the only side that can authorize spending its database credits.

import { useEffect, useId, useState } from "react";
import type {
  AutoTopupPolicy,
  AutoTopupStatus,
  WikiBridgeActor,
} from "@kinic/credit-bridge-candid";
import { Button } from "@kinic/ui/button";
import { Input } from "@kinic/ui/input";
import { formatCycles } from "@kinic/ui/cycles";
import { StatusPill } from "@/components/ui/status-pill";
import { AdminPanel } from "@/components/admin-ui";

export type AutoTopupDatabase = { databaseId: string; name: string };

const BILLION = 1_000_000_000n;
/** "12.5" billion cycles → 12_500_000_000n; rejects negatives and over-precision. */
export function parseBillions(text: string): bigint | null {
  const match = /^\s*(\d{1,12})(?:\.(\d{1,9}))?\s*$/.exec(text);
  if (!match) return null;
  const fraction = (match[2] ?? "").padEnd(9, "0");
  return BigInt(match[1]) * BILLION + BigInt(fraction);
}
function billions(value: bigint): string {
  const whole = value / BILLION;
  const fraction = (value % BILLION).toString().padStart(9, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : `${whole}`;
}
const defaults = { threshold: "10", amount: "50", daily: "200", keep: "100" };

export function AutoTopupPanel({
  actor,
  databases,
  disabled,
}: {
  actor: WikiBridgeActor | undefined;
  databases: AutoTopupDatabase[];
  disabled: boolean;
}) {
  // undefined while loading; null when no policy is set.
  const [status, setStatus] = useState<AutoTopupStatus | null>();
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [database, setDatabase] = useState("");
  const [threshold, setThreshold] = useState(defaults.threshold);
  const [amount, setAmount] = useState(defaults.amount);
  const [daily, setDaily] = useState(defaults.daily);
  const [keep, setKeep] = useState(defaults.keep);

  useEffect(() => {
    if (!actor) return;
    let live = true;
    void Promise.resolve()
      .then(() => actor.get_vault_auto_topup())
      .then((reply) => {
        if (live) setStatus("Ok" in reply ? (reply.Ok[0] ?? null) : null);
      })
      .catch(() => {
        if (live) setStatus(null);
      });
    return () => {
      live = false;
    };
  }, [actor]);

  const edit = () => {
    const policy = status?.policy;
    setDatabase(policy?.database_id ?? databases[0]?.databaseId ?? "");
    setThreshold(policy ? billions(policy.threshold_cycles) : defaults.threshold);
    setAmount(policy ? billions(policy.amount_cycles) : defaults.amount);
    setDaily(policy ? billions(policy.daily_limit_cycles) : defaults.daily);
    setKeep(policy ? billions(policy.min_database_cycles) : defaults.keep);
    setNotice("");
    setEditing(true);
  };
  const values = {
    threshold: parseBillions(threshold),
    amount: parseBillions(amount),
    daily: parseBillions(daily),
    keep: parseBillions(keep),
  };
  const invalid =
    !database ||
    Object.values(values).some((v) => v === null) ||
    values.threshold === 0n ||
    values.amount === 0n ||
    (values.daily ?? 0n) < (values.amount ?? 0n);
  const save = (policy: AutoTopupPolicy | null) => {
    if (!actor) return;
    setBusy(true);
    setNotice("");
    void actor
      .set_vault_auto_topup(policy ? [policy] : [])
      .then((reply) => {
        if ("Err" in reply) throw Error(Object.keys(reply.Err)[0]);
        setStatus(reply.Ok[0] ?? null);
        setEditing(false);
        setNotice(policy ? "Auto top-up saved." : "Auto top-up turned off.");
      })
      .catch(() => setNotice("Could not save auto top-up. Check the database and amounts, then try again."))
      .finally(() => setBusy(false));
  };

  if (status === undefined) return null;
  const policy = status?.policy;
  return (
    <AdminPanel className="grid min-w-0 gap-3" ariaLabel="Auto top-up">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold">Auto top-up</h2>
        <StatusPill dot tone={policy ? "positive" : "neutral"} label={policy ? "On" : "Off"} />
      </div>
      {!editing ? (
        <>
          <p className="text-sm text-muted">
            {policy && status
              ? `Below ${formatCycles(policy.threshold_cycles)}: add ${formatCycles(policy.amount_cycles)} from ${status.database_name} (max ${formatCycles(policy.daily_limit_cycles)}/day, keep ${formatCycles(policy.min_database_cycles)}). Today: ${status.sent_today_cycles === 0n ? "none" : formatCycles(status.sent_today_cycles)}.`
              : "Refill Vault automatically when balance is low."}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant={policy ? "outline" : "default"} disabled={disabled || busy || !databases.length} onClick={edit}>
              {policy ? "Change" : "Turn on auto top-up"}
            </Button>
            {policy ? (
              <Button size="sm" variant="outline" className="text-dangerText" disabled={disabled || busy} onClick={() => save(null)}>
                Turn off
              </Button>
            ) : null}
          </div>
        </>
      ) : (
        <form
          className="grid gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (invalid) return;
            save({
              database_id: database,
              threshold_cycles: values.threshold!,
              amount_cycles: values.amount!,
              daily_limit_cycles: values.daily!,
              min_database_cycles: values.keep!,
            });
          }}
        >
          <label className="grid gap-1 text-sm">
            Pay from database
            <select
              className="min-h-11 min-w-0 rounded border border-line bg-paper px-3"
              value={database}
              disabled={busy}
              onChange={(e) => setDatabase(e.target.value)}
            >
              {databases.map((db) => (
                <option key={db.databaseId} value={db.databaseId}>
                  {db.name}
                </option>
              ))}
            </select>
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Refill when Vault is below" value={threshold} onChange={setThreshold} disabled={busy} />
            <Field label="Add each time" value={amount} onChange={setAmount} disabled={busy} />
            <Field label="At most per day" value={daily} onChange={setDaily} disabled={busy} />
            <Field label="Always keep in database" value={keep} onChange={setKeep} disabled={busy} />
          </div>
          <p className="text-xs text-muted">
            Values in billions of cycles (B). Max once every 10 min.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="sm" disabled={busy || invalid}>
              Save auto top-up
            </Button>
            <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </form>
      )}
      {notice ? <output className="text-sm">{notice}</output> : null}
    </AdminPanel>
  );
}

function Field({ label, value, onChange, disabled }: { label: string; value: string; onChange: (value: string) => void; disabled: boolean }) {
  const parsed = parseBillions(value);
  const id = useId();
  return (
    <div className="grid gap-1 text-sm">
      <label htmlFor={id}>{label}</label>
      <span className="flex items-center gap-2">
        <Input id={id} inputMode="decimal" value={value} disabled={disabled} aria-invalid={parsed === null} onChange={(e) => onChange(e.target.value)} />
        <span aria-hidden className="shrink-0 text-muted">B</span>
      </span>
    </div>
  );
}
