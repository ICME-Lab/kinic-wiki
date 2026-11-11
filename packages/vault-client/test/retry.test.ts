import { expect, it, vi } from 'vitest';
import { Ed25519KeyIdentity } from '@icp-sdk/core/identity';
import { VaultClient } from '../src/api';
import type { Header, VaultActor } from '../src/contracts';
import { importKey } from '../../vault-crypto/src/index';
const header: Header = {
  published_slot: [], generation: [], recovery_verifier: [], id: new Uint8Array(16), epoch: 0n, sequence: 0n, key_name: 'test_key_1', state: { Active: null }, normal: [], recovery: [], backup_at: [], backup_sequence: [] };
it('retries the same encrypted revision and chunk operation after transport loss', async () => {
  const begin_revision = vi.fn().mockRejectedValueOnce(Error('transport')).mockResolvedValue({ Ok: { id: new Uint8Array(16), expires: 0n, revision: 1n } });
  const put_chunk = vi.fn().mockRejectedValueOnce(Error('transport')).mockResolvedValue({ Ok: null });
  const commit_revision = vi.fn().mockRejectedValueOnce(Error('transport')).mockResolvedValue({ Ok: { revision: 1n } });
  const client = new VaultClient({ actor: { begin_revision, put_chunk, commit_revision, get_vault_header: async () => ({ Ok: header }) } as unknown as VaultActor, identity: Ed25519KeyIdentity.generate(), canister: 'aaaaa-aa', local: true });
  client.header = header; client.session.root = await importKey(new Uint8Array(32));
  await client.save({ kind: 'note', title: 'Synthetic' }, new TextEncoder().encode('synthetic'), undefined, () => {});
  expect(begin_revision).toHaveBeenCalledTimes(2); expect(begin_revision.mock.calls[0]).toEqual(begin_revision.mock.calls[1]);
  expect(put_chunk).toHaveBeenCalledTimes(2); expect(put_chunk.mock.calls[0]).toEqual(put_chunk.mock.calls[1]);
  expect(commit_revision).toHaveBeenCalledTimes(2); expect(commit_revision.mock.calls[0]).toEqual(commit_revision.mock.calls[1]);
});
it('never retries an interrupted upload after a lock', async () => {
  let reject!: (cause: Error) => void;
  const begin_revision = vi.fn(() => new Promise((_resolve, r) => { reject = r; }));
  const client = new VaultClient({ actor: { begin_revision } as unknown as VaultActor, identity: Ed25519KeyIdentity.generate(), canister: 'aaaaa-aa', local: true });
  client.header = header; client.session.root = await importKey(new Uint8Array(32));
  const pending = client.save({ kind: 'note', title: 'Synthetic' }, new Uint8Array([1]), undefined, () => {});
  await vi.waitFor(() => expect(begin_revision).toHaveBeenCalled());
  client.session.lock(); reject(Error('transport'));
  await expect(pending).rejects.toThrow('Locked'); expect(begin_revision).toHaveBeenCalledTimes(1);
});
