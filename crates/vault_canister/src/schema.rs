use kinic_sqlite_compat::{self as sqlite, Connection, OptionalExtension, params};
pub(crate) fn initialize_vault_schema(db: &Connection) -> vault_types::Result<()> {
    let initialized: Option<i64> = db
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='global_settings'",
            params![],
            |r| sqlite::row_get(r, 0),
        )
        .optional()
        .map_err(|_| vault_types::Error::Storage)?;
    if initialized.is_none() {
        db.execute_batch(&[vault_store::SCHEMA,vault_store::CONTENT_SCHEMA,vault_store::RESTORE_SCHEMA,
            "CREATE INDEX uploads_expiry ON uploads(owner,expires); CREATE INDEX exports_expiry ON exports(owner,state,expires); CREATE INDEX restores_expiry ON restores(owner,expires); PRAGMA user_version=1;"].concat()).map_err(|_|vault_types::Error::Storage)?;
    }
    let version: i64 = db
        .query_row("PRAGMA user_version", params![], |r| sqlite::row_get(r, 0))
        .map_err(|_| vault_types::Error::Storage)?;
    if version == 1 {
        db.execute_batch(vault_store::EXPIRY_SCHEMA)
            .map_err(|_| vault_types::Error::Storage)?;
        db.execute_batch("PRAGMA user_version=2")
            .map_err(|_| vault_types::Error::Storage)?;
    }
    if matches!(version, 1 | 2) {
        db.execute_batch(vault_store::WRAPPER_SCHEMA)
            .map_err(|_| vault_types::Error::Storage)?;
        db.execute_batch("PRAGMA user_version=3")
            .map_err(|_| vault_types::Error::Storage)?;
    }
    if !matches!(version, 1 | 2 | 3) {
        return Err(vault_types::Error::Storage);
    }
    Ok(())
}
