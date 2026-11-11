import { useCallback, useEffect, useMemo, useState } from "react";
import { bytes, ok } from "@kinic/vault-client";
import { IncidentClient } from "@kinic/vault-client/incident";
import type {
  Header,
  IncidentContext,
  IncidentStatus,
  IncidentTarget,
} from "@kinic/vault-client/contracts";
import { randomBytes } from "@kinic/vault-crypto";
import { b64 } from "@kinic/vault-crypto/documents";
import { VaultButton } from "./ui";
import { useRecoveryFiles, RecoveryFilePrompt } from "./recovery-files";
import {
  covers,
  generationLabel,
  bindRecovery,
  sameBytes,
  type RecoveryProps,
} from "./recovery-shared";
export function IncidentRecovery({
  client,
  disabled,
  enabled,
  credential,
  run,
  onChanged,
  service: unboundService,
}: RecoveryProps & { service: IncidentClient }) {
  const service = useMemo(
    () => bindRecovery(unboundService, client.session),
    [unboundService, client],
  );
  const actor = useMemo(
    () => bindRecovery(client.actor, client.session),
    [client],
  );
  const files = useRecoveryFiles(client.session);
  const [status, setStatus] = useState<IncidentStatus>(),
    [context, setContext] = useState<IncidentContext>(),
    [vaults, setVaults] = useState<Header[]>([]),
    [revoked, setRevoked] = useState<string[]>([]);
  const refresh = useCallback(async () => {
    const ticket = client.session.capture();
    const [j, c, h] = await Promise.all([
      actor.incident_status(),
      actor.incident_context(),
      actor.list_vaults(),
    ]);
    client.session.check(ticket);
    setStatus(ok(j)[0]);
    setContext(ok(c)[0]);
    setVaults(ok(h));
  }, [client, actor]);
  useEffect(() => {
    void refresh().catch(() => {});
  }, [refresh]);
  const key = () => {
    if (!credential) throw Error("ChoosePasskey");
    return credential;
  };
  const act = (f: () => Promise<void>) =>
    run(async () => {
      const ticket = client.session.capture();
      try {
        await f();
      } finally {
        files.clear();
        if (ticket === client.session.capture()) await refresh();
      }
    });
  const proof = async () => {
    const j = await service.status();
    const remaining = j.targets.filter(
      (t) => !("Purged" in t.phase) && !("Purging" in t.phase),
    );
    const sources = remaining.map((t) => t.source.generation[0]!);
    // Allocation resumes the exact existing declaration. An Incident grant
    // requires every remaining target nonce to have already been allocated.
    await service.ensureAuthenticated(
      key(),
      remaining.some((t) => !t.target[0])
        ? {
            IncidentPrepare: {
              job: j.job,
              namespace: j.namespace,
              sources,
              targets: remaining.map((t) => ({
                namespace: j.namespace,
                vault: t.source.id,
                attempt: t.attempt,
              })),
              compromised: j.compromised,
            },
          }
        : { Incident: { job: j.job, vector_digest: j.vector_digest } },
      sources,
    );
    return j;
  };
  const compromised =
    context?.credentials.filter((c) =>
      revoked.includes(b64(bytes(c.credential))),
    ) ?? [];
  const affected = vaults.filter(
    (h) =>
      h.generation[0] && compromised.some((c) => covers(c, h.generation[0]!)),
  );
  const trusted = context?.credentials.find(
    (c) => credential && sameBytes(c.credential, credential),
  );
  const resolvedOriginals =
    !!status?.complete &&
    status.completed_digest.length === 0 &&
    status.targets.length > 0 &&
    status.targets.every((t) => "Purged" in t.phase);
  const awaitingAllocation = !!status?.targets.some(
    (t) => !("Purged" in t.phase) && !("Purging" in t.phase) && !t.target[0],
  );
  const allVerified =
    !!status &&
    status.targets.length > 0 &&
    status.targets.every(
      (t) =>
        "Purged" in t.phase ||
        ("BackupVerified" in t.phase &&
          !!t.backup_ack[0] &&
          !t.restore_child[0]),
    );
  const targetAction = (t: IncidentTarget, f: () => Promise<void>) =>
    act(async () => {
      await proof();
      const current = await service.status();
      const live = current.targets.find((x) =>
        sameBytes(x.source.id, t.source.id),
      );
      if (
        !live ||
        !sameBytes(live.attempt, t.attempt) ||
        b64(bytes(current.vector_digest)) !== b64(bytes(status!.vector_digest))
      )
        throw Error("TargetChanged");
      await f();
    });
  return (
    <div className="grid min-w-0 gap-3">
      <h3 className="font-semibold">Compromised passkey response</h3>
      <p className="text-sm">
        Revoke selected compromised passkeys and freeze every affected Vault. A
        trusted remaining passkey must cover all affected instances. Protection
        is incomplete until every new kit and backup is verified and the whole
        incident is committed.
      </p>
      <VaultButton disabled={disabled} onClick={() => act(refresh)}>
        Refresh incident
      </VaultButton>
      {!status || status.complete ? (
        <>
          <fieldset className="grid gap-2">
            <legend className="text-sm font-semibold">
              Compromised passkeys to revoke
            </legend>
            {context?.credentials.map((c, i) => (
              <label
                key={b64(bytes(c.credential))}
                className="flex items-center gap-2 text-sm"
              >
                <input
                  type="checkbox"
                  disabled={disabled}
                  checked={revoked.includes(b64(bytes(c.credential)))}
                  onChange={(e) => {
                    const id = b64(bytes(c.credential));
                    setRevoked(
                      e.target.checked
                        ? [...revoked, id]
                        : revoked.filter((x) => x !== id),
                    );
                  }}
                />
                Passkey {i + 1} ·{" "}
                {"Global" in c.scope ? "all Vaults" : "scoped instances"}
              </label>
            ))}
          </fieldset>
          <p className="text-sm">
            All affected Vaults: {affected.length}.{" "}
            {affected.map((h) => generationLabel(h.generation[0]!)).join("; ")}
          </p>
          <VaultButton
            disabled={
              disabled ||
              !enabled ||
              !compromised.length ||
              !affected.length ||
              !trusted ||
              compromised.includes(trusted) ||
              affected.some((h) => !covers(trusted, h.generation[0]!))
            }
            onClick={() =>
              act(async () => {
                if (
                  !context ||
                  !window.confirm(
                    `Revoke the selected passkeys and freeze all ${affected.length} affected Vaults? Cancelling preparation will not restore old writes.`,
                  )
                )
                  return;
                const sources = affected.map((h) => h.generation[0]!);
                const sorted = [...compromised].sort((a, b) => {
                  const x = bytes(a.credential),
                    y = bytes(b.credential);
                  for (let i = 0; i < Math.min(x.length, y.length); i++)
                    if (x[i] !== y[i]) return x[i] - y[i];
                  return x.length - y.length;
                });
                await service.authenticate(
                  key(),
                  {
                    IncidentPrepare: {
                      job: randomBytes(16),
                      namespace: context.namespace,
                      sources,
                      targets: sources.map((g) => ({
                        namespace: context.namespace,
                        vault: g.vault,
                        attempt: randomBytes(16),
                      })),
                      compromised: sorted.map((c) => ({
                        credential: c.credential,
                        version: c.version,
                      })),
                    },
                  },
                  sources,
                );
                await service.start();
                await onChanged();
              })
            }
          >
            Revoke and freeze all affected Vaults
          </VaultButton>
        </>
      ) : null}
      {status ? (
        <>
          <output className="text-sm">
            {status.complete && status.completed_digest[0]?.length === 32
              ? "All incident targets committed. Unlock again with fresh passkey verification."
              : resolvedOriginals
                ? "The original incident is resolved by removal or replacement. Finish any separate pending restore before using its replacement Vault."
                : "Incident incomplete. Old writes stay frozen, including after cancellation or interruption."}
          </output>
          {awaitingAllocation ? (
            <p className="text-sm">
              Allocate every remaining target before preparing or resetting
              targets. Cancellation remains available.
            </p>
          ) : null}
          {status.targets.map((t, i) => {
            const phase = Object.keys(t.phase)[0];
            const terminal =
              !!t.restore_child[0] || phase === "Purged" || phase === "Purging";
            return (
              <section
                aria-label={`Incident target ${i + 1}`}
                className="grid min-w-0 gap-2 border-t border-line pt-3"
                key={`${b64(bytes(t.source.id))}:${b64(bytes(t.attempt))}`}
              >
                <h4 className="font-semibold">Affected Vault {i + 1}</h4>
                <p className="break-all text-sm">
                  Frozen source: {generationLabel(t.source.generation[0]!)}
                </p>
                {t.target[0] ? (
                  <p className="break-all text-sm">
                    New target: {generationLabel(t.target[0])}
                  </p>
                ) : null}
                <p className="text-sm">
                  {terminal
                    ? resolvedOriginals
                      ? "This original target was removed or separately replaced. Check any separate restore before using its replacement."
                      : "This original target was discarded or separately restored. Other targets remain frozen; this does not complete the owner incident."
                    : phase === "BackupVerified"
                      ? "New backup fully verified for this target; whole incident still pending."
                      : phase === "Cancelled"
                        ? "Preparation cancelled. Source remains frozen."
                        : phase === "Resetting"
                          ? "Discarding this prepared target; source remains frozen."
                          : `${phase === "PendingNonce" ? "Awaiting a new target instance" : phase === "Allocated" ? "Awaiting a new recovery kit" : phase === "EnvelopesStaged" ? "Reselect the saved new kit" : phase === "Cancelling" ? "Cancellation in progress" : "Preparing encrypted records"}. New kit ${t.kit_ack[0] ? "verified" : "not yet verified"}; new backup ${t.backup_ack[0] ? "verified" : "not yet verified"}.`}
                </p>
                {!status.complete && !terminal ? (
                  <div className="flex flex-wrap gap-2">
                    {phase === "PendingNonce" ? (
                      <VaultButton
                        disabled={disabled || !enabled}
                        onClick={() =>
                          targetAction(t, async () => {
                            await service.allocate(
                              bytes(t.source.id),
                              bytes(t.attempt),
                            );
                          })
                        }
                      >
                        Allocate new target {i + 1}
                      </VaultButton>
                    ) : null}
                    {phase === "Allocated" ? (
                      <VaultButton
                        disabled={disabled || !enabled || awaitingAllocation}
                        onClick={() =>
                          targetAction(t, async () => {
                            await service.prepare(
                              bytes(t.source.id),
                              (data) =>
                                files.save(
                                  data,
                                  `incident-${i + 1}-new-kit.json`,
                                ),
                              () =>
                                files.select(
                                  `Reselect saved new kit for target ${i + 1}`,
                                  4096,
                                ),
                            );
                          })
                        }
                      >
                        Save and verify new kit {i + 1}
                      </VaultButton>
                    ) : null}
                    {[
                      "EnvelopesStaged",
                      "KitConfirmed",
                      "Wrapping",
                      "BackupVerified",
                    ].includes(phase) ? (
                      <VaultButton
                        disabled={disabled || !enabled || awaitingAllocation}
                        onClick={() =>
                          targetAction(t, async () => {
                            await service.resume(bytes(t.source.id), () =>
                              files.select(
                                `Reselect saved new kit for target ${i + 1}`,
                                4096,
                              ),
                            );
                            for (;;) {
                              const j = await service.status();
                              const next = j.targets.find((x) =>
                                sameBytes(x.source.id, t.source.id),
                              );
                              if (!next || !sameBytes(next.attempt, t.attempt))
                                throw Error("TargetChanged");
                              if (next.coverage[0]?.complete) break;
                              await service.wrapNext(bytes(t.source.id));
                            }
                          })
                        }
                      >
                        Resume and prepare target {i + 1}
                      </VaultButton>
                    ) : null}
                    {t.coverage[0]?.complete ? (
                      <VaultButton
                        disabled={disabled || !enabled || awaitingAllocation}
                        onClick={() =>
                          targetAction(t, async () => {
                            await service.saveBackup(
                              bytes(t.source.id),
                              (data) =>
                                files.save(
                                  data,
                                  `incident-${i + 1}-new-backup.kvault`,
                                ),
                              () =>
                                files.select(
                                  `Reselect saved new backup for target ${i + 1}`,
                                ),
                              () =>
                                files.select(
                                  `Reselect saved new kit for target ${i + 1}`,
                                  4096,
                                ),
                            );
                          })
                        }
                      >
                        Save and verify new backup {i + 1}
                      </VaultButton>
                    ) : null}
                    <VaultButton
                      disabled={disabled || !enabled || awaitingAllocation}
                      onClick={() =>
                        targetAction(t, async () => {
                          if (
                            !window.confirm(
                              "Discard this prepared target and its acknowledgments? The source remains frozen; new target files will be required.",
                            )
                          )
                            return;
                          await service.reset(
                            bytes(t.source.id),
                            bytes(t.attempt),
                          );
                        })
                      }
                    >
                      {phase === "Resetting"
                        ? "Continue resetting target"
                        : "Reset prepared target"}{" "}
                      {i + 1}
                    </VaultButton>
                  </div>
                ) : null}
              </section>
            );
          })}
          {!status.complete ? (
            <>
              <VaultButton
                disabled={disabled || !enabled || !allVerified}
                onClick={() =>
                  act(async () => {
                    if (
                      !window.confirm(
                        "Commit protection for every affected Vault now? This requires a fresh whole-incident passkey verification.",
                      )
                    )
                      return;
                    await service.cutover(key());
                    await onChanged();
                  })
                }
              >
                Commit all verified targets with fresh passkey proof
              </VaultButton>
              <VaultButton
                disabled={disabled}
                onClick={() =>
                  act(async () => {
                    if (
                      !window.confirm(
                        "Cancel prepared targets? Revoked passkeys stay revoked and old writes stay frozen.",
                      )
                    )
                      return;
                    const progress = ok(await actor.cleanup_status())[0];
                    await service.cancel(
                      key(),
                      progress && !progress.complete
                        ? bytes(progress.job)
                        : randomBytes(16),
                    );
                    await onChanged();
                  })
                }
              >
                Cancel incident preparation
              </VaultButton>
              <VaultButton
                disabled={disabled}
                onClick={() =>
                  act(async () => {
                    await service.retry();
                  })
                }
              >
                Retry incident request
              </VaultButton>
            </>
          ) : null}
        </>
      ) : null}
      <RecoveryFilePrompt files={files} />
    </div>
  );
}
