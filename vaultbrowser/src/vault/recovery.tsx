import { useEffect, useMemo, useState } from "react";
import { VaultButton, VaultPanel } from "./ui";
import { clientArguments, type RecoveryProps } from "./recovery-shared";
import { IncidentClient } from "@kinic/vault-client/incident";
import { RestoreClient } from "@kinic/vault-client/restore";
import { CreateEmptyClient } from "@kinic/vault-client/create-empty";
import { IncidentRecovery } from "./recovery-incident";
import { BackupRestore } from "./recovery-restore";
import { ScopedCreation } from "./recovery-create";
export function VaultRecovery(props: RecoveryProps) {
  const rpId = props.client.recoveryConfiguration.rpId;
  const services = useMemo(
    () => ({
      incident: new IncidentClient(...clientArguments(props.client, rpId)),
      restore: new RestoreClient(...clientArguments(props.client, rpId)),
      create: new CreateEmptyClient(...clientArguments(props.client, rpId)),
    }),
    [props.client, rpId],
  );
  useEffect(
    () => () => {
      services.incident.destroy();
      services.restore.destroy();
      services.create.destroy();
    },
    [services],
  );
  const [mode, setMode] = useState<"incident" | "restore" | "create">();
  const [generation, setGeneration] = useState(props.client.session.capture());
  useEffect(() => {
    const detach = props.client.session.addLockCleanup(() =>
      setGeneration(props.client.session.capture()),
    );
    return () => {
      detach();
    };
  }, [props.client]);
  const choose = (next: typeof mode) => {
    props.client.session.lock();
    setMode(next);
  };
  return (
    <VaultPanel label="Recovery and access">
      <h2 className="font-semibold">Recovery and access</h2>
      <p className="text-sm text-muted">
        Ordinary passkey removal leaves encryption keys unchanged. Use incident
        response when a key may be compromised. Recovery creates access only to
        the restored instance.
      </p>
      <div className="flex flex-wrap gap-2">
        <VaultButton
          disabled={props.disabled}
          onClick={() => choose("incident")}
        >
          Respond to a compromised passkey
        </VaultButton>
        <VaultButton
          disabled={props.disabled}
          onClick={() => choose("restore")}
        >
          Recover after losing all passkeys
        </VaultButton>
        <VaultButton disabled={props.disabled} onClick={() => choose("create")}>
          Create a new empty Vault with scoped access
        </VaultButton>
      </div>
      <p className="text-sm text-muted">
        Use a trusted replacement device or passkey. Revoke lost devices with
        your passkey sync provider. Rotate passwords and API keys at the
        services where they are used. Old backups remain readable with their old
        recovery kits.
      </p>
      {mode ? (
        <p className="text-sm text-muted">
          If a request loses its response, use the workflow's retry button
          before requesting fresh proof. After a lock, refresh and resume from
          saved files and current server status; an uncertain result is not a
          cancellation.
        </p>
      ) : null}
      {mode === "incident" ? (
        <IncidentRecovery
          service={services.incident}
          key={`incident-${generation}`}
          {...props}
        />
      ) : mode === "restore" ? (
        <BackupRestore
          service={services.restore}
          key={`restore-${generation}`}
          {...props}
        />
      ) : mode === "create" ? (
        <ScopedCreation
          service={services.create}
          key={`create-${generation}`}
          {...props}
        />
      ) : null}
    </VaultPanel>
  );
}
