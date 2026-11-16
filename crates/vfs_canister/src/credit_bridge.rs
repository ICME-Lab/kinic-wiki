//! Fixed-peer transport. No service borrow or SQLite transaction crosses an await.
use super::*;
use candid::utils::ArgumentEncoder;
use credit_bridge_types::*;
use serde::de::DeserializeOwned;
use vfs_runtime::credit_bridge::{
    Dispatch, TransferAmount, TransferApproval, TransferPhase, VaultTransfer,
};

fn bridge_now() -> u64 {
    #[cfg(test)]
    if let Some(now) = TEST_BRIDGE_NOW.with(|slot| slot.get()) {
        return now;
    }
    now_nanos()
}
#[cfg(test)]
thread_local! {
    static TEST_PEER_CALLS: RefCell<Vec<&'static str>> = const {RefCell::new(Vec::new())};
    static TEST_BRIDGE_NOW: std::cell::Cell<Option<u64>> = const { std::cell::Cell::new(None) };
    static TEST_PEER_REPLIES: RefCell<std::collections::VecDeque<TestPeerReply>> = const { RefCell::new(std::collections::VecDeque::new()) };
}
#[cfg(test)]
struct TestPeerReply {
    method: &'static str,
    args: Vec<u8>,
    result: Result<Vec<u8>, BridgeError>,
    callback: Option<Box<dyn FnOnce()>>,
}
fn bridge<T>(f: impl FnOnce(&VfsService) -> Result<T, String>) -> BridgeResult<T> {
    with_service(f).map_err(|e| match e.rsplit(": ").next().unwrap_or(&e) {
        "Unauthorized" => BridgeError::Unauthorized,
        "Disabled" => BridgeError::Disabled,
        "InvalidInput" => BridgeError::InvalidInput,
        "NotFound" => BridgeError::NotFound,
        "Conflict" => BridgeError::Conflict,
        "Expired" => BridgeError::Expired,
        "Capacity" => BridgeError::Capacity,
        _ => BridgeError::Storage,
    })
}
fn caller() -> BridgeResult<Principal> {
    let p = Principal::from_text(caller_text()).map_err(|_| BridgeError::Unauthorized)?;
    if p == Principal::anonymous() {
        Err(BridgeError::Unauthorized)
    } else {
        Ok(p)
    }
}
fn valid_id(id: &[u8]) -> BridgeResult<()> {
    if id.len() == 16 {
        Ok(())
    } else {
        Err(BridgeError::InvalidInput)
    }
}
#[query]
fn vault_bridge_config() -> BridgeResult<Option<BridgeConfig>> {
    bridge(|s| s.vault_bridge_config())
}
#[update]
fn set_vault_bridge_config(config: BridgeConfig) -> BridgeResult<()> {
    require_controller_caller().map_err(|_| BridgeError::Unauthorized)?;
    bridge(|s| s.configure_vault_bridge(config))
}
#[update]
async fn preview_vault_link(challenge: Vec<u8>) -> BridgeResult<LinkChallenge> {
    valid_id(&challenge)?;
    let p = caller()?;
    let snapshot = bridge(|s| s.vault_link_snapshot(p, bridge_now()))?;
    let result = async {
        let preview: LinkChallenge = peer_call(
            snapshot.config.peer,
            "inspect_wiki_link",
            (challenge.clone(),),
        )
        .await?;
        bridge(|s| s.validate_vault_link_snapshot(p, &snapshot, bridge_now()))?;
        if preview.challenge != challenge || preview.expires_at_ns <= bridge_now() {
            return Err(BridgeError::Conflict);
        }
        Ok(preview)
    }
    .await;
    bridge(|s| s.release_vault_link_snapshot(p, &snapshot))?;
    result
}
#[update]
async fn approve_vault_link(challenge: Vec<u8>) -> BridgeResult<LinkStatus> {
    valid_id(&challenge)?;
    let p = caller()?;
    let snapshot = bridge(|s| s.vault_link_snapshot(p, bridge_now()))?;
    let result = async {
        let preview = match bridge(|s| s.vault_link_recovery(p, &challenge))? {
            Some(ch) => ch,
            None => {
                peer_call(
                    snapshot.config.peer,
                    "inspect_wiki_link",
                    (challenge.clone(),),
                )
                .await?
            }
        };
        if preview.challenge != challenge {
            return Err(BridgeError::Conflict);
        }
        let expected = bridge(|s| s.vault_link_begin(p, preview, &snapshot, bridge_now()))?;
        let proof: LinkProof =
            peer_call(snapshot.config.peer, "consume_wiki_link", (challenge, p)).await?;
        if proof != expected {
            return Err(BridgeError::Conflict);
        }
        bridge(|s| s.validate_vault_link_proof(&proof, &snapshot))?;
        peer_call::<(), _>(
            snapshot.config.peer,
            "acknowledge_wiki_link",
            (proof.clone(),),
        )
        .await?;
        bridge(|s| s.vault_link_finish(&proof, &snapshot))
    }
    .await;
    bridge(|s| s.release_vault_link_snapshot(p, &snapshot))?;
    result
}
#[query]
fn get_vault_link() -> BridgeResult<Option<LinkStatus>> {
    let p = caller()?;
    bridge(|s| s.get_vault_link(p))
}
#[update]
fn revoke_vault_link() -> BridgeResult<()> {
    let p = caller()?;
    bridge(|s| s.revoke_vault_link(p))
}
#[update]
fn bridge_link_status(vault_owner: Principal) -> BridgeResult<Option<LinkStatus>> {
    let p = caller()?;
    bridge(|s| s.bridge_link_status(p, vault_owner))
}
#[update]
fn revoke_link_from_vault(revocation: BridgeRevocation) -> BridgeResult<()> {
    let p = caller()?;
    bridge(|s| s.revoke_link_from_vault(p, revocation, bridge_now()))
}
#[update]
fn bridge_credit_offer(operation: Vec<u8>, vault_owner: Principal) -> BridgeResult<CreditOffer> {
    let p = caller()?;
    bridge(|s| s.bridge_credit_offer(p, &operation, vault_owner, bridge_now()))
}
#[update]
fn quote_vault_transfer(
    database_id: String,
    amount: TransferAmount,
    operation: Vec<u8>,
) -> BridgeResult<VaultTransfer> {
    let p = caller()?;
    bridge(|s| {
        s.quote_vault_transfer(
            p,
            &database_id,
            amount,
            operation,
            bridge_now(),
            (UPDATE_EXECUTION_BASE_CYCLES + UPDATE_ACCOUNTING_OVERHEAD_CYCLES) as u64,
        )
    })
}
#[update]
async fn execute_vault_transfer(
    operation: Vec<u8>,
    approval: TransferApproval,
) -> BridgeResult<VaultTransfer> {
    let p = caller()?;
    let before = update_charge_units();
    bridge(|s| s.validate_vault_transfer_approval(p, &operation, &approval))?;
    let initial = bridge(|s| s.get_vault_transfer(p, &operation, bridge_now()))?;
    if initial.phase == TransferPhase::Quoted {
        let charged_through = update_charge_units();
        let charge =
            update_charge_cycles(before, charged_through).map_err(|_| BridgeError::Storage)?;
        // First execution only holds and publishes. Vault must authenticate independently
        // and prepare that immutable offer before the caller executes again.
        let held =
            bridge(|s| s.confirm_vault_transfer(p, &operation, approval, charge, bridge_now()))?;
        if held.phase != TransferPhase::Offered {
            return Ok(held);
        }
        let remaining = update_charge_units()
            .checked_sub(charged_through)
            .unwrap_or_else(|| ic_cdk::trap("instruction counter decreased"));
        // Same cap-at-available accounting as ordinary updates. The amount is already
        // held; All may collect zero here. No second base fee or debit is introduced.
        return Ok(bridge(|s| {
            s.collect_vault_execution_fee(p, &operation, remaining, bridge_now())
        })
        .unwrap_or_else(|e| ic_cdk::trap(format!("bridge accounting failed: {e:?}"))));
    }
    if initial.phase != TransferPhase::Offered {
        return reconcile(p, &operation).await;
    }
    bridge(|s| s.confirm_vault_transfer(p, &operation, approval, 0, bridge_now()))?;
    let context = bridge(|s| s.vault_transfer_dispatch_context(p, &operation))?;
    let receipt: CreditReceipt =
        peer_call(context.peer, "wiki_credit_status", (context.offer.clone(),)).await?;
    if receipt.offer != context.offer {
        return Err(BridgeError::Conflict);
    }
    if receipt.status != CreditStatus::Prepared {
        bridge(|s| s.settle_vault_receipt(&context, &receipt, bridge_now()))?;
        return reconcile(p, &operation).await;
    }
    dispatch(p, context, receipt).await?;
    reconcile(p, &operation).await
}
#[update]
fn get_pending_vault_transfer(database_id: Option<String>) -> BridgeResult<Option<VaultTransfer>> {
    let p = caller()?;
    bridge(|s| s.pending_vault_transfer(p, database_id.as_deref(), bridge_now()))
}
#[update]
fn get_vault_transfer(operation: Vec<u8>) -> BridgeResult<VaultTransfer> {
    let p = caller()?;
    bridge(|s| s.get_vault_transfer(p, &operation, bridge_now()))
}
#[update]
async fn cancel_vault_transfer(operation: Vec<u8>) -> BridgeResult<VaultTransfer> {
    let p = caller()?;
    bridge(|s| s.cancel_vault_transfer(p, &operation, bridge_now()))?;
    reconcile(p, &operation).await
}
#[update]
async fn reconcile_vault_transfer(operation: Vec<u8>) -> BridgeResult<VaultTransfer> {
    reconcile(caller()?, &operation).await
}
async fn reconcile(p: Principal, op: &[u8]) -> BridgeResult<VaultTransfer> {
    let view = bridge(|s| s.get_vault_transfer(p, op, bridge_now()))?;
    if view.phase == TransferPhase::Quoted
        || (view.phase == TransferPhase::Refunded && !view.receiver_cleanup_pending)
        || (view.phase == TransferPhase::Paid && !view.receiver_cleanup_pending)
    {
        return Ok(view);
    }
    let d = bridge(|s| s.vault_transfer_dispatch_context(p, op))?;
    match peer_call::<CreditReceipt, _>(d.peer, "wiki_credit_status", (d.offer.clone(),)).await {
        Ok(receipt) if receipt.offer == d.offer => {
            let settled = bridge(|s| s.settle_vault_receipt(&d, &receipt, bridge_now()))?;
            if settled.receiver_cleanup_pending && receipt.status != CreditStatus::Prepared {
                if peer_call::<(), _>(d.peer, "acknowledge_wiki_credit", (d.offer.clone(),))
                    .await
                    .is_ok()
                {
                    bridge(|s| s.finish_vault_cleanup(&d, bridge_now(), false))?;
                }
            }
        }
        Err(BridgeError::NotFound | BridgeError::Conflict)
            if matches!(view.phase, TransferPhase::Paid | TransferPhase::Refunded)
                && bridge_now() >= view.offer.expires_at_ns =>
        {
            bridge(|s| s.finish_vault_cleanup(&d, bridge_now(), true))?;
        }
        // A timeout, decode failure, reject or absent receipt is never refund evidence.
        _ => {}
    }
    bridge(|s| s.get_vault_transfer(p, op, bridge_now()))
}
async fn peer_call<T, A>(peer: Principal, method: &'static str, args: A) -> BridgeResult<T>
where
    T: CandidType + DeserializeOwned,
    A: ArgumentEncoder,
{
    #[cfg(target_arch = "wasm32")]
    {
        let bytes = candid::encode_args(args).map_err(|_| BridgeError::InvalidInput)?;
        ic_cdk::call::Call::bounded_wait(peer, method)
            .change_timeout(30)
            .with_raw_args(&bytes)
            .await
            .map_err(|_| BridgeError::Unavailable)?
            .candid::<BridgeResult<T>>()
            .map_err(|_| BridgeError::Unavailable)?
    }
    #[cfg(test)]
    {
        TEST_PEER_CALLS.with(|slot| slot.borrow_mut().push(method));
        let reply = TEST_PEER_REPLIES.with(|slot| slot.borrow_mut().pop_front());
        let Some(reply) = reply else {
            return Err(BridgeError::Unavailable);
        };
        assert_eq!(peer, Principal::from_slice(&[9]));
        assert_eq!(method, reply.method);
        assert_eq!(candid::encode_args(args).unwrap(), reply.args);
        if let Some(callback) = reply.callback {
            callback();
        }
        candid::decode_one::<BridgeResult<T>>(&reply.result?)
            .map_err(|_| BridgeError::Unavailable)?
    }
    #[cfg(all(not(target_arch = "wasm32"), not(test)))]
    {
        let _ = (peer, method, args);
        Err(BridgeError::Unavailable)
    }
}
async fn dispatch(p: Principal, context: Dispatch, receipt: CreditReceipt) -> BridgeResult<()> {
    #[cfg(target_arch = "wasm32")]
    {
        let bytes =
            candid::encode_args((context.offer.clone(),)).map_err(|_| BridgeError::InvalidInput)?;
        let call = ic_cdk::call::Call::bounded_wait(context.peer, "receive_wiki_credit")
            .change_timeout(30)
            .with_raw_args(&bytes)
            .with_cycles(u128::from(context.offer.amount_cycles));
        let cost = call.get_cost();
        let liquid = ic_cdk::api::canister_liquid_cycle_balance();
        // Final role/link/config/receipt/daily/physical checks, durable dispatch fence,
        // and actual call submission happen in this same message without another await.
        let d =
            bridge(|s| s.begin_vault_dispatch(p, &context, &receipt, liquid, cost, bridge_now()))?;
        match call.await {
            Ok(response) => {
                if let Ok(Ok(receipt)) = response.candid::<BridgeResult<CreditReceipt>>() {
                    bridge(|s| s.settle_vault_receipt(&d, &receipt, bridge_now()))?;
                }
            }
            Err(_) => {} // remains Unknown; only authoritative status can release the hold
        }
        Ok(())
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        let _ = (p, context, receipt);
        Err(BridgeError::Unavailable)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        future::Future,
        task::{Context, Poll, Waker},
    };
    fn p(n: u8) -> Principal {
        Principal::from_slice(&[n])
    }
    fn run<F: Future>(f: F) -> F::Output {
        let mut f = std::pin::pin!(f);
        match f.as_mut().poll(&mut Context::from_waker(Waker::noop())) {
            Poll::Ready(v) => v,
            Poll::Pending => panic!("native test must not issue a real intercanister call"),
        }
    }
    fn setup() -> (tempfile::TempDir, String) {
        TEST_BRIDGE_NOW.with(|slot| slot.set(None));
        TEST_PEER_CALLS.with(|slot| slot.borrow_mut().clear());
        TEST_PEER_REPLIES.with(|slot| slot.borrow_mut().clear());
        let root = tempfile::tempdir().unwrap();
        let service = VfsService::new(root.path().join("index.sqlite3"), root.path().join("db"));
        service.run_index_migrations().unwrap();
        let db = service
            .create_generated_database_with_initial_free_grant_or_pending(
                "bridge",
                &p(1).to_text(),
                now_millis(),
            )
            .unwrap()
            .meta
            .database_id;
        service
            .configure_vault_bridge(BridgeConfig {
                peer: p(9),
                enabled: true,
                daily_limit_cycles: i64::MAX as u64,
                physical_reserve_cycles: 1_000_000,
            })
            .unwrap();
        let snap = service.vault_link_snapshot(p(1), bridge_now()).unwrap();
        let proof = service
            .vault_link_begin(
                p(1),
                LinkChallenge {
                    challenge: vec![1; 16],
                    vault_owner: p(2),
                    generation: 1,
                    expires_at_ns: bridge_now() + 300_000_000_000,
                },
                &snap,
                bridge_now(),
            )
            .unwrap();
        service.vault_link_finish(&proof, &snap).unwrap();
        SERVICE.with(|slot| slot.replace(Some(service)));
        set_test_caller_principal_for_test(p(1));
        (root, db)
    }
    #[test]
    fn first_execution_holds_all_with_existing_capped_execution_fee() {
        let (_root, db) = setup();
        let q = quote_vault_transfer(db, TransferAmount::All, vec![4; 16]).unwrap();
        set_update_charge_units_for_test(vec![100, 200, 300]);
        let held = run(execute_vault_transfer(
            vec![4; 16],
            TransferApproval::AllAvailable,
        ))
        .unwrap();
        assert_eq!(held.phase, TransferPhase::Offered);
        assert_eq!(held.collected_execution_fee_cycles, 20_000_100);
        assert_eq!(held.offer.amount_cycles, q.offer.amount_cycles - 20_000_100);
        set_update_charge_units_for_test(vec![400]);
        assert_eq!(
            run(execute_vault_transfer(
                vec![4; 16],
                TransferApproval::AllAvailable
            )),
            Err(BridgeError::Unavailable)
        );
        assert_eq!(get_vault_transfer(vec![4; 16]).unwrap(), held);
    }
    #[test]
    fn partial_transfer_collects_actual_instruction_delta_without_second_base_fee() {
        let (_root, db) = setup();
        quote_vault_transfer(db, TransferAmount::Exact(100), vec![4; 16]).unwrap();
        set_update_charge_units_for_test(vec![100, 200, 300]);
        let held = run(execute_vault_transfer(
            vec![4; 16],
            TransferApproval::Exact(100),
        ))
        .unwrap();
        assert_eq!(held.collected_execution_fee_cycles, 20_000_200);
        assert_eq!(held.offer.amount_cycles, 100);
    }
    #[test]
    fn bridge_entrypoints_authenticate_user_peer_and_controller_independently() {
        let (_root, db) = setup();
        assert_eq!(
            set_vault_bridge_config(BridgeConfig {
                peer: p(9),
                enabled: true,
                daily_limit_cycles: 1,
                physical_reserve_cycles: 1
            }),
            Err(BridgeError::Unauthorized)
        );
        assert_eq!(bridge_link_status(p(2)), Err(BridgeError::Unauthorized));
        set_test_caller_principal_for_test(p(9));
        assert_eq!(bridge_link_status(p(2)).unwrap().unwrap().wiki_owner, p(1));
        set_test_caller_principal_for_test(Principal::anonymous());
        assert_eq!(
            quote_vault_transfer(db, TransferAmount::All, vec![4; 16]),
            Err(BridgeError::Unauthorized)
        );
        assert_eq!(
            get_pending_vault_transfer(None),
            Err(BridgeError::Unauthorized)
        );
    }
    #[test]
    fn failed_public_previews_do_not_permanently_exhaust_new_owner_admission() {
        let (_root, _db) = setup();
        for n in 0..1023u32 {
            set_test_caller_principal_for_test(Principal::from_slice(&(n + 1000).to_be_bytes()));
            reply::<LinkChallenge, _>(
                "inspect_wiki_link",
                (vec![9u8; 16],),
                Err(BridgeError::NotFound),
            );
            assert_eq!(
                run(preview_vault_link(vec![9; 16])),
                Err(BridgeError::NotFound)
            );
        }
        let fresh = p(20);
        let snap = with_service(|s| s.vault_link_snapshot(fresh, bridge_now())).unwrap();
        let proof = with_service(|s| {
            s.vault_link_begin(
                fresh,
                LinkChallenge {
                    challenge: vec![8; 16],
                    vault_owner: p(21),
                    generation: 2,
                    expires_at_ns: bridge_now() + 300_000_000_000,
                },
                &snap,
                bridge_now(),
            )
        })
        .unwrap();
        assert!(
            with_service(|s| s.vault_link_finish(&proof, &snap))
                .unwrap()
                .active
        );
    }
    #[test]
    fn execute_rejects_changed_approval_in_every_phase() {
        for phase in [
            TransferPhase::Offered,
            TransferPhase::Unknown,
            TransferPhase::Paid,
            TransferPhase::Refunded,
        ] {
            let (_root, db) = setup();
            quote_vault_transfer(db, TransferAmount::Exact(500), vec![4; 16]).unwrap();
            set_update_charge_units_for_test(vec![0, 0, 0]);
            run(execute_vault_transfer(
                vec![4; 16],
                TransferApproval::Exact(500),
            ))
            .unwrap();
            if phase != TransferPhase::Offered {
                let d =
                    with_service(|s| s.vault_transfer_dispatch_context(p(1), &[4; 16])).unwrap();
                let d = with_service(|s| {
                    s.begin_vault_dispatch(
                        p(1),
                        &d,
                        &CreditReceipt {
                            offer: d.offer.clone(),
                            status: CreditStatus::Prepared,
                        },
                        u128::MAX,
                        600,
                        bridge_now(),
                    )
                })
                .unwrap();
                if phase != TransferPhase::Unknown {
                    with_service(|s| {
                        s.settle_vault_receipt(
                            &d,
                            &CreditReceipt {
                                offer: d.offer.clone(),
                                status: if phase == TransferPhase::Paid {
                                    CreditStatus::Accepted
                                } else {
                                    CreditStatus::NotAccepted
                                },
                            },
                            bridge_now(),
                        )
                    })
                    .unwrap();
                }
            }
            for wrong in [TransferApproval::Exact(501), TransferApproval::AllAvailable] {
                assert_eq!(
                    run(execute_vault_transfer(vec![4; 16], wrong)),
                    Err(BridgeError::Conflict),
                    "{phase:?}"
                );
            }
        }
    }
    fn reply<T: CandidType, A: ArgumentEncoder>(
        method: &'static str,
        args: A,
        value: BridgeResult<T>,
    ) {
        TEST_PEER_REPLIES.with(|slot| {
            slot.borrow_mut().push_back(TestPeerReply {
                method,
                args: candid::encode_args(args).unwrap(),
                result: Ok(candid::encode_one(value).unwrap()),
                callback: None,
            })
        });
    }
    fn dispatch_for_test() -> Dispatch {
        let d = with_service(|s| s.vault_transfer_dispatch_context(p(1), &[4; 16])).unwrap();
        with_service(|s| {
            s.begin_vault_dispatch(
                p(1),
                &d,
                &CreditReceipt {
                    offer: d.offer.clone(),
                    status: CreditStatus::Prepared,
                },
                u128::MAX,
                u128::from(d.offer.amount_cycles) + 100,
                bridge_now(),
            )
        })
        .unwrap()
    }
    #[test]
    fn reconcile_recovers_lost_ack_after_receiver_gc_or_key_reuse() {
        for status in [CreditStatus::Accepted, CreditStatus::NotAccepted] {
            for absent in [BridgeError::NotFound, BridgeError::Conflict] {
                let (_root, db) = setup();
                quote_vault_transfer(db.clone(), TransferAmount::Exact(500), vec![4; 16]).unwrap();
                set_update_charge_units_for_test(vec![0, 0, 0]);
                run(execute_vault_transfer(
                    vec![4; 16],
                    TransferApproval::Exact(500),
                ))
                .unwrap();
                let d = dispatch_for_test();
                let receipt = CreditReceipt {
                    offer: d.offer.clone(),
                    status: status.clone(),
                };
                reply("wiki_credit_status", (d.offer.clone(),), Ok(receipt));
                let receiver_acknowledged = std::rc::Rc::new(std::cell::Cell::new(false));
                let committed = receiver_acknowledged.clone();
                TEST_PEER_REPLIES.with(|slot| {
                    slot.borrow_mut().push_back(TestPeerReply {
                        method: "acknowledge_wiki_credit",
                        args: candid::encode_args((d.offer.clone(),)).unwrap(),
                        result: Err(BridgeError::Unavailable),
                        callback: Some(Box::new(move || committed.set(true))),
                    })
                });
                let settled = run(reconcile_vault_transfer(vec![4; 16])).unwrap();
                assert!(receiver_acknowledged.get());
                assert!(settled.receiver_cleanup_pending);
                let now = (bridge_now() / 86_400_000_000_000 + 2) * 86_400_000_000_000;
                TEST_BRIDGE_NOW.with(|slot| slot.set(Some(now)));
                // Script the receiver's authoritative status after its acknowledged
                // receipt was GC'd; Conflict models a new record reusing the key.
                reply::<CreditReceipt, _>("wiki_credit_status", (d.offer.clone(),), Err(absent));
                TEST_PEER_CALLS.with(|slot| slot.borrow_mut().clear());
                let recovered = run(reconcile_vault_transfer(vec![4; 16])).unwrap();
                assert_eq!(
                    TEST_PEER_CALLS.with(|slot| slot.borrow().clone()),
                    vec!["wiki_credit_status"]
                );
                assert_eq!(recovered.phase, settled.phase);
                assert_eq!(recovered.offer, settled.offer);
                assert_eq!(
                    recovered.collected_execution_fee_cycles,
                    settled.collected_execution_fee_cycles
                );
                assert!(!recovered.receiver_cleanup_pending);
                assert!(get_pending_vault_transfer(None).unwrap().is_none());
                assert!(TEST_PEER_REPLIES.with(|slot| slot.borrow().is_empty()));
                quote_vault_transfer(db.clone(), TransferAmount::Exact(1), vec![5; 16]).unwrap();
                run(cancel_vault_transfer(vec![5; 16])).unwrap();
                with_service(|s| s.delete_account(&p(1).to_text(), (now / 1_000_000) as i64))
                    .unwrap();
            }
        }
    }
    #[test]
    fn unknown_notfound_or_reused_key_does_not_refund_or_release_pending_slot() {
        for absent in [BridgeError::NotFound, BridgeError::Conflict] {
            let (_root, db) = setup();
            quote_vault_transfer(db, TransferAmount::Exact(500), vec![4; 16]).unwrap();
            set_update_charge_units_for_test(vec![0, 0, 0]);
            run(execute_vault_transfer(
                vec![4; 16],
                TransferApproval::Exact(500),
            ))
            .unwrap();
            let d = dispatch_for_test();
            let before = get_vault_transfer(vec![4; 16]).unwrap();
            TEST_BRIDGE_NOW.with(|slot| slot.set(Some(d.offer.expires_at_ns + 86_400_000_000_000)));
            reply::<CreditReceipt, _>("wiki_credit_status", (d.offer.clone(),), Err(absent));
            assert_eq!(run(reconcile_vault_transfer(vec![4; 16])).unwrap(), before);
            assert!(get_pending_vault_transfer(None).unwrap().is_some());
        }
    }
    #[test]
    fn approval_mismatch_is_rejected_for_all_and_expired_quotes_and_matching_old_payer_can_reconcile()
     {
        let (_root, db) = setup();
        let q = quote_vault_transfer(db.clone(), TransferAmount::All, vec![4; 16]).unwrap();
        TEST_BRIDGE_NOW.with(|slot| slot.set(Some(q.offer.expires_at_ns)));
        assert_eq!(
            run(execute_vault_transfer(
                vec![4; 16],
                TransferApproval::Exact(q.offer.amount_cycles)
            )),
            Err(BridgeError::Conflict)
        );
        let (_root, db) = setup();
        quote_vault_transfer(db.clone(), TransferAmount::All, vec![4; 16]).unwrap();
        set_update_charge_units_for_test(vec![0, 0, 0]);
        let held = run(execute_vault_transfer(
            vec![4; 16],
            TransferApproval::AllAvailable,
        ))
        .unwrap();
        let d = dispatch_for_test();
        with_service(|s| {
            s.grant_database_access(
                &db,
                &p(1).to_text(),
                &p(3).to_text(),
                DatabaseRole::Owner,
                now_millis(),
            )
        })
        .unwrap();
        with_service(|s| {
            s.grant_database_access(
                &db,
                &p(3).to_text(),
                &p(1).to_text(),
                DatabaseRole::Reader,
                now_millis(),
            )
        })
        .unwrap();
        assert_eq!(
            run(execute_vault_transfer(
                vec![4; 16],
                TransferApproval::Exact(held.offer.amount_cycles)
            )),
            Err(BridgeError::Conflict)
        );
        assert_eq!(
            run(execute_vault_transfer(
                vec![4; 16],
                TransferApproval::AllAvailable
            ))
            .unwrap()
            .phase,
            TransferPhase::Unknown
        );
        reply(
            "wiki_credit_status",
            (d.offer.clone(),),
            Ok(CreditReceipt {
                offer: d.offer.clone(),
                status: CreditStatus::Accepted,
            }),
        );
        reply("acknowledge_wiki_credit", (d.offer.clone(),), Ok(()));
        assert_eq!(
            run(reconcile_vault_transfer(vec![4; 16])).unwrap().phase,
            TransferPhase::Paid
        );
        assert_eq!(
            run(execute_vault_transfer(
                vec![4; 16],
                TransferApproval::Exact(held.offer.amount_cycles)
            )),
            Err(BridgeError::Conflict)
        );
        assert_eq!(
            run(execute_vault_transfer(
                vec![4; 16],
                TransferApproval::AllAvailable
            ))
            .unwrap()
            .phase,
            TransferPhase::Paid
        );
    }
    #[test]
    fn first_link_revoke_at_each_peer_await_prevents_activation() {
        for stage in [
            "inspect_wiki_link",
            "consume_wiki_link",
            "acknowledge_wiki_link",
        ] {
            let (_root, _db) = setup();
            set_test_caller_principal_for_test(p(20));
            let ch = LinkChallenge {
                challenge: vec![8; 16],
                vault_owner: p(21),
                generation: 2,
                expires_at_ns: bridge_now() + 300_000_000_000,
            };
            let proof = LinkProof {
                challenge: ch.clone(),
                wiki_owner: p(20),
            };
            reply("inspect_wiki_link", (ch.challenge.clone(),), Ok(ch.clone()));
            reply(
                "consume_wiki_link",
                (ch.challenge.clone(), p(20)),
                Ok(proof.clone()),
            );
            reply("acknowledge_wiki_link", (proof.clone(),), Ok(()));
            TEST_PEER_REPLIES.with(|slot| {
                slot.borrow_mut()
                    .iter_mut()
                    .find(|r| r.method == stage)
                    .unwrap()
                    .callback = Some(Box::new(|| {
                    with_service(|s| s.revoke_vault_link(p(20))).unwrap()
                }));
            });
            assert_eq!(
                run(approve_vault_link(ch.challenge)),
                Err(BridgeError::Conflict),
                "{stage}"
            );
            assert!(!get_vault_link().unwrap().is_some_and(|l| l.active));
            // A stale consume must be stopped before ACK, not just after it.
            if stage == "consume_wiki_link" {
                assert!(
                    !TEST_PEER_CALLS.with(|slot| slot.borrow().contains(&"acknowledge_wiki_link"))
                );
            }
        }
    }
    #[test]
    fn public_preview_releases_pending_lease_and_valid_approval_promotes_it() {
        let (_root, _db) = setup();
        set_test_caller_principal_for_test(p(20));
        let ch = LinkChallenge {
            challenge: vec![8; 16],
            vault_owner: p(21),
            generation: 2,
            expires_at_ns: bridge_now() + 300_000_000_000,
        };
        reply("inspect_wiki_link", (ch.challenge.clone(),), Ok(ch.clone()));
        assert_eq!(run(preview_vault_link(ch.challenge.clone())).unwrap(), ch);
        assert!(get_vault_link().unwrap().is_none());
        let proof = LinkProof {
            challenge: ch.clone(),
            wiki_owner: p(20),
        };
        reply("inspect_wiki_link", (ch.challenge.clone(),), Ok(ch.clone()));
        reply(
            "consume_wiki_link",
            (ch.challenge.clone(), p(20)),
            Ok(proof.clone()),
        );
        reply("acknowledge_wiki_link", (proof,), Ok(()));
        assert!(run(approve_vault_link(ch.challenge)).unwrap().active);
        assert!(get_vault_link().unwrap().unwrap().active);
    }
    #[test]
    fn matched_terminal_retry_before_retirement_keeps_cleanup_without_error() {
        let (_root, db) = setup();
        quote_vault_transfer(db, TransferAmount::Exact(500), vec![4; 16]).unwrap();
        set_update_charge_units_for_test(vec![0, 0, 0]);
        run(execute_vault_transfer(
            vec![4; 16],
            TransferApproval::Exact(500),
        ))
        .unwrap();
        let d = dispatch_for_test();
        let paid = with_service(|s| {
            s.settle_vault_receipt(
                &d,
                &CreditReceipt {
                    offer: d.offer.clone(),
                    status: CreditStatus::Accepted,
                },
                bridge_now(),
            )
        })
        .unwrap();
        TEST_BRIDGE_NOW.with(|slot| slot.set(Some(d.offer.expires_at_ns + 1)));
        reply::<CreditReceipt, _>(
            "wiki_credit_status",
            (d.offer.clone(),),
            Err(BridgeError::NotFound),
        );
        assert_eq!(
            run(execute_vault_transfer(
                vec![4; 16],
                TransferApproval::Exact(500)
            ))
            .unwrap(),
            paid
        );
    }
}
