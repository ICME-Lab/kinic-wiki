// NONDEPLOYABLE source-injected fixture. The real peer accepts cycles first;
// this source drops its one post-await reply so manual reconciliation is tested.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '../..');
const out = resolve(root, 'target/wiki-credit-fault');
const sourceDir = resolve(out, 'source');
const targetDir = resolve(out, 'build');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const head = git('rev-parse', 'HEAD');
const relevant = ['Cargo.toml', 'Cargo.lock', 'crates/vfs_canister', 'crates/vfs_runtime', 'crates/credit_bridge_types', 'crates/kinic_cycle_grants'];
if (git('diff', 'HEAD', '--', ...relevant)) throw Error('Commit current Wiki backend changes before archived fixture build');
rmSync(sourceDir, { recursive: true, force: true });
mkdirSync(sourceDir, { recursive: true });
const archive = resolve(sourceDir, 'source.tar');
execFileSync('git', ['archive', '--format=tar', '--output', archive, head], { cwd: root });
execFileSync('tar', ['-xf', archive, '-C', sourceDir]);
const file = resolve(sourceDir, 'crates/vfs_canister/src/credit_bridge.rs');
const code = readFileSync(file, 'utf8');
const needle = '        match call.await {';
if (code.split(needle).length !== 2) throw Error('Expected exactly one physical receive await');
const ackNeedle = `        ic_cdk::call::Call::bounded_wait(peer, method)
            .change_timeout(30)
            .with_raw_args(&bytes)
            .await
            .map_err(|_| BridgeError::Unavailable)?
            .candid::<BridgeResult<T>>()`;
if (code.split(ackNeedle).length !== 2) throw Error('Expected unique peer call await');
const statusNeedle = `    let receipt: CreditReceipt =
        peer_call(context.peer, "wiki_credit_status", (context.offer.clone(),)).await?;`;
if (code.split(statusNeedle).length !== 2) throw Error('Expected unique pre-dispatch status await');
const statusReplacement = `${statusNeedle}
    // Fixture-only interleaving after a real peer await, before dispatch.
    if FIXTURE_DISABLE_AFTER_STATUS.with(|flag| flag.replace(false)) {
        let old = bridge(|s| s.vault_bridge_config())?.ok_or(BridgeError::Disabled)?;
        bridge(|s| s.configure_vault_bridge(BridgeConfig { enabled: false, ..old }))?;
    }
    if FIXTURE_CONFIG_ABA_AFTER_STATUS.with(|flag| flag.replace(false)) {
        let old = bridge(|s| s.vault_bridge_config())?.ok_or(BridgeError::Disabled)?;
        bridge(|s| s.configure_vault_bridge(BridgeConfig { enabled: false, ..old.clone() }))?;
        bridge(|s| s.configure_vault_bridge(old))?;
    }
    if let Some(next) = FIXTURE_CHANGE_OWNER_AFTER_STATUS.with(|slot| slot.borrow_mut().take()) {
        let database = bridge(|s| s.get_vault_transfer(p, &operation, bridge_now()))?.database_id;
        bridge(|s| s.grant_database_access(&database, &p.to_text(), &next.to_text(), DatabaseRole::Owner, now_millis()))?;
        bridge(|s| s.grant_database_access(&database, &next.to_text(), &p.to_text(), DatabaseRole::Writer, now_millis()))?;
    }`;
const ackReplacement = `        let response = ic_cdk::call::Call::bounded_wait(peer, method)
            .change_timeout(30)
            .with_raw_args(&bytes)
            .await
            .map_err(|_| BridgeError::Unavailable)?;
        if method == "acknowledge_wiki_credit" && FIXTURE_DROP_ACK.with(|flag| flag.replace(false)) {
            return Err(BridgeError::Unavailable);
        }
        response.candid::<BridgeResult<T>>()`;
