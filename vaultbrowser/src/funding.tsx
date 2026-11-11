import { useEffect, useState } from 'react';
import { Actor, HttpAgent } from '@icp-sdk/core/agent';
import { Principal } from '@icp-sdk/core/principal';
import { IDL } from '@icp-sdk/core/candid';
import type { VaultClient } from '@kinic/vault-client';
import { ok } from '@kinic/vault-client';
import type { Payment } from '@kinic/vault-client/contracts';
import { loadConfig } from './config';
import { VaultButton } from './vault/ui';
const ledgerIDL: IDL.InterfaceFactory = ({
  IDL
}) => {
  const Account = IDL.Record({
    owner: IDL.Principal,
    subaccount: IDL.Opt(IDL.Vec(IDL.Nat8))
  });
  const Error = IDL.Variant({
    BadFee: IDL.Record({
      expected_fee: IDL.Nat
    }),
    InsufficientFunds: IDL.Record({
      balance: IDL.Nat
    }),
    AllowanceChanged: IDL.Record({
      current_allowance: IDL.Nat
    }),
    Expired: IDL.Record({
      ledger_time: IDL.Nat64
    }),
    TooOld: IDL.Null,
    CreatedInFuture: IDL.Record({
      ledger_time: IDL.Nat64
    }),
    Duplicate: IDL.Record({
      duplicate_of: IDL.Nat
    }),
    TemporarilyUnavailable: IDL.Null,
    GenericError: IDL.Record({
      error_code: IDL.Nat,
      message: IDL.Text
    })
  });
  return IDL.Service({
    icrc2_approve: IDL.Func([IDL.Record({
      from_subaccount: IDL.Opt(IDL.Vec(IDL.Nat8)),
      spender: Account,
      amount: IDL.Nat,
      expected_allowance: IDL.Opt(IDL.Nat),
      expires_at: IDL.Opt(IDL.Nat64),
      fee: IDL.Opt(IDL.Nat),
      memo: IDL.Opt(IDL.Vec(IDL.Nat8)),
      created_at_time: IDL.Opt(IDL.Nat64)
    })], [IDL.Variant({
      Ok: IDL.Nat,
      Err: Error
    })], [])
  });
};
export function Funding({
  client,
  onFunded
}: {
  client: VaultClient;
  onFunded: () => Promise<void>;
}) {
  const [amount, setAmount] = useState('1');
  const [quote, setQuote] = useState<Payment>();
  const [historyReady, setHistoryReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const work = (f: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setMessage('');
    const generation = client.session.capture();
    void f().catch(() => {
      if (client.session.capture() === generation) setMessage('Request did not complete. Check the saved payment status before attempting another payment.');
    }).finally(() => setBusy(false));
  };
  useEffect(() => {
    let active = true;
    void client.actor.list_payments().then(result => {
      if (active) {
        const saved = ok(result).find(p => 'Unknown' in p.status || 'InFlight' in p.status || 'Quoted' in p.status);
        if (saved) setQuote(saved);
        setHistoryReady(true);
      }
    }).catch(() => {
      if (active) setMessage('Could not load previous payments. Check payment history before funding.');
    });
    return () => {
      active = false;
    };
  }, [client]);
  const refresh = async () => {
    if (!quote) return;
    const p = ok(await client.actor.payment_status(quote.request.operation))[0];
    if (p) setQuote(p);
    await onFunded();
  };
  return <div className="grid gap-3">
 <p className="text-sm">Pay from this Vault identity’s KINIC account. For a different wallet, use this Vault principal as the beneficiary of the dedicated purchase API.</p>
 <label className="grid gap-1 text-sm">KINIC amount<input aria-label="KINIC amount" inputMode="decimal" className="rounded border border-line p-2" value={amount} disabled={busy || !!quote} onChange={e => setAmount(e.target.value)} /></label>
 {!quote ? <VaultButton disabled={busy || !historyReady} onClick={() => work(async () => {
      if (!/^\d+(\.\d{1,8})?$/.test(amount)) throw Error('InvalidAmount');
      const [whole, frac = ''] = amount.split('.');
      const e8s = BigInt(whole) * 100_000_000n + BigInt(frac.padEnd(8, '0'));
      if (e8s <= 0n) throw Error('InvalidAmount');
      const p = ok(await client.actor.quote_purchase({
        operation: crypto.getRandomValues(new Uint8Array(16)),
        beneficiary: client.identity.getPrincipal(),
        amount_e8s: e8s,
        min_credits: 20_000_000n,
        created_at_time: BigInt(Date.now()) * 1_000_000n
      }));
      setQuote(p);
    })}>Get quote</VaultButton> : <>
 <p className="text-sm">Credit: {quote.credits.toString()} cycles. Transfer fee: {quote.fee.toString()} e8s. Approval also costs {quote.fee.toString()} e8s.</p>
 <p className="break-all text-xs">Ledger: {quote.config.ledger.toText()} · Recipient: {quote.config.recipient.toText()}</p>
 <p className="break-all text-xs">Payment ID: {Array.from(quote.request.operation).map(b => b.toString(16).padStart(2, '0')).join('')}</p>
 <output>{Object.keys(quote.status)[0]}</output>
 {'Quoted' in quote.status ? <VaultButton disabled={busy} onClick={() => work(async () => {
        const config = await loadConfig();
        const agent = HttpAgent.createSync({
          host: config.host,
          identity: client.identity
        });
        if (config.local) await agent.fetchRootKey();
        const ledger = Actor.createActor<{
          icrc2_approve: (arg: unknown) => Promise<{
            Ok: bigint;
          } | {
            Err: unknown;
          }>;
        }>(ledgerIDL, {
          agent,
          canisterId: quote.config.ledger
        });
        const result = await ledger.icrc2_approve({
          from_subaccount: [],
          spender: {
            owner: Principal.fromText(config.canister),
            subaccount: []
          },
          amount: quote.request.amount_e8s + quote.fee,
          expected_allowance: [],
          expires_at: [quote.created_at_time + 300_000_000_000n],
          fee: [quote.fee],
          memo: [quote.memo],
          created_at_time: [quote.created_at_time]
        });
        if ('Err' in result && !(typeof result.Err === 'object' && result.Err !== null && 'Duplicate' in result.Err)) throw Error('ApprovalFailed');
        setQuote(ok(await client.actor.pay_purchase(quote.request.operation)));
        await onFunded();
      })}>Approve and pay this quote</VaultButton> : null}
 {'Unknown' in quote.status || 'InFlight' in quote.status ? <><p className="text-sm">The ledger outcome is unknown. Retry only this exact payment. After the retry window, ledger reconciliation is required; do not create a replacement payment.</p><VaultButton disabled={busy} onClick={() => work(async () => {
          setQuote(ok(await client.actor.pay_purchase(quote.request.operation)));
          await onFunded();
        })}>Retry same payment</VaultButton></> : null}
 <VaultButton disabled={busy} onClick={() => work(refresh)}>Check payment status</VaultButton>
 {'Quoted' in quote.status ? <VaultButton disabled={busy} onClick={() => work(async () => {
        setQuote(ok(await client.actor.cancel_quote(quote.request.operation)));
      })}>Cancel unpaid quote</VaultButton> : null}
 {['Paid', 'BadFee', 'InsufficientFunds', 'InsufficientAllowance', 'Rejected', 'Expired'].some(k => k in quote.status) ? <VaultButton disabled={busy} onClick={() => setQuote(undefined)}>New quote</VaultButton> : null}
 </>}
 {message ? <p role="alert" className="text-sm">{message}</p> : null}
 </div>;
}
