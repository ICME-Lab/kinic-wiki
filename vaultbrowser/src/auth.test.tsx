// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { afterEach, it, expect, vi } from 'vitest';
const mock = vi.hoisted(() => ({
  create: vi.fn(),
  load: vi.fn()
}));
vi.mock('@icp-sdk/auth/client', () => ({
  AuthClient: {
    create: mock.create
  }
}));
vi.mock('./config', () => ({
  loadConfig: mock.load
}));
import { VaultAuthProvider, useVaultAuth } from './auth';
function Child() {
  const s = useVaultAuth();
  return <><span>{s.identity ? 'signed' : 'unsigned'}</span><button onClick={s.login}>login</button><button onClick={s.logout}>logout</button></>;
}
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
it('opens II with only its own certified derivation origin and removes identity before async logout completes', async () => {
  const identity = {
    getPrincipal: () => ({
      toText: () => 'vault-principal'
    })
  };
  const login = vi.fn();
  let finish!: () => void;
  const c = {
    isAuthenticated: async () => false,
    getIdentity: () => identity,
    login,
    logout: vi.fn(() => new Promise<void>(r => {
      finish = r;
    })),
    idleManager: {
      registerCallback: vi.fn()
    }
  };
  mock.create.mockResolvedValue(c);
  mock.load.mockResolvedValue({
    identityProvider: 'https://id.ai',
    derivationOrigin: 'https://rrkah-fqaaa-aaaaa-aaaaq-cai.icp0.io'
  });
  render(<VaultAuthProvider><Child /></VaultAuthProvider>);
  await waitFor(() => expect(mock.create).toHaveBeenCalled());
  await waitFor(() => expect(c.idleManager.registerCallback).toHaveBeenCalled());
  fireEvent.click(screen.getByText('login'));
  await waitFor(() => expect(login).toHaveBeenCalled());
  const args = login.mock.calls[0][0];
  expect(args.derivationOrigin).toBe('https://rrkah-fqaaa-aaaaa-aaaaq-cai.icp0.io');
  expect(args.identityProvider).toBe('https://id.ai');
  args.onSuccess();
  await screen.findByText('signed');
  fireEvent.click(screen.getByText('logout'));
  expect(screen.queryByText('signed')).toBeNull();
  expect(screen.getByText('unsigned')).toBeTruthy();
  finish();
});
it('never authenticates when certified configuration fails validation', async () => {
  const login = vi.fn();
  mock.create.mockResolvedValue({
    isAuthenticated: async () => false,
    login,
    idleManager: {
      registerCallback: vi.fn()
    }
  });
  mock.load.mockRejectedValue(Error('wrong origin'));
  render(<VaultAuthProvider><Child /></VaultAuthProvider>);
  await waitFor(() => expect(mock.create).toHaveBeenCalled());
  fireEvent.click(screen.getByText('login'));
  await waitFor(() => expect(mock.load).toHaveBeenCalled());
  expect(login).not.toHaveBeenCalled();
  expect(screen.getByText('unsigned')).toBeTruthy();
});
