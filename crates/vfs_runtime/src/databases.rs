// Where: crates/vfs_runtime/src/databases.rs
// What: Database lifecycle - create, reserve, activate, migrate, delete, members, metadata.
// Why: Mechanical split out of lib.rs; a child module keeps same-crate private access.
use super::*;

impl VfsService {
    pub fn initial_free_database_grant_status(
        &self,
        caller: &str,
    ) -> Result<InitialFreeDatabaseGrantStatus, String> {
        self.read_index(|conn| load_initial_free_database_grant_status(conn, caller))
    }

    #[cfg(any(test, debug_assertions))]
    pub fn mark_initial_free_database_grant_used_for_test(
        &self,
        caller: &str,
        database_id: &str,
        now: i64,
    ) -> Result<(), String> {
        self.write_index(|tx| {
            if load_initial_free_database_grant(tx, caller)?.is_none() {
                insert_initial_free_database_grant(
                    tx,
                    caller,
                    database_id,
                    cycles_to_i64(INITIAL_FREE_DATABASE_GRANT_CYCLES)?,
                    now,
                )?;
            }
            Ok(())
        })
    }

    pub fn create_database(
        &self,
        database_id: &str,
        caller: &str,
        now: i64,
    ) -> Result<DatabaseMeta, String> {
        let meta = self.reserve_database(database_id, database_id, caller, now)?;
        if let Err(error) = self
            .run_database_migrations(database_id)
            .and_then(|_| self.seed_database_store_roots(&meta, now))
        {
            let cleanup_error = self.discard_database_reservation(&meta.database_id).err();
            return Err(match cleanup_error {
                Some(cleanup_error) => format!("{error}; cleanup failed: {cleanup_error}"),
                None => error,
            });
        }
        Ok(meta)
    }

    pub fn create_generated_database(
        &self,
        name: &str,
        caller: &str,
        now: i64,
    ) -> Result<DatabaseMeta, String> {
        let meta = self.reserve_generated_database(name, caller, now)?;
        if let Err(error) = self
            .run_database_migrations(&meta.database_id)
            .and_then(|_| self.seed_database_store_roots(&meta, now))
        {
            let cleanup_error = self.discard_database_reservation(&meta.database_id).err();
            return Err(match cleanup_error {
                Some(cleanup_error) => format!("{error}; cleanup failed: {cleanup_error}"),
                None => error,
            });
        }
        Ok(meta)
    }

    pub fn create_generated_database_with_initial_free_grant_or_pending(
        &self,
        name: &str,
        caller: &str,
        now: i64,
    ) -> Result<DatabaseCreateOutcome, String> {
        if self.initial_free_database_grant_status(caller)?.available {
            return self.create_generated_database_with_initial_free_grant(name, caller, now);
        }
        let meta = self.reserve_pending_generated_database(name, caller, now)?;
        Ok(DatabaseCreateOutcome {
            meta,
            status: DatabaseStatus::Pending,
            initial_free_grant_applied: false,
        })
    }

    fn create_generated_database_with_initial_free_grant(
        &self,
        name: &str,
        caller: &str,
        now: i64,
    ) -> Result<DatabaseCreateOutcome, String> {
        let cycles_i64 = cycles_to_i64(INITIAL_FREE_DATABASE_GRANT_CYCLES)?;
        let metadata = normalize_database_metadata(DatabaseMetadata {
            name: name.to_string(),
            description: String::new(),
            llm_summary: None,
            tags_json: "[]".to_string(),
        })?;
        let meta = self.write_index(|tx| {
            if load_initial_free_database_grant(tx, caller)?.is_some() {
                return Err("initial free database grant already used".to_string());
            }
            let mount_id = allocate_mount_id(tx)?;
            let mut selected_database_id = None;
            for attempt in 0_u32..100 {
                let database_id = generated_database_id(caller, now, mount_id, attempt);
                if !database_exists(tx, &database_id)? {
                    selected_database_id = Some(database_id);
                    break;
                }
            }
            let database_id = selected_database_id
                .ok_or_else(|| "failed to generate unique database id".to_string())?;
            let meta = self.insert_database_reservation(
                tx,
                &database_id,
                &metadata,
                caller,
                now,
                mount_id,
                cycles_i64,
            )?;
            insert_initial_free_database_grant(tx, caller, &database_id, cycles_i64, now)?;
            insert_database_ledger(
                tx,
                DatabaseLedgerInsert {
                    database_id: &database_id,
                    kind: "free_grant",
                    amount_cycles: cycles_i64,
                    balance_after_cycles: cycles_i64,
                    payment_amount_e8s: None,
                    caller,
                    method: Some("create_database"),
                    cycles_delta: None,
                    config: None,
                    ledger_block_index: None,
                    now,
                },
            )?;
            Ok(meta)
        })?;
        if let Err(error) = self
            .run_database_migrations(&meta.database_id)
            .and_then(|_| self.seed_database_store_roots(&meta, now))
        {
            let mut cleanup_errors = Vec::new();
            if let Err(cleanup_error) = self.discard_database_reservation(&meta.database_id) {
                cleanup_errors.push(format!(
                    "discard_database_reservation failed: {cleanup_error}"
                ));
            }
            if let Err(cleanup_error) = self.delete_initial_free_database_grant(caller) {
                cleanup_errors.push(format!(
                    "delete_initial_free_database_grant failed: {cleanup_error}"
                ));
            }
            if cleanup_errors.is_empty() {
                return Err(error);
            }
            return Err(format!(
                "{error}; cleanup failed: {}",
                cleanup_errors.join("; ")
            ));
        }
        Ok(DatabaseCreateOutcome {
            meta,
            status: DatabaseStatus::Active,
            initial_free_grant_applied: true,
        })
    }

    pub fn reserve_generated_database_for_mount(
        &self,
        name: &str,
        caller: &str,
        now: i64,
    ) -> Result<DatabaseMeta, String> {
        self.reserve_generated_database(name, caller, now)
    }

    pub fn reserve_pending_generated_database(
        &self,
        name: &str,
        caller: &str,
        now: i64,
    ) -> Result<DatabaseMeta, String> {
        let metadata = normalize_database_metadata(DatabaseMetadata {
            name: name.to_string(),
            description: String::new(),
            llm_summary: None,
            tags_json: "[]".to_string(),
        })?;
        self.write_index(|tx| {
            purge_expired_unstarted_pending_databases(tx, caller, now)?;
            let pending_count = pending_database_count_for_caller(tx, caller)?;
            if pending_count >= MAX_PENDING_DATABASES_PER_CALLER {
                return Err("too many pending databases for caller".to_string());
            }
            let mut selected_database_id = None;
            for attempt in 0_u32..100 {
                let database_id =
                    generated_database_id(caller, now, PENDING_DATABASE_MOUNT_ID, attempt);
                if !database_exists(tx, &database_id)? {
                    selected_database_id = Some(database_id);
                    break;
                }
            }
            let database_id = selected_database_id
                .ok_or_else(|| "failed to generate unique database id".to_string())?;
            self.insert_pending_database_reservation(tx, &database_id, &metadata, caller, now)
        })
    }

