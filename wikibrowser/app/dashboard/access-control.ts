// Where: wikibrowser/app/dashboard/access-control.ts
// What: Shared dashboard ACL constants and helpers.
// Why: Permission UI components need one role parser and one busy-state shape.

import type { DatabaseRole } from "@/lib/types";

export const ANONYMOUS_PRINCIPAL = "2vxsx-fae";
export const LLM_WRITER_LABEL = "LLM writer";
export const LLM_WRITER_PRINCIPAL = "ckurn-x74ln-nemlm-42vfv-gej7r-4cc3e-v22e5-otcod-jndlh-pbst4-3qe";
export const DATABASE_ROLES: DatabaseRole[] = ["reader", "writer", "owner"];

export type BusyAction = { kind: "grant"; principalText: string; role: DatabaseRole } | { kind: "revoke"; principalText: string } | { kind: "rename" };

export function databaseRoleFromValue(value: string): DatabaseRole {
  if (value === "owner") return "owner";
  if (value === "writer") return "writer";
  return "reader";
}

export function isBusyGrant(action: BusyAction | null, principalText: string, role: DatabaseRole): boolean {
  return action?.kind === "grant" && action.principalText === principalText && action.role === role;
}

export function isBusyRevoke(action: BusyAction | null, principalText: string): boolean {
  return action?.kind === "revoke" && action.principalText === principalText;
}

export function isLlmWriterPrincipal(principalText: string): boolean {
  return principalText === LLM_WRITER_PRINCIPAL;
}

export function principalDisplayName(principalText: string): string {
  return isLlmWriterPrincipal(principalText) ? LLM_WRITER_LABEL : principalText;
}
