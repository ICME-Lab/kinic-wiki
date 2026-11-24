import type { Icrc2Did, IcrcCallCanisterRequestParams, IcrcCallCanisterResult, RelyingPartyOptions } from "@dfinity/oisy-wallet-signer";
import type { RelyingParty } from "@dfinity/oisy-wallet-signer/relying-party";
import type { IDL } from "@icp-sdk/core/candid";
import type { Principal } from "@icp-sdk/core/principal";
import { PaymentFailure } from "./errors";
import type { FundingAccount } from "./types";

export type ApproveArgs = Icrc2Did.ApproveArgs;
export type WalletAccess = { canisterId: string; methods: readonly string[] };
export type DispatchGuard = { isCurrent?: () => boolean };
export type WalletCall = DispatchGuard & {
  canisterId: string;
  method: string;
  mode: "query" | "update";
  arg: Uint8Array;
  interfaceFactory: IDL.InterfaceFactory;
};
export interface FundingTransport {
  readonly account: Readonly<FundingAccount>;
  readonly silentCheck: boolean;
  approve(ledger: string, args: ApproveArgs, guard?: DispatchGuard): Promise<bigint>;
  call(request: WalletCall): Promise<Uint8Array>;
  revalidate(): Promise<void>;
  disconnect(): Promise<void>;
  /**
   * Keeps an interactive signer open until the returned release runs. Call it
   * synchronously from a click before awaiting, so its window may open.
   */
  holdSigner?(): () => void;
}
export type WalletIssue = "account-changed" | "empty-accounts" | "unsupported-account" | "permission-denied"
  | "extension-missing" | "popup-blocked" | "unsupported-network" | "connection-failed" | "disconnected" | "scope-required";
export class WalletFailure extends PaymentFailure {
  constructor(readonly reason: WalletIssue) {
    super(reason === "account-changed" ? "AccountChanged"
      : reason === "unsupported-account" || reason === "empty-accounts" ? "UnsupportedAccount"
      : reason === "popup-blocked" ? "SignerBlocked" : "Unavailable");
  }
}
export type OisySigner = Pick<RelyingParty, "permissions" | "requestPermissions" | "accounts" | "disconnect"> & {
  callCanister(params: IcrcCallCanisterRequestParams): Promise<IcrcCallCanisterResult>;
};
export type OpenSigner = (options: RelyingPartyOptions) => Promise<OisySigner>;
export type WalletActor = Record<string, unknown>;
export interface PlugWallet {
  requestConnect(options: { whitelist: string[]; host: string; timeout: number; onConnectionUpdate: () => void }): Promise<unknown>;
  isConnected?(): Promise<boolean>;
  agent?: { getPrincipal(): Promise<Principal>; host?: URL | string };
  isWalletLocked?: boolean;
  createActor(options: { canisterId: string; interfaceFactory: IDL.InterfaceFactory }): Promise<WalletActor>;
  disconnect?(): Promise<void>;
  onExternalDisconnect?(callback: () => void): unknown;
  onLockStateChange?(callback: (locked: boolean) => void): unknown;
}
