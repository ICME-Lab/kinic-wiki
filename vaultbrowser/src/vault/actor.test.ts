import { expect, it, vi, afterEach } from 'vitest';
import { Ed25519KeyIdentity } from '@icp-sdk/core/identity';
const mock = vi.hoisted(() => ({
  createActor: vi.fn(),
  createSync: vi.fn(),
  fetchRootKey: vi.fn(async () => {}),
  config: {
    canister: 'aaaaa-aa',
    host: 'https://icp0.io',
    local: false
  }
}));
vi.mock('@icp-sdk/core/agent', () => ({
  Actor: {
    createActor: mock.createActor
  },
  HttpAgent: {
    createSync: mock.createSync
  }
}));
vi.mock('../config', () => ({
  loadConfig: async () => mock.config
}));
import { createPrivateVaultClient } from './actor';
import { idlFactory } from '@kinic/vault-candid';
afterEach(() => vi.clearAllMocks());
it('constructs an independent dedicated actor with Vault identity and no mainnet root replacement', async () => {
  mock.config.local = false;
  mock.config.host = 'https://icp0.io';
  const agent = {
    fetchRootKey: mock.fetchRootKey
  };
  mock.createSync.mockReturnValue(agent);
  mock.createActor.mockReturnValue({});
  const identity = Ed25519KeyIdentity.generate();
  const client = await createPrivateVaultClient(identity),
    second = await createPrivateVaultClient(identity);
  expect(second).not.toBe(client);
  expect(mock.createActor).toHaveBeenCalledWith(idlFactory, {
    agent,
    canisterId: 'aaaaa-aa'
  });
  expect(mock.createSync).toHaveBeenCalledWith({
    host: 'https://icp0.io',
    identity
  });
  expect(mock.fetchRootKey).not.toHaveBeenCalled();
  client.destroy();
  second.destroy();
});
it('uses the explicitly local root only for local config', async () => {
  mock.config.local = true;
  mock.config.host = 'http://127.0.0.1:8024';
  mock.createSync.mockReturnValue({
    fetchRootKey: mock.fetchRootKey
  });
  mock.createActor.mockReturnValue({});
  const c = await createPrivateVaultClient(Ed25519KeyIdentity.generate());
  expect(mock.fetchRootKey).toHaveBeenCalledTimes(1);
  c.destroy();
});
