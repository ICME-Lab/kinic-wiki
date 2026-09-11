import { describe, expect, it } from "vitest";
import { IDL } from "@icp-sdk/core/candid";
import { idlFactory } from "@kinic/vfs-candid";
import { normalizeCyclesBillingConfig } from "@/lib/vfs-client/cycles";
import type { RawCyclesBillingConfig } from "@/lib/vfs-client/raw-types";

const wireConfig = IDL.Record({
  kinic_ledger_canister_id: IDL.Text,
  billing_authority_id: IDL.Text,
  iap_authority_id: IDL.Opt(IDL.Text),
  cycles_per_kinic: IDL.Nat64,
  min_update_cycles: IDL.Nat64,
  top_up: IDL.Record({
    enabled: IDL.Bool,
    launcher_principal: IDL.Text,
    threshold_cycles: IDL.Nat
  })
});

describe("cycles billing Candid response", () => {
  it.each<{ authority: [] | [string]; expected: string | null }>([
    { authority: [], expected: null },
    { authority: ["aaaaa-aa"], expected: "aaaaa-aa" }
  ])("decodes and normalizes IAP authority $expected", ({ authority, expected }) => {
    const wireResult = IDL.Variant({ Ok: wireConfig, Err: IDL.Text });
    const bytes = IDL.encode([wireResult], [{
      Ok: {
        kinic_ledger_canister_id: "aaaaa-aa",
        billing_authority_id: "rrkah-fqaaa-aaaaa-aaaaq-cai",
        iap_authority_id: authority,
        cycles_per_kinic: 234_500_000_000n,
        min_update_cycles: 1_000_000n,
        top_up: {
          enabled: true,
          launcher_principal: "aaaaa-aa",
          threshold_cycles: 2_000_000_000_000n
        }
      }
    }]);
    const service = idlFactory({ IDL }) as ReturnType<typeof IDL.Service>;
    const method = service._fields.find(([name]) => name === "get_cycles_billing_config")![1];
    const [decoded] = IDL.decode(method.retTypes, bytes) as [{ Ok: RawCyclesBillingConfig }];
    const config = normalizeCyclesBillingConfig(decoded.Ok);

    expect(config.iapAuthorityId).toBe(expected);
    expect(config.minUpdateCycles).toBe("1000000");
    expect(config.topUp.thresholdCycles).toBe("2000000000000");
  });
});
