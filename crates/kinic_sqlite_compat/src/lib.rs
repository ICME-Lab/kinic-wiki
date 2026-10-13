// What: Shared superset SQLite API for native and canister VFS consumers.
// Why: Native tests use rusqlite while canister builds use ic-sqlite-vfs.

#[cfg(not(target_arch = "wasm32"))]
pub use rusqlite::{
    Connection, Error, OpenFlags, OptionalExtension, Params, Result, Row, Statement, Transaction,
    params, params_from_iter,
};
#[cfg(not(target_arch = "wasm32"))]
use std::ffi::c_int;

#[cfg(not(target_arch = "wasm32"))]
pub mod types {
    pub use rusqlite::types::{Type, Value};
}

#[cfg(not(target_arch = "wasm32"))]
pub fn invalid_column_type(index: usize, name: String, kind: types::Type) -> Error {
    Error::InvalidColumnType(index, name, kind)
}

#[cfg(not(target_arch = "wasm32"))]
pub fn invalid_query() -> Error {
    Error::InvalidQuery
}

#[cfg(not(target_arch = "wasm32"))]
pub fn query_returned_no_rows() -> Error {
    Error::QueryReturnedNoRows
}

#[cfg(not(target_arch = "wasm32"))]
pub fn integral_value_out_of_range(index: usize, value: i64) -> Error {
    Error::IntegralValueOutOfRange(index, value)
}

