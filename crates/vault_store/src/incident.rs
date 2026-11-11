//! Source pins live in the one prepaid transition slot, never in a per-record table.
use super::*;
pub fn status(db: &Connection) -> Result<Option<IncidentStatus>> {
    Ok(transition::load_state(db)?.incident)
}
pub fn pending(db: &Connection) -> Result<bool> {
    Ok(status(db)?.is_some_and(|j| !j.complete))
}
pub fn owner_change_allowed(db: &Connection) -> Result<()> {
    if transition::pending(db)? {
        Err(Error::Conflict)
    } else {
        Ok(())
    }
}
pub fn pinned(db: &Connection, vault: &[u8]) -> Result<bool> {
    transition::pinned(db, vault)
}
pub fn readable(db: &Connection, vault: &[u8]) -> Result<Header> {
    let h = header(db, vault)?;
    if h.state == VaultState::IncidentRequired
        && status(db)?.is_some_and(|j| {
            j.targets.iter().any(|t| {
                t.source.id == vault
                    && matches!(
                        t.phase,
                        PreparationPhase::Purging | PreparationPhase::Purged
                    )
            })
        })
    {
        return Err(Error::Conflict);
    }
    if matches!(h.state, VaultState::Active | VaultState::IncidentRequired) {
        Ok(h)
    } else {
        Err(Error::Conflict)
    }
}
/// TIME and sequence are captured together at entry. Current schema retires by sequence,
/// not time; keeping TIME explicit prevents a future expiry filter from changing membership.
pub fn snapshot(db: &Connection, vault: &[u8]) -> Result<(u64, u64)> {
    let j = status(db)?.filter(|j| !j.complete).ok_or(Error::NotFound)?;
    let t = j
        .targets
        .iter()
        .find(|t| {
            t.source.id == vault
                && !matches!(
                    t.phase,
                    PreparationPhase::Purging | PreparationPhase::Purged
                )
        })
        .ok_or(Error::NotFound)?;
    Ok((t.snapshot_time, t.snapshot_sequence))
}
