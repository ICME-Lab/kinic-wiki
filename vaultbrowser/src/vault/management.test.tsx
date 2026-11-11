// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { Ed25519KeyIdentity } from '@icp-sdk/core/identity';
import { VaultClient } from '@kinic/vault-client';
import type { Header, VaultActor } from '@kinic/vault-client/contracts';
import { VaultBackups, VaultEncryptedCleanup } from './management';
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const header: Header = {
        generation: [], recovery_verifier: [], id: new Uint8Array(16), epoch: 0n, sequence: 0n, state: { Active: null }, key_name: 'test_key_1', normal: [], recovery: [], backup_sequence: [], backup_at: [] };
const run = (f: () => Promise<void>) => { void f(); };
it('offers owner-authenticated ciphertext purge while locked without a payer or root key', async () => {
  const object = new Uint8Array(16).fill(3);
  const list_objects = vi.fn(async () => ({ Ok: { entries: [{ object, deleted: false }], next: [] } }));
  const purge_object = vi.fn(async () => ({ Ok: null }));
  const client = new VaultClient({ actor: { list_objects, purge_object } as unknown as VaultActor, identity: Ed25519KeyIdentity.generate(), canister: 'aaaaa-aa', local: true });
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  const onChanged = vi.fn(async () => {});
  render(<VaultEncryptedCleanup client={client} selected={header} disabled={false} run={run} onChanged={onChanged} />);
  fireEvent.click(screen.getByText('Encrypted storage cleanup', { selector: 'summary' }));
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'List encrypted object IDs' })); });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^Purge object/ })); });
  expect(purge_object).toHaveBeenCalledWith(header.id, object);
  expect(client.session.root).toBeUndefined();
  expect(onChanged).toHaveBeenCalled();
});
it('clears locked recovery input immediately and exports through the recovery path only', async () => {
  const client = new VaultClient();
  const backup = vi.spyOn(client, 'backup').mockRejectedValue(Error('Unexpected'));
  const recovery = vi.spyOn(client, 'backupWithRecovery').mockResolvedValue({ exportId: new Uint8Array(16), data: new Uint8Array([1]) });
  vi.spyOn(client.session, 'download').mockImplementation(() => {});
  render(<VaultBackups client={client} selected={header} unlocked={false} disabled={false} run={run} onChanged={async () => {}} />);
  fireEvent.change(screen.getByLabelText('Export recovery secret'), { target: { value: 'synthetic-recovery-secret' } });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Download encrypted backup' })); });
  expect(screen.getByLabelText('Export recovery secret')).toHaveProperty('value', '');
  expect(recovery).toHaveBeenCalledWith(header, 'synthetic-recovery-secret');
  expect(backup).not.toHaveBeenCalled();
});