#[cfg(not(target_arch = "wasm32"))]
pub fn row_get<T>(row: &Row<'_>, index: usize) -> Result<T>
where
    T: rusqlite::types::FromSql,
{
    row.get(index)
}

#[cfg(not(target_arch = "wasm32"))]
pub fn row_has_column(row: &Row<'_>, index: usize) -> Result<bool> {
    Ok(index < row.as_ref().column_count())
}

#[cfg(not(target_arch = "wasm32"))]
pub fn query_map<T, P, F>(statement: &mut Statement<'_>, params: P, f: F) -> Result<Vec<T>>
where
    P: Params,
    F: FnMut(&Row<'_>) -> Result<T>,
{
    statement.query_map(params, f)?.collect()
}

pub enum QueryTryMapError<E> {
    Sqlite(Error),
    Validation(E),
}

impl<E> From<Error> for QueryTryMapError<E> {
    fn from(error: Error) -> Self {
        Self::Sqlite(error)
    }
}

#[cfg(not(target_arch = "wasm32"))]
pub fn query_try_map_limit<T, E, P, F>(
    statement: &mut Statement<'_>,
    params: P,
    limit: usize,
    mut f: F,
) -> std::result::Result<Vec<T>, QueryTryMapError<E>>
where
    P: Params,
    F: FnMut(&Row<'_>) -> std::result::Result<T, QueryTryMapError<E>>,
{
    let mut rows = statement.query(params).map_err(QueryTryMapError::Sqlite)?;
    let mut output = Vec::new();
    while output.len() < limit {
        let Some(row) = rows.next().map_err(QueryTryMapError::Sqlite)? else {
            break;
        };
        output.push(f(row)?);
    }
    Ok(output)
}

#[cfg(not(target_arch = "wasm32"))]
pub fn query_one<T, P, F>(statement: &mut Statement<'_>, params: P, f: F) -> Result<T>
where
    P: Params,
    F: FnOnce(&Row<'_>) -> Result<T>,
{
    statement.query_row(params, f)
}

#[cfg(not(target_arch = "wasm32"))]
pub fn query_fold<T, P, F>(statement: &mut Statement<'_>, params: P, init: T, mut f: F) -> Result<T>
where
    P: Params,
    F: FnMut(T, &Row<'_>) -> Result<T>,
{
    let mut rows = statement.query(params)?;
    let mut acc = init;
    while let Some(row) = rows.next()? {
        acc = f(acc, row)?;
    }
    Ok(acc)
}

#[cfg(not(target_arch = "wasm32"))]
pub fn last_insert_rowid(conn: &Connection) -> Result<i64> {
    Ok(conn.last_insert_rowid())
}

#[cfg(not(target_arch = "wasm32"))]
pub fn statement_exists<P>(statement: &mut Statement<'_>, params: P) -> Result<bool>
where
    P: Params,
{
    statement.exists(params)
}

#[cfg(not(target_arch = "wasm32"))]
pub struct ProgressHandlerGuard<'connection> {
    conn: &'connection Connection,
}

#[cfg(not(target_arch = "wasm32"))]
impl<'connection> ProgressHandlerGuard<'connection> {
    pub fn new(conn: &'connection Connection, op_interval: c_int, callback_budget: u32) -> Self {
        let mut callbacks = 0_u32;
        conn.progress_handler(
            op_interval,
            Some(move || {
                callbacks = callbacks.saturating_add(1);
                callbacks > callback_budget
            }),
        );
        Self { conn }
    }
}

#[cfg(not(target_arch = "wasm32"))]
impl Drop for ProgressHandlerGuard<'_> {
    fn drop(&mut self) {
        self.conn.progress_handler(0, None::<fn() -> bool>);
    }
}

#[cfg(not(target_arch = "wasm32"))]
pub fn install_progress_handler(
    conn: &Connection,
    op_interval: c_int,
    callback_budget: u32,
) -> ProgressHandlerGuard<'_> {
    ProgressHandlerGuard::new(conn, op_interval, callback_budget)
}

#[cfg(not(target_arch = "wasm32"))]
pub fn is_interrupted(error: &Error) -> bool {
    matches!(
        error,
        Error::SqliteFailure(sqlite_error, _)
            if sqlite_error.code == rusqlite::ErrorCode::OperationInterrupted
    )
}

#[cfg(not(target_arch = "wasm32"))]
pub trait ExecuteValues {
    fn execute_values(&self, sql: &str, values: &[types::Value]) -> Result<()>;
}

#[cfg(not(target_arch = "wasm32"))]
impl ExecuteValues for Connection {
    fn execute_values(&self, sql: &str, values: &[types::Value]) -> Result<()> {
        self.execute(sql, rusqlite::params_from_iter(values.iter()))
            .map(|_| ())
    }
}

#[cfg(not(target_arch = "wasm32"))]
impl ExecuteValues for Transaction<'_> {
    fn execute_values(&self, sql: &str, values: &[types::Value]) -> Result<()> {
        self.execute(sql, rusqlite::params_from_iter(values.iter()))
            .map(|_| ())
    }
}

#[cfg(not(target_arch = "wasm32"))]
pub fn execute_values(conn: &impl ExecuteValues, sql: &str, values: &[types::Value]) -> Result<()> {
    conn.execute_values(sql, values)
}

#[cfg(target_arch = "wasm32")]
pub use ic_sqlite_vfs::db::connection::Connection;
#[cfg(target_arch = "wasm32")]
pub use ic_sqlite_vfs::db::statement::Statement;
#[cfg(target_arch = "wasm32")]
pub use ic_sqlite_vfs::db::transaction::UpdateConnection as Transaction;
#[cfg(target_arch = "wasm32")]
pub use ic_sqlite_vfs::db::{FromColumn, Row, ToSql};
#[cfg(target_arch = "wasm32")]
pub use ic_sqlite_vfs::{DbError as Error, params};
#[cfg(target_arch = "wasm32")]
use std::ffi::{c_int, c_void};

#[cfg(target_arch = "wasm32")]
pub type Result<T> = std::result::Result<T, Error>;

#[cfg(target_arch = "wasm32")]
const SQLITE_INTERRUPT: i32 = 9;

#[cfg(target_arch = "wasm32")]
#[repr(C)]
struct Sqlite3 {
    _private: [u8; 0],
}

#[cfg(target_arch = "wasm32")]
unsafe extern "C" {
    fn sqlite3_progress_handler(
        db: *mut Sqlite3,
        op_interval: c_int,
        callback: Option<unsafe extern "C" fn(*mut c_void) -> c_int>,
        state: *mut c_void,
    );
}

#[cfg(target_arch = "wasm32")]
pub trait OptionalExtension<T> {
    fn optional(self) -> Result<Option<T>>;
}

#[cfg(target_arch = "wasm32")]
impl<T> OptionalExtension<T> for Result<T> {
    fn optional(self) -> Result<Option<T>> {
        match self {
            Ok(value) => Ok(Some(value)),
            Err(Error::NotFound) => Ok(None),
            Err(error) => Err(error),
        }
    }
}

#[cfg(target_arch = "wasm32")]
pub trait Params {
    fn with_params<T>(&self, f: impl FnOnce(&[&dyn ToSql]) -> T) -> T;
}

#[cfg(target_arch = "wasm32")]
impl Params for &[&dyn ToSql] {
    fn with_params<T>(&self, f: impl FnOnce(&[&dyn ToSql]) -> T) -> T {
        f(self)
    }
}

#[cfg(target_arch = "wasm32")]
impl<const N: usize> Params for &[&dyn ToSql; N] {
    fn with_params<T>(&self, f: impl FnOnce(&[&dyn ToSql]) -> T) -> T {
        f(self.as_slice())
    }
}

#[cfg(target_arch = "wasm32")]
impl Params for Vec<&dyn ToSql> {
    fn with_params<T>(&self, f: impl FnOnce(&[&dyn ToSql]) -> T) -> T {
        f(self.as_slice())
    }
}

#[cfg(target_arch = "wasm32")]
impl Params for Vec<ic_sqlite_vfs::db::value::Value<'_>> {
    fn with_params<T>(&self, f: impl FnOnce(&[&dyn ToSql]) -> T) -> T {
        let refs = self
            .iter()
            .map(|value| value as &dyn ToSql)
            .collect::<Vec<_>>();
        f(refs.as_slice())
    }
}

#[cfg(target_arch = "wasm32")]
pub mod types {
    #[derive(Clone, Debug)]
    pub enum Value {
        Text(String),
        Integer(i64),
        Blob(Vec<u8>),
        Null,
    }

    #[derive(Clone, Copy, Debug)]
    pub enum Type {
        Text,
    }

    impl From<String> for Value {
        fn from(value: String) -> Self {
            Self::Text(value)
        }
    }

    impl From<i64> for Value {
        fn from(value: i64) -> Self {
            Self::Integer(value)
        }
    }

    impl From<Option<i64>> for Value {
        fn from(value: Option<i64>) -> Self {
            value.map(Self::Integer).unwrap_or(Self::Null)
        }
    }

    impl From<Vec<u8>> for Value {
        fn from(value: Vec<u8>) -> Self {
            Self::Blob(value)
        }
    }
}

#[cfg(target_arch = "wasm32")]
pub fn text_value(value: impl Into<String>) -> types::Value {
    types::Value::Text(value.into())
}

#[cfg(not(target_arch = "wasm32"))]
pub fn text_value(value: impl Into<String>) -> types::Value {
    types::Value::Text(value.into())
}

#[cfg(target_arch = "wasm32")]
pub fn nullable_text_value(value: Option<String>) -> types::Value {
    value.map(types::Value::Text).unwrap_or(types::Value::Null)
}

#[cfg(not(target_arch = "wasm32"))]
pub fn nullable_text_value(value: Option<String>) -> types::Value {
    value.map(types::Value::Text).unwrap_or(types::Value::Null)
}

#[cfg(target_arch = "wasm32")]
pub fn integer_value(value: i64) -> types::Value {
    types::Value::Integer(value)
}

#[cfg(not(target_arch = "wasm32"))]
pub fn integer_value(value: i64) -> types::Value {
    types::Value::Integer(value)
}

#[cfg(target_arch = "wasm32")]
pub fn nullable_integer_value(value: Option<i64>) -> types::Value {
    value
        .map(types::Value::Integer)
        .unwrap_or(types::Value::Null)
}

#[cfg(not(target_arch = "wasm32"))]
pub fn nullable_integer_value(value: Option<i64>) -> types::Value {
    value
        .map(types::Value::Integer)
        .unwrap_or(types::Value::Null)
}

#[cfg(target_arch = "wasm32")]
pub fn nullable_blob_value(value: Option<Vec<u8>>) -> types::Value {
    value.map(types::Value::Blob).unwrap_or(types::Value::Null)
}

#[cfg(not(target_arch = "wasm32"))]
pub fn nullable_blob_value(value: Option<Vec<u8>>) -> types::Value {
    value.map(types::Value::Blob).unwrap_or(types::Value::Null)
}

#[cfg(target_arch = "wasm32")]
pub fn invalid_column_type(index: usize, _name: String, kind: types::Type) -> Error {
    Error::TypeMismatch {
        index,
        expected: match kind {
            types::Type::Text => "TEXT",
        },
        actual: "UNKNOWN",
    }
}

#[cfg(target_arch = "wasm32")]
pub fn invalid_query() -> Error {
    Error::Sqlite(1, "invalid query".to_string())
}

#[cfg(target_arch = "wasm32")]
pub fn query_returned_no_rows() -> Error {
    Error::NotFound
}

#[cfg(target_arch = "wasm32")]
pub fn integral_value_out_of_range(index: usize, value: i64) -> Error {
    Error::Sqlite(
        1,
        format!("integral value out of range at column {index}: {value}"),
    )
}

#[cfg(target_arch = "wasm32")]
pub fn row_get<T>(row: &Row<'_>, index: usize) -> Result<T>
where
    T: FromColumn,
{
    row.get(index)
}

#[cfg(target_arch = "wasm32")]
pub fn row_has_column(row: &Row<'_>, index: usize) -> Result<bool> {
    match row_get::<Option<String>>(row, index) {
        Ok(_) => Ok(true),
        Err(Error::ColumnOutOfRange { .. }) => Ok(false),
        Err(Error::TypeMismatch { .. }) => Ok(true),
        Err(error) => Err(error),
    }
}

#[cfg(target_arch = "wasm32")]
pub fn query_map<T, P, F>(statement: &mut Statement<'_>, params: P, f: F) -> Result<Vec<T>>
where
    P: Params,
    F: FnMut(&Row<'_>) -> Result<T>,
{
    params.with_params(|params| statement.query_all(params, f))
}

#[cfg(target_arch = "wasm32")]
pub fn query_try_map_limit<T, E, P, F>(
    statement: &mut Statement<'_>,
    params: P,
    limit: usize,
    mut f: F,
) -> std::result::Result<Vec<T>, QueryTryMapError<E>>
where
    P: Params,
    F: FnMut(&Row<'_>) -> std::result::Result<T, QueryTryMapError<E>>,
{
    let mut rows = params
        .with_params(|params| statement.query(params))
        .map_err(QueryTryMapError::Sqlite)?;
    let mut output = Vec::new();
    while output.len() < limit {
        let Some(row) = rows.next_row().map_err(QueryTryMapError::Sqlite)? else {
            break;
        };
        output.push(f(&row)?);
    }
    Ok(output)
}

#[cfg(target_arch = "wasm32")]
pub fn query_one<T, P, F>(statement: &mut Statement<'_>, params: P, f: F) -> Result<T>
where
    P: Params,
    F: FnOnce(&Row<'_>) -> Result<T>,
{
    params.with_params(|params| statement.query_one(params, f))
}

#[cfg(target_arch = "wasm32")]
pub fn query_fold<T, P, F>(statement: &mut Statement<'_>, params: P, init: T, mut f: F) -> Result<T>
where
    P: Params,
    F: FnMut(T, &Row<'_>) -> Result<T>,
{
    let mut rows = params.with_params(|params| statement.query(params))?;
    let mut acc = init;
    while let Some(row) = rows.next_row()? {
        acc = f(acc, &row)?;
    }
    Ok(acc)
}

#[cfg(target_arch = "wasm32")]
pub fn last_insert_rowid(conn: &Connection) -> Result<i64> {
    conn.query_row("SELECT last_insert_rowid()", params![], |row| {
        row_get(row, 0)
    })
}

#[cfg(target_arch = "wasm32")]
pub fn statement_exists<P>(statement: &mut Statement<'_>, params: P) -> Result<bool>
where
    P: Params,
{
    params
        .with_params(|params| statement.query_optional(params, |_row| Ok(())))
        .map(|row| row.is_some())
}

#[cfg(target_arch = "wasm32")]
struct ProgressHandlerState {
    callbacks: u32,
    callback_budget: u32,
}

#[cfg(target_arch = "wasm32")]
pub struct ProgressHandlerGuard<'connection> {
    raw: *mut Sqlite3,
    _conn: &'connection Connection,
    _state: Box<ProgressHandlerState>,
}

#[cfg(target_arch = "wasm32")]
impl<'connection> ProgressHandlerGuard<'connection> {
    pub fn new(conn: &'connection Connection, op_interval: c_int, callback_budget: u32) -> Self {
        unsafe extern "C" fn progress_callback(state: *mut c_void) -> c_int {
            // SAFETY: sqlite3 calls this only while ProgressHandlerGuard is alive.
            // The pointer is the boxed ProgressHandlerState registered in new().
            let state = unsafe { &mut *(state.cast::<ProgressHandlerState>()) };
            state.callbacks = state.callbacks.saturating_add(1);
            c_int::from(state.callbacks > state.callback_budget)
        }

        let raw = conn.raw().cast::<Sqlite3>();
        let mut state = Box::new(ProgressHandlerState {
            callbacks: 0,
            callback_budget,
        });
        // SAFETY: raw belongs to conn, and the boxed state is retained by the guard
        // until Drop unregisters the callback before the box is freed.
        unsafe {
            sqlite3_progress_handler(
                raw,
                op_interval,
                Some(progress_callback),
                state.as_mut() as *mut ProgressHandlerState as *mut c_void,
            );
        }
        Self {
            raw,
            _conn: conn,
            _state: state,
        }
    }
}

#[cfg(target_arch = "wasm32")]
impl Drop for ProgressHandlerGuard<'_> {
    fn drop(&mut self) {
        // SAFETY: raw is the same live sqlite handle used during registration;
        // passing a null callback clears SQLite's progress handler.
        unsafe {
            sqlite3_progress_handler(self.raw, 0, None, std::ptr::null_mut());
        }
    }
}

#[cfg(target_arch = "wasm32")]
pub fn install_progress_handler(
    conn: &Connection,
    op_interval: c_int,
    callback_budget: u32,
) -> ProgressHandlerGuard<'_> {
    ProgressHandlerGuard::new(conn, op_interval, callback_budget)
}

#[cfg(target_arch = "wasm32")]
pub fn is_interrupted(error: &Error) -> bool {
    matches!(error, Error::Sqlite(code, _) if *code == SQLITE_INTERRUPT)
}

#[cfg(target_arch = "wasm32")]
pub trait ExecuteValues {
    fn execute_values(&self, sql: &str, values: &[types::Value]) -> Result<()>;
}

#[cfg(target_arch = "wasm32")]
impl ExecuteValues for Connection {
    fn execute_values(&self, sql: &str, values: &[types::Value]) -> Result<()> {
        let params = params_from_values(values);
        let param_refs = params
            .iter()
            .map(|value| value as &dyn ToSql)
            .collect::<Vec<_>>();
        self.execute(sql, param_refs.as_slice())
    }
}

#[cfg(target_arch = "wasm32")]
impl ExecuteValues for Transaction<'_> {
    fn execute_values(&self, sql: &str, values: &[types::Value]) -> Result<()> {
        let params = params_from_values(values);
        let param_refs = params
            .iter()
            .map(|value| value as &dyn ToSql)
            .collect::<Vec<_>>();
        self.execute(sql, param_refs.as_slice())
    }
}

#[cfg(target_arch = "wasm32")]
pub fn execute_values(conn: &impl ExecuteValues, sql: &str, values: &[types::Value]) -> Result<()> {
    conn.execute_values(sql, values)
}

#[cfg(not(target_arch = "wasm32"))]
pub fn params_from_values(values: &[types::Value]) -> impl Params + '_ {
    params_from_iter(values.iter())
}

#[cfg(target_arch = "wasm32")]
pub fn params_from_values(values: &[types::Value]) -> Vec<ic_sqlite_vfs::db::value::Value<'_>> {
    values
        .iter()
        .map(|value| match value {
            types::Value::Text(value) => ic_sqlite_vfs::db::value::Value::Text(value.as_str()),
            types::Value::Integer(value) => ic_sqlite_vfs::db::value::Value::Integer(*value),
            types::Value::Blob(value) => ic_sqlite_vfs::db::value::Value::Blob(value.as_slice()),
            types::Value::Null => ic_sqlite_vfs::db::value::Value::Null,
        })
        .collect()
}

#[cfg(not(target_arch = "wasm32"))]
pub fn params_from_i64s(values: &[i64]) -> impl Params + '_ {
    params_from_iter(values.iter().copied())
}

#[cfg(target_arch = "wasm32")]
pub fn params_from_i64s(values: &[i64]) -> Vec<&dyn ToSql> {
    values.iter().map(|value| value as &dyn ToSql).collect()
}

// SQLite reports database=None for an unqualified table read that references
// no columns. Permit that form only on a verified main-only connection: temp
// shadows and attached databases would make resolution ambiguous.
fn require_main_database(conn: &Connection) -> Result<()> {
    let mut statement = conn.prepare("PRAGMA database_list")?;
    let names = query_map(&mut statement, params![], |row| row_get::<String>(row, 1))?;
    if names.iter().any(|name| name != "main") {
        return Err(invalid_query());
    }
    Ok(())
}

// Authorization follows SQLite's resolved operations, not SQL text tokens.
#[derive(Clone, Copy)]
struct ReadPolicy {
    tables: &'static [&'static str],
}
impl ReadPolicy {
    fn permits(
        &self,
        action: i32,
        arg1: Option<&str>,
        arg2: Option<&str>,
        database: Option<&str>,
    ) -> bool {
        match action {
            21 => true, // SQLITE_SELECT
            20 => {
                (database == Some("main") || (database.is_none() && arg2 == Some("")))
                    && arg1.is_some_and(|table| {
                        self.tables
                            .iter()
                            .any(|allowed| table.eq_ignore_ascii_case(allowed))
                    })
            }
            31 => arg2.is_some_and(|function| !function.eq_ignore_ascii_case("load_extension")),
            _ => false,
        }
    }
}

#[cfg(not(target_arch = "wasm32"))]
pub struct ReadAuthorizerGuard<'connection> {
    conn: &'connection Connection,
}
#[cfg(not(target_arch = "wasm32"))]
pub fn install_read_authorizer<'connection>(
    conn: &'connection Connection,
    tables: &'static [&'static str],
) -> Result<ReadAuthorizerGuard<'connection>> {
    require_main_database(conn)?;
    use rusqlite::hooks::{AuthAction, Authorization};
    let policy = ReadPolicy { tables };
    conn.authorizer(Some(move |ctx: rusqlite::hooks::AuthContext<'_>| {
        let (action, arg1, arg2) = match ctx.action {
            AuthAction::Select => (21, None, None),
            AuthAction::Read {
                table_name,
                column_name,
            } => (20, Some(table_name), Some(column_name)),
            AuthAction::Function { function_name } => (31, None, Some(function_name)),
            _ => (0, None, None),
        };
        if policy.permits(action, arg1, arg2, ctx.database_name) {
            Authorization::Allow
        } else {
            Authorization::Deny
        }
    }));
    Ok(ReadAuthorizerGuard { conn })
}
#[cfg(not(target_arch = "wasm32"))]
impl Drop for ReadAuthorizerGuard<'_> {
    fn drop(&mut self) {
        self.conn.authorizer(
            None::<fn(rusqlite::hooks::AuthContext<'_>) -> rusqlite::hooks::Authorization>,
        );
    }
}

