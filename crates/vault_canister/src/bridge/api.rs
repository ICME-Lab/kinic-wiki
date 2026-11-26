//! Browser input is opaque IDs only; peer calls bind the complete pinned tuple.
use super::*;
fn wire<T>(r: Result<T>) -> BridgeResult<T> {
    r.map_err(|e| match e {
        Error::Unauthorized => BridgeError::Unauthorized,
        Error::InvalidInput => BridgeError::InvalidInput,
        Error::NotFound => BridgeError::NotFound,
        Error::Conflict => BridgeError::Conflict,
        Error::Expired => BridgeError::Expired,
        Error::QuotaExceeded => BridgeError::Capacity,
        Error::Storage => BridgeError::Storage,
        _ => BridgeError::Unavailable,
    })
}
#[ic_cdk::update]
fn set_wiki_bridge_config(config: BridgeConfig) -> BridgeResult<()> {
    if !ic_cdk::api::is_controller(&ic_cdk::api::msg_caller()) {
        return Err(BridgeError::Unauthorized);
    }
    wire(configure(config))
}
#[ic_cdk::query]
fn wiki_bridge_config() -> Option<BridgeConfig> {
    transaction(|db| settings(db).map(|s| s.config)).ok()
}
#[ic_cdk::update]
fn begin_wiki_link(operation: Vec<u8>) -> BridgeResult<LinkChallenge> {
    wire(begin_link(
        ic_cdk::api::msg_caller(),
        operation,
        crate::now_nanos(),
    ))
}
#[ic_cdk::update]
fn consume_wiki_link(challenge: Vec<u8>, wiki_owner: Principal) -> BridgeResult<LinkProof> {
    wire(consume_link(
        ic_cdk::api::msg_caller(),
        challenge,
        wiki_owner,
        crate::now_nanos(),
    ))
}
#[ic_cdk::update]
fn acknowledge_wiki_link(proof: LinkProof) -> BridgeResult<()> {
    wire(ack_link(ic_cdk::api::msg_caller(), proof))
}
#[ic_cdk::update]
async fn revoke_wiki_link() -> BridgeResult<BridgeRevocation> {
    let caller = ic_cdk::api::msg_caller();
    let revocation = wire(revoke(caller))?;
    let peer = wire(transaction(|db| settings(db).map(|s| s.config.peer)))?;
    let result: BridgeResult<()> = ic_cdk::call::Call::bounded_wait(peer, "revoke_link_from_vault")
        .with_arg(&revocation)
        .await
        .map_err(|_| BridgeError::Unavailable)?
        .candid()
        .map_err(|_| BridgeError::Unavailable)?;
    result?;
    wire(finish_revoke(&revocation))?;
    Ok(revocation)
}
#[ic_cdk::update]
async fn prepare_wiki_credit(quote_id: Vec<u8>) -> BridgeResult<CreditReceipt> {
    let caller = ic_cdk::api::msg_caller();
    let snapshot = wire(lookup_snapshot(caller, &quote_id))?;
    let response: BridgeResult<CreditOffer> =
        ic_cdk::call::Call::bounded_wait(snapshot.settings.config.peer, "bridge_credit_offer")
            .with_args(&(quote_id.clone(), caller))
            .await
            .map_err(|_| BridgeError::Unavailable)?
            .candid()
            .map_err(|_| BridgeError::Unavailable)?;
    let offer = response?;
    if offer.operation != quote_id {
        return Err(BridgeError::Conflict);
    }
    wire(finish_lookup(snapshot, caller, offer, crate::now_nanos()))
}
#[ic_cdk::update]
fn receive_wiki_credit(offer: CreditOffer) -> BridgeResult<CreditReceipt> {
    wire(receive(
        ic_cdk::api::msg_caller(),
        offer,
        crate::now_nanos(),
        ic_cdk::api::msg_cycles_available(),
        ic_cdk::api::msg_cycles_accept,
    ))
}
#[ic_cdk::update]
fn wiki_credit_status(offer: CreditOffer) -> BridgeResult<CreditReceipt> {
    wire(status(ic_cdk::api::msg_caller(), offer, crate::now_nanos()))
}
#[ic_cdk::update]
fn acknowledge_wiki_credit(offer: CreditOffer) -> BridgeResult<()> {
    wire(ack_credit(
        ic_cdk::api::msg_caller(),
        offer,
        crate::now_nanos(),
    ))
}

#[ic_cdk::update]
fn inspect_wiki_link(challenge: Vec<u8>) -> BridgeResult<LinkChallenge> {
    wire(inspect_link(
        ic_cdk::api::msg_caller(),
        challenge,
        crate::now_nanos(),
    ))
}

#[ic_cdk::update]
async fn wiki_link_status() -> BridgeResult<Option<LinkStatus>> {
    let caller = ic_cdk::api::msg_caller();
    wire(auth(caller))?;
    let peer = wire(transaction(|db| settings(db).map(|s| s.config.peer)))?;
    let status: BridgeResult<Option<LinkStatus>> =
        ic_cdk::call::Call::bounded_wait(peer, "bridge_link_status")
            .with_arg(caller)
            .await
            .map_err(|_| BridgeError::Unavailable)?
            .candid()
            .map_err(|_| BridgeError::Unavailable)?;
    wire(validate_link_status(caller, status?))
}

#[ic_cdk::update]
fn prepare_wiki_auto_credit(offer: CreditOffer) -> BridgeResult<CreditReceipt> {
    wire(prepare_auto(
        ic_cdk::api::msg_caller(),
        offer,
        crate::now_nanos(),
    ))
}
/// The signed-in owner asks Wiki for one refill under the owner's Wiki policy.
/// `None` means none was due; `Prepared` means the send is still unresolved.
#[ic_cdk::update]
async fn request_wiki_auto_topup() -> BridgeResult<Option<CreditReceipt>> {
    let caller = ic_cdk::api::msg_caller();
    let balance = wire(crate::state::State.balance(&caller.to_text()))?;
    let (peer, operation) = wire(auto_operation(caller, crate::now_nanos()))?;
    let reply: BridgeResult<Option<CreditReceipt>> =
        ic_cdk::call::Call::bounded_wait(peer, "request_vault_auto_topup")
            .with_args(&(caller, operation, balance))
            .await
            .map_err(|_| BridgeError::Unavailable)?
            .candid()
            .map_err(|_| BridgeError::Unavailable)?;
    reply
}
/// The owner's refill policy as stored by the linked Wiki owner.
#[ic_cdk::update]
async fn wiki_auto_topup_status() -> BridgeResult<Option<AutoTopupStatus>> {
    let caller = ic_cdk::api::msg_caller();
    wire(auth(caller))?;
    let peer = wire(bridge_peer())?;
    let reply: BridgeResult<Option<AutoTopupStatus>> =
        ic_cdk::call::Call::bounded_wait(peer, "vault_auto_topup_status")
            .with_arg(caller)
            .await
            .map_err(|_| BridgeError::Unavailable)?
            .candid()
            .map_err(|_| BridgeError::Unavailable)?;
    reply
}
