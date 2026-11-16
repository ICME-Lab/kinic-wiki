//! Durable Wiki bridge state in the existing bounded payments pool.
use crate::state::transaction;
use candid::Principal;
use credit_bridge_types::*;
use kinic_sqlite_compat::{self as sql, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use vault_types::{Error, Result};
mod api;
const TTL: u64 = 300_000_000_000;
const DAY: u64 = 86_400_000_000_000;
#[derive(Clone, Debug, Serialize, Deserialize)]
struct Settings {
    config: BridgeConfig,
    serial: u64,
    /// Only controller configuration changes invalidate all pending offer lookups.
    config_epoch: u64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) enum Record {
    Link {
        challenge: LinkChallenge,
        wiki_owner: Option<Principal>,
        revoked: bool,
        acknowledged: bool,
    },
    Credit {
        offer: CreditOffer,
        status: CreditStatus,
        acknowledged: bool,
        day: u64,
    },
}
#[derive(Serialize, Deserialize)]
struct Envelope {
    bridge_v1: Record,
}
fn auth(p: Principal) -> Result<()> {
    if p == Principal::anonymous() || p == Principal::management_canister() {
        Err(Error::Unauthorized)
    } else {
        Ok(())
    }
}
fn id(v: &[u8]) -> Result<()> {
    if v.len() == 16 {
        Ok(())
    } else {
        Err(Error::InvalidInput)
    }
}
fn settings(db: &sql::Connection) -> Result<Settings> {
    let raw: String = db
        .query_row(
            "SELECT value FROM global_settings WHERE key='bridge'",
            params![],
            |r| sql::row_get(r, 0),
        )
        .optional()
        .map_err(|_| Error::Storage)?
        .ok_or(Error::Unauthorized)?;
    serde_json::from_str(&raw).map_err(|_| Error::Storage)
}
fn save_settings(db: &sql::Connection, s: &Settings) -> Result<()> {
    db.execute("INSERT INTO global_settings(key,value) VALUES('bridge',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",params![serde_json::to_string(s).map_err(|_|Error::Storage)?]).map_err(|_|Error::Storage)?;
    Ok(())
}
fn peer(db: &sql::Connection, p: Principal) -> Result<Settings> {
    let s = settings(db)?;
    if s.config.peer != p {
        return Err(Error::Unauthorized);
    }
    Ok(s)
}
fn enabled(s: &Settings) -> Result<()> {
    if s.config.enabled {
        Ok(())
    } else {
        Err(Error::Unauthorized)
    }
}
fn configure(config: BridgeConfig) -> Result<()> {
    auth(config.peer)?;
    if config.daily_limit_cycles == 0
        || config.daily_limit_cycles > i64::MAX as u64
        || config.physical_reserve_cycles == 0
    {
        return Err(Error::InvalidInput);
    }
    transaction(|db| {
        let exists: i64 = db
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM global_settings WHERE key='bridge')",
                params![],
                |r| sql::row_get(r, 0),
            )
            .map_err(|_| Error::Storage)?;
        let (serial, config_epoch) = if exists != 0 {
            let old = settings(db)?;
            if old.config.peer != config.peer {
                return Err(Error::Conflict);
            }
            (
                old.serial,
                old.config_epoch
                    .checked_add(1)
                    .ok_or(Error::QuotaExceeded)?,
            )
        } else {
            (0, 0)
        };
        save_settings(
            db,
            &Settings {
                config,
                serial,
                config_epoch,
            },
        )
    })
}
pub(crate) fn decode(raw: &str) -> Result<Option<Record>> {
    let value: serde_json::Value = serde_json::from_str(raw).map_err(|_| Error::Storage)?;
    if value.get("bridge_v1").is_some() {
        Ok(Some(
            serde_json::from_value::<Envelope>(value)
                .map_err(|_| Error::Storage)?
                .bridge_v1,
        ))
    } else {
        Ok(None)
    }
}
fn rows(db: &sql::Connection) -> Result<Vec<(Principal, Vec<u8>, Record)>> {
    let mut q = db
        .prepare("SELECT wallet,operation,record FROM payments")
        .map_err(|_| Error::Storage)?;
    let rows: Vec<(String, Vec<u8>, String)> = sql::query_map(&mut q, params![], |r| {
        Ok((
            sql::row_get(r, 0)?,
            sql::row_get(r, 1)?,
            sql::row_get(r, 2)?,
        ))
    })
    .map_err(|_| Error::Storage)?;
    let mut out = vec![];
    for (w, o, raw) in rows {
        if let Some(record) = decode(&raw)? {
            out.push((
                Principal::from_text(w).map_err(|_| Error::Storage)?,
                o,
                record,
            ));
        }
    }
    Ok(out)
}
fn load(db: &sql::Connection, owner: Principal, operation: &[u8]) -> Result<Option<Record>> {
    let raw: Option<String> = db
        .query_row(
            "SELECT record FROM payments WHERE wallet=?1 AND operation=?2",
            params![owner.to_text(), operation],
            |r| sql::row_get(r, 0),
        )
        .optional()
        .map_err(|_| Error::Storage)?;
    raw.map(|r| decode(&r)?.ok_or(Error::Conflict)).transpose()
}
fn save(db: &sql::Connection, owner: Principal, operation: &[u8], record: Record) -> Result<()> {
    let expiry = match &record {
        Record::Link {
            challenge,
            wiki_owner,
            revoked,
            acknowledged,
        } if (*acknowledged || wiki_owner.is_none()) && !revoked => {
            challenge.expires_at_ns / 1_000_000_000
        }
        Record::Credit {
            offer,
            acknowledged: true,
            status,
            day,
        } => {
            let end = if *status == CreditStatus::Accepted {
                day.saturating_add(1).saturating_mul(DAY)
            } else {
                0
            };
            offer.expires_at_ns.max(end) / 1_000_000_000
        }
        _ => i64::MAX as u64,
    };
    let raw = serde_json::to_string(&Envelope { bridge_v1: record }).map_err(|_| Error::Storage)?;
    if vault_types::capacity::row_size(&[owner.to_text().len(), operation.len(), raw.len()], 1)
        .ok_or(Error::QuotaExceeded)?
        > vault_types::capacity::PAYMENT_ROW
    {
        return Err(Error::QuotaExceeded);
    }
    db.execute("INSERT INTO payments(wallet,operation,record,expires) VALUES(?1,?2,?3,?4) ON CONFLICT(wallet,operation) DO UPDATE SET record=excluded.record,expires=excluded.expires",params![owner.to_text(),operation,raw,expiry as i64]).map_err(|_|Error::Storage)?;
    Ok(())
}
/// The ICRC fee lease and payments table share one wallet/operation namespace.
/// Expired or pre-upgrade leases cannot write on completion and need not block reuse.
fn ensure_no_live_fee(
    db: &sql::Connection,
    owner: Principal,
    operation: &[u8],
    now: u64,
) -> Result<()> {
    let now = i64::try_from(now).map_err(|_| Error::InvalidInput)?;
    let occupied: i64 = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM quote_fee_flights WHERE wallet=?1 AND operation=?2 AND expires_ns>?3 AND generation=(SELECT CAST(value AS INTEGER) FROM global_settings WHERE key='generation'))",
        params![owner.to_text(), operation, now], |r| sql::row_get(r,0),
    ).map_err(|_| Error::Storage)?;
    if occupied != 0 {
        Err(Error::Conflict)
    } else {
        Ok(())
    }
}
fn admit(db: &sql::Connection, owner: Principal, now: u64) -> Result<()> {
    db.execute(
        "DELETE FROM payments WHERE expires<?1",
        params![(now / 1_000_000_000).min(i64::MAX as u64) as i64],
    )
    .map_err(|_| Error::Storage)?;
    let(count,owned):(i64,i64)=db.query_row("SELECT count(*),coalesce(sum(wallet=?1),0) FROM (SELECT wallet FROM payments UNION ALL SELECT wallet FROM quote_fee_flights)",params![owner.to_text()],|r|Ok((sql::row_get(r,0)?,sql::row_get(r,1)?))).map_err(|_|Error::Storage)?;
    if count >= 1024 || owned >= 16 {
        Err(Error::QuotaExceeded)
    } else {
        Ok(())
    }
}
fn begin_link(owner: Principal, operation: Vec<u8>, now: u64) -> Result<LinkChallenge> {
    auth(owner)?;
    id(&operation)?;
    transaction(|db| {
        let mut s = settings(db)?;
        enabled(&s)?;
        if let Some(old) = load(db, owner, &operation)? {
            return match old {
                Record::Link {
                    challenge,
                    revoked: false,
                    ..
                } if challenge.expires_at_ns > now => Ok(challenge),
                _ => Err(Error::Conflict),
            };
        }
        ensure_no_live_fee(db, owner, &operation, now)?;
        admit(db, owner, now)?;
        s.serial = s.serial.checked_add(1).ok_or(Error::QuotaExceeded)?;
        let mut hash = Sha256::new();
        hash.update(b"vault-wiki-challenge-v1");
        hash.update([owner.as_slice().len() as u8]);
        hash.update(owner.as_slice());
        hash.update(&operation);
        hash.update(s.serial.to_be_bytes());
        let challenge = LinkChallenge {
            challenge: hash.finalize()[..16].to_vec(),
            vault_owner: owner,
            generation: s.serial,
            expires_at_ns: now.checked_add(TTL).ok_or(Error::InvalidInput)?,
        };
        save_settings(db, &s)?;
        save(
            db,
            owner,
            &operation,
            Record::Link {
                challenge: challenge.clone(),
                wiki_owner: None,
                revoked: false,
                acknowledged: false,
            },
        )?;
        Ok(challenge)
    })
}
fn find_link(db: &sql::Connection, challenge: &[u8]) -> Result<(Principal, Vec<u8>, Record)> {
    id(challenge)?;
    let mut matches = rows(db)?
        .into_iter()
        .filter(|(_, _, r)| matches!(r,Record::Link{challenge:c,..} if c.challenge==challenge));
    let found = matches.next().ok_or(Error::NotFound)?;
    if matches.next().is_some() {
        return Err(Error::Conflict);
    }
    Ok(found)
}
fn consume_link(
    caller: Principal,
    challenge: Vec<u8>,
    wiki: Principal,
    now: u64,
) -> Result<LinkProof> {
    auth(wiki)?;
    transaction(|db| {
        let s = peer(db, caller)?;
        let (owner, operation, record) = find_link(db, &challenge)?;
        let Record::Link {
            challenge,
            wiki_owner,
            revoked,
            acknowledged,
        } = record
        else {
            unreachable!()
        };
        if revoked || wiki_owner.is_some_and(|w| w != wiki) {
            return Err(Error::Conflict);
        }
        if wiki_owner.is_none() {
            enabled(&s)?;
            if now >= challenge.expires_at_ns {
                return Err(Error::Expired);
            }
        }
        save(
            db,
            owner,
            &operation,
            Record::Link {
                challenge: challenge.clone(),
                wiki_owner: Some(wiki),
                revoked,
                acknowledged,
            },
        )?;
        Ok(LinkProof {
            challenge,
            wiki_owner: wiki,
        })
    })
}
fn ack_link(caller: Principal, proof: LinkProof) -> Result<()> {
    transaction(|db| {
        peer(db, caller)?;
        let (owner, operation, record) = find_link(db, &proof.challenge.challenge)?;
        let Record::Link {
            challenge,
            wiki_owner,
            revoked,
            ..
        } = record
        else {
            unreachable!()
        };
        if revoked || challenge != proof.challenge || wiki_owner != Some(proof.wiki_owner) {
            return Err(Error::Conflict);
        }
        save(
            db,
            owner,
            &operation,
            Record::Link {
                challenge,
                wiki_owner,
                revoked: false,
                acknowledged: true,
            },
        )
    })
}
fn revoke(owner: Principal) -> Result<BridgeRevocation> {
    auth(owner)?;
    transaction(|db| {
        let mut s = settings(db)?;
        let through_generation = s.serial;
        s.serial = s.serial.checked_add(1).ok_or(Error::QuotaExceeded)?;
        save_settings(db, &s)?;
        for (w, op, r) in rows(db)? {
            if w == owner
                && let Record::Link {
                    challenge,
                    wiki_owner,
                    ..
                } = r
            {
                save(
                    db,
                    w,
                    &op,
                    Record::Link {
                        challenge,
                        wiki_owner,
                        revoked: true,
                        acknowledged: false,
                    },
                )?;
            }
        }
        Ok(BridgeRevocation {
            vault_owner: owner,
            through_generation,
        })
    })
}
/// A late acknowledgement only releases challenges fenced by this revocation.
fn finish_revoke(revocation: &BridgeRevocation) -> Result<()> {
    transaction(|db| {
        for (w, op, r) in rows(db)? {
            if w == revocation.vault_owner
                && let Record::Link {
                    challenge,
                    revoked: true,
                    ..
                } = r
                && challenge.generation <= revocation.through_generation
            {
                db.execute(
                    "DELETE FROM payments WHERE wallet=?1 AND operation=?2",
                    params![w.to_text(), op],
                )
                .map_err(|_| Error::Storage)?;
            }
        }
        Ok(())
    })
}
/// Prepared intents reserve future balances and account membership across every funding path.
pub(crate) fn reservations(db: &sql::Connection) -> Result<Vec<(Principal, Vec<u8>, u64)>> {
    Ok(rows(db)?
        .into_iter()
        .filter_map(|(_, _, r)| match r {
            Record::Credit {
                offer,
                status: CreditStatus::Prepared,
                ..
            } => Some((offer.vault_owner, offer.operation, offer.amount_cycles)),
            _ => None,
        })
        .collect())
}
struct OfferLookup {
    settings: Settings,
    generation: i64,
}
fn lookup_snapshot(owner: Principal, operation: &[u8]) -> Result<OfferLookup> {
    auth(owner)?;
    id(operation)?;
    transaction(|db| {
        let settings = settings(db)?;
        enabled(&settings)?;
        let generation = db
            .query_row(
                "SELECT CAST(value AS INTEGER) FROM global_settings WHERE key='generation'",
                params![],
                |r| sql::row_get(r, 0),
            )
            .map_err(|_| Error::Storage)?;
        Ok(OfferLookup {
            settings,
            generation,
        })
    })
}
fn finish_lookup(
    snapshot: OfferLookup,
    owner: Principal,
    offer: CreditOffer,
    now: u64,
) -> Result<CreditReceipt> {
    let current = lookup_snapshot(owner, &offer.operation)?;
    if current.generation != snapshot.generation
        || current.settings.config_epoch != snapshot.settings.config_epoch
        || current.settings.config != snapshot.settings.config
    {
        return Err(Error::Conflict);
    }
    // A Prepared intent carries no funds or link authority. In particular, a same-owner
    // revoke may finish while this read is pending. Wiki must revalidate the active
    // link/generation before dispatch; revoked approval proofs remain fenced locally.
    // Do not let another user's challenge/revoke cancel this owner's harmless intent.
    prepare(owner, snapshot.settings.config.peer, offer, now)
}
fn prepare(
    owner: Principal,
    caller: Principal,
    offer: CreditOffer,
    now: u64,
) -> Result<CreditReceipt> {
    auth(owner)?;
    auth(offer.wiki_owner)?;
    id(&offer.operation)?;
    if offer.vault_owner != owner {
        return Err(Error::Unauthorized);
    }
    if offer.amount_cycles == 0
        || offer.amount_cycles > i64::MAX as u64
        || offer.link_generation == 0
    {
        return Err(Error::InvalidInput);
    }
    transaction(|db| {
        let s = peer(db, caller)?;
        enabled(&s)?;
        if let Some(r) = load(db, owner, &offer.operation)? {
            return receipt(r, &offer);
        }
        if offer.expires_at_ns <= now || offer.expires_at_ns > now.saturating_add(TTL) {
            return Err(Error::Expired);
        }
        ensure_no_live_fee(db, owner, &offer.operation, now)?;
        admit(db, owner, now)?;
        crate::capacity::admit_beneficiary(db, owner)?;
        crate::capacity::admit_credit(db, owner, owner, &offer.operation, offer.amount_cycles)?;
        let mut daily = u128::from(offer.amount_cycles);
        for (_, _, r) in rows(db)? {
            if let Record::Credit {
                offer, status, day, ..
            } = r
                && (status == CreditStatus::Prepared
                    || (day == now / DAY && status == CreditStatus::Accepted))
            {
                daily += u128::from(offer.amount_cycles)
            }
        }
        if daily > u128::from(s.config.daily_limit_cycles) {
            return Err(Error::QuotaExceeded);
        }
        save(
            db,
            owner,
            &offer.operation,
            Record::Credit {
                offer: offer.clone(),
                status: CreditStatus::Prepared,
                acknowledged: false,
                day: now / DAY,
            },
        )?;
        Ok(CreditReceipt {
            offer,
            status: CreditStatus::Prepared,
        })
    })
}
fn receipt(r: Record, offer: &CreditOffer) -> Result<CreditReceipt> {
    match r {
        Record::Credit {
            offer: o, status, ..
        } if o == *offer => Ok(CreditReceipt { offer: o, status }),
        _ => Err(Error::Conflict),
    }
}
fn status(caller: Principal, offer: CreditOffer, now: u64) -> Result<CreditReceipt> {
    id(&offer.operation)?;
    transaction(|db| {
        peer(db, caller)?;
        let r = load(db, offer.vault_owner, &offer.operation)?.ok_or(Error::NotFound)?;
        let mut result = receipt(r.clone(), &offer)?;
        if result.status == CreditStatus::Prepared && now >= offer.expires_at_ns {
            let Record::Credit {
                acknowledged, day, ..
            } = r
            else {
                unreachable!()
            };
            result.status = CreditStatus::NotAccepted;
            save(
                db,
                offer.vault_owner,
                &offer.operation,
                Record::Credit {
                    offer: offer.clone(),
                    status: result.status.clone(),
                    acknowledged,
                    day,
                },
            )?;
        }
        Ok(result)
    })
}
fn receive(
    caller: Principal,
    offer: CreditOffer,
    now: u64,
    available: u128,
    accept: impl FnOnce(u128) -> u128,
) -> Result<CreditReceipt> {
    id(&offer.operation)?;
    // SQL writes precede acceptance. Any failure of the commit after acceptance must
    // trap the whole IC message, rolling back stable memory and accepted cycles.
    let accepted = std::cell::Cell::new(false);
    let result = transaction(|db| {
        peer(db, caller)?;
        let r = load(db, offer.vault_owner, &offer.operation)?.ok_or(Error::NotFound)?;
        let mut result = receipt(r.clone(), &offer)?;
        if result.status != CreditStatus::Prepared {
            return Ok(result);
        }
        let Record::Credit {
            acknowledged, day, ..
        } = r
        else {
            unreachable!()
        };
        if now >= offer.expires_at_ns {
            result.status = CreditStatus::NotAccepted;
            save(
                db,
                offer.vault_owner,
                &offer.operation,
                Record::Credit {
                    offer: offer.clone(),
                    status: result.status.clone(),
                    acknowledged,
                    day,
                },
            )?;
            return Ok(result);
        }
        if available != u128::from(offer.amount_cycles) {
            return Err(Error::InvalidInput);
        }
        let owner = offer.vault_owner.to_text();
        let balance: i64 = db
            .query_row(
                "SELECT balance_cycles FROM accounts WHERE owner=?1",
                params![owner],
                |r| sql::row_get(r, 0),
            )
            .optional()
            .map_err(|_| Error::Storage)?
            .unwrap_or(0);
        let next = balance
            .checked_add(offer.amount_cycles as i64)
            .ok_or(Error::QuotaExceeded)?;
        db.execute("INSERT INTO accounts(owner,balance_cycles,storage_charged_at_ms) VALUES(?1,?2,?3) ON CONFLICT(owner) DO UPDATE SET balance_cycles=excluded.balance_cycles",params![owner,next,(now/1_000_000) as i64]).map_err(|_|Error::Storage)?;
        crate::accounting::record_entry(
            db,
            &owner,
            "wiki-credit",
            offer.amount_cycles as i64,
            next,
            (now / 1_000_000) as i64,
            Some(&offer.operation),
        )?;
        result.status = CreditStatus::Accepted;
        save(
            db,
            offer.vault_owner,
            &offer.operation,
            Record::Credit {
                offer: offer.clone(),
                status: result.status.clone(),
                acknowledged,
                day: now / DAY,
            },
        )?;
        accepted.set(true);
        assert_eq!(
            accept(u128::from(offer.amount_cycles)),
            u128::from(offer.amount_cycles),
            "cycles acceptance invariant"
        );
        Ok(result)
    });
    if accepted.get() && result.is_err() {
        panic!("accepted cycles transaction failed")
    }
    result
}
fn ack_credit(caller: Principal, offer: CreditOffer, _now: u64) -> Result<()> {
    transaction(|db| {
        peer(db, caller)?;
        let r = load(db, offer.vault_owner, &offer.operation)?.ok_or(Error::NotFound)?;
        let result = receipt(r.clone(), &offer)?;
        if result.status == CreditStatus::Prepared {
            return Err(Error::Conflict);
        }
        let Record::Credit { day, .. } = r else {
            unreachable!()
        };
        save(
            db,
            offer.vault_owner,
            &offer.operation,
            Record::Credit {
                offer: offer.clone(),
                status: result.status,
                acknowledged: true,
                day,
            },
        )
    })
}
#[cfg(test)]
mod tests;

fn inspect_link(caller: Principal, challenge: Vec<u8>, now: u64) -> Result<LinkChallenge> {
    transaction(|db| {
        enabled(&peer(db, caller)?)?;
        let (_, _, record) = find_link(db, &challenge)?;
        let Record::Link {
            challenge, revoked, ..
        } = record
        else {
            unreachable!()
        };
        if revoked {
            return Err(Error::Conflict);
        }
        if now >= challenge.expires_at_ns {
            return Err(Error::Expired);
        }
        Ok(challenge)
    })
}

fn validate_link_status(
    owner: Principal,
    status: Option<LinkStatus>,
) -> Result<Option<LinkStatus>> {
    if let Some(link) = &status {
        if link.vault_owner != owner || link.generation == 0 {
            return Err(Error::Conflict);
        }
        auth(link.wiki_owner)?;
    }
    Ok(status)
}

#[cfg(test)]
mod review_tests;
