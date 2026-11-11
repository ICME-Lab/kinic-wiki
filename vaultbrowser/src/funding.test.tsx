// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { it, expect, vi, afterEach } from 'vitest';
import { Principal } from '@icp-sdk/core/principal';
import type { VaultClient } from '@kinic/vault-client';
import type { Payment } from '@kinic/vault-client/contracts';
const mocks = vi.hoisted(() => ({
  approve: vi.fn(),
  agent: vi.fn()
}));
vi.mock('@icp-sdk/core/agent', () => ({
  Actor: {
    createActor: () => ({
      icrc2_approve: mocks.approve
    })
  },
  HttpAgent: {
    createSync: mocks.agent
  }
}));
vi.mock('./config', () => ({
  loadConfig: async () => ({
    canister: 'aaaaa-aa',
    host: 'https://icp0.io',
    local: false
  })
}));
import { Funding } from './funding';
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
const payment: Payment = {
  wallet: Principal.fromText('aaaaa-aa'),
  request: {
    operation: new Uint8Array(16).fill(4),
    beneficiary: Principal.fromText('aaaaa-aa'),
    amount_e8s: 100_000_000n,
    min_credits: 20_000_000n,
    created_at_time: 100n
  },
  config: {
    ledger: Principal.fromText('aaaaa-aa'),
    recipient: Principal.fromText('aaaaa-aa'),
    cycles_per_kinic: 100_000_000n
  },
  fee: 10n,
  credits: 100_000_000n,
  memo: new Uint8Array(32).fill(3),
  created_at_time: 100n,
  status: {
    Unknown: null
  },
  generation: 1n,
  attempt: 1n,
  sent_at: 100n,
  uncertain: true
};
function client(p: Payment = payment) {
  return {
    identity: {
      getPrincipal: () => p.wallet
    },
    session: {
      capture: () => 0
    },
    actor: {
      list_payments: vi.fn(async () => ({
        Ok: [p]
      })),
      pay_purchase: vi.fn(async () => ({
        Ok: p
      })),
      quote_purchase: vi.fn(),
      payment_status: vi.fn(async () => ({
        Ok: [p]
      }))
    }
  } as unknown as VaultClient;
}
it('recovers unknown payment and retries only its stored operation without new approval or new quote', async () => {
  const c = client();
  render(<Funding client={c} onFunded={async () => {}} />);
  fireEvent.click(await screen.findByRole('button', {
    name: 'Retry same payment'
  }));
  await waitFor(() => expect(c.actor.pay_purchase).toHaveBeenCalledWith(payment.request.operation));
  expect(mocks.approve).not.toHaveBeenCalled();
  expect(c.actor.quote_purchase).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', {
    name: 'New quote'
  })).toBeNull();
});
it('pins approval amount, expiry, memo and timestamp and accepts its Duplicate before the exact purchase', async () => {
  const p = {
    ...payment,
    status: {
      Quoted: null
    },
    uncertain: false
  } as Payment;
  const c = client(p);
  mocks.approve.mockResolvedValue({
    Err: {
      Duplicate: {
        duplicate_of: 8n
      }
    }
  });
  render(<Funding client={c} onFunded={async () => {}} />);
  fireEvent.click(await screen.findByRole('button', {
    name: 'Approve and pay this quote'
  }));
  await waitFor(() => expect(c.actor.pay_purchase).toHaveBeenCalledWith(p.request.operation));
  expect(mocks.approve).toHaveBeenCalledWith(expect.objectContaining({
    amount: 100_000_010n,
    fee: [10n],
    memo: [p.memo],
    created_at_time: [100n],
    expires_at: [300_000_000_100n]
  }));
  expect(mocks.agent).toHaveBeenCalledWith({
    host: 'https://icp0.io',
    identity: c.identity
  });
});
it('does not permit a replacement payment while history is unavailable', async () => {
  const c = client();
  vi.mocked(c.actor.list_payments).mockRejectedValue(Error('offline'));
  render(<Funding client={c} onFunded={async () => {}} />);
  await screen.findByRole('alert');
  expect((screen.getByRole('button', {
    name: 'Get quote'
  }) as HTMLButtonElement).disabled).toBe(true);
  expect(c.actor.quote_purchase).not.toHaveBeenCalled();
});