#[cfg(target_arch = "wasm32")]
unsafe extern "C" {
    fn sqlite3_set_authorizer(
        db: *mut Sqlite3,
        callback: Option<
            unsafe extern "C" fn(
                *mut c_void,
                c_int,
                *const std::ffi::c_char,
                *const std::ffi::c_char,
                *const std::ffi::c_char,
                *const std::ffi::c_char,
            ) -> c_int,
        >,
        state: *mut c_void,
    ) -> c_int;
}
#[cfg(target_arch = "wasm32")]
pub struct ReadAuthorizerGuard<'connection> {
    raw: *mut Sqlite3,
    _conn: &'connection Connection,
    _policy: Box<ReadPolicy>,
}
#[cfg(target_arch = "wasm32")]
pub fn install_read_authorizer<'connection>(
    conn: &'connection Connection,
    tables: &'static [&'static str],
) -> Result<ReadAuthorizerGuard<'connection>> {
    require_main_database(conn)?;
    unsafe extern "C" fn authorize(
        state: *mut c_void,
        action: c_int,
        arg1: *const std::ffi::c_char,
        arg2: *const std::ffi::c_char,
        database: *const std::ffi::c_char,
        _accessor: *const std::ffi::c_char,
    ) -> c_int {
        // SAFETY: SQLite supplies NUL-terminated arguments valid during this call;
        // the guard owns the boxed policy until after callback removal.
        unsafe fn text<'a>(value: *const std::ffi::c_char) -> Option<&'a str> {
            if value.is_null() {
                None
            } else {
                unsafe { std::ffi::CStr::from_ptr(value) }.to_str().ok()
            }
        }
        let policy = unsafe { &*state.cast::<ReadPolicy>() };
        let permitted = policy.permits(
            action,
            unsafe { text(arg1) },
            unsafe { text(arg2) },
            unsafe { text(database) },
        );
        if permitted { 0 } else { 1 } // SQLITE_OK / SQLITE_DENY
    }
    let raw = conn.raw().cast::<Sqlite3>();
    let mut policy = Box::new(ReadPolicy { tables });
    // SAFETY: conn owns raw and the guard retains policy for the callback lifetime.
    let code = unsafe {
        sqlite3_set_authorizer(
            raw,
            Some(authorize),
            policy.as_mut() as *mut ReadPolicy as *mut c_void,
        )
    };
    if code != 0 {
        return Err(Error::Sqlite(
            code,
            "could not install SQL read authorizer".into(),
        ));
    }
    Ok(ReadAuthorizerGuard {
        raw,
        _conn: conn,
        _policy: policy,
    })
}
#[cfg(target_arch = "wasm32")]
impl Drop for ReadAuthorizerGuard<'_> {
    fn drop(&mut self) {
        // SAFETY: unregister before releasing the policy; conn remains borrowed.
        unsafe {
            sqlite3_set_authorizer(self.raw, None, std::ptr::null_mut());
        }
    }
}

