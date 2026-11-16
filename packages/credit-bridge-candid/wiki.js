export const idlFactory = ({ IDL }) => {
  const LinkStatus = IDL.Record({
    'wiki_owner' : IDL.Principal,
    'active' : IDL.Bool,
    'generation' : IDL.Nat64,
    'vault_owner' : IDL.Principal,
  });
  const BridgeError = IDL.Variant({
    'Storage' : IDL.Null,
    'InvalidInput' : IDL.Null,
    'Disabled' : IDL.Null,
    'NotFound' : IDL.Null,
    'Unauthorized' : IDL.Null,
    'Capacity' : IDL.Null,
    'Unavailable' : IDL.Null,
    'Expired' : IDL.Null,
    'Conflict' : IDL.Null,
  });
  const Result_1 = IDL.Variant({ 'Ok' : LinkStatus, 'Err' : BridgeError });
  const TransferAmount = IDL.Variant({ 'All' : IDL.Null, 'Exact' : IDL.Nat64 });
  const CreditOffer = IDL.Record({
    'wiki_owner' : IDL.Principal,
    'link_generation' : IDL.Nat64,
    'operation' : IDL.Vec(IDL.Nat8),
    'amount_cycles' : IDL.Nat64,
    'vault_owner' : IDL.Principal,
    'expires_at_ns' : IDL.Nat64,
  });
  const TransferPhase = IDL.Variant({
    'Quoted' : IDL.Null,
    'Refunded' : IDL.Null,
    'Paid' : IDL.Null,
    'Offered' : IDL.Null,
    'Unknown' : IDL.Null,
  });
  const VaultTransfer = IDL.Record({
    'requested' : TransferAmount,
    'offer' : CreditOffer,
    'receiver_cleanup_pending' : IDL.Bool,
    'balance_at_quote' : IDL.Nat64,
    'database_id' : IDL.Text,
    'phase' : TransferPhase,
    'collected_execution_fee_cycles' : IDL.Nat64,
    'estimated_execution_fee_cycles' : IDL.Nat64,
  });
  const Result_5 = IDL.Variant({ 'Ok' : VaultTransfer, 'Err' : BridgeError });
  const TransferApproval = IDL.Variant({
    'Exact' : IDL.Nat64,
    'AllAvailable' : IDL.Null,
  });
  const Result_19 = IDL.Variant({
    'Ok' : IDL.Opt(VaultTransfer),
    'Err' : BridgeError,
  });
  const Result_4 = IDL.Variant({
    'Ok' : IDL.Opt(LinkStatus),
    'Err' : BridgeError,
  });
  const LinkChallenge = IDL.Record({
    'challenge' : IDL.Vec(IDL.Nat8),
    'generation' : IDL.Nat64,
    'vault_owner' : IDL.Principal,
    'expires_at_ns' : IDL.Nat64,
  });
  const Result_47 = IDL.Variant({ 'Ok' : LinkChallenge, 'Err' : BridgeError });
  const Result_57 = IDL.Variant({ 'Ok' : IDL.Null, 'Err' : BridgeError });
  return IDL.Service({
    'approve_vault_link' : IDL.Func([IDL.Vec(IDL.Nat8)], [Result_1], []),
    'cancel_vault_transfer' : IDL.Func([IDL.Vec(IDL.Nat8)], [Result_5], []),
    'execute_vault_transfer' : IDL.Func(
        [IDL.Vec(IDL.Nat8), TransferApproval],
        [Result_5],
        [],
      ),
    'get_pending_vault_transfer' : IDL.Func(
        [IDL.Opt(IDL.Text)],
        [Result_19],
        [],
      ),
    'get_vault_link' : IDL.Func([], [Result_4], ['query']),
    'get_vault_transfer' : IDL.Func([IDL.Vec(IDL.Nat8)], [Result_5], []),
    'preview_vault_link' : IDL.Func([IDL.Vec(IDL.Nat8)], [Result_47], []),
    'quote_vault_transfer' : IDL.Func(
        [IDL.Text, TransferAmount, IDL.Vec(IDL.Nat8)],
        [Result_5],
        [],
      ),
    'reconcile_vault_transfer' : IDL.Func([IDL.Vec(IDL.Nat8)], [Result_5], []),
    'revoke_vault_link' : IDL.Func([], [Result_57], []),
  });
};
export const init = ({ IDL }) => { return []; };
