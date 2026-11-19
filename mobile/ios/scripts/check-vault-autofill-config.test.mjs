import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
const ios = new URL('../', import.meta.url);
const read = name => JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', fileURLToPath(new URL(name, ios))], { encoding: 'utf8' }));
const capability = 'com.apple.developer.authentication-services.autofill-credential-provider';
for (const file of ['KinicApp/Kinic.entitlements', 'KinicApp/KinicDebug.entitlements', 'KinicVaultAutoFill/KinicVaultAutoFill.entitlements']) {
  test(`${file} permits credential provision with the existing shared storage groups`, () => {
    const config = read(file);
    assert.equal(config[capability], true);
    assert.deepEqual(config['com.apple.security.application-groups'], ['$(APP_GROUP_ID)']);
    assert.deepEqual(config['keychain-access-groups'], ['$(KINIC_KEYCHAIN_ACCESS_GROUP)']);
  });
}
for (const file of ['KinicApp/Info.plist', 'KinicVaultAutoFill/Info.plist']) {
  test(`${file} explains Face ID use`, () => {
    assert.ok(read(file).NSFaceIDUsageDescription?.trim());
  });
}
