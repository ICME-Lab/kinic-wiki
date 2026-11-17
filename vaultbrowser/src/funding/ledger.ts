import { IDL } from "@icp-sdk/core/candid";

export const ledgerIDL: IDL.InterfaceFactory = ({ IDL }) => {
  const Account = IDL.Record({
    owner: IDL.Principal,
    subaccount: IDL.Opt(IDL.Vec(IDL.Nat8)),
  });
  const Error = IDL.Variant({
    BadFee: IDL.Record({
      expected_fee: IDL.Nat,
    }),
    InsufficientFunds: IDL.Record({
      balance: IDL.Nat,
    }),
    AllowanceChanged: IDL.Record({
      current_allowance: IDL.Nat,
    }),
    Expired: IDL.Record({
      ledger_time: IDL.Nat64,
    }),
    TooOld: IDL.Null,
    CreatedInFuture: IDL.Record({
      ledger_time: IDL.Nat64,
    }),
    Duplicate: IDL.Record({
      duplicate_of: IDL.Nat,
    }),
    TemporarilyUnavailable: IDL.Null,
    GenericError: IDL.Record({
      error_code: IDL.Nat,
      message: IDL.Text,
    }),
  });
  return IDL.Service({
    icrc2_approve: IDL.Func(
      [
        IDL.Record({
          from_subaccount: IDL.Opt(IDL.Vec(IDL.Nat8)),
          spender: Account,
          amount: IDL.Nat,
          expected_allowance: IDL.Opt(IDL.Nat),
          expires_at: IDL.Opt(IDL.Nat64),
          fee: IDL.Opt(IDL.Nat),
          memo: IDL.Opt(IDL.Vec(IDL.Nat8)),
          created_at_time: IDL.Opt(IDL.Nat64),
        }),
      ],
      [
        IDL.Variant({
          Ok: IDL.Nat,
          Err: Error,
        }),
      ],
      [],
    ),
  });
};
