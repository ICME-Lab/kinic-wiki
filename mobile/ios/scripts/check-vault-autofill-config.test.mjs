import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
const ios = new URL('../', import.meta.url);
const read = name => JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', fileURLToPath(new URL(name, ios))], { encoding: 'utf8' }));
const capability = 'com.apple.developer.authentication-services.autofill-credential-provider';
for (const file of ['KinicApp/Kinic.entitlements', 'KinicApp/KinicDebug.entitlements']) {
  test(`${file} permits credential provision with separate Wiki and Vault keychain access groups`, () => {
    const config = read(file);
    assert.equal(config[capability], true);
    assert.deepEqual(config['com.apple.security.application-groups'], ['$(APP_GROUP_ID)']);
    assert.deepEqual(config['keychain-access-groups'], [
      '$(KINIC_KEYCHAIN_ACCESS_GROUP)',
      '$(KINIC_VAULT_KEYCHAIN_ACCESS_GROUP)',
    ]);
  });
}
test('KinicVaultAutoFill/KinicVaultAutoFill.entitlements is scoped exclusively to the Vault keychain access group', () => {
  const config = read('KinicVaultAutoFill/KinicVaultAutoFill.entitlements');
  assert.equal(config[capability], true);
  assert.deepEqual(config['com.apple.security.application-groups'], ['$(APP_GROUP_ID)']);
  assert.deepEqual(config['keychain-access-groups'], ['$(KINIC_VAULT_KEYCHAIN_ACCESS_GROUP)']);
});
test('KinicShareExtension/KinicShareExtension.entitlements cannot access the Vault keychain group', () => {
  const config = read('KinicShareExtension/KinicShareExtension.entitlements');
  assert.deepEqual(config['keychain-access-groups'], ['$(KINIC_KEYCHAIN_ACCESS_GROUP)']);
  assert.ok(!config['keychain-access-groups'].includes('$(KINIC_VAULT_KEYCHAIN_ACCESS_GROUP)'));
});
for (const file of ['KinicApp/Info.plist', 'KinicVaultAutoFill/Info.plist']) {
  test(`${file} explains Face ID use and declares KINIC_VAULT_KEYCHAIN_ACCESS_GROUP`, () => {
    const plist = read(file);
    assert.ok(plist.NSFaceIDUsageDescription?.trim());
    assert.equal(plist.KINIC_VAULT_KEYCHAIN_ACCESS_GROUP, '$(KINIC_VAULT_KEYCHAIN_ACCESS_GROUP)');
  });
}
test('KinicVaultAutoFill/Info.plist does not expose the Wiki keychain access group', () => {
  const plist = read('KinicVaultAutoFill/Info.plist');
  assert.equal(plist.KINIC_KEYCHAIN_ACCESS_GROUP, undefined);
});
