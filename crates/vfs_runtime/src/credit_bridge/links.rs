use super::*;

impl VfsService {
    pub fn fence_vault_bridge_upgrade(&self) -> R<()> {
        self.write_index(|c| {
            let mut s = match settings(c) {
                Ok(s) => s,
                Err(e) if e == "Disabled" => return Ok(()),
                Err(e) => return Err(e),
            };
            s.generation = s.generation.checked_add(1).ok_or("Capacity")?;
            s.epoch = s.epoch.checked_add(1).ok_or("Capacity")?;
            save_settings(c, &s)?;
            c.execute(
                "DELETE FROM credit_bridge_owners WHERE expires_at_ns IS NOT NULL",
                params![],
            )
            .map_err(|e| e.to_string())?;
            Ok(())
        })
    }
    pub fn vault_bridge_config(&self) -> R<Option<BridgeConfig>> {
        self.read_index(|c| match settings(c) {
            Ok(s) => Ok(Some(s.config)),
            Err(e) if e == "Disabled" => Ok(None),
            Err(e) => Err(e),
        })
    }
    pub fn configure_vault_bridge(&self, config: BridgeConfig) -> R<()> {
        auth(config.peer)?;
        if config.peer == Principal::management_canister()
            || config.daily_limit_cycles == 0
            || config.daily_limit_cycles > i64::MAX as u64
            || config.physical_reserve_cycles == 0
        {
            return Err("InvalidInput".into());
        }
        self.write_index(|c| {
            let old = match settings(c) {
                Ok(s) => Some(s),
                Err(e) if e == "Disabled" => None,
                Err(e) => return Err(e),
            };
            if old
                .as_ref()
                .is_some_and(|old| old.config.peer != config.peer)
            {
                return Err("Conflict".into());
            }
            let s = Settings {
                config,
                epoch: old
                    .as_ref()
                    .map_or(Ok(1), |s| s.epoch.checked_add(1).ok_or("Capacity"))?,
                serial: old.as_ref().map_or(0, |s| s.serial),
                generation: old.map_or(0, |s| s.generation),
            };
            save_settings(c, &s)
        })
    }
    pub fn vault_bridge_peer(&self, caller: Principal) -> R<BridgeConfig> {
        self.read_index(|c| {
            let s = settings(c)?;
            if s.config.peer != caller {
                return Err("Unauthorized".into());
            }
            Ok(s.config)
        })
    }
    pub fn vault_link_snapshot(&self, p: Principal, now: u64) -> R<LinkSnapshot> {
        auth(p)?;
        self.write_index(|c| {
            let mut s = enabled(c)?;
            let now_i64 = i64::try_from(now).map_err(|_| "InvalidInput")?;
            c.execute(
                "DELETE FROM credit_bridge_owners
                 WHERE expires_at_ns IS NOT NULL AND expires_at_ns<=?1",
                params![now_i64],
            )
            .map_err(|e| e.to_string())?;
            let existing = load_owner_lease(c, p)?;
            if let Some((epoch, None)) = existing {
                return Ok(LinkSnapshot {
                    config: s.config,
                    epoch: s.epoch,
                    owner_epoch: epoch as u64,
                    lease_expires_at_ns: None,
                });
            }
            if existing.is_none()
                && row_count(c, "SELECT count(*) FROM credit_bridge_owners")? >= CAP
            {
                return Err("Capacity".into());
            }
            // Serial allocates an identity, never a global callback cancellation fence.
            // Only this owner's row is replaced; another user's callbacks stay valid.
            let token = next_owner_token(c, &mut s)?;
            let expires = now
                .checked_add(TTL)
                .filter(|n| *n <= i64::MAX as u64)
                .ok_or("InvalidInput")?;
            c.execute(
                "INSERT INTO credit_bridge_owners(wiki_owner,epoch,expires_at_ns)
                 VALUES(?1,?2,?3) ON CONFLICT(wiki_owner)
                 DO UPDATE SET epoch=excluded.epoch,expires_at_ns=excluded.expires_at_ns",
                params![p.to_text(), token as i64, expires as i64],
            )
            .map_err(|e| e.to_string())?;
            Ok(LinkSnapshot {
                config: s.config,
                epoch: s.epoch,
                owner_epoch: token,
                lease_expires_at_ns: Some(expires),
            })
        })
    }
    pub fn validate_vault_link_snapshot(
        &self,
        p: Principal,
        snap: &LinkSnapshot,
        now: u64,
    ) -> R<()> {
        self.read_index(|c| validate_snapshot(c, p, snap, now))
    }
    pub fn release_vault_link_snapshot(&self, p: Principal, snap: &LinkSnapshot) -> R<()> {
        auth(p)?;
        self.write_index(|c| {
            // A late failure may delete only its own pending lease, never a new
            // attempt or a row promoted to a permanent pair by valid approval.
            c.execute(
                "DELETE FROM credit_bridge_owners
                 WHERE wiki_owner=?1 AND epoch=?2 AND expires_at_ns IS NOT NULL",
                params![p.to_text(), snap.owner_epoch as i64],
            )
            .map_err(|e| e.to_string())?;
            Ok(())
        })
    }
    pub fn vault_link_begin(
        &self,
        p: Principal,
        ch: LinkChallenge,
        snap: &LinkSnapshot,
        now: u64,
    ) -> R<LinkProof> {
        auth(p)?;
        id(&ch.challenge)?;
        auth(ch.vault_owner)?;
        if ch.generation == 0 || ch.generation > i64::MAX as u64 {
            return Err("InvalidInput".into());
        }
        self.write_index(|c| {
            validate_snapshot(c, p, snap, now)?;
            let now_i64 = i64::try_from(now).map_err(|_| "InvalidInput")?;
            expire_unpaired_fence(c, ch.vault_owner, now_i64)?;
            if ch.generation <= fence(c, ch.vault_owner)? {
                return Err("Conflict".into());
            }
            if let Some(old) = link(c, p)? {
                if old.proof.challenge.vault_owner != ch.vault_owner {
                    return Err("Conflict".into());
                }
                if old.proof.challenge != ch && ch.generation <= old.proof.challenge.generation {
                    return Err("Conflict".into());
                }
                if old.proof.challenge == ch {
                    if old.owner_epoch != snap.owner_epoch {
                        return Err("Conflict".into());
                    }
                    let mut recovered = old;
                    recovered.config_epoch = snap.epoch;
                    save_link(c, &recovered)?;
                    return Ok(recovered.proof);
                }
            }
            if ch.expires_at_ns <= now {
                return Err("Expired".into());
            }
            let count = row_count(c, "SELECT count(*) FROM credit_bridge_links")?;
            if count >= CAP && link(c, p)?.is_none() {
                return Err("Capacity".into());
            }
            // Once admitted, the peer can always revoke this pair even at quota.
            if scalar(
                c,
                "SELECT count(*) FROM credit_bridge_fences WHERE vault_owner=?1",
                &ch.vault_owner.to_text(),
            )? == 0
            {
                if row_count(c, "SELECT count(*) FROM credit_bridge_fences")? >= CAP {
                    expire_unpaired_fences(c, now_i64)?;
                    if row_count(c, "SELECT count(*) FROM credit_bridge_fences")? >= CAP {
                        return Err("Capacity".into());
                    }
                }
            }
            // Admission makes a fence permanent, including pending approval.
            c.execute(
                "INSERT INTO credit_bridge_fences(vault_owner,generation) VALUES(?1,0)
                 ON CONFLICT(vault_owner) DO UPDATE SET expires_at_ns=NULL
                 WHERE expires_at_ns IS NOT NULL",
                params![ch.vault_owner.to_text()],
            )
            .map_err(|e| e.to_string())?;
            let l = Link {
                proof: LinkProof {
                    challenge: ch,
                    wiki_owner: p,
                },
                active: false,
                owner_epoch: snap.owner_epoch,
                config_epoch: snap.epoch,
            };
            save_link(c, &l)?;
            c.execute(
                "UPDATE credit_bridge_owners SET expires_at_ns=NULL
                 WHERE wiki_owner=?1 AND epoch=?2",
                params![p.to_text(), snap.owner_epoch as i64],
            )
            .map_err(|e| e.to_string())?;
            Ok(l.proof)
        })
    }
    pub fn vault_link_recovery(&self, p: Principal, ch: &[u8]) -> R<Option<LinkChallenge>> {
        auth(p)?;
        self.read_index(|c| {
            Ok(link(c, p)?
                .filter(|l| l.proof.challenge.challenge == ch)
                .map(|l| l.proof.challenge))
        })
    }
    /// Revalidate the consumed proof before acknowledging the receiver's claimed row.
    pub fn validate_vault_link_proof(&self, proof: &LinkProof, snap: &LinkSnapshot) -> R<()> {
        self.read_index(|c| validate_proof(c, proof, snap).map(|_| ()))
    }
    pub fn vault_link_finish(&self, proof: &LinkProof, snap: &LinkSnapshot) -> R<LinkStatus> {
        self.write_index(|c| {
            let mut l = validate_proof(c, proof, snap)?;
            l.active = true;
            save_link(c, &l)?;
            Ok(link_status(&l))
        })
    }
    pub fn get_vault_link(&self, p: Principal) -> R<Option<LinkStatus>> {
        auth(p)?;
        self.read_index(|c| Ok(link(c, p)?.map(|l| link_status(&l))))
    }
    pub fn bridge_link_status(&self, peer: Principal, p: Principal) -> R<Option<LinkStatus>> {
        self.vault_bridge_peer(peer)?;
        self.read_index(|c| {
            let s: Option<String> = c
                .query_row(
                    "SELECT record FROM credit_bridge_links WHERE vault_owner=?1",
                    params![p.to_text()],
                    |r| crate::sqlite::row_get(r, 0),
                )
                .optional()
                .map_err(|e| e.to_string())?;
            s.map(|s| decode::<Link>(s).map(|l| link_status(&l)))
                .transpose()
        })
    }
    pub fn revoke_vault_link(&self, p: Principal) -> R<()> {
        auth(p)?;
        self.write_index(|c| {
            let exists = scalar(
                c,
                "SELECT count(*) FROM credit_bridge_owners WHERE wiki_owner=?1",
                &p.to_text(),
            )? != 0;
            if !exists {
                return Ok(());
            }
            let mut settings = settings(c)?;
            let next = next_owner_token(c, &mut settings)?;
            c.execute(
                "UPDATE credit_bridge_owners SET epoch=?2 WHERE wiki_owner=?1",
                params![p.to_text(), next as i64],
            )
            .map_err(|e| e.to_string())?;
            if let Some(mut l) = link(c, p)? {
                l.active = false;
                save_link(c, &l)?;
            }
            Ok(())
        })
    }
    pub fn revoke_link_from_vault(&self, peer: Principal, r: BridgeRevocation, now: u64) -> R<()> {
        self.vault_bridge_peer(peer)?;
        auth(r.vault_owner)?;
        if r.through_generation > i64::MAX as u64 {
            return Err("InvalidInput".into());
        }
        let expires_at_ns = now
            .checked_add(TTL)
            .and_then(|n| i64::try_from(n).ok())
            .ok_or("InvalidInput")?;
        self.write_index(|c| {
            let now_i64 = i64::try_from(now).map_err(|_| "InvalidInput")?;
            expire_unpaired_fence(c, r.vault_owner, now_i64)?;
            let exists=scalar(c,"SELECT count(*) FROM credit_bridge_fences WHERE vault_owner=?1",&r.vault_owner.to_text())? != 0;
            if !exists && row_count(c,"SELECT count(*) FROM credit_bridge_fences")? >= CAP {
                expire_unpaired_fences(c, now_i64)?;
                if row_count(c,"SELECT count(*) FROM credit_bridge_fences")? >= CAP {return Err("Capacity".into());}
            }
            c.execute(
                "INSERT INTO credit_bridge_fences(vault_owner,generation,expires_at_ns) VALUES(?1,?2,?3)
                 ON CONFLICT(vault_owner) DO UPDATE SET
                   generation=max(generation,excluded.generation),
                   expires_at_ns=CASE WHEN credit_bridge_fences.expires_at_ns IS NULL THEN NULL
                                      ELSE max(credit_bridge_fences.expires_at_ns,excluded.expires_at_ns) END",
                params![r.vault_owner.to_text(),r.through_generation as i64,expires_at_ns],
            ).map_err(|e|e.to_string())?;
            let row:Option<String>=c.query_row(
                "SELECT record FROM credit_bridge_links WHERE vault_owner=?1",
                params![r.vault_owner.to_text()],|r|crate::sqlite::row_get(r,0),
            ).optional().map_err(|e|e.to_string())?;
            if let Some(row)=row {
                let mut l:Link=decode(row)?;
                if l.proof.challenge.generation<=r.through_generation {l.active=false;save_link(c,&l)?;}
            }
            Ok(())
        })
    }
}

