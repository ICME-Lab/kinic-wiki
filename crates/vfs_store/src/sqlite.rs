// Where: crates/vfs_store/src/sqlite.rs
// What: SQLite API boundary used by the VFS store.
// Why: Native tests use rusqlite while canister builds use ic-sqlite-vfs.

#[cfg(not(target_arch = "wasm32"))]
pub(crate) use rusqlite::{
    Connection, Error, OptionalExtension, Params, Result, Row, Statement, Transaction, params,
    params_from_iter,
};

#[cfg(not(target_arch = "wasm32"))]
pub(crate) mod types {
    pub(crate) use rusqlite::types::{Type, Value};
}

#[cfg(not(target_arch = "wasm32"))]
pub(crate) fn invalid_column_type(index: usize, name: String, kind: types::Type) -> Error {
    Error::InvalidColumnType(index, name, kind)
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
pub(crate) fn statement_exists<P>(statement: &mut Statement<'_>, params: P) -> Result<bool>
where
    P: Params,
{
    statement.exists(params)
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

    #[derive(Clone, Copy, Debug)]
    pub(crate) enum Type {
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
pub(crate) fn invalid_column_type(index: usize, _name: String, kind: types::Type) -> Error {
    Error::TypeMismatch {
        index,
        expected: match kind {
            types::Type::Text => "TEXT",
        },
        actual: "UNKNOWN",
    }
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
pub(crate) fn statement_exists<P>(statement: &mut Statement<'_>, params: P) -> Result<bool>
where
    P: Params,
{
    statement
        .query_optional(params.as_params(), |_row| Ok(()))
        .map(|row| row.is_some())
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

#[cfg(not(target_arch = "wasm32"))]
pub(crate) fn params_from_values(values: &[types::Value]) -> impl Params + '_ {
    params_from_iter(values.iter())
}

#[cfg(target_arch = "wasm32")]
pub(crate) fn params_from_values(values: &[types::Value]) -> Vec<&dyn ToSql> {
    values.iter().map(|value| value as &dyn ToSql).collect()
}

#[cfg(not(target_arch = "wasm32"))]
pub(crate) fn params_from_i64s(values: &[i64]) -> impl Params + '_ {
    params_from_iter(values.iter().copied())
}

#[cfg(target_arch = "wasm32")]
pub(crate) fn params_from_i64s(values: &[i64]) -> Vec<&dyn ToSql> {
    values.iter().map(|value| value as &dyn ToSql).collect()
}
