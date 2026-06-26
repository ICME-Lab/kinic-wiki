// Where: crates/vfs_runtime/src/sqlite.rs
// What: SQLite API boundary used by the VFS runtime.
// Why: Native tests use rusqlite while canister builds use ic-sqlite-vfs.

#[cfg(not(target_arch = "wasm32"))]
pub(crate) use rusqlite::{
    Connection, Error, OptionalExtension, Params, Result, Row, Statement, Transaction, params,
};
#[cfg(not(target_arch = "wasm32"))]
use std::ffi::c_int;

#[cfg(not(target_arch = "wasm32"))]
pub(crate) mod types {
    pub(crate) use rusqlite::types::Value;
}

#[cfg(not(target_arch = "wasm32"))]
pub(crate) fn query_returned_no_rows() -> Error {
    Error::QueryReturnedNoRows
}

#[cfg(not(target_arch = "wasm32"))]
pub(crate) fn invalid_query() -> Error {
    Error::InvalidQuery
}

#[cfg(not(target_arch = "wasm32"))]
pub(crate) fn integral_value_out_of_range(index: usize, value: i64) -> Error {
    Error::IntegralValueOutOfRange(index, value)
}

#[cfg(not(target_arch = "wasm32"))]
pub(crate) fn row_get<T>(row: &Row<'_>, index: usize) -> Result<T>
where
    T: rusqlite::types::FromSql,
{
    row.get(index)
}

#[cfg(not(target_arch = "wasm32"))]
pub(crate) fn row_has_column(row: &Row<'_>, index: usize) -> Result<bool> {
    Ok(index < row.as_ref().column_count())
}

#[cfg(not(target_arch = "wasm32"))]
pub(crate) fn query_map<T, P, F>(statement: &mut Statement<'_>, params: P, f: F) -> Result<Vec<T>>
where
    P: Params,
    F: FnMut(&Row<'_>) -> Result<T>,
{
    statement.query_map(params, f)?.collect()
}

#[cfg(not(target_arch = "wasm32"))]
pub(crate) fn query_one<T, P, F>(statement: &mut Statement<'_>, params: P, f: F) -> Result<T>
where
    P: Params,
    F: FnOnce(&Row<'_>) -> Result<T>,
{
    statement.query_row(params, f)
}

#[cfg(not(target_arch = "wasm32"))]
pub(crate) fn query_fold<T, P, F>(
    statement: &mut Statement<'_>,
    params: P,
    init: T,
    mut f: F,
) -> Result<T>
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

pub(crate) enum QueryTryMapError<E> {
    Sqlite(Error),
    Validation(E),
}

impl<E> From<Error> for QueryTryMapError<E> {
    fn from(error: Error) -> Self {
        Self::Sqlite(error)
    }
}

#[cfg(not(target_arch = "wasm32"))]
pub(crate) fn query_try_map_limit<T, E, P, F>(
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
pub(crate) fn last_insert_rowid(conn: &Connection) -> Result<i64> {
    Ok(conn.last_insert_rowid())
}

pub(crate) struct ProgressHandlerGuard<'connection> {
    conn: &'connection Connection,
}

#[cfg(not(target_arch = "wasm32"))]
impl<'connection> ProgressHandlerGuard<'connection> {
    pub(crate) fn new(
        conn: &'connection Connection,
        op_interval: c_int,
        callback_budget: u32,
    ) -> Self {
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
pub(crate) fn install_progress_handler(
    conn: &Connection,
    op_interval: c_int,
    callback_budget: u32,
) -> ProgressHandlerGuard<'_> {
    ProgressHandlerGuard::new(conn, op_interval, callback_budget)
}

#[cfg(not(target_arch = "wasm32"))]
pub(crate) fn is_interrupted(error: &Error) -> bool {
    matches!(
        error,
        Error::SqliteFailure(sqlite_error, _)
            if sqlite_error.code == rusqlite::ErrorCode::OperationInterrupted
    )
}

#[cfg(not(target_arch = "wasm32"))]
pub(crate) trait ExecuteValues {
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
pub(crate) fn execute_values(
    conn: &impl ExecuteValues,
    sql: &str,
    values: &[types::Value],
) -> Result<()> {
    conn.execute_values(sql, values)
}

#[cfg(target_arch = "wasm32")]
pub(crate) use ic_sqlite_vfs::db::connection::Connection;
#[cfg(target_arch = "wasm32")]
pub(crate) use ic_sqlite_vfs::db::statement::Statement;
#[cfg(target_arch = "wasm32")]
pub(crate) use ic_sqlite_vfs::db::transaction::UpdateConnection as Transaction;
#[cfg(target_arch = "wasm32")]
pub(crate) use ic_sqlite_vfs::db::{FromColumn, Row, ToSql};
#[cfg(target_arch = "wasm32")]
pub(crate) use ic_sqlite_vfs::{DbError as Error, params};

#[cfg(target_arch = "wasm32")]
pub(crate) type Result<T> = std::result::Result<T, Error>;

#[cfg(target_arch = "wasm32")]
pub(crate) trait OptionalExtension<T> {
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
pub(crate) trait Params {
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
pub(crate) mod types {
    #[derive(Clone, Debug)]
    pub(crate) enum Value {
        Text(String),
        Integer(i64),
        Blob(Vec<u8>),
        Null,
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
pub(crate) fn text_value(value: impl Into<String>) -> types::Value {
    types::Value::Text(value.into())
}

#[cfg(not(target_arch = "wasm32"))]
pub(crate) fn text_value(value: impl Into<String>) -> types::Value {
    types::Value::Text(value.into())
}

#[cfg(target_arch = "wasm32")]
pub(crate) fn nullable_text_value(value: Option<String>) -> types::Value {
    value.map(types::Value::Text).unwrap_or(types::Value::Null)
}

#[cfg(not(target_arch = "wasm32"))]
pub(crate) fn nullable_text_value(value: Option<String>) -> types::Value {
    value.map(types::Value::Text).unwrap_or(types::Value::Null)
}

#[cfg(target_arch = "wasm32")]
pub(crate) fn integer_value(value: i64) -> types::Value {
    types::Value::Integer(value)
}

#[cfg(not(target_arch = "wasm32"))]
pub(crate) fn integer_value(value: i64) -> types::Value {
    types::Value::Integer(value)
}

#[cfg(target_arch = "wasm32")]
pub(crate) fn nullable_integer_value(value: Option<i64>) -> types::Value {
    value
        .map(types::Value::Integer)
        .unwrap_or(types::Value::Null)
}

#[cfg(not(target_arch = "wasm32"))]
pub(crate) fn nullable_integer_value(value: Option<i64>) -> types::Value {
    value
        .map(types::Value::Integer)
        .unwrap_or(types::Value::Null)
}

#[cfg(target_arch = "wasm32")]
pub(crate) fn nullable_blob_value(value: Option<Vec<u8>>) -> types::Value {
    value.map(types::Value::Blob).unwrap_or(types::Value::Null)
}

#[cfg(not(target_arch = "wasm32"))]
pub(crate) fn nullable_blob_value(value: Option<Vec<u8>>) -> types::Value {
    value.map(types::Value::Blob).unwrap_or(types::Value::Null)
}

#[cfg(target_arch = "wasm32")]
pub(crate) fn query_returned_no_rows() -> Error {
    Error::NotFound
}

#[cfg(target_arch = "wasm32")]
pub(crate) fn invalid_query() -> Error {
    Error::Sqlite(1, "invalid query".to_string())
}

#[cfg(target_arch = "wasm32")]
pub(crate) fn integral_value_out_of_range(index: usize, value: i64) -> Error {
    Error::Sqlite(
        1,
        format!("integral value out of range at column {index}: {value}"),
    )
}

#[cfg(target_arch = "wasm32")]
pub(crate) fn row_get<T>(row: &Row<'_>, index: usize) -> Result<T>
where
    T: FromColumn,
{
    row.get(index)
}

#[cfg(target_arch = "wasm32")]
pub(crate) fn row_has_column(row: &Row<'_>, index: usize) -> Result<bool> {
    match row_get::<Option<String>>(row, index) {
        Ok(_) => Ok(true),
        Err(Error::ColumnOutOfRange { .. }) => Ok(false),
        Err(Error::TypeMismatch { .. }) => Ok(true),
        Err(error) => Err(error),
    }
}

#[cfg(target_arch = "wasm32")]
pub(crate) fn query_map<T, P, F>(statement: &mut Statement<'_>, params: P, f: F) -> Result<Vec<T>>
where
    P: Params,
    F: FnMut(&Row<'_>) -> Result<T>,
{
    params.with_params(|params| statement.query_all(params, f))
}

#[cfg(target_arch = "wasm32")]
pub(crate) fn query_one<T, P, F>(statement: &mut Statement<'_>, params: P, f: F) -> Result<T>
where
    P: Params,
    F: FnOnce(&Row<'_>) -> Result<T>,
{
    params.with_params(|params| statement.query_one(params, f))
}

#[cfg(target_arch = "wasm32")]
pub(crate) fn query_fold<T, P, F>(
    statement: &mut Statement<'_>,
    params: P,
    init: T,
    mut f: F,
) -> Result<T>
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
pub(crate) fn query_try_map_limit<T, E, P, F>(
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
pub(crate) fn last_insert_rowid(conn: &Connection) -> Result<i64> {
    conn.query_row("SELECT last_insert_rowid()", params![], |row| {
        row_get(row, 0)
    })
}

#[cfg(target_arch = "wasm32")]
pub(crate) fn install_progress_handler(
    _conn: &Connection,
    _op_interval: i32,
    _callback_budget: u32,
) -> ProgressHandlerGuard {
    ProgressHandlerGuard
}

#[cfg(target_arch = "wasm32")]
pub(crate) fn is_interrupted(_error: &Error) -> bool {
    false
}

#[cfg(target_arch = "wasm32")]
pub(crate) trait ExecuteValues {
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
pub(crate) fn execute_values(
    conn: &impl ExecuteValues,
    sql: &str,
    values: &[types::Value],
) -> Result<()> {
    conn.execute_values(sql, values)
}

#[cfg(target_arch = "wasm32")]
pub(crate) fn params_from_values(
    values: &[types::Value],
) -> Vec<ic_sqlite_vfs::db::value::Value<'_>> {
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
