import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const did = `${root}crates/vault_canister/vault.did`;
const ts = execFileSync('didc', ['bind', did, '--target', 'ts'], {
  encoding: 'utf8'
}).replaceAll('@dfinity/agent', '@icp-sdk/core/agent').replaceAll('@dfinity/principal', '@icp-sdk/core/principal').replaceAll('@dfinity/candid', '@icp-sdk/core/candid');
const js = execFileSync('didc', ['bind', did, '--target', 'js'], {
  encoding: 'utf8'
});
const outputs = {
  'packages/vault-client/src/contracts.ts': '// Shared declarations generated from dedicated vault.did.\nexport type * from "@kinic/vault-candid";\nexport type { _SERVICE as VaultActor } from "@kinic/vault-candid";\n',
  'packages/vault-candid/index.js': js,
  'packages/vault-candid/index.d.ts': ts
};
for (const [path, text] of Object.entries(outputs)) {
  if (process.argv.includes('--check')) {
    if (readFileSync(root + path, 'utf8') !== text) throw Error(`Candid drift: ${path}`);
  } else writeFileSync(root + path, text);
}
console.log('Dedicated Vault Candid contracts match');
