import { useLayoutEffect, useRef, useState } from "react";
import { Principal } from "@icp-sdk/core/principal";
import { bytes, type MemberRole, type VaultClient } from "@kinic/vault-client";
import type { Header, VaultMember } from "@kinic/vault-client/contracts";
import { ChevronRight, Users } from "lucide-react";
import { VaultButton, VaultField } from "./ui";
import { useConfirm } from "./confirm";
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
  vault,
  disabled,
  initiallyOpen,
  run,
}: {
  client: VaultClient;
  vault: Header["id"];
  initiallyOpen: boolean;
  disabled: boolean;
  run: VaultWork;
}) {
  const [principal, setPrincipal] = useState("");
  const [role, setRole] = useState<MemberRole>("Viewer");
  const [members, setMembers] = useState<VaultMember[]>();
  const [open, setOpen] = useState(initiallyOpen);
  const [confirm, confirmDialog] = useConfirm();
  const live = useRef(false);
  useLayoutEffect(() => {
    live.current = true;
    return () => { live.current = false; };
  }, []);
  const refresh = async () => {
    const ticket = client.session.capture();
    const result = await client.listMembers(bytes(vault));
    client.session.check(ticket);
    if (live.current) setMembers(result);
  };
  return (
    <details
      className="vault-disclosure"
      data-vault-sensitive="true"
      open={open}
      onToggle={(e) => {
        setOpen(e.currentTarget.open);
        if (e.currentTarget.open && !members) run(refresh);
      }}
    >
      <summary>
        <span className="vault-disclosure-icon" aria-hidden><Users size={17} /></span>
        <span className="vault-disclosure-label">Vault members</span>
        <ChevronRight size={16} aria-hidden />
      </summary>
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
              const ticket = client.session.capture();
              await client.setMember(member, role, bytes(vault));
              client.session.check(ticket);
              if (!live.current) return;
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
                        const ticket = client.session.capture();
                        await client.setMember(member, next, bytes(vault));
                        client.session.check(ticket);
                        if (live.current) await refresh();
                      })
                    }
                  />
                  <VaultButton
                                        disabled={disabled}
                    onClick={() => {
                      void confirm({
                        title: "Remove this member?",
                        description: `${member.toText()} loses access to this Vault. You can add them again later.`,
                        confirmLabel: "Remove",
                      }).then((confirmed) => {
                        if (!confirmed) return;
                        run(async () => {
                          const ticket = client.session.capture();
                          await client.removeMember(member, bytes(vault));
                          client.session.check(ticket);
                          if (live.current) await refresh();
                        });
                      });
                    }}
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
      {confirmDialog}
    </details>
  );
}