    fn reserve_generated_database(
        &self,
        name: &str,
        caller: &str,
        now: i64,
    ) -> Result<DatabaseMeta, String> {
        let metadata = normalize_database_metadata(DatabaseMetadata {
            name: name.to_string(),
            description: String::new(),
            llm_summary: None,
            tags_json: "[]".to_string(),
        })?;
        self.write_index(|tx| {
            let mount_id = allocate_mount_id(tx)?;
            let mut selected_database_id = None;
            for attempt in 0_u32..100 {
                let database_id = generated_database_id(caller, now, mount_id, attempt);
                if !database_exists(tx, &database_id)? {
                    selected_database_id = Some(database_id);
                    break;
                }
            }
            let database_id = selected_database_id
                .ok_or_else(|| "failed to generate unique database id".to_string())?;
            self.insert_database_reservation(tx, &database_id, &metadata, caller, now, mount_id, 0)
        })
    }

    pub fn reserve_database(
        &self,
        database_id: &str,
        name: &str,
        caller: &str,
        now: i64,
    ) -> Result<DatabaseMeta, String> {
        validate_database_id(database_id)?;
        let metadata = normalize_database_metadata(DatabaseMetadata {
            name: name.to_string(),
            description: String::new(),
            llm_summary: None,
            tags_json: "[]".to_string(),
        })?;
        self.write_index(|tx| {
            if database_exists(tx, database_id)? {
                return Err(format!("database already exists: {database_id}"));
            }
            let mount_id = allocate_mount_id(tx)?;
            self.insert_database_reservation(tx, database_id, &metadata, caller, now, mount_id, 0)
        })
    }

    #[allow(clippy::too_many_arguments)]
    fn insert_database_reservation(
        &self,
        tx: &Transaction<'_>,
        database_id: &str,
        metadata: &DatabaseMetadata,
        caller: &str,
        now: i64,
        mount_id: u16,
        initial_cycles_balance: i64,
    ) -> Result<DatabaseMeta, String> {
        let db_file_name = self.database_file_name(database_id, mount_id)?;
        let values = vec![
            crate::sqlite::text_value(database_id),
            crate::sqlite::text_value(metadata.name.as_str()),
            crate::sqlite::text_value(metadata.description.as_str()),
            crate::sqlite::nullable_text_value(metadata.llm_summary.clone()),
            crate::sqlite::text_value(metadata.tags_json.as_str()),
            crate::sqlite::text_value(db_file_name.as_str()),
            crate::sqlite::integer_value(i64::from(mount_id)),
            crate::sqlite::text_value(DATABASE_SCHEMA_VERSION),
            crate::sqlite::integer_value(now),
        ];
        crate::sqlite::execute_values(
            tx,
            "INSERT INTO databases
             (database_id, name, description, llm_summary, tags_json, db_file_name, mount_id,
              active_mount_id, status, schema_version, logical_size_bytes, created_at_ms, updated_at_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7, 'active', ?8, 0, ?9, ?9)",
            &values,
        )
        .map_err(|error| error.to_string())?;
        record_mount_history(tx, database_id, mount_id, "create", now)?;
        insert_initial_database_members(tx, database_id, caller, now)?;
        let suspended_at_ms = if initial_cycles_balance == 0 {
            Some(now)
        } else {
            None
        };
        let values = vec![
            crate::sqlite::text_value(database_id),
            crate::sqlite::integer_value(initial_cycles_balance),
            crate::sqlite::nullable_integer_value(suspended_at_ms),
            crate::sqlite::integer_value(now),
        ];
        crate::sqlite::execute_values(
            tx,
            "INSERT INTO database_cycle_accounts
             (database_id, balance_cycles, suspended_at_ms, storage_charged_at_ms,
              created_at_ms, updated_at_ms)
             VALUES (?1, ?2, ?3, ?4, ?4, ?4)",
            &values,
        )
        .map_err(|error| error.to_string())?;
        Ok(DatabaseMeta {
            database_id: database_id.to_string(),
            metadata: metadata.clone(),
            db_file_name,
            mount_id,
            schema_version: DATABASE_SCHEMA_VERSION.to_string(),
            logical_size_bytes: 0,
        })
    }

    fn insert_pending_database_reservation(
        &self,
        tx: &Transaction<'_>,
        database_id: &str,
        metadata: &DatabaseMetadata,
        caller: &str,
        now: i64,
    ) -> Result<DatabaseMeta, String> {
        let values = vec![
            crate::sqlite::text_value(database_id),
            crate::sqlite::text_value(metadata.name.as_str()),
            crate::sqlite::text_value(metadata.description.as_str()),
            crate::sqlite::nullable_text_value(metadata.llm_summary.clone()),
            crate::sqlite::text_value(metadata.tags_json.as_str()),
            crate::sqlite::integer_value(i64::from(PENDING_DATABASE_MOUNT_ID)),
            crate::sqlite::text_value(DATABASE_SCHEMA_VERSION),
            crate::sqlite::integer_value(now),
        ];
        crate::sqlite::execute_values(
            tx,
            "INSERT INTO databases
             (database_id, name, description, llm_summary, tags_json, db_file_name, mount_id,
              active_mount_id, status, schema_version, logical_size_bytes, created_at_ms, updated_at_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, '', ?6, NULL, 'pending', ?7, 0, ?8, ?8)",
            &values,
        )
        .map_err(|error| error.to_string())?;
        insert_initial_database_members(tx, database_id, caller, now)?;
        tx.execute(
            "INSERT INTO database_cycle_accounts
             (database_id, balance_cycles, suspended_at_ms, storage_charged_at_ms,
              created_at_ms, updated_at_ms)
             VALUES (?1, 0, ?2, NULL, ?2, ?2)",
            params![database_id, now],
        )
        .map_err(|error| error.to_string())?;
        Ok(DatabaseMeta {
            database_id: database_id.to_string(),
            metadata: metadata.clone(),
            db_file_name: String::new(),
            mount_id: PENDING_DATABASE_MOUNT_ID,
            schema_version: DATABASE_SCHEMA_VERSION.to_string(),
            logical_size_bytes: 0,
        })
    }

