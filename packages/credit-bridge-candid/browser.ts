// Pure browser protocol: no authentication, persistence, network or application imports.
import type { TransferAmount, TransferApproval } from "./wiki.js";
export type Origins = { wiki: string; vault: string };
export const productionOrigins: Origins = {
  wiki: "https://wiki.kinic.xyz",
  vault: "https://vault.kinic.xyz",
};
export function bridgeOrigins(
  local?: Origins,
  explicitLocalTest = false,
): Origins {
  if (!local) return productionOrigins;
  if (!explicitLocalTest)
    throw Error("Local bridge requires an explicit test build");
  for (const value of Object.values(local)) {
    const url = new URL(value);
    if (
      url.origin !== value ||
      url.protocol !== "http:" ||
      (!["localhost", "127.0.0.1"].includes(url.hostname) &&
        !url.hostname.endsWith(".localhost"))
    )
      throw Error("Invalid local bridge origin");
  }
  if (local.wiki === local.vault)
    throw Error("Distinct application origins required");
  return local;
}
export function configuredBridgeOrigins(env: {
  MODE?: string;
  VITE_CREDIT_BRIDGE_LOCAL_TEST?: string;
  VITE_CREDIT_BRIDGE_WIKI_ORIGIN?: string;
  VITE_CREDIT_BRIDGE_VAULT_ORIGIN?: string;
}): Origins {
  const wiki = env.VITE_CREDIT_BRIDGE_WIKI_ORIGIN;
  const vault = env.VITE_CREDIT_BRIDGE_VAULT_ORIGIN;
  const local = env.VITE_CREDIT_BRIDGE_LOCAL_TEST === "1";
  if (env.VITE_CREDIT_BRIDGE_LOCAL_TEST && !local)
    throw Error("Invalid local bridge flag");
  if (
    (wiki || vault) &&
    (!local || env.MODE !== "bridge-local-test" || !wiki || !vault)
  ) {
    throw Error(
      "Pinned bridge origins require both origins, explicit local flag, and bridge-local-test mode",
    );
  }
  return bridgeOrigins(
    local
      ? {
          wiki: wiki || "http://wiki.localhost:3010",
          vault: vault || "http://vault.localhost:3024",
        }
      : undefined,
    local,
  );
}
export type Launch = {
  mode: "link" | "fund";
  id: string;
  nonce: string;
  receipt?: "1";
};
export type BridgeMessage = {
  protocol: "kinic-credit-v1";
  type: "linked" | "offer" | "ready" | "result" | "hello" | "ack";
  id: string;
  nonce: string;
};
const idPattern = /^[a-f0-9]{32}$/;
const noncePattern = /^[a-f0-9]{64}$/;
export function hex(bytes: Uint8Array | number[]): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
export function bytes(id: string): Uint8Array {
  if (!idPattern.test(id)) throw Error("Invalid operation identifier");
  return Uint8Array.from(id.match(/../g)!, (b) => parseInt(b, 16));
}
export function parseLaunch(hash: string): Launch | null {
  const p = new URLSearchParams(hash.replace(/^#/, ""));
  const keys = [...p.keys()].sort().join(",");
  if (keys !== "id,mode,nonce" && keys !== "id,mode,nonce,receipt") return null;
  const receipt = p.get("receipt");
  if (receipt !== null && (receipt !== "1" || p.get("mode") !== "fund"))
    return null;
  const mode = p.get("mode"),
    id = p.get("id")!,
    nonce = p.get("nonce")!;
  return (mode === "link" || mode === "fund") &&
    idPattern.test(id) &&
    noncePattern.test(nonce)
    ? { mode, id, nonce, ...(receipt === "1" ? { receipt } : {}) }
    : null;
}
export function bridgeUrl(
  target: "wiki" | "vault",
  launch: Launch,
  origins = productionOrigins,
): string {
  const hash = new URLSearchParams(launch).toString();
  if (!parseLaunch(hash)) throw Error("Invalid launch");
  return `${origins[target]}${target === "wiki" ? "/vault-credit" : "/"}#${hash}`;
}
export function message(
  type: BridgeMessage["type"],
  id: string,
  nonce: string,
): BridgeMessage {
  if (!idPattern.test(id) || !noncePattern.test(nonce))
    throw Error("Invalid message");
  return { protocol: "kinic-credit-v1", type, id, nonce };
}
export function acceptMessage(
  event: { origin: string; source: unknown; data: unknown },
  expected: { origin: string; source: unknown; nonce: string },
): BridgeMessage | null {
  if (
    !expected.source ||
    event.source !== expected.source ||
    event.origin !== expected.origin
  )
    return null;
  const d = event.data;
  if (
    !d ||
    typeof d !== "object" ||
    Object.keys(d).sort().join(",") !== "id,nonce,protocol,type"
  )
    return null;
  const m = d as BridgeMessage;
  return m.protocol === "kinic-credit-v1" &&
    ["hello", "ack", "linked", "offer", "ready", "result"].includes(m.type) &&
    typeof m.id === "string" &&
    idPattern.test(m.id) &&
    m.nonce === expected.nonce &&
    noncePattern.test(m.nonce)
    ? m
    : null;
}
export function parseExactCycles(input: string): bigint {
  if (!/^[1-9][0-9]*$/.test(input))
    throw Error("Enter a positive whole number of cycles");
  const amount = BigInt(input);
  if (amount > 9223372036854775807n) throw Error("Cycle amount is too large");
  return amount;
}
export function approvalFor(
  amount: TransferAmount,
  allConfirmed: boolean,
): TransferApproval {
  if ("Exact" in amount) return { Exact: amount.Exact };
  if (!allConfirmed) throw Error("Confirm the full available balance");
  return { AllAvailable: null };
}
export function bridgeOk<T>(result: { Ok: T } | { Err: unknown }): T {
  if ("Err" in result)
    throw Error(
      "Credit bridge request was not completed. Refresh status before retrying.",
    );
  return result.Ok;
}
export function sessionFence(
  read: () => { identity: unknown; client: unknown; epoch: unknown } | null,
): () => void {
  const initial = read();
  return () => {
    const now = read();
    if (
      !initial ||
      !now ||
      initial.identity !== now.identity ||
      initial.client !== now.client ||
      initial.epoch !== now.epoch
    )
      throw Error("Session changed");
  };
}
