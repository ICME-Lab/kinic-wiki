import { resolve } from "node:path";
// Minimal wire types from the pinned official ledger DID, including recursive ICRC3.
export function ledgerTypes(IDL) {
  const opt = IDL.Opt,
    vec = IDL.Vec,
    rec = IDL.Record;
  const Account = rec({ owner: IDL.Principal, subaccount: opt(vec(IDL.Nat8)) });
  const Value = IDL.Rec();
  Value.fill(
    IDL.Variant({
      Nat: IDL.Nat,
      Int: IDL.Int,
      Text: IDL.Text,
      Blob: vec(IDL.Nat8),
      Array: vec(Value),
      Map: vec(IDL.Tuple(IDL.Text, Value)),
    }),
  );
  const Range = rec({ start: IDL.Nat, length: IDL.Nat });
  const Blocks = IDL.Rec();
  Blocks.fill(
    rec({
      log_length: IDL.Nat,
      blocks: vec(rec({ id: IDL.Nat, block: Value })),
      archived_blocks: vec(
        rec({
          args: vec(Range),
          callback: IDL.Func([vec(Range)], [Blocks], ["query"]),
        }),
      ),
    }),
  );
  const Init = IDL.Variant({
    Init: rec({
      minting_account: Account,
      fee_collector_account: opt(Account),
      transfer_fee: IDL.Nat,
      decimals: opt(IDL.Nat8),
      max_memo_length: opt(IDL.Nat16),
      token_symbol: IDL.Text,
      token_name: IDL.Text,
      metadata: vec(
        IDL.Tuple(
          IDL.Text,
          IDL.Variant({
            Nat: IDL.Nat,
            Int: IDL.Int,
            Text: IDL.Text,
            Blob: vec(IDL.Nat8),
          }),
        ),
      ),
      initial_balances: vec(IDL.Tuple(Account, IDL.Nat)),
      feature_flags: opt(rec({ icrc2: IDL.Bool })),
      archive_options: rec({
        num_blocks_to_archive: IDL.Nat64,
        max_transactions_per_response: opt(IDL.Nat64),
        trigger_threshold: IDL.Nat64,
        max_message_size_bytes: opt(IDL.Nat64),
        cycles_for_archive_creation: opt(IDL.Nat64),
        node_max_memory_size_bytes: opt(IDL.Nat64),
        controller_id: IDL.Principal,
        more_controller_ids: opt(vec(IDL.Principal)),
      }),
      index_principal: opt(IDL.Principal),
    }),
  });
  const Error = IDL.Variant({
    GenericError: rec({ message: IDL.Text, error_code: IDL.Nat }),
    TemporarilyUnavailable: IDL.Null,
    Duplicate: rec({ duplicate_of: IDL.Nat }),
    BadFee: rec({ expected_fee: IDL.Nat }),
    BadBurn: rec({ min_burn_amount: IDL.Nat }),
    AllowanceChanged: rec({ current_allowance: IDL.Nat }),
    CreatedInFuture: rec({ ledger_time: IDL.Nat64 }),
    TooOld: IDL.Null,
    Expired: rec({ ledger_time: IDL.Nat64 }),
    InsufficientFunds: rec({ balance: IDL.Nat }),
  });
  const Result = IDL.Variant({ Ok: IDL.Nat, Err: Error });
  return {
    Init,
    factory: () =>
      IDL.Service({
        icrc1_balance_of: IDL.Func([Account], [IDL.Nat], ["query"]),
        icrc2_allowance: IDL.Func(
          [rec({ account: Account, spender: Account })],
          [rec({ allowance: IDL.Nat, expires_at: opt(IDL.Nat64) })],
          ["query"],
        ),
        icrc2_approve: IDL.Func(
          [
            rec({
              from_subaccount: opt(vec(IDL.Nat8)),
              spender: Account,
              amount: IDL.Nat,
              expected_allowance: opt(IDL.Nat),
              expires_at: opt(IDL.Nat64),
              fee: opt(IDL.Nat),
              memo: opt(vec(IDL.Nat8)),
              created_at_time: opt(IDL.Nat64),
            }),
          ],
          [Result],
          [],
        ),
        icrc1_transfer: IDL.Func(
          [
            rec({
              from_subaccount: opt(vec(IDL.Nat8)),
              to: Account,
              amount: IDL.Nat,
              fee: opt(IDL.Nat),
              memo: opt(vec(IDL.Nat8)),
              created_at_time: opt(IDL.Nat64),
            }),
          ],
          [Result],
          [],
        ),
        icrc3_get_blocks: IDL.Func([vec(Range)], [Blocks], ["query"]),
      }),
  };
}

export async function installOfficialLedger({
  pic,
  IDL,
  Principal,
  root,
  owner,
  other,
}) {
  const account = (p) => ({ owner: p, subaccount: [] });
  const { Init, factory } = ledgerTypes(IDL);
  return pic.setupCanister({
    sender: owner,
    idlFactory: factory,
    targetCanisterId: Principal.fromText("73mez-iiaaa-aaaaq-aaasq-cai"),
    wasm: resolve(root, "target/tools/ic-icrc1-ledger.wasm.gz"),
    cycles: 100_000_000_000_000n,
    arg: IDL.encode(
      [Init],
      [
        {
          Init: {
            minting_account: account(other),
            fee_collector_account: [],
            transfer_fee: 10n,
            decimals: [8],
            max_memo_length: [32],
            token_symbol: "TEST",
            token_name: "Official local ledger",
            metadata: [],
            initial_balances: [[account(owner), 100_000_000_000n]],
            feature_flags: [{ icrc2: true }],
            archive_options: {
              num_blocks_to_archive: 110n,
              trigger_threshold: 120n,
              max_transactions_per_response: [100n],
              max_message_size_bytes: [],
              cycles_for_archive_creation: [10_000_000_000_000n],
              node_max_memory_size_bytes: [],
              controller_id: owner,
              more_controller_ids: [],
            },
            index_principal: [],
          },
        },
      ],
    ),
  });
}
