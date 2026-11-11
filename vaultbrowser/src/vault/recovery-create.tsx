import { useCallback, useEffect, useMemo, useState } from "react";
import { bytes, ok } from "@kinic/vault-client";
import { CreateEmptyClient } from "@kinic/vault-client/create-empty";
import type {
  CreateEmptyStatus,
  Header,
  IncidentContext,
} from "@kinic/vault-client/contracts";
import { randomBytes } from "@kinic/vault-crypto";
import { b64, unb64 } from "@kinic/vault-crypto/documents";
import { VaultButton } from "./ui";
import { useRecoveryFiles, RecoveryFilePrompt } from "./recovery-files";
import {
  covers,
  generationLabel,
  bindRecovery,
  sameBytes,
  type RecoveryProps,
} from "./recovery-shared";
export function ScopedCreation({
  client,
  disabled,
  enabled,
  credential,
  run,
  onChanged,
  service: unboundService,
}: RecoveryProps & { service: CreateEmptyClient }) {
  const service = useMemo(
    () => bindRecovery(unboundService, client.session),
    [unboundService, client],
  );
  const actor = useMemo(
    () => bindRecovery(client.actor, client.session),
    [client],
  );
  const files = useRecoveryFiles(client.session);
  const [status, setStatus] = useState<CreateEmptyStatus>(),
    [vaults, setVaults] = useState<Header[]>([]),
    [context, setContext] = useState<IncidentContext>(),
    [source, setSource] = useState("");
  const refresh = useCallback(async () => {
    const ticket = client.session.capture();
    const [j, h, c] = await Promise.all([
      actor.create_empty_status(),
      actor.list_vaults(),
      actor.incident_context(),
    ]);
    client.session.check(ticket);
    setStatus(ok(j)[0]);
    setVaults(ok(h));
    setContext(ok(c)[0]);
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
  const proof = async (j: CreateEmptyStatus) =>
    service.ensureAuthenticated(
      key(),
      bytes(j.job),
      j.target,
      j.authorizer_instance,
    );
  const phase = status ? Object.keys(status.phase)[0] : "";
  const scoped = context?.credentials.find(
    (c) =>
      credential &&
      sameBytes(c.credential, credential) &&
      "Instances" in c.scope,
  );
  const eligible = vaults.filter(
    (h) =>
      h.generation[0] &&
      "Active" in h.state &&
      scoped &&
      covers(scoped, h.generation[0]),
  );
  return (
    <div className="grid min-w-0 gap-3">
      <h3 className="font-semibold">New empty Vault</h3>
      <p className="text-sm">
        Choose a current restored Vault and its scoped passkey. This creates a
        separate empty instance, imports no backup, and grants no authority over
        other existing Vaults.
      </p>
      <VaultButton disabled={disabled} onClick={() => act(refresh)}>
        Refresh empty creation
      </VaultButton>
      {!status || phase === "Cancelled" || phase === "Active" ? (
        <>
          <label className="grid gap-1 text-sm">
            Authorizing restored Vault
            <select
              value={source}
              onChange={(e) => setSource(e.target.value)}
              className="min-h-10 min-w-0 rounded-lg border border-line bg-white px-3"
            >
              <option value="">Choose a current instance</option>
              {eligible.map((h) => (
                <option value={b64(bytes(h.id))} key={b64(bytes(h.id))}>
                  {generationLabel(h.generation[0]!)}
                </option>
              ))}
            </select>
          </label>
          <VaultButton
            disabled={
              disabled || !enabled || !source || !scoped || vaults.length >= 3
            }
            onClick={() =>
              act(async () => {
                const h = eligible.find((h) => sameBytes(h.id, unb64(source)));
                if (!h?.generation[0] || !context) throw Error("ChoosePasskey");
                await service.authenticate(
                  key(),
                  randomBytes(16),
                  {
                    namespace: context.namespace,
                    vault: randomBytes(16),
                    attempt: randomBytes(16),
                  },
                  h.generation[0],
                );
              })
            }
          >
            Authorize new empty Vault
          </VaultButton>
        </>
      ) : null}
      {status ? (
        <>
          <p className="break-all text-sm">
            Source: {generationLabel(status.authorizer_instance)}
          </p>
          {status.generation[0] ? (
            <p className="break-all text-sm">
              New target: {generationLabel(status.generation[0])}
            </p>
          ) : null}
          <output className="text-sm">
            {phase === "Active"
              ? "Empty Vault created. Unlock it with a fresh passkey verification."
              : phase === "Cancelled"
                ? "Empty creation cancelled. No existing Vault was deleted."
                : phase === "KitConfirmed"
                  ? "New kit file verified. Ready to activate the empty Vault."
                  : "Empty creation incomplete. Save and reselect the new kit before activation."}
          </output>
          {phase === "Admitted" ? (
            <VaultButton
              disabled={disabled || !enabled}
              onClick={() =>
                act(async () => {
                  await proof(status);
                  await service.allocate();
                })
              }
            >
              Allocate empty Vault
            </VaultButton>
          ) : null}
          {phase === "Allocated" ? (
            <VaultButton
              disabled={disabled || !enabled}
              onClick={() =>
                act(async () => {
                  await proof(status);
                  await service.prepare(
                    (data) => files.save(data, "new-empty-vault-kit.json"),
                    () => files.select("Reselect saved empty Vault kit", 4096),
                  );
                })
              }
            >
              Save and verify empty Vault kit
            </VaultButton>
          ) : null}
          {phase === "EnvelopesStaged" ? (
            <VaultButton
              disabled={disabled || !enabled}
              onClick={() =>
                act(async () => {
                  await proof(status);
                  await service.confirmSavedKit(
                    await files.select("Reselect saved empty Vault kit", 4096),
                  );
                })
              }
            >
              Resume with saved empty Vault kit
            </VaultButton>
          ) : null}
          {phase === "KitConfirmed" ? (
            <VaultButton
              disabled={disabled || !enabled}
              onClick={() =>
                act(async () => {
                  await proof(status);
                  await service.activate();
                  client.session.lock();
                  await onChanged();
                })
              }
            >
              Activate new empty Vault
            </VaultButton>
          ) : null}
          {phase !== "Active" && phase !== "Cancelled" ? (
            <VaultButton
              disabled={disabled}
              onClick={() =>
                act(async () => {
                  if (
                    !window.confirm(
                      "Cancel this never-active empty Vault? Existing Vaults remain unchanged.",
                    )
                  )
                    return;
                  let p = await service.cancel();
                  while (!p.complete) p = await service.cancel();
                  await onChanged();
                })
              }
            >
              Cancel never-active empty creation
            </VaultButton>
          ) : null}
          <VaultButton
            disabled={disabled}
            onClick={() =>
              act(async () => {
                await service.retry();
              })
            }
          >
            Retry empty creation request
          </VaultButton>
        </>
      ) : null}
      <RecoveryFilePrompt files={files} />
    </div>
  );
}