    pub fn discard_database_reservation(&self, database_id: &str) -> Result<(), String> {
        #[cfg(any(test, debug_assertions))]
        {
            let should_fail = {
                let mut next_failure = TEST_DISCARD_DATABASE_RESERVATION_FAIL_ONCE
                    .lock()
                    .expect("test discard failure lock should not poison");
                next_failure.remove(database_id)
            };
            if should_fail {
                return Err("test discard database reservation failure".to_string());
            }
        }
        let db_file_name = self.write_index(|tx| {
            let db_file_name: Option<String> = tx
                .query_row(
                    "SELECT db_file_name
                 FROM databases
                 WHERE database_id = ?1",
                    params![database_id],
                    |row| crate::sqlite::row_get(row, 0),
                )
                .optional()
                .map_err(|error| error.to_string())?;
            tx.execute(
                "DELETE FROM database_cycle_ledger WHERE database_id = ?1",
                params![database_id],
            )
            .map_err(|error| error.to_string())?;
            tx.execute(
                "DELETE FROM database_cycle_pending_operations WHERE database_id = ?1",
                params![database_id],
            )
            .map_err(|error| error.to_string())?;
            tx.execute(
                "DELETE FROM database_cycle_accounts WHERE database_id = ?1",
                params![database_id],
            )
            .map_err(|error| error.to_string())?;
            tx.execute(
                "DELETE FROM market_entitlements WHERE database_id = ?1",
                params![database_id],
            )
            .map_err(|error| error.to_string())?;
            tx.execute(
                "DELETE FROM market_listings WHERE database_id = ?1",
                params![database_id],
            )
            .map_err(|error| error.to_string())?;
            tx.execute(
                "DELETE FROM database_members WHERE database_id = ?1",
                params![database_id],
            )
            .map_err(|error| error.to_string())?;
            tx.execute(
                "DELETE FROM database_mount_history WHERE database_id = ?1",
                params![database_id],
            )
            .map_err(|error| error.to_string())?;
            tx.execute(
                "DELETE FROM databases WHERE database_id = ?1",
                params![database_id],
            )
            .map_err(|error| error.to_string())?;
            Ok(db_file_name)
        })?;
        #[cfg(target_arch = "wasm32")]
        let _ = &db_file_name;
        #[cfg(not(target_arch = "wasm32"))]
        if let Some(db_file_name) = db_file_name
            && let Err(error) = remove_file(&db_file_name)
            && error.kind() != std::io::ErrorKind::NotFound
        {
            return Err(error.to_string());
        }
        Ok(())
    }

    fn delete_initial_free_database_grant(&self, caller: &str) -> Result<(), String> {
        self.write_index(|tx| {
            tx.execute(
                "DELETE FROM database_free_cycle_grants WHERE principal = ?1",
                params![caller],
            )
            .map_err(|error| error.to_string())?;
            Ok(())
        })
    }

    pub fn prepare_pending_database_activation(
        &self,
        database_id: &str,
        now: i64,
    ) -> Result<Option<DatabaseMeta>, String> {
        let activation = self
            .write_index(|tx| self.activate_pending_database_mount_for_tx(tx, database_id, now))?;
        if let Some(meta) = &activation {
            self.run_database_migrations_for_meta(database_id, meta)?;
            self.seed_database_store_roots(meta, now)?;
        }
        Ok(activation)
    }

    fn activate_pending_database_mount_for_tx(
        &self,
        tx: &Connection,
        database_id: &str,
        now: i64,
    ) -> Result<Option<DatabaseMeta>, String> {
        let status = load_database_status(tx, database_id)?;
        if status != DatabaseStatus::Pending {
            return Ok(None);
        }
        let (db_file_name, mount_id, active_mount_id): (String, i64, Option<i64>) = tx
            .query_row(
                "SELECT db_file_name, mount_id, active_mount_id
                 FROM databases
                 WHERE database_id = ?1",
                params![database_id],
                |row| {
                    Ok((
                        crate::sqlite::row_get(row, 0)?,
                        crate::sqlite::row_get(row, 1)?,
                        crate::sqlite::row_get(row, 2)?,
                    ))
                },
            )
            .map_err(|error| error.to_string())?;
        if active_mount_id.is_some() {
            return load_database_with_statuses(tx, database_id, &[DatabaseStatus::Pending]);
        }
        if mount_id != i64::from(PENDING_DATABASE_MOUNT_ID) {
            if db_file_name.is_empty() {
                return Err(format!(
                    "pending database activation is staged without a db file name: {database_id}"
                ));
            }
            return load_pending_database_activation_meta(tx, database_id);
        }
        let mount_id = allocate_mount_id(tx)?;
        let db_file_name = self.database_file_name(database_id, mount_id)?;
        record_mount_history(tx, database_id, mount_id, "activate", now)?;
        tx.execute(
            "UPDATE databases
             SET db_file_name = ?2,
                 mount_id = ?3,
                 updated_at_ms = ?4
             WHERE database_id = ?1 AND status = 'pending'",
            params![database_id, db_file_name, i64::from(mount_id), now],
        )
        .map_err(|error| error.to_string())?;
        load_pending_database_activation_meta(tx, database_id)
    }

    pub fn run_database_migrations(&self, database_id: &str) -> Result<(), String> {
        let meta = self.database_meta(database_id)?;
        self.run_database_migrations_for_meta(database_id, &meta)
    }

    pub fn run_pending_database_migrations(&self, database_id: &str) -> Result<(), String> {
        let meta = self.database_meta_with_statuses(database_id, &[DatabaseStatus::Pending])?;
        self.run_database_migrations_for_meta(database_id, &meta)
    }

