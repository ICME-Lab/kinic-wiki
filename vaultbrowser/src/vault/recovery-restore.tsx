import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { bytes, ok } from "@kinic/vault-client";
import { RestoreClient, kitSecret } from "@kinic/vault-client/restore";
import type {
  RestoreAdmissionStatus,
  IncidentContext,
} from "@kinic/vault-client/contracts";
import { randomBytes } from "@kinic/vault-crypto";
import { b64, unb64 } from "@kinic/vault-crypto/documents";
import { VaultButton } from "./ui";
import { useRecoveryFiles, RecoveryFilePrompt } from "./recovery-files";
import {
  generationLabel,
  bindRecovery,
  sameBytes,
  sourceKit,
  legacySource,
  type RecoveryProps,
} from "./recovery-shared";
export function BackupRestore({
  client,
  disabled,
  enabled,
  run,
  onChanged,
  service: unboundService,
}: RecoveryProps & { service: RestoreClient }) {
  const service = useMemo(
    () => bindRecovery(unboundService, client.session),
    [unboundService, client],
  );
  const actor = useMemo(
    () => bindRecovery(client.actor, client.session),
    [client],
  );
  const files = useRecoveryFiles(client.session);
  const [sourceFormat, setSourceFormat] = useState("kit");
  const legacy = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    const detach = client.session.addLockCleanup(() => {
      if (legacy.current) legacy.current.value = "";
    });
    return () => {
      detach();
    };
  }, [client]);
  const [status, setStatus] = useState<RestoreAdmissionStatus>(),
    [context, setContext] = useState<IncidentContext>(),
    [existing, setExisting] = useState("");
  const refresh = useCallback(async () => {
    const ticket = client.session.capture();
    const [j, c] = await Promise.all([
      actor.restore_admission_status(),
      actor.incident_context(),
    ]);
    client.session.check(ticket);
    setStatus(ok(j)[0]);
    setContext(ok(c)[0]);
  }, [client, actor]);
  useEffect(() => {
    void refresh().catch(() => {});
  }, [refresh]);
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
  const readSource = async (j?: RestoreAdmissionStatus) => {
    const archive = await files.select("Select source encrypted backup");
    const source =
      sourceFormat === "legacy"
        ? await legacySource(
            archive,
            legacy.current?.value ?? "",
            client.session,
            files.track,
          )
        : await sourceKit(
            archive,
            await files.select("Select original source recovery kit", 4096),
            client.session,
            files.track,
          );
    const ticket = client.session.capture();
    const current =
      j?.current_live[0] ??
      ok(await actor.list_vaults()).find((h) =>
        sameBytes(h.id, unb64(source.header.vault)),
      )?.generation[0];
    client.session.check(ticket);
    let currentSecret: Uint8Array | undefined;
    if (current) {
      const sourceGeneration = source.header.generation;
      if (
        sourceGeneration &&
        sourceGeneration.nonce === b64(bytes(current.nonce)) &&
        source.header.epoch === current.epoch.toString() &&
        sourceGeneration.owner === current.owner.toText() &&
        sourceGeneration.canister === current.canister.toText() &&
        sourceGeneration.key_name === current.key_name
      )
        currentSecret = source.secret;
      else
        currentSecret = files.track(
          kitSecret(
            await files.select("Select CURRENT live Vault recovery kit", 4096),
            current,
          ),
        );
    }
    return { archive, secret: source.secret, currentSecret };
  };
  const candidate = (j: RestoreAdmissionStatus) => {
    const ids = j.challenge.credential_ids;
    if (j.challenge.registration || ids.length !== 1)
      throw Error("RestoreCandidateChanged");
    return bytes(ids[0]);
  };
  const authenticate = async (j: RestoreAdmissionStatus, cleanup = false) => {
    const p = j.pipeline[0];
    await service.authenticate(
      candidate(j),
      cleanup
        ? { RestoreCleanup: { job: j.request.job, target: j.request.target } }
        : p
          ? { RestoreTarget: { job: j.request.job, generation: p.target } }
          : {
              RestorePrepare: { job: j.request.job, target: j.request.target },
            },
    );
  };
  const resume = async (cleanup = false) => {
    const j = await service.status(),
      s = await readSource(j);
    const next = await service.resume(s.archive, s.secret, s.currentSecret);
    await authenticate(next, cleanup);
    return s;
  };
  const p = status?.pipeline[0],
    phase = p ? Object.keys(p.phase)[0] : "";
  const terminal =
    phase === "Active" || phase === "Cancelled" || status?.cancel_complete;
  const currentLabel = status?.current_live[0]
    ? generationLabel(status.current_live[0])
    : undefined;
  return (
    <div className="grid min-w-0 gap-3">
      <h3 className="font-semibold">Restore after losing all passkeys</h3>
      <p className="text-sm">
        Keep the original encrypted backup and its recovery kit. The complete
        archive is verified locally before admission. If this Vault still
        exists, its current kit must separately prove the exact live instance. A
        new passkey is scoped only to the fresh restored instance.
      </p>
      <p className="text-sm">
        At the 10-passkey limit, reuse an existing scoped passkey from a
        previous restoration. Every other target still needs its own current
        recovery proof. Existing scopes remain intact; this does not grant
        access to any other Vault.
      </p>
      <VaultButton disabled={disabled} onClick={() => act(refresh)}>
        Refresh restoration
      </VaultButton>
      <label className="grid gap-1 text-sm">
        Source recovery format
        <select
          value={sourceFormat}
          disabled={disabled}
          onChange={(e) => {
            setSourceFormat(e.target.value);
            if (legacy.current) legacy.current.value = "";
          }}
          className="min-h-10 rounded-lg border border-line bg-white px-3"
        >
          <option value="kit">Saved recovery kit file</option>
          <option value="legacy">Original legacy recovery secret</option>
        </select>
      </label>
      {sourceFormat === "legacy" ? (
        <label className="grid gap-1 text-sm">
          Original legacy recovery secret
          <input
            ref={legacy}
            type="password"
            maxLength={43}
            autoComplete="off"
            spellCheck={false}
            className="min-h-10 min-w-0 rounded-lg border border-line bg-white px-3"
          />
        </label>
      ) : null}
      <label className="grid gap-1 text-sm">
        Replacement passkey
        <select
          className="min-h-10 min-w-0 rounded-lg border border-line bg-white px-3"
          value={existing}
          disabled={disabled}
          onChange={(e) => setExisting(e.target.value)}
        >
          <option value="">Register a new trusted passkey</option>
          {context?.credentials
            .filter((c) => "Instances" in c.scope)
            .map((c, i) => (
              <option
                key={b64(bytes(c.credential))}
                value={b64(bytes(c.credential))}
              >
                Reuse scoped passkey {i + 1}
              </option>
            ))}
        </select>
      </label>
      {!status || terminal ? (
        <VaultButton
          disabled={disabled || !enabled}
          onClick={() =>
            act(async () => {
              const s = await readSource();
              if (
                !window.confirm(
                  "Keep the original source backup and kit. A later destructive step can permanently discard the current live Vault; recovery then depends on these saved files. Continue admission?",
                )
              )
                return;
              const ticket = client.session.capture();
              const c = ok(await actor.incident_context())[0];
              client.session.check(ticket);
              const namespace =
                c?.namespace ??
                ok(await actor.initialize_restore_namespace(randomBytes(16)));
              client.session.check(ticket);
              await service.admit(
                bytes(namespace),
                s.archive,
                s.secret,
                async () => {},
                s.currentSecret,
                existing ? unb64(existing) : undefined,
              );
            })
          }
        >
          Select source backup and recovery kit
        </VaultButton>
      ) : null}
      {status ? (
        <>
          <p className="break-all text-sm">
            Source:{" "}
            {status.request.source_generation[0]
              ? generationLabel(status.request.source_generation[0])
              : "Legacy encrypted backup"}
          </p>
          {currentLabel ? (
            <p className="break-all text-sm">
              Current live instance to replace: {currentLabel}
            </p>
          ) : null}
          {p ? (
            <p className="break-all text-sm">
              Fresh restoration target: {generationLabel(p.target)}
            </p>
          ) : null}
          {status.parent_job[0] ? (
            <p className="text-sm">
              This restores only the proven frozen Vault into a separate fresh
              instance. Other incident targets stay frozen. The owner incident
              remains incomplete; this is not a partial incident commit.
            </p>
          ) : null}
          <output className="text-sm">
            {phase === "Active"
              ? "Restoration complete for this scoped instance. Unlock it with fresh passkey verification. You can deliberately create a new empty Vault using scoped access."
              : terminal
                ? "Restoration cancelled. Any previously discarded live data stays discarded; retain your source backup."
                : "Restoration incomplete. A prepared encrypted archive alone does not mean the server restore or protection is complete."}
          </output>
          {!terminal ? (
            <>
              <VaultButton
                disabled={disabled || !enabled}
                onClick={() =>
                  act(async () => {
                    await resume();
                  })
                }
              >
                Resume restoration with source files and fresh proof
              </VaultButton>
              {!p ? (
                <VaultButton
                  disabled={disabled || !enabled}
                  onClick={() =>
                    act(async () => {
                      await resume();
                      await service.allocate();
                    })
                  }
                >
                  Allocate fresh restoration target
                </VaultButton>
              ) : null}
              {phase === "Allocated" ? (
                <VaultButton
                  disabled={disabled || !enabled}
                  onClick={() =>
                    act(async () => {
                      const s = await resume();
                      await service.prepare(
                        s.archive,
                        s.secret,
                        (data) =>
                          files.save(data, "restored-vault-new-kit.json"),
                        () =>
                          files.select(
                            "Reselect saved restoration NEW kit",
                            4096,
                          ),
                        (data) =>
                          files.save(
                            data,
                            "restored-vault-prepared-backup.kvault",
                          ),
                        () =>
                          files.select("Reselect saved prepared TARGET backup"),
                      );
                    })
                  }
                >
                  Save new kit and prepared encrypted backup
                </VaultButton>
              ) : null}
              {[
                "EnvelopesStaged",
                "KitConfirmed",
                "Importing",
                "BackupVerified",
              ].includes(phase) ? (
                <>
                  <p className="text-sm">
                    Resume with the exact saved prepared target backup and NEW
                    kit. Lost either file before preparation completed? Cancel
                    this attempt and start again from the original source;
                    existing randomized wrappers cannot be recreated.
                  </p>
                  <VaultButton
                    disabled={disabled || !enabled}
                    onClick={() =>
                      act(async () => {
                        const s = await resume();
                        const prepared = await files.select(
                            "Select saved prepared TARGET backup",
                          ),
                          kit = await files.select(
                            "Select saved restoration NEW kit",
                            4096,
                          );
                        await service.resumePrepared(
                          s.archive,
                          s.secret,
                          prepared,
                          kit,
                        );
                      })
                    }
                  >
                    Verify saved target files and resume preparation
                  </VaultButton>
                </>
              ) : null}
              {p?.preflight[0] && status.current_live[0] && !p.old_removed ? (
                <>
                  <p className="text-sm text-dangerText">
                    Destructive step: discarding removes the current live
                    encrypted content and history before importing the saved
                    backup. Cancellation cannot undo that removal. An
                    interrupted or faulty import may leave only your saved
                    source backup as recovery.
                  </p>
                  <VaultButton
                    disabled={disabled}
                    onClick={() =>
                      act(async () => {
                        await resume(true);
                        if (
                          !window.confirm(
                            "Permanently discard the current live Vault content and history now? Recovery depends on your saved original backup and kit.",
                          )
                        )
                          return;
                        let next = await service.discard();
                        while (!next.pipeline[0]?.old_removed)
                          next = await service.discard();
                        await onChanged();
                      })
                    }
                  >
                    Permanently discard current live content
                  </VaultButton>
                </>
              ) : null}
              {p?.preflight[0] &&
              (!status.current_live[0] || p.old_removed) &&
              ["KitConfirmed", "Importing"].includes(phase) ? (
                <VaultButton
                  disabled={disabled || !enabled}
                  onClick={() =>
                    act(async () => {
                      const s = await resume();
                      const prepared = await files.select(
                          "Select saved prepared TARGET backup",
                        ),
                        kit = await files.select(
                          "Select saved restoration NEW kit",
                          4096,
                        );
                      await service.importPrepared(
                        s.archive,
                        s.secret,
                        prepared,
                        kit,
                      );
                    })
                  }
                >
                  Import saved prepared target
                </VaultButton>
              ) : null}
              {phase === "Importing" || phase === "BackupVerified" ? (
                <VaultButton
                  disabled={disabled || !enabled}
                  onClick={() =>
                    act(async () => {
                      await resume();
                      const kit = await files.select(
                        "Select saved restoration NEW kit",
                        4096,
                      );
                      await service.saveAndVerifyBackup(
                        kit,
                        async () => {},
                        () =>
                          files.select(
                            "Reselect saved prepared TARGET backup for final server comparison",
                          ),
                      );
                    })
                  }
                >
                  Verify saved target backup against restored server content
                </VaultButton>
              ) : null}
              {phase === "BackupVerified" && p?.backup_ack[0] ? (
                <VaultButton
                  disabled={disabled || !enabled}
                  onClick={() =>
                    act(async () => {
                      await resume();
                      await service.activate();
                      client.session.lock();
                      await onChanged();
                    })
                  }
                >
                  Activate verified scoped restoration
                </VaultButton>
              ) : null}
              <VaultButton
                disabled={disabled}
                onClick={() =>
                  act(async () => {
                    if (
                      !window.confirm(
                        "Cancel this restoration attempt? Already discarded live data cannot be recovered by cancellation.",
                      )
                    )
                      return;
                    await resume(true);
                    let j = await service.cancel();
                    while (!j.cancel_complete) j = await service.cancel();
                    await onChanged();
                  })
                }
              >
                Cancel restoration attempt
              </VaultButton>
              <VaultButton
                disabled={disabled}
                onClick={() =>
                  act(async () => {
                    await service.retry();
                  })
                }
              >
                Retry restoration request
              </VaultButton>
            </>
          ) : null}
        </>
      ) : null}
      <RecoveryFilePrompt files={files} />
    </div>
  );
}