const replacement = `        let response = call.await;
        // Fixture-only fault: the peer has executed, but this caller has no reply.
        if FIXTURE_DROP_RECEIVE.with(|flag| flag.replace(false)) {
            return Err(BridgeError::Unavailable);
        }
        match response {`;
writeFileSync(file, code.replace(ackNeedle, ackReplacement).replace(needle, replacement).replace(statusNeedle, statusReplacement) + `
// Fixture-only controller hook. This archived source is never deployable.
thread_local! { static FIXTURE_DROP_RECEIVE: std::cell::Cell<bool> = const { std::cell::Cell::new(false) }; }
thread_local! { static FIXTURE_DROP_ACK: std::cell::Cell<bool> = const { std::cell::Cell::new(false) }; }
thread_local! { static FIXTURE_DISABLE_AFTER_STATUS: std::cell::Cell<bool> = const { std::cell::Cell::new(false) }; }
thread_local! { static FIXTURE_CONFIG_ABA_AFTER_STATUS: std::cell::Cell<bool> = const { std::cell::Cell::new(false) }; }
thread_local! { static FIXTURE_CHANGE_OWNER_AFTER_STATUS: std::cell::RefCell<Option<Principal>> = const { std::cell::RefCell::new(None) }; }
#[ic_cdk::update]
fn fixture_drop_receive_reply() {
    assert!(ic_cdk::api::is_controller(&ic_cdk::api::msg_caller()));
    FIXTURE_DROP_RECEIVE.with(|flag| flag.set(true));
}
#[ic_cdk::update]
fn fixture_drop_credit_ack_reply() {
    assert!(ic_cdk::api::is_controller(&ic_cdk::api::msg_caller()));
    FIXTURE_DROP_ACK.with(|flag| flag.set(true));
}
#[ic_cdk::update]
fn fixture_disable_bridge_after_status() {
    assert!(ic_cdk::api::is_controller(&ic_cdk::api::msg_caller()));
    FIXTURE_DISABLE_AFTER_STATUS.with(|flag| flag.set(true));
}
#[ic_cdk::update]
fn fixture_config_aba_after_status() {
    assert!(ic_cdk::api::is_controller(&ic_cdk::api::msg_caller()));
    FIXTURE_CONFIG_ABA_AFTER_STATUS.with(|flag| flag.set(true));
}
#[ic_cdk::update]
fn fixture_change_owner_after_status(next: Principal) {
    assert!(ic_cdk::api::is_controller(&ic_cdk::api::msg_caller()));
    FIXTURE_CHANGE_OWNER_AFTER_STATUS.with(|slot| *slot.borrow_mut() = Some(next));
}
`);
const env = { ...process.env, CARGO_TARGET_DIR: targetDir };
for (const name of ['RUSTFLAGS', 'CARGO_ENCODED_RUSTFLAGS', 'VAULT_LOCAL_ORIGIN', 'VAULT_LOCAL_HOST', 'VAULT_LOCAL_II']) delete env[name];
execFileSync('cargo', ['build', '-p', 'vfs-canister', '--target', 'wasm32-unknown-unknown', '--release', '--offline', '--locked'], { cwd: sourceDir, env, stdio: 'inherit' });
const sha = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const wasm = resolve(targetDir, 'wasm32-unknown-unknown/release/vfs_canister.wasm');
writeFileSync(resolve(out, 'provenance.json'), JSON.stringify({
  deployable: false, source_commit: head, source_archive_sha256: sha(archive),
  injected_file_sha256: sha(file), builder_sha256: sha(import.meta.filename),
  lock_sha256: sha(resolve(sourceDir, 'Cargo.lock')), wasm_sha256: sha(wasm),
  faults: ['Discard actual receive reply after peer await', 'Discard actual terminal ACK reply after peer await', 'Disable source config after actual status peer await, before physical dispatch', 'Toggle source config off/on after actual status peer await, before physical dispatch', 'Change database Owner after actual status peer await, before physical dispatch'],
}, null, 2) + '\n');
console.log('Built NONDEPLOYABLE Wiki credit fault fixture:', wasm);