fn validate_proof(c: &Connection, proof: &LinkProof, snap: &LinkSnapshot) -> R<Link> {
    let s = enabled(c)?;
    let l = link(c, proof.wiki_owner)?.ok_or("NotFound")?;
    if l.proof != *proof
        || s.epoch != snap.epoch
        || l.config_epoch != snap.epoch
        || owner_epoch(c, proof.wiki_owner)? != snap.owner_epoch
        || l.owner_epoch != snap.owner_epoch
        || proof.challenge.generation <= fence(c, proof.challenge.vault_owner)?
    {
        return Err("Conflict".into());
    }
    Ok(l)
}

fn next_owner_token(c: &Transaction<'_>, s: &mut Settings) -> R<u64> {
    s.serial = s
        .serial
        .checked_add(1)
        .filter(|n| *n <= i64::MAX as u64)
        .ok_or("Capacity")?;
    save_settings(c, s)?;
    Ok(s.serial)
}
fn validate_snapshot(c: &Connection, p: Principal, snap: &LinkSnapshot, now: u64) -> R<()> {
    let s = enabled(c)?;
    let row = load_owner_lease(c, p)?;
    let (epoch, expires) = row.ok_or("Conflict")?;
    if s.epoch != snap.epoch
        || epoch as u64 != snap.owner_epoch
        || expires.map(|n| n as u64) != snap.lease_expires_at_ns
        || expires.is_some_and(|n| now >= n as u64)
    {
        return Err("Conflict".into());
    }
    Ok(())
}

fn load_owner_lease(c: &Connection, p: Principal) -> R<Option<(i64, Option<i64>)>> {
    c.query_row(
        "SELECT epoch,expires_at_ns FROM credit_bridge_owners WHERE wiki_owner=?1",
        params![p.to_text()],
        |r| Ok((crate::sqlite::row_get(r, 0)?, crate::sqlite::row_get(r, 1)?)),
    )
    .optional()
    .map_err(|e| e.to_string())
}
