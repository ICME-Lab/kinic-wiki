// NONDEPLOYABLE Vault fixture: trap after real cycles acceptance, before SQL commit.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '../..');
const out = resolve(root, 'target/vault-credit-trap');
const dir = resolve(out, 'source');
const target = resolve(out, 'build');
const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const paths = ['Cargo.toml', 'Cargo.lock', 'rust-toolchain.toml', 'crates/vault_canister', 'crates/vault_types', 'crates/vault_store', 'crates/vault_service', 'crates/kinic_sqlite_compat', 'crates/credit_bridge_types', 'crates/kinic_cycle_grants'];
if (execFileSync('git', ['diff', 'HEAD', '--', ...paths], { cwd: root }).length) throw Error('Commit Vault backend before archived fixture build');
rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
const archive = resolve(dir, 'source.tar');
execFileSync('git', ['archive', '--format=tar', '--output', archive, head, ...paths], { cwd: root });
execFileSync('tar', ['-xf', archive, '-C', dir]);
const cargo = resolve(dir, 'Cargo.toml');
writeFileSync(cargo, readFileSync(cargo, 'utf8')
  .replace(/members = \[[\s\S]*?\]/, 'members = ["crates/vault_canister","crates/vault_types","crates/vault_store","crates/vault_service","crates/kinic_sqlite_compat","crates/credit_bridge_types","crates/kinic_cycle_grants"]')
  .replace('ic-agent = { path = "vendor/ic-agent" }', ''));
const file = resolve(dir, 'crates/vault_canister/src/bridge.rs');
const code = readFileSync(file, 'utf8');
const needle = `            "cycles acceptance invariant"
        );
        Ok(result)`;
if (code.split(needle).length !== 2) throw Error('Expected unique receive acceptance point');
writeFileSync(file, code.replace(needle, `            "cycles acceptance invariant"
        );
        // Fixture only: prove the IC rolls back accepted cycles and SQL together.
        if FIXTURE_TRAP_AFTER_ACCEPT.with(|flag| flag.replace(false)) {
            ic_cdk::trap("fixture trap after cycles acceptance");
        }
        Ok(result)`) + `
// Fixture-only controller hook. Not present in a production build.
thread_local! { static FIXTURE_TRAP_AFTER_ACCEPT: std::cell::Cell<bool> = const { std::cell::Cell::new(false) }; }
#[ic_cdk::update]
fn fixture_trap_after_accept() {
    assert!(ic_cdk::api::is_controller(&ic_cdk::api::msg_caller()));
    FIXTURE_TRAP_AFTER_ACCEPT.with(|flag| flag.set(true));
}
`);
const env = { ...process.env, CARGO_TARGET_DIR: target };
for (const name of ['RUSTFLAGS', 'CARGO_ENCODED_RUSTFLAGS', 'VAULT_LOCAL_ORIGIN', 'VAULT_LOCAL_HOST', 'VAULT_LOCAL_II']) delete env[name];
execFileSync('cargo', ['build', '-p', 'vault-canister', '--target', 'wasm32-unknown-unknown', '--release', '--offline'], { cwd: dir, env, stdio: 'inherit' });
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const wasm = resolve(target, 'wasm32-unknown-unknown/release/vault_canister.wasm');
writeFileSync(resolve(out, 'provenance.json'), JSON.stringify({
  deployable: false, source_commit: head, source_archive_sha256: sha(archive),
  injected_file_sha256: sha(file), builder_sha256: sha(import.meta.filename),
  source_lock_sha256: sha(resolve(root, 'Cargo.lock')), fixture_lock_sha256: sha(resolve(dir, 'Cargo.lock')), wasm_sha256: sha(wasm),
  fault: 'Trap after real msg_cycles_accept within the same receiver SQL transaction',
}, null, 2) + '\n');
console.log('Built NONDEPLOYABLE Vault credit trap fixture:', wasm);
