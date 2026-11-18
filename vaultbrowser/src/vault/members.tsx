import { useState } from "react";
import { Principal } from "@icp-sdk/core/principal";
import type { MemberRole, VaultClient } from "@kinic/vault-client";
import type { VaultMember } from "@kinic/vault-client/contracts";
import { VaultButton, VaultField } from "./ui";
import type { VaultWork } from "./workspace";

function RoleSelect({
  role,
  onChange,
  disabled,
}: {
  role: MemberRole;
  onChange: (role: MemberRole) => void;
  disabled: boolean;
}) {
  return (
    <label className="grid gap-1 text-sm font-medium">
      Member role
      <select
        className="min-h-10 rounded-lg border border-line bg-white px-3 text-ink"
        value={role}
        disabled={disabled}
        onChange={(e) =>
          onChange(e.target.value === "Editor" ? "Editor" : "Viewer")
        }
      >
        <option value="Viewer">Viewer</option>
        <option value="Editor">Editor</option>
      </select>
    </label>
  );
}

export function VaultMembers({
  client,
  disabled,
  initiallyOpen,
  run,
}: {
  client: VaultClient;
  initiallyOpen: boolean;
  disabled: boolean;
  run: VaultWork;
}) {
  const [principal, setPrincipal] = useState("");
  const [role, setRole] = useState<MemberRole>("Viewer");
  const [members, setMembers] = useState<VaultMember[]>();
  const refresh = async () => setMembers(await client.listMembers());
  return (
    <details
      className="vault-disclosure [&:not([open])>div]:hidden"
      open={initiallyOpen || undefined}
      onToggle={(e) => {
        if (e.currentTarget.open && !members) run(refresh);
      }}
    >
      <summary>Vault members</summary>
      <div className="vault-disclosure-body">
        <form
          className="grid gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            run(async () => {
              let member: Principal;
              try {
                member = Principal.fromText(principal.trim());
              } catch {
                throw Error("InvalidMemberPrincipal");
              }
              if (
                member.isAnonymous() ||
                member.toText() === client.identity.getPrincipal().toText()
              )
                throw Error("InvalidMemberPrincipal");
              await client.setMember(member, role);
              setPrincipal("");
              await refresh();
            });
          }}
        >
          <VaultField
            label="Member Vault principal"
            value={principal}
            disabled={disabled}
            maxLength={128}
            onChange={(e) => setPrincipal(e.target.value)}
          />
          <div className="flex flex-wrap items-end gap-2">
            <RoleSelect role={role} onChange={setRole} disabled={disabled} />
            <VaultButton
              type="submit"
              tone="primary"
              disabled={disabled || !principal.trim()}
            >
              Add member
            </VaultButton>
          </div>
        </form>
        <VaultButton disabled={disabled} onClick={() => run(refresh)}>
          Refresh members
        </VaultButton>
        {members?.length ? (
          <ul className="grid gap-2">
            {members.map(({ principal: member, role: grant }) => (
              <li
                key={member.toText()}
                className="grid gap-2 rounded-lg border border-line p-3"
              >
                <code className="break-all text-sm">{member.toText()}</code>
                <div className="flex flex-wrap items-end gap-2">
                  <RoleSelect
                    role={"Editor" in grant ? "Editor" : "Viewer"}
                    disabled={disabled}
                    onChange={(next) =>
                      run(async () => {
                        await client.setMember(member, next);
                        await refresh();
                      })
                    }
                  />
                  <VaultButton
                    disabled={disabled}
                    onClick={() =>
                      run(async () => {
                        await client.removeMember(member);
                        await refresh();
                      })
                    }
                  >
                    Remove member
                  </VaultButton>
                </div>
              </li>
            ))}
          </ul>
        ) : members ? (
          <p>No additional members.</p>
        ) : null}
      </div>
    </details>
  );
}
