use kinic_sqlite_compat::Connection;
use vault_types::{Error, Result};
pub struct State;
#[cfg(not(target_arch = "wasm32"))]
thread_local! {static DB:std::cell::RefCell<Connection>=std::cell::RefCell::new(Connection::open_in_memory().unwrap());}
#[cfg(target_arch = "wasm32")]
thread_local! {
 static MEMORY:std::cell::RefCell<ic_sqlite_vfs::MemoryManager<ic_sqlite_vfs::DefaultMemoryImpl>>=std::cell::RefCell::new(ic_sqlite_vfs::MemoryManager::init_strict(ic_sqlite_vfs::DefaultMemoryImpl::default()).expect("Vault memory manager"));
 static DB:std::cell::Cell<Option<ic_sqlite_vfs::DbHandle>>=const{std::cell::Cell::new(None)};
}
pub fn initialize() -> Result<()> {
    #[cfg(target_arch = "wasm32")]
    DB.with(|db| {
        let handle = MEMORY
            .with(|m| {
                ic_sqlite_vfs::DbHandle::init(m.borrow().get(ic_sqlite_vfs::MemoryId::new(0)))
            })
            .map_err(|_| Error::Storage)?;
        db.set(Some(handle));
        Ok::<_, Error>(())
    })?;
    transaction(|db| {
        crate::schema::initialize_vault_schema(db)?;
        db.execute_batch(include_str!("accounts.sql"))
            .map_err(|_| Error::Storage)?;
        crate::capacity::initialize(db)?;
        Ok(())
    })?;
    State.vault_start_generation()
}
pub fn transaction<T>(f: impl FnOnce(&Connection) -> Result<T>) -> Result<T> {
    #[cfg(not(target_arch = "wasm32"))]
    {
        DB.with(|db| {
            let mut db = db.borrow_mut();
            let tx = db.transaction().map_err(|_| Error::Storage)?;
            let value = f(&tx)?;
            tx.commit().map_err(|_| Error::Storage)?;
            Ok(value)
        })
    }
    #[cfg(target_arch = "wasm32")]
    {
        DB.with(|db| {
            let mut error = None;
            db.get()
                .ok_or(Error::Storage)?
                .update(|db| {
                    f(db).map_err(|e| {
                        error = Some(e);
                        ic_sqlite_vfs::DbError::Sqlite(1, "Vault transaction aborted".into())
                    })
                })
                .map_err(|_| error.unwrap_or(Error::Storage))
        })
    }
}
