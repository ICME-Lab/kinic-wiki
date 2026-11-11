import { expect, it, vi, afterEach } from 'vitest';
import { Ed25519KeyIdentity } from '@icp-sdk/core/identity';
const mock = vi.hoisted(() => ({ createActor: vi.fn(), createSync: vi.fn(), fetchRootKey: vi.fn(async () => {}) }));
vi.mock('@icp-sdk/core/agent', () => ({ Actor: { createActor: mock.createActor }, HttpAgent: { createSync: mock.createSync } }));
import { createPrivateVaultClient } from './actor';
import { idlFactory } from '@kinic/vfs-candid';
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });
it('uses the existing II identity, full generated IDL, uncached actor and only active caller-owned payers', async () => {
  vi.stubEnv('VITE_WIKI_IC_HOST', 'https://icp0.io');
  vi.stubEnv('VITE_KINIC_WIKI_CANISTER_ID', 'aaaaa-aa');
  const agent = { fetchRootKey: mock.fetchRootKey };
  mock.createSync.mockReturnValue(agent);
  mock.createActor.mockReturnValue({ list_databases: async () => ({ Ok: [
    { database_id: 'owned', name: 'Owned', role: { Owner: null }, status: { Active: null } },
    { database_id: 'shared', name: 'Shared', role: { Writer: null }, status: { Active: null } },
    { database_id: 'deleted', name: 'Deleted', role: { Owner: null }, status: { Deleted: null } }
  ] }) });
  const identity = Ed25519KeyIdentity.generate();
  const client = await createPrivateVaultClient(identity);
  expect(await client.payerDatabases()).toEqual([{ id: 'owned', name: 'Owned' }]);
  const second = await createPrivateVaultClient(identity);
  expect(second).not.toBe(client); expect(mock.createActor).toHaveBeenCalledTimes(2);
  expect(mock.createSync).toHaveBeenCalledWith({ host: 'https://icp0.io', identity });
  expect(mock.createActor).toHaveBeenCalledWith(idlFactory, { agent, canisterId: 'aaaaa-aa' });
  expect(mock.fetchRootKey).not.toHaveBeenCalled();
  client.destroy(); second.destroy();
});
it('fetches a root key only for the selected local replica', async () => {
  vi.stubEnv('VITE_WIKI_IC_HOST', 'http://127.0.0.1:4943');
  vi.stubEnv('VITE_KINIC_WIKI_CANISTER_ID', 'aaaaa-aa');
  mock.createSync.mockReturnValue({ fetchRootKey: mock.fetchRootKey });
  mock.createActor.mockReturnValue({});
  const client = await createPrivateVaultClient(Ed25519KeyIdentity.generate());
  expect(mock.fetchRootKey).toHaveBeenCalledTimes(1); client.destroy();
});