#[cfg(all(test, not(target_arch = "wasm32")))]
mod read_authorizer_tests {
    use super::*;
    #[test]
    fn resolved_tables_and_operations_are_checked_and_guard_is_cleared() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE fs_nodes(id INTEGER); INSERT INTO fs_nodes VALUES(1); CREATE TABLE secret(id INTEGER); INSERT INTO secret VALUES(7);").unwrap();
        for sql in ["SELECT id FROM secret", "SELECT id FROM fs_nodes"] {
            conn.prepare_cached(sql)
                .unwrap()
                .query_row([], |row| row.get::<_, i64>(0))
                .unwrap();
        }
        {
            let _guard = install_read_authorizer(&conn, &["fs_nodes", "fs_links"]).unwrap();
            for sql in [
                "SELECT id FROM secret",
                "SELECT id FROM 'secret' fs_nodes",
                "SELECT id IN secret FROM fs_nodes",
                "SELECT json_object('x', 1) FROM secret",
                "DELETE FROM fs_nodes",
                "PRAGMA database_list",
            ] {
                assert!(conn.prepare(sql).is_err(), "allowed {sql}");
            }
            assert!(
                conn.prepare_cached("SELECT id FROM secret")
                    .and_then(|mut statement| statement.query_row([], |row| row.get::<_, i64>(0)))
                    .is_err()
            );
            assert_eq!(
                conn.prepare_cached("SELECT id FROM fs_nodes")
                    .unwrap()
                    .query_row([], |row| row.get::<_, i64>(0))
                    .unwrap(),
                1
            );
            let constant: String = conn
                .query_row("SELECT json_object('x', 1) FROM fs_nodes", [], |row| {
                    row.get(0)
                })
                .unwrap();
            assert_eq!(constant, "{\"x\":1}");
            let value: String = conn
                .prepare("SELECT json_object('id', id) FROM fs_nodes")
                .unwrap()
                .query_row([], |row| row.get(0))
                .unwrap();
            assert_eq!(value, "{\"id\":1}");
        }
        assert_eq!(
            conn.query_row("SELECT id FROM secret", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            7
        );
        conn.execute("INSERT INTO fs_nodes VALUES(2)", []).unwrap();
    }
    #[test]
    fn ambiguous_connections_fail_closed() {
        for setup in [
            "ATTACH ':memory:' AS other",
            "CREATE TEMP TABLE fs_nodes(id INTEGER)",
        ] {
            let conn = Connection::open_in_memory().unwrap();
            conn.execute_batch(setup).unwrap();
            assert!(install_read_authorizer(&conn, &["fs_nodes"]).is_err());
        }
    }
    #[test]
    fn policy_fails_closed_for_unknown_actions_and_missing_arguments() {
        let policy = ReadPolicy {
            tables: &["fs_nodes"],
        };
        assert!(!policy.permits(999, None, None, None));
        assert!(!policy.permits(20, Some("fs_nodes"), None, None));
        assert!(!policy.permits(31, None, None, None));
        assert!(!policy.permits(31, None, Some("load_extension"), None));
    }
}
