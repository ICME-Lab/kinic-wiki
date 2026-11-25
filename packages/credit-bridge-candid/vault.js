export const idlFactory = ({ IDL }) => {
  const LinkChallenge = IDL.Record({
    'challenge' : IDL.Vec(IDL.Nat8),
    'generation' : IDL.Nat64,
    'vault_owner' : IDL.Principal,
    'expires_at_ns' : IDL.Nat64,
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
  const Result_2 = IDL.Variant({ 'Ok' : LinkChallenge, 'Err' : BridgeError });
  const CreditStatus = IDL.Variant({
    'Prepared' : IDL.Null,
    'Accepted' : IDL.Null,
    'NotAccepted' : IDL.Null,
  });
  const CreditOffer = IDL.Record({
    'wiki_owner' : IDL.Principal,
    'link_generation' : IDL.Nat64,
    'operation' : IDL.Vec(IDL.Nat8),
    'amount_cycles' : IDL.Nat64,
    'vault_owner' : IDL.Principal,
    'expires_at_ns' : IDL.Nat64,
  });
  const CreditReceipt = IDL.Record({
    'status' : CreditStatus,
    'offer' : CreditOffer,
  });
  const Result_27 = IDL.Variant({ 'Ok' : CreditReceipt, 'Err' : BridgeError });
  const Result_29 = IDL.Variant({
    'Ok' : IDL.Opt(CreditReceipt),
    'Err' : BridgeError,
  });
  const BridgeRevocation = IDL.Record({
    'through_generation' : IDL.Nat64,
    'vault_owner' : IDL.Principal,
  });
  const Result_30 = IDL.Variant({
    'Ok' : BridgeRevocation,
    'Err' : BridgeError,
  });
  const AutoTopupPolicy = IDL.Record({
    'daily_limit_cycles' : IDL.Nat64,
    'threshold_cycles' : IDL.Nat64,
    'database_id' : IDL.Text,
    'amount_cycles' : IDL.Nat64,
    'min_database_cycles' : IDL.Nat64,
  });
  const AutoTopupStatus = IDL.Record({
    'sent_today_cycles' : IDL.Nat64,
    'last_topup_at_ns' : IDL.Opt(IDL.Nat64),
    'database_name' : IDL.Text,
    'policy' : AutoTopupPolicy,
  });
  const Result_32 = IDL.Variant({
    'Ok' : IDL.Opt(AutoTopupStatus),
    'Err' : BridgeError,
  });
  const LinkStatus = IDL.Record({
    'wiki_owner' : IDL.Principal,
    'active' : IDL.Bool,
    'generation' : IDL.Nat64,
    'vault_owner' : IDL.Principal,
  });
  const Result_33 = IDL.Variant({
    'Ok' : IDL.Opt(LinkStatus),
    'Err' : BridgeError,
  });
  return IDL.Service({
    'begin_wiki_link' : IDL.Func([IDL.Vec(IDL.Nat8)], [Result_2], []),
    'prepare_wiki_credit' : IDL.Func([IDL.Vec(IDL.Nat8)], [Result_27], []),
    'request_wiki_auto_topup' : IDL.Func([], [Result_29], []),
    'revoke_wiki_link' : IDL.Func([], [Result_30], []),
    'wiki_auto_topup_status' : IDL.Func([], [Result_32], []),
    'wiki_link_status' : IDL.Func([], [Result_33], []),
  });
};
export const init = ({ IDL }) => { return []; };