    fn run_database_migrations_for_meta(
        &self,
        database_id: &str,
        meta: &DatabaseMeta,
    ) -> Result<(), String> {
        #[cfg(any(test, debug_assertions))]
        {
            let should_fail = {
                let mut next_failure = TEST_DATABASE_MIGRATION_FAIL_ONCE
                    .lock()
                    .expect("test migration failure lock should not poison");
                next_failure.remove(database_id)
            };
            if should_fail {
                return Err("test database migration failure".to_string());
            }
        }
        #[cfg(not(target_arch = "wasm32"))]
        if let Some(parent) = Path::new(&meta.db_file_name).parent() {
            create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let result = self.database_store(meta)?.run_fs_migrations();
        if result.is_ok() {
            let _ = self.refresh_logical_size_for_meta(database_id, meta);
        }
        result
    }

    fn seed_database_store_roots(&self, meta: &DatabaseMeta, now: i64) -> Result<(), String> {
        let store = self.database_store(meta)?;
        for seed in database_store_seed_nodes() {
            if let Some(existing) = store.read_node(seed.path)? {
                if existing.kind != seed.kind {
                    return Err(format!(
                        "store seed path has kind {:?} but expected {:?}: {}",
                        existing.kind, seed.kind, seed.path
                    ));
                }
                continue;
            }
            store.mkdir_node(
                MkdirNodeRequest {
                    database_id: meta.database_id.clone(),
                    path: seed.path.to_string(),
                },
                now,
            )?;
        }
        Ok(())
    }

    pub fn delete_database(
        &self,
        request: DeleteDatabaseRequest,
        caller: &str,
        _now: i64,
    ) -> Result<(), String> {
        let database_id = request.database_id.as_str();
        self.require_role(database_id, caller, RequiredRole::Owner)?;
        self.require_no_pending_cycles_operations(database_id)?;
        let status = self.read_index(|conn| load_database_status(conn, database_id))?;
        if !matches!(status, DatabaseStatus::Pending | DatabaseStatus::Active) {
            return Err(format!(
                "database is {}: {database_id}",
                status_to_db(status)
            ));
        }
        let meta = self.database_meta(database_id).ok();
        #[cfg(target_arch = "wasm32")]
        let _ = &meta;
        #[cfg(not(target_arch = "wasm32"))]
        if let Some(meta) = &meta
            && let Err(error) = remove_file(&meta.db_file_name)
            && error.kind() != std::io::ErrorKind::NotFound
        {
            return Err(error.to_string());
        }
        self.write_index(|conn| {
            delete_database_index_rows(conn, database_id)?;
            Ok(())
        })
    }

    fn require_no_pending_cycles_operations(&self, database_id: &str) -> Result<(), String> {
        self.read_index(|conn| {
            let pending = cycles::first_database_cycles_pending_purchase_status(conn, database_id)?;
            if let Some(pending) = pending {
                return Err(format!(
                    "database has pending cycle operation: {database_id}; operation_id={}; status={}; required_action={}",
                    pending.operation_id,
                    pending.status,
                    pending.required_action
                ));
            }
            Ok(())
        })
    }

    pub fn grant_database_access(
        &self,
        database_id: &str,
        caller: &str,
        principal: &str,
        role: DatabaseRole,
        now: i64,
    ) -> Result<(), String> {
        self.require_role(database_id, caller, RequiredRole::Owner)?;
        if caller == principal && role != DatabaseRole::Owner {
            return Err("owner cannot downgrade own access".to_string());
        }
        self.write_index(|conn| {
            if !database_member_exists(conn, database_id, principal)? {
                let member_count = database_member_count_for_conn(conn, database_id)?;
                if member_count >= MAX_DATABASE_MEMBERS_PER_DATABASE {
                    return Err("too many database members".to_string());
                }
            }
            conn.execute(
                "INSERT INTO database_members (database_id, principal, role, created_at_ms)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(database_id, principal)
             DO UPDATE SET role = excluded.role",
                params![database_id, principal, role_to_db(role), now],
            )
            .map_err(|error| error.to_string())?;
            Ok(())
        })
    }

    pub fn update_database_metadata(
        &self,
        caller: &str,
        request: UpdateDatabaseMetadataRequest,
        now: i64,
    ) -> Result<DatabaseMetadata, String> {
        validate_database_id(&request.database_id)?;
        self.require_role(&request.database_id, caller, RequiredRole::Owner)?;
        self.database_meta(&request.database_id)?;
        let metadata = normalize_database_metadata(DatabaseMetadata {
            name: request.name,
            description: request.description,
            llm_summary: request.llm_summary,
            tags_json: request.tags_json,
        })?;
        self.write_index(|conn| {
            let values = vec![
                crate::sqlite::text_value(request.database_id.as_str()),
                crate::sqlite::text_value(metadata.name.as_str()),
                crate::sqlite::text_value(metadata.description.as_str()),
                crate::sqlite::nullable_text_value(metadata.llm_summary.clone()),
                crate::sqlite::text_value(metadata.tags_json.as_str()),
                crate::sqlite::integer_value(now),
            ];
            crate::sqlite::execute_values(
                conn,
                "UPDATE databases
                 SET name = ?2,
                     description = ?3,
                     llm_summary = ?4,
                     tags_json = ?5,
                     updated_at_ms = ?6
                 WHERE database_id = ?1",
                &values,
            )
            .map_err(|error| error.to_string())?;
            Ok(())
        })?;
        Ok(metadata)
    }

    pub fn rename_database(
        &self,
        caller: &str,
        request: vfs_types::RenameDatabaseRequest,
        now: i64,
    ) -> Result<(), String> {
        validate_database_id(&request.database_id)?;
        self.require_role(&request.database_id, caller, RequiredRole::Owner)?;
        let mut metadata = self.database_meta(&request.database_id)?.metadata;
        metadata.name = request.name;
        let metadata = normalize_database_metadata(metadata)?;
        self.write_index(|conn| {
            conn.execute(
                "UPDATE databases
                 SET name = ?2,
                     updated_at_ms = ?3
                 WHERE database_id = ?1",
                params![request.database_id, metadata.name, now],
            )
            .map_err(|error| error.to_string())?;
            Ok(())
        })
    }

    pub fn revoke_database_access(
        &self,
        database_id: &str,
        caller: &str,
        principal: &str,
    ) -> Result<(), String> {
        self.require_role(database_id, caller, RequiredRole::Owner)?;
        self.database_meta(database_id)?;
        if caller == principal {
            return Err("owner cannot revoke own access".to_string());
        }
        self.write_index(|conn| {
            conn.execute(
                "DELETE FROM database_members WHERE database_id = ?1 AND principal = ?2",
                params![database_id, principal],
            )
            .map_err(|error| error.to_string())?;
            Ok(())
        })
    }

    pub fn list_database_members(
        &self,
        database_id: &str,
        caller: &str,
    ) -> Result<Vec<DatabaseMember>, String> {
        self.database_meta(database_id)?;
        self.read_index(|conn| {
            let caller_role = load_member_role(conn, database_id, caller)?
                .ok_or_else(|| format!("principal has no access to database: {database_id}"))?;
            if caller_role != DatabaseRole::Owner
                && !(caller == ANONYMOUS_PRINCIPAL
                    && role_allows(caller_role, RequiredRole::Reader))
            {
                return Err(format!(
                    "principal lacks required database role: {database_id}"
                ));
            }
            let mut stmt = conn
                .prepare(
                    "SELECT database_id, principal, role, created_at_ms
             FROM database_members
             WHERE database_id = ?1
             ORDER BY principal ASC",
                )
                .map_err(|error| error.to_string())?;
            crate::sqlite::query_map(&mut stmt, params![database_id], |row| {
                Ok(DatabaseMember {
                    database_id: crate::sqlite::row_get(row, 0)?,
                    principal: crate::sqlite::row_get(row, 1)?,
                    role: role_from_db(&crate::sqlite::row_get::<String>(row, 2)?)?,
                    created_at_ms: crate::sqlite::row_get(row, 3)?,
                })
            })
            .map_err(|error| error.to_string())
        })
    }
}

pub(crate) fn delete_database_index_rows(
    conn: &Connection,
    database_id: &str,
) -> Result<(), String> {
    for table in [
        "database_cycle_pending_operations",
        "database_cycle_ledger",
        "database_cycle_accounts",
        "market_entitlements",
        "market_listings",
        "database_members",
        "source_capture_trigger_sessions",
        "ops_answer_sessions",
        "source_run_sessions",
        "databases",
    ] {
        let sql = format!("DELETE FROM {table} WHERE database_id = ?1");
        conn.execute(&sql, params![database_id])
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

pub(crate) fn purge_expired_unstarted_pending_databases(
    conn: &Transaction<'_>,
    caller: &str,
    now: i64,
) -> Result<(), String> {
    let expires_before = now.saturating_sub(PENDING_DATABASE_TTL_MS);
    let expired_database_ids = {
        let mut stmt = conn
            .prepare(
                "SELECT d.database_id
                 FROM databases d
                 JOIN database_members m ON m.database_id = d.database_id
                 WHERE d.status = 'pending'
                   AND d.active_mount_id IS NULL
                   AND d.mount_id = ?3
                   AND d.created_at_ms <= ?2
                   AND m.principal = ?1
                   AND m.role = 'owner'
                   AND NOT EXISTS (
                     SELECT 1
                     FROM database_cycle_pending_operations p
                     WHERE p.database_id = d.database_id
                   )
                 ORDER BY d.created_at_ms ASC",
            )
            .map_err(|error| error.to_string())?;
        crate::sqlite::query_map(
            &mut stmt,
            params![caller, expires_before, i64::from(PENDING_DATABASE_MOUNT_ID)],
            |row| crate::sqlite::row_get::<String>(row, 0),
        )
        .map_err(|error| error.to_string())?
    };
    for database_id in expired_database_ids {
        delete_database_index_rows(conn, &database_id)?;
    }
    Ok(())
}

pub(crate) fn pending_database_count_for_caller(
    conn: &Connection,
    caller: &str,
) -> Result<i64, String> {
    conn.query_row(
        "SELECT COUNT(*)
         FROM databases d
         JOIN database_members m ON m.database_id = d.database_id
         WHERE d.status = 'pending'
           AND d.active_mount_id IS NULL
           AND d.mount_id = ?2
           AND m.principal = ?1
           AND m.role = 'owner'",
        params![caller, i64::from(PENDING_DATABASE_MOUNT_ID)],
        |row| crate::sqlite::row_get(row, 0),
    )
    .map_err(|error| error.to_string())
}

pub(crate) fn load_initial_free_database_grant_status(
    conn: &Connection,
    caller: &str,
) -> Result<InitialFreeDatabaseGrantStatus, String> {
    match load_initial_free_database_grant(conn, caller)? {
        Some((database_id, grant_cycles, created_at_ms)) => Ok(InitialFreeDatabaseGrantStatus {
            available: false,
            grant_cycles,
            database_id: Some(database_id),
            created_at_ms: Some(created_at_ms),
        }),
        None => Ok(InitialFreeDatabaseGrantStatus {
            available: true,
            grant_cycles: INITIAL_FREE_DATABASE_GRANT_CYCLES,
            database_id: None,
            created_at_ms: None,
        }),
    }
}

pub(crate) fn load_initial_free_database_grant(
    conn: &Connection,
    caller: &str,
) -> Result<Option<(String, u64, i64)>, String> {
    conn.query_row(
        "SELECT database_id, grant_cycles, created_at_ms
         FROM database_free_cycle_grants
         WHERE principal = ?1",
        params![caller],
        |row| {
            let grant_cycles: i64 = crate::sqlite::row_get(row, 1)?;
            Ok((
                crate::sqlite::row_get(row, 0)?,
                grant_cycles.max(0) as u64,
                crate::sqlite::row_get(row, 2)?,
            ))
        },
    )
    .optional()
    .map_err(|error| error.to_string())
}

pub(crate) fn insert_initial_free_database_grant(
    conn: &Connection,
    caller: &str,
    database_id: &str,
    grant_cycles: i64,
    now: i64,
) -> Result<(), String> {
    conn.execute(
        "INSERT INTO database_free_cycle_grants
         (principal, database_id, grant_cycles, created_at_ms)
         VALUES (?1, ?2, ?3, ?4)",
        params![caller, database_id, grant_cycles, now],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

pub(crate) fn complete_pending_database_activation(
    conn: &Connection,
    database_id: &str,
    now: i64,
) -> Result<(), String> {
    let status = load_database_status(conn, database_id)?;
    if status != DatabaseStatus::Pending {
        return Ok(());
    }
    let (db_file_name, mount_id, active_mount_id): (String, i64, Option<i64>) = conn
        .query_row(
            "SELECT db_file_name, mount_id, active_mount_id
             FROM databases
             WHERE database_id = ?1",
            params![database_id],
            |row| {
                Ok((
                    crate::sqlite::row_get(row, 0)?,
                    crate::sqlite::row_get(row, 1)?,
                    crate::sqlite::row_get(row, 2)?,
                ))
            },
        )
        .map_err(|error| error.to_string())?;
    if mount_id == i64::from(PENDING_DATABASE_MOUNT_ID) || db_file_name.is_empty() {
        return Err(format!(
            "pending database has no activation mount: {database_id}"
        ));
    }
    let active_mount_id = active_mount_id.unwrap_or(mount_id);
    conn.execute(
        "UPDATE databases
         SET status = 'active',
             active_mount_id = ?2,
             updated_at_ms = ?3
         WHERE database_id = ?1 AND status = 'pending'",
        params![database_id, active_mount_id, now],
    )
    .map_err(|error| error.to_string())?;
    conn.execute(
        "UPDATE database_cycle_accounts
         SET storage_charged_at_ms = COALESCE(storage_charged_at_ms, ?2),
             updated_at_ms = ?2
         WHERE database_id = ?1",
        params![database_id, now],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

pub(crate) fn database_balance_for_update(
    conn: &Transaction<'_>,
    database_id: &str,
) -> Result<i64, String> {
    conn.query_row(
        "SELECT balance_cycles FROM database_cycle_accounts WHERE database_id = ?1",
        params![database_id],
        |row| crate::sqlite::row_get(row, 0),
    )
    .optional()
    .map_err(|error| error.to_string())?
    .ok_or_else(|| format!("database cycles account not found: {database_id}"))
}

pub(crate) fn update_database_cycles_balance(
    conn: &Transaction<'_>,
    database_id: &str,
    balance: i64,
    config: &CyclesBillingConfig,
    now: i64,
) -> Result<(), String> {
    let min = cycles_to_i64(config.min_update_cycles)?;
    let suspended_at_ms = if balance >= min { None } else { Some(now) };
    let values = vec![
        crate::sqlite::text_value(database_id),
        crate::sqlite::integer_value(balance),
        crate::sqlite::nullable_integer_value(suspended_at_ms),
        crate::sqlite::integer_value(now),
    ];
    crate::sqlite::execute_values(
        conn,
        "UPDATE database_cycle_accounts
         SET balance_cycles = ?2, suspended_at_ms = ?3, updated_at_ms = ?4
         WHERE database_id = ?1",
        &values,
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

pub(crate) fn page_limit(limit: u32) -> u32 {
    limit.clamp(1, 100)
}

pub(crate) fn map_database_cycles_entry(
    row: &crate::sqlite::Row<'_>,
) -> crate::sqlite::Result<DatabaseCycleEntry> {
    let entry_id: i64 = crate::sqlite::row_get(row, 0)?;
    let balance_after: i64 = crate::sqlite::row_get(row, 4)?;
    let payment_amount_e8s: Option<i64> = crate::sqlite::row_get(row, 5)?;
    let cycles_delta: Option<i64> = crate::sqlite::row_get(row, 8)?;
    let cycles_per_kinic: Option<i64> = crate::sqlite::row_get(row, 9)?;
    let ledger_block_index: Option<i64> = crate::sqlite::row_get(row, 10)?;
    Ok(DatabaseCycleEntry {
        entry_id: entry_id.max(0) as u64,
        database_id: crate::sqlite::row_get(row, 1)?,
        kind: crate::sqlite::row_get(row, 2)?,
        amount_cycles: crate::sqlite::row_get(row, 3)?,
        balance_after_cycles: balance_after.max(0) as u64,
        payment_amount_e8s: payment_amount_e8s.map(|value| value.max(0) as u64),
        caller: crate::sqlite::row_get(row, 6)?,
        method: crate::sqlite::row_get(row, 7)?,
        cycles_delta: cycles_delta.map(|value| value.max(0) as u64),
        cycles_per_kinic: cycles_per_kinic.map(|value| value.max(0) as u64),
        ledger_block_index: ledger_block_index.map(|value| value.max(0) as u64),
        created_at_ms: crate::sqlite::row_get(row, 11)?,
    })
}

pub(crate) fn validate_database_id(database_id: &str) -> Result<(), String> {
    if database_id.is_empty() || database_id.len() > 64 {
        return Err("database_id must be 1..64 characters".to_string());
    }
    if !database_id
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err("database_id may only contain ASCII letters, digits, '-' and '_'".to_string());
    }
    Ok(())
}

pub(crate) fn normalize_database_metadata(
    metadata: DatabaseMetadata,
) -> Result<DatabaseMetadata, String> {
    let name = normalize_database_name(&metadata.name)?;
    validate_database_multiline_text(
        "database description",
        &metadata.description,
        0,
        MAX_DATABASE_DESCRIPTION_CHARS,
    )?;
    if let Some(summary) = metadata.llm_summary.as_deref() {
        validate_database_multiline_text(
            "database summary",
            summary,
            0,
            MAX_DATABASE_DESCRIPTION_CHARS,
        )?;
    }
    validate_database_text(
        "database tags",
        &metadata.tags_json,
        0,
        MAX_DATABASE_JSON_CHARS,
    )?;
    validate_database_tags_json(&metadata.tags_json)?;
    Ok(DatabaseMetadata {
        name,
        description: metadata.description,
        llm_summary: metadata.llm_summary,
        tags_json: metadata.tags_json,
    })
}

pub(crate) fn normalize_database_name(name: &str) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > MAX_DATABASE_NAME_CHARS {
        return Err(format!(
            "database name must be 1..{MAX_DATABASE_NAME_CHARS} characters"
        ));
    }
    if name.chars().any(char::is_control) {
        return Err("database name may not contain control characters".to_string());
    }
    Ok(name.to_string())
}

pub(crate) fn validate_database_text(
    label: &str,
    value: &str,
    min_chars: usize,
    max_chars: usize,
) -> Result<(), String> {
    let count = value.chars().count();
    if count < min_chars || count > max_chars {
        return Err(format!(
            "{label} must be {min_chars}..{max_chars} characters"
        ));
    }
    if value.chars().any(char::is_control) {
        return Err(format!("{label} may not contain control characters"));
    }
    Ok(())
}

pub(crate) fn validate_database_multiline_text(
    label: &str,
    value: &str,
    min_chars: usize,
    max_chars: usize,
) -> Result<(), String> {
    let count = value.chars().count();
    if count < min_chars || count > max_chars {
        return Err(format!(
            "{label} must be {min_chars}..{max_chars} characters"
        ));
    }
    if value
        .chars()
        .any(|character| character.is_control() && !matches!(character, '\n' | '\r' | '\t'))
    {
        return Err(format!(
            "{label} may only contain newline, carriage return, or tab control characters"
        ));
    }
    Ok(())
}

pub(crate) fn validate_database_tags_json(tags_json: &str) -> Result<(), String> {
    let tags: Vec<String> = serde_json::from_str(tags_json)
        .map_err(|error| format!("database tags_json must be a JSON string array: {error}"))?;
    for tag in tags {
        if tag.trim().is_empty() {
            return Err("database tags_json must not contain empty tags".to_string());
        }
        if tag.chars().any(char::is_control) {
            return Err("database tags_json must not contain control characters".to_string());
        }
    }
    Ok(())
}

pub(crate) fn generated_database_id(caller: &str, now: i64, mount_id: u16, attempt: u32) -> String {
    let mut hasher = Sha256::new();
    hasher.update(caller.as_bytes());
    hasher.update(now.to_be_bytes());
    hasher.update(mount_id.to_be_bytes());
    hasher.update(attempt.to_be_bytes());
    format!(
        "{GENERATED_DATABASE_ID_PREFIX}{}",
        &base32_lower(&hasher.finalize())[..GENERATED_DATABASE_ID_HASH_CHARS]
    )
}

#[cfg(any(test, debug_assertions))]
pub fn generated_database_id_for_test(
    caller: &str,
    now: i64,
    mount_id: u16,
    attempt: u32,
) -> String {
    generated_database_id(caller, now, mount_id, attempt)
}

pub(crate) fn base32_lower(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 32] = b"abcdefghijklmnopqrstuvwxyz234567";
    let mut output = String::new();
    let mut buffer = 0_u16;
    let mut bit_count = 0_u8;
    for byte in bytes {
        buffer = (buffer << 8) | u16::from(*byte);
        bit_count += 8;
        while bit_count >= 5 {
            let shift = bit_count - 5;
            let index = ((buffer >> shift) & 0b11111) as usize;
            output.push(ALPHABET[index] as char);
            bit_count -= 5;
            buffer &= (1_u16 << bit_count) - 1;
        }
    }
    if bit_count > 0 {
        let index = ((buffer << (5 - bit_count)) & 0b11111) as usize;
        output.push(ALPHABET[index] as char);
    }
    output
}

#[cfg(not(target_arch = "wasm32"))]
pub(crate) fn database_file_name(
    databases_dir: &Path,
    database_id: &str,
) -> Result<String, String> {
    validate_database_id(database_id)?;
    Ok(databases_dir
        .join(format!("{database_id}.sqlite3"))
        .to_string_lossy()
        .into_owned())
}

pub(crate) fn database_exists(conn: &Connection, database_id: &str) -> Result<bool, String> {
    conn.query_row(
        "SELECT 1 FROM databases WHERE database_id = ?1",
        params![database_id],
        |_| Ok(()),
    )
    .optional()
    .map(|row| row.is_some())
    .map_err(|error| error.to_string())
}

pub(crate) fn database_has_owner(conn: &Connection, database_id: &str) -> Result<bool, String> {
    conn.query_row(
        "SELECT 1 FROM database_members
         WHERE database_id = ?1 AND role = 'owner'
         LIMIT 1",
        params![database_id],
        |_| Ok(()),
    )
    .optional()
    .map(|row| row.is_some())
    .map_err(|error| error.to_string())
}

pub(crate) fn insert_initial_database_members(
    tx: &Transaction<'_>,
    database_id: &str,
    caller: &str,
    now: i64,
) -> Result<(), String> {
    tx.execute(
        "INSERT INTO database_members
         (database_id, principal, role, created_at_ms)
         VALUES (?1, ?2, 'owner', ?3)",
        params![database_id, caller, now],
    )
    .map_err(|error| error.to_string())?;
    if caller != DEFAULT_LLM_WRITER_PRINCIPAL {
        tx.execute(
            "INSERT INTO database_members
             (database_id, principal, role, created_at_ms)
             VALUES (?1, ?2, 'writer', ?3)",
            params![database_id, DEFAULT_LLM_WRITER_PRINCIPAL, now],
        )
        .map_err(|error| error.to_string())?;
    }
    Ok(())
}

pub(crate) fn allocate_mount_id(conn: &Connection) -> Result<u16, String> {
    let mut stmt = conn
        .prepare(
            "SELECT mount_id AS used_mount_id
             FROM database_mount_history
             ORDER BY used_mount_id ASC",
        )
        .map_err(|error| error.to_string())?;
    let used = crate::sqlite::query_map(&mut stmt, params![], |row| {
        crate::sqlite::row_get::<i64>(row, 0)
    })
    .map_err(|error| error.to_string())?;
    let mut used = used.into_iter().map(mount_id_from_db).peekable();
    for mount_id in MIN_DATABASE_MOUNT_ID..=MAX_DATABASE_MOUNT_ID {
        while let Some(used_mount_id) = used.peek() {
            match used_mount_id {
                Ok(used_mount_id) if *used_mount_id < mount_id => {
                    used.next();
                }
                Ok(used_mount_id) if *used_mount_id == mount_id => break,
                Ok(_) => return Ok(mount_id),
                Err(error) => return Err(error.to_string()),
            }
        }
        if used.peek().is_none() {
            return Ok(mount_id);
        }
        used.next();
    }
    Err("database mount_id capacity exhausted".to_string())
}

pub(crate) fn record_mount_history(
    conn: &Connection,
    database_id: &str,
    mount_id: u16,
    reason: &str,
    now: i64,
) -> Result<(), String> {
    conn.execute(
        "INSERT INTO database_mount_history
         (database_id, mount_id, reason, created_at_ms)
         VALUES (?1, ?2, ?3, ?4)",
        params![database_id, i64::from(mount_id), reason, now],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

pub(crate) fn database_meta_error(conn: &Connection, database_id: &str) -> String {
    match conn
        .query_row(
            "SELECT status FROM databases WHERE database_id = ?1",
            params![database_id],
            |row| crate::sqlite::row_get::<String>(row, 0),
        )
        .optional()
    {
        Ok(Some(status)) => format!("database is {status}: {database_id}"),
        _ => format!("database not found: {database_id}"),
    }
}

pub(crate) fn load_database_status(
    conn: &Connection,
    database_id: &str,
) -> Result<DatabaseStatus, String> {
    conn.query_row(
        "SELECT status FROM databases WHERE database_id = ?1",
        params![database_id],
        |row| status_from_db(&crate::sqlite::row_get::<String>(row, 0)?),
    )
    .optional()
    .map_err(|error| error.to_string())?
    .ok_or_else(|| format!("database not found: {database_id}"))
}

pub(crate) fn load_database_with_statuses(
    conn: &Connection,
    database_id: &str,
    statuses: &[DatabaseStatus],
) -> Result<Option<DatabaseMeta>, String> {
    conn.query_row(
        "SELECT database_id, name, description, llm_summary, tags_json,
                db_file_name, active_mount_id, schema_version, logical_size_bytes, status
         FROM databases
         WHERE database_id = ?1",
        params![database_id],
        |row| map_database_meta_with_statuses(row, statuses),
    )
    .optional()
    .map_err(|error| error.to_string())
}

pub(crate) fn load_pending_database_activation_meta(
    conn: &Connection,
    database_id: &str,
) -> Result<Option<DatabaseMeta>, String> {
    conn.query_row(
        "SELECT database_id, name, description, llm_summary, tags_json,
                db_file_name, mount_id, schema_version, logical_size_bytes, status
         FROM databases
         WHERE database_id = ?1",
        params![database_id],
        |row| map_database_meta_with_statuses(row, &[DatabaseStatus::Pending]),
    )
    .optional()
    .map_err(|error| error.to_string())
}

pub(crate) fn load_databases(conn: &Connection) -> Result<Vec<DatabaseMeta>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT database_id, name, description, llm_summary, tags_json,
                db_file_name, active_mount_id, schema_version, logical_size_bytes, status
         FROM databases
         WHERE status IN ('pending', 'active') AND active_mount_id IS NOT NULL
         ORDER BY mount_id ASC",
        )
        .map_err(|error| error.to_string())?;
    crate::sqlite::query_map(&mut stmt, params![], map_database_meta)
        .map_err(|error| error.to_string())
}

pub(crate) fn clear_storage_billing_timer_state(tx: &Transaction<'_>) -> Result<(), String> {
    tx.execute(
        "DELETE FROM storage_billing_state WHERE key = 'timer'",
        params![],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

pub(crate) fn load_database_infos(conn: &Connection) -> Result<Vec<DatabaseInfo>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT database_id, name, description, llm_summary, tags_json, status,
                    active_mount_id, schema_version, logical_size_bytes
         FROM databases
         ORDER BY database_id ASC",
        )
        .map_err(|error| error.to_string())?;
    crate::sqlite::query_map(&mut stmt, params![], |row| {
        let mount_id: Option<i64> = crate::sqlite::row_get(row, 6)?;
        let logical_size_bytes: i64 = crate::sqlite::row_get(row, 8)?;
        Ok(DatabaseInfo {
            database_id: crate::sqlite::row_get(row, 0)?,
            metadata: DatabaseMetadata {
                name: crate::sqlite::row_get(row, 1)?,
                description: crate::sqlite::row_get(row, 2)?,
                llm_summary: crate::sqlite::row_get(row, 3)?,
                tags_json: crate::sqlite::row_get(row, 4)?,
            },
            status: status_from_db(&crate::sqlite::row_get::<String>(row, 5)?)?,
            mount_id: mount_id.map(mount_id_from_db).transpose()?,
            schema_version: crate::sqlite::row_get(row, 7)?,
            logical_size_bytes: logical_size_bytes.max(0) as u64,
        })
    })
    .map_err(|error| error.to_string())
}

pub(crate) fn load_database_summaries_for_caller(
    conn: &Connection,
    caller: &str,
) -> Result<Vec<DatabaseSummary>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT d.database_id, d.name, d.description, d.llm_summary, d.tags_json,
                    d.status, m.role, d.logical_size_bytes,
                    COALESCE(b.balance_cycles, 0), b.suspended_at_ms,
                    d.deleted_at_ms,
                    0 AS access_source_rank,
                    CASE m.role
                      WHEN 'owner' THEN 0
                      WHEN 'writer' THEN 1
                      ELSE 2
                    END AS role_rank
             FROM databases d
             INNER JOIN database_members m ON m.database_id = d.database_id
             LEFT JOIN database_cycle_accounts b ON b.database_id = d.database_id
             WHERE m.principal = ?1
             UNION ALL
             SELECT d.database_id, d.name, d.description, d.llm_summary, d.tags_json,
                    d.status, 'reader' AS role, d.logical_size_bytes,
                    COALESCE(b.balance_cycles, 0), b.suspended_at_ms,
                    d.deleted_at_ms,
                    1 AS access_source_rank,
                    2 AS role_rank
             FROM databases d
             INNER JOIN market_entitlements e ON e.database_id = d.database_id
             LEFT JOIN database_cycle_accounts b ON b.database_id = d.database_id
            WHERE e.buyer_principal = ?2
              AND e.status = ?3
              AND d.status = ?4
             ORDER BY 1 ASC, 12 ASC, 13 ASC",
        )
        .map_err(|error| error.to_string())?;
    let rows = crate::sqlite::query_map(
        &mut stmt,
        params![
            caller,
            caller,
            MARKET_ENTITLEMENT_STATUS_ACTIVE,
            status_to_db(DatabaseStatus::Active)
        ],
        |row| {
            let logical_size_bytes: i64 = crate::sqlite::row_get(row, 7)?;
            let cycles_balance: i64 = crate::sqlite::row_get(row, 8)?;
            Ok(DatabaseSummary {
                database_id: crate::sqlite::row_get(row, 0)?,
                name: crate::sqlite::row_get(row, 1)?,
                metadata: Some(DatabaseMetadata {
                    name: crate::sqlite::row_get(row, 1)?,
                    description: crate::sqlite::row_get(row, 2)?,
                    llm_summary: crate::sqlite::row_get(row, 3)?,
                    tags_json: crate::sqlite::row_get(row, 4)?,
                }),
                status: status_from_db(&crate::sqlite::row_get::<String>(row, 5)?)?,
                role: role_from_db(&crate::sqlite::row_get::<String>(row, 6)?)?,
                logical_size_bytes: logical_size_bytes.max(0) as u64,
                cycles_balance: Some(cycles_balance.max(0) as u64),
                cycles_suspended_at_ms: crate::sqlite::row_get(row, 9)?,
                deleted_at_ms: crate::sqlite::row_get(row, 10)?,
            })
        },
    )
    .map_err(|error| error.to_string())?;
    let mut summaries = Vec::new();
    for row in rows {
        if summaries
            .last()
            .is_none_or(|last: &DatabaseSummary| last.database_id != row.database_id)
        {
            summaries.push(row);
        }
    }
    Ok(summaries)
}

pub(crate) fn map_database_meta_with_statuses(
    row: &crate::sqlite::Row<'_>,
    statuses: &[DatabaseStatus],
) -> crate::sqlite::Result<DatabaseMeta> {
    let status: String = crate::sqlite::row_get(row, 9).unwrap_or_else(|_| "active".to_string());
    let Ok(status) = status_from_db(&status) else {
        return Err(crate::sqlite::query_returned_no_rows());
    };
    if !statuses.contains(&status) {
        return Err(crate::sqlite::query_returned_no_rows());
    }
    map_database_meta(row)
}

pub(crate) fn map_database_meta(
    row: &crate::sqlite::Row<'_>,
) -> crate::sqlite::Result<DatabaseMeta> {
    let mount_id: Option<i64> = crate::sqlite::row_get(row, 6)?;
    let mount_id = mount_id.ok_or_else(crate::sqlite::query_returned_no_rows)?;
    let logical_size_bytes: i64 = crate::sqlite::row_get(row, 8)?;
    Ok(DatabaseMeta {
        database_id: crate::sqlite::row_get(row, 0)?,
        metadata: DatabaseMetadata {
            name: crate::sqlite::row_get(row, 1)?,
            description: crate::sqlite::row_get(row, 2)?,
            llm_summary: crate::sqlite::row_get(row, 3)?,
            tags_json: crate::sqlite::row_get(row, 4)?,
        },
        db_file_name: crate::sqlite::row_get(row, 5)?,
        mount_id: mount_id_from_db(mount_id)?,
        schema_version: crate::sqlite::row_get(row, 7)?,
        logical_size_bytes: logical_size_bytes.max(0) as u64,
    })
}

pub(crate) fn mount_id_from_db(mount_id: i64) -> crate::sqlite::Result<u16> {
    u16::try_from(mount_id).map_err(|_| crate::sqlite::integral_value_out_of_range(2, mount_id))
}

pub(crate) fn load_member_role(
    conn: &Connection,
    database_id: &str,
    principal: &str,
) -> Result<Option<DatabaseRole>, String> {
    conn.query_row(
        "SELECT role FROM database_members WHERE database_id = ?1 AND principal = ?2",
        params![database_id, principal],
        |row| role_from_db(&crate::sqlite::row_get::<String>(row, 0)?),
    )
    .optional()
    .map_err(|error| error.to_string())
}

pub(crate) fn database_member_exists(
    conn: &Connection,
    database_id: &str,
    principal: &str,
) -> Result<bool, String> {
    conn.query_row(
        "SELECT 1 FROM database_members WHERE database_id = ?1 AND principal = ?2",
        params![database_id, principal],
        |row| crate::sqlite::row_get::<i64>(row, 0),
    )
    .optional()
    .map_err(|error| error.to_string())
    .map(|value| value.is_some())
}

pub(crate) fn database_member_count_for_conn(
    conn: &Connection,
    database_id: &str,
) -> Result<i64, String> {
    conn.query_row(
        "SELECT COUNT(*) FROM database_members WHERE database_id = ?1",
        params![database_id],
        |row| crate::sqlite::row_get(row, 0),
    )
    .map_err(|error| error.to_string())
}

pub(crate) fn role_from_db(role: &str) -> crate::sqlite::Result<DatabaseRole> {
    match role {
        "owner" => Ok(DatabaseRole::Owner),
        "writer" => Ok(DatabaseRole::Writer),
        "reader" => Ok(DatabaseRole::Reader),
        _ => Err(crate::sqlite::invalid_query()),
    }
}

pub(crate) fn role_to_db(role: DatabaseRole) -> &'static str {
    match role {
        DatabaseRole::Owner => "owner",
        DatabaseRole::Writer => "writer",
        DatabaseRole::Reader => "reader",
    }
}

pub(crate) struct StoreSeedNode {
    path: &'static str,
    kind: NodeKind,
}

pub(crate) fn database_store_seed_nodes() -> Vec<StoreSeedNode> {
    vec![
        folder_seed("/Memory"),
        folder_seed("/Knowledge"),
        folder_seed("/Skills"),
        folder_seed("/Sessions"),
        folder_seed("/Sources"),
        folder_seed("/Sources/sessions"),
        folder_seed("/Sources/skill-runs"),
        folder_seed("/Sources/source-capture-requests"),
    ]
}

pub(crate) fn folder_seed(path: &'static str) -> StoreSeedNode {
    StoreSeedNode {
        path,
        kind: NodeKind::Folder,
    }
}

pub(crate) fn status_from_db(status: &str) -> crate::sqlite::Result<DatabaseStatus> {
    match status {
        "pending" => Ok(DatabaseStatus::Pending),
        "active" => Ok(DatabaseStatus::Active),
        "deleted" => Ok(DatabaseStatus::Deleted),
        _ => Err(crate::sqlite::invalid_query()),
    }
}

pub(crate) fn status_to_db(status: DatabaseStatus) -> &'static str {
    match status {
        DatabaseStatus::Pending => "pending",
        DatabaseStatus::Active => "active",
        DatabaseStatus::Deleted => "deleted",
    }
}

pub(crate) fn role_allows(role: DatabaseRole, required_role: RequiredRole) -> bool {
    match required_role {
        RequiredRole::Reader => matches!(
            role,
            DatabaseRole::Reader | DatabaseRole::Writer | DatabaseRole::Owner
        ),
        RequiredRole::Writer => matches!(role, DatabaseRole::Writer | DatabaseRole::Owner),
        RequiredRole::Owner => role == DatabaseRole::Owner,
    }
}
