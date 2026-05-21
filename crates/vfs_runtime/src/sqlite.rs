// Where: crates/vfs_runtime/src/sqlite.rs
// What: SQLite API boundary used by the VFS runtime.
// Why: Native tests use rusqlite while canister builds use ic-sqlite-vfs.

#[cfg(not(target_arch = "wasm32"))]
pub(crate) use rusqlite::{
    Connection, Error, OptionalExtension, Params, Result, Row, Statement, Transaction, params,
};

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
pub(crate) fn query_map<T, P, F>(statement: &mut Statement<'_>, params: P, f: F) -> Result<Vec<T>>
where
    P: Params,
    F: FnMut(&Row<'_>) -> Result<T>,
{
    statement.query_map(params, f)?.collect()
}

#[cfg(not(target_arch = "wasm32"))]
pub(crate) fn last_insert_rowid(conn: &Connection) -> Result<i64> {
    Ok(conn.last_insert_rowid())
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
    fn as_params(&self) -> &[&dyn ToSql];
}

#[cfg(target_arch = "wasm32")]
impl Params for &[&dyn ToSql] {
    fn as_params(&self) -> &[&dyn ToSql] {
        self
    }
}

#[cfg(target_arch = "wasm32")]
impl<const N: usize> Params for &[&dyn ToSql; N] {
    fn as_params(&self) -> &[&dyn ToSql] {
        self.as_slice()
    }
}

#[cfg(target_arch = "wasm32")]
impl Params for Vec<&dyn ToSql> {
    fn as_params(&self) -> &[&dyn ToSql] {
        self.as_slice()
    }
}

#[cfg(target_arch = "wasm32")]
pub(crate) mod types {
    use ic_sqlite_vfs::DbError;
    use ic_sqlite_vfs::db::value::ToSql;
    use ic_sqlite_vfs::sqlite_vfs::ffi;
    use std::ffi::c_int;

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

    impl ToSql for Value {
        fn bind_to(
            &self,
            statement: *mut ffi::sqlite3_stmt,
            index: c_int,
        ) -> std::result::Result<(), DbError> {
            match self {
                Self::Text(value) => value.bind_to(statement, index),
                Self::Integer(value) => value.bind_to(statement, index),
                Self::Blob(value) => value.bind_to(statement, index),
                Self::Null => ic_sqlite_vfs::db::NULL.bind_to(statement, index),
            }
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
pub(crate) fn query_map<T, P, F>(statement: &mut Statement<'_>, params: P, f: F) -> Result<Vec<T>>
where
    P: Params,
    F: FnMut(&Row<'_>) -> Result<T>,
{
    statement.query_all(params.as_params(), f)
}

#[cfg(target_arch = "wasm32")]
pub(crate) fn last_insert_rowid(conn: &Connection) -> Result<i64> {
    conn.query_row("SELECT last_insert_rowid()", params![], |row| {
        row_get(row, 0)
    })
}

#[cfg(target_arch = "wasm32")]
pub(crate) trait ExecuteValues {
    fn execute_values(&self, sql: &str, values: &[types::Value]) -> Result<()>;
}

#[cfg(target_arch = "wasm32")]
impl ExecuteValues for Connection {
    fn execute_values(&self, sql: &str, values: &[types::Value]) -> Result<()> {
        let params = params_from_values(values);
        self.execute(sql, params.as_slice())
    }
}

#[cfg(target_arch = "wasm32")]
impl ExecuteValues for Transaction<'_> {
    fn execute_values(&self, sql: &str, values: &[types::Value]) -> Result<()> {
        let params = params_from_values(values);
        self.execute(sql, params.as_slice())
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
pub(crate) fn params_from_values(values: &[types::Value]) -> Vec<&dyn ToSql> {
    values.iter().map(|value| value as &dyn ToSql).collect()
}
