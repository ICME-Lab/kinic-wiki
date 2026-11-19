import { readFileSync, appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
export function selectsVault(paths) {
  return paths.some(p => /^(?:package\.json$|pnpm-(?:lock|workspace)\.yaml$|\.npmrc$|tools\/candid\/|patches\/|scripts\/cloudflare\/|crates\/(?:vault_|vfs_|wiki_|kinic_sqlite_compat\/|kinic_cycle_grants\/|credit_bridge_types\/)|crates\/vfs_canister\/vfs\.did$|packages\/|(?:vaultbrowser|wikibrowser)\/|scripts\/.*vault.*|pocketic-tests\/|Cargo\.(?:toml|lock)$|rust-toolchain\.toml$|\.github\/workflows\/ci\.yml$)/.test(p));
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
 const selected = selectsVault(readFileSync(0, 'utf8').split('\n'));
 appendFileSync(process.env.GITHUB_OUTPUT, `vault=${selected}\n`);
}
