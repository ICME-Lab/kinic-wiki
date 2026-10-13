// Where: crates/vfs_store/src/fs_store/sql_json.rs
// What: Read-only SQL-over-JSON queries and SQL validation.
// Why: Mechanical split out of fs_store.rs; a child module keeps private access.
use super::*;

impl FsStore {
    pub fn query_sql_json(&self, sql: &str, limit: u32) -> Result<IndexSqlJsonQueryResult, String> {
        validate_database_sql_json_select(sql, "database SQL")?;
        let limit = sql_json_page_limit(limit);
        self.read_conn(|conn| {
            let _progress_handler = crate::sqlite::install_progress_handler(
                conn,
                SQL_JSON_PROGRESS_OP_INTERVAL,
                SQL_JSON_PROGRESS_CALLBACK_BUDGET,
            );
            let _authorizer = crate::sqlite::install_read_authorizer(conn, &["fs_nodes", "fs_links"])
                .map_err(map_sql_json_execution_error)?;
            let mut json_object_stmt = conn
                .prepare(
                    "SELECT CASE WHEN json_valid(?1) THEN json_type(?1) = 'object' ELSE 0 END",
                )
                .map_err(map_sql_json_execution_error)?;
            let mut stmt = conn.prepare(sql).map_err(map_sql_json_execution_error)?;
            let mut total_bytes = 0_usize;
            let rows = crate::sqlite::query_try_map_limit(
                &mut stmt,
                params![],
                limit as usize,
                |row| -> std::result::Result<
                    String,
                    crate::sqlite::QueryTryMapError<String>,
                > {
                    if crate::sqlite::row_has_column(row, 1)? {
                        return Err(crate::sqlite::invalid_query().into());
                    }
                    let value: Option<String> = crate::sqlite::row_get(row, 0)?;
                    let value = value.ok_or_else(crate::sqlite::invalid_query)?;
                    validate_sql_json_value_bytes("database SQL", &value, &mut total_bytes)
                        .map_err(crate::sqlite::QueryTryMapError::Validation)?;
                    let is_object: i64 = crate::sqlite::query_one(
                        &mut json_object_stmt,
                        params![value.as_str()],
                        |row| crate::sqlite::row_get(row, 0),
                    )?;
                    if is_object == 1 {
                        Ok(value)
                    } else {
                        Err(crate::sqlite::invalid_query().into())
                    }
                },
            )
            .map_err(|error| {
                let error = match error {
                    crate::sqlite::QueryTryMapError::Sqlite(error) => error,
                    crate::sqlite::QueryTryMapError::Validation(error) => return error,
                };
                if crate::sqlite::is_interrupted(&error) {
                    return SQL_JSON_EXECUTION_BUDGET_EXCEEDED.to_string();
                }
                format!(
                    "database SQL must return exactly one non-null valid JSON object TEXT column: {error}"
                )
            })?;
            Ok(IndexSqlJsonQueryResult {
                row_count: rows.len() as u32,
                rows,
                limit,
            })
        })
    }
}

pub fn validate_sql_json_select(sql: &str, label: &str) -> Result<(), String> {
    let tokens = sql_syntax_tokens(sql, label, false)?;
    validate_select_tokens(&tokens, label)
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum SqlTokenKind {
    Bare,
    QuotedIdentifier,
    OpenParen,
}

struct SqlToken {
    value: String,
    kind: SqlTokenKind,
}

impl SqlToken {
    fn is_keyword(&self, keyword: &str) -> bool {
        self.kind == SqlTokenKind::Bare && self.value == keyword
    }
}

fn validate_select_tokens(tokens: &[SqlToken], label: &str) -> Result<(), String> {
    if tokens.is_empty() {
        return Err(format!("{label} must not be empty"));
    }
    if !tokens[0].is_keyword("select") {
        return Err(format!("{label} must start with SELECT"));
    }
    let blocked = [
        "pragma", "attach", "detach", "insert", "update", "delete", "create", "drop", "alter",
        "replace", "vacuum", "reindex", "analyze",
    ];
    for token in tokens {
        if blocked.contains(&token.value.as_str()) {
            return Err(format!("{label} token is not allowed: {}", token.value));
        }
    }
    Ok(())
}

pub(crate) fn validate_database_sql_json_select(sql: &str, label: &str) -> Result<(), String> {
    if sql.len() > SQL_JSON_SQL_BYTES_MAX {
        return Err(format!(
            "{label} must be at most {SQL_JSON_SQL_BYTES_MAX} bytes"
        ));
    }
    let tokens = sql_syntax_tokens(sql, label, true)?;
    validate_select_tokens(&tokens, label)?;
    validate_database_sql_tokens(label, &tokens)
}

fn validate_database_sql_tokens(label: &str, tokens: &[SqlToken]) -> Result<(), String> {
    if tokens
        .iter()
        .filter(|token| token.is_keyword("select"))
        .count()
        != 1
    {
        return Err(format!("{label} must contain exactly one SELECT"));
    }
    let blocked = [
        "with",
        "recursive",
        "join",
        "union",
        "intersect",
        "except",
        "group",
        "having",
        "over",
        "offset",
        "random",
        "randomblob",
        "zeroblob",
        "load_extension",
        "group_concat",
        "json_group_array",
        "json_group_object",
        "count",
        "sum",
        "avg",
        "min",
        "max",
        "total",
    ];
    for token in tokens {
        if blocked.contains(&token.value.as_str()) {
            return Err(format!("{label} token is not allowed: {}", token.value));
        }
    }
    // SQLite also accepts `expr IN table_name`, an implicit table read with no
    // second SELECT or FROM. Restrict IN to explicit parenthesized values.
    for (index, token) in tokens.iter().enumerate() {
        if token.is_keyword("in")
            && tokens.get(index + 1).map(|next| next.kind) != Some(SqlTokenKind::OpenParen)
        {
            return Err(format!("{label} IN must use a parenthesized value list"));
        }
    }
    let table = validate_database_sql_from_clause(label, tokens)?;
    validate_database_sql_order_by(label, table, tokens)?;
    validate_database_sql_limit(label, tokens)
}

fn validate_database_sql_from_clause<'a>(
    label: &str,
    tokens: &'a [SqlToken],
) -> Result<&'a str, String> {
    let from_indexes = tokens
        .iter()
        .enumerate()
        .filter_map(|(index, token)| token.is_keyword("from").then_some(index))
        .collect::<Vec<_>>();
    if from_indexes.len() != 1 {
        return Err(format!("{label} must read from fs_nodes or fs_links"));
    }
    let from_index = from_indexes[0];
    let Some(table) = tokens.get(from_index + 1) else {
        return Err(format!("{label} must name a table after FROM"));
    };
    if !matches!(table.value.as_str(), "fs_nodes" | "fs_links") {
        return Err(format!("{label} table is not allowed: {}", table.value));
    }
    if let Some(extra) = tokens.get(from_index + 2)
        && !["where", "order", "limit"]
            .iter()
            .any(|keyword| extra.is_keyword(keyword))
    {
        return Err(format!("{label} must read from exactly one allowed table"));
    }
    Ok(&table.value)
}

fn validate_database_sql_order_by(
    label: &str,
    table: &str,
    tokens: &[SqlToken],
) -> Result<(), String> {
    let order_indexes = tokens
        .iter()
        .enumerate()
        .filter_map(|(index, token)| token.is_keyword("order").then_some(index))
        .collect::<Vec<_>>();
    if order_indexes.is_empty() {
        return Ok(());
    }
    if order_indexes.len() != 1 {
        return Err(format!("{label} must contain at most one ORDER BY"));
    }
    let order_index = order_indexes[0];
    if !tokens
        .get(order_index + 1)
        .is_some_and(|token| token.is_keyword("by"))
    {
        return Err(format!("{label} ORDER must be followed by BY"));
    }
    let Some(column) = tokens
        .get(order_index + 2)
        .map(|token| token.value.as_str())
    else {
        return Err(format!("{label} ORDER BY must name one allowed column"));
    };
    if !database_sql_order_column_allowed(table, column) {
        return Err(format!("{label} ORDER BY column is not allowed: {column}"));
    }
    let next_index = if tokens
        .get(order_index + 3)
        .is_some_and(|token| token.is_keyword("asc") || token.is_keyword("desc"))
    {
        order_index + 4
    } else {
        order_index + 3
    };
    if !tokens
        .get(next_index)
        .is_some_and(|token| token.is_keyword("limit"))
    {
        return Err(format!(
            "{label} ORDER BY must be one allowed column followed by LIMIT"
        ));
    }
    Ok(())
}

pub(crate) fn database_sql_order_column_allowed(table: &str, column: &str) -> bool {
    match table {
        "fs_nodes" => matches!(
            column,
            "id" | "path" | "kind" | "created_at" | "updated_at" | "etag" | "name" | "parent_id"
        ),
        "fs_links" => matches!(
            column,
            "source_path" | "target_path" | "updated_at" | "link_kind"
        ),
        _ => false,
    }
}

fn validate_database_sql_limit(label: &str, tokens: &[SqlToken]) -> Result<(), String> {
    let limit_indexes = tokens
        .iter()
        .enumerate()
        .filter_map(|(index, token)| token.is_keyword("limit").then_some(index))
        .collect::<Vec<_>>();
    if limit_indexes.len() != 1 {
        return Err(format!("{label} must contain exactly one LIMIT"));
    }
    let value = tokens.get(limit_indexes[0] + 1).ok_or_else(|| {
        format!("{label} LIMIT must be an integer between 1 and {QUERY_RESULT_LIMIT_MAX}")
    })?;
    let limit = value.value.parse::<u32>().map_err(|_| {
        format!("{label} LIMIT must be an integer between 1 and {QUERY_RESULT_LIMIT_MAX}")
    })?;
    if !(1..=QUERY_RESULT_LIMIT_MAX).contains(&limit) {
        return Err(format!(
            "{label} LIMIT must be between 1 and {QUERY_RESULT_LIMIT_MAX}"
        ));
    }
    if tokens.get(limit_indexes[0] + 2).is_some() {
        return Err(format!(
            "{label} LIMIT must be an integer between 1 and {QUERY_RESULT_LIMIT_MAX}"
        ));
    }
    Ok(())
}

pub(crate) fn validate_sql_json_value_bytes(
    label: &str,
    value: &str,
    total: &mut usize,
) -> Result<(), String> {
    if value.len() > SQL_JSON_ROW_BYTES_MAX {
        return Err(format!(
            "{label} row JSON exceeds {SQL_JSON_ROW_BYTES_MAX} bytes"
        ));
    }
    *total = total.saturating_add(value.len());
    if *total > SQL_JSON_RESPONSE_BYTES_MAX {
        return Err(format!(
            "{label} response JSON exceeds {SQL_JSON_RESPONSE_BYTES_MAX} bytes"
        ));
    }
    Ok(())
}

pub(crate) fn sql_json_page_limit(limit: u32) -> u32 {
    limit.clamp(1, QUERY_RESULT_LIMIT_MAX)
}

pub(crate) fn map_sql_json_execution_error(error: crate::sqlite::Error) -> String {
    if crate::sqlite::is_interrupted(&error) {
        SQL_JSON_EXECUTION_BUDGET_EXCEEDED.to_string()
    } else {
        error.to_string()
    }
}

// Literal values are data, while quoted identifiers must still participate in
// table, keyword, and function restrictions. This is lexical validation only;
// SQLite remains responsible for parsing the allowed statement.
fn sql_syntax_tokens(
    sql: &str,
    label: &str,
    reject_comments: bool,
) -> Result<Vec<SqlToken>, String> {
    let bytes = sql.as_bytes();
    let mut tokens = Vec::new();
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'(' => {
                tokens.push(SqlToken {
                    value: "(".into(),
                    kind: SqlTokenKind::OpenParen,
                });
                index += 1;
            }
            b';' => return Err(format!("{label} must be a single SELECT statement")),
            b'-' if bytes.get(index + 1) == Some(&b'-') => {
                if reject_comments {
                    return Err(format!("{label} comments are not allowed"));
                }
                while index < bytes.len() && !matches!(bytes[index], b'\r' | b'\n') {
                    index += 1;
                }
            }
            b'/' if bytes.get(index + 1) == Some(&b'*') => {
                if reject_comments {
                    return Err(format!("{label} comments are not allowed"));
                }
                index += 2;
                while index + 1 < bytes.len() && &bytes[index..index + 2] != b"*/" {
                    index += 1;
                }
                if index + 1 >= bytes.len() {
                    return Err(format!("{label} must contain terminated comments"));
                }
                index += 2;
            }
            b'*' if bytes.get(index + 1) == Some(&b'/') => {
                return Err(format!("{label} comments are not allowed"));
            }
            quote @ (b'\'' | b'"' | b'`' | b'[') => {
                let closing = if quote == b'[' { b']' } else { quote };
                index += 1;
                let start = index;
                loop {
                    if index == bytes.len() {
                        return Err(format!("{label} must contain terminated quotes"));
                    }
                    if bytes[index] == closing {
                        // SQLite escapes quotes by doubling them. Bracketed
                        // identifiers end at the first closing bracket.
                        if quote != b'[' && bytes.get(index + 1) == Some(&closing) {
                            index += 2;
                            continue;
                        }
                        if quote != b'\'' {
                            let value = &sql[start..index];
                            let escaped = format!("{}{}", closing as char, closing as char);
                            tokens.push(SqlToken {
                                value: value
                                    .replace(&escaped, &(closing as char).to_string())
                                    .to_ascii_lowercase(),
                                kind: SqlTokenKind::QuotedIdentifier,
                            });
                        }
                        index += 1;
                        break;
                    }
                    index += 1;
                }
            }
            byte if is_sql_identifier_character(byte as char) => {
                let start = index;
                while index < bytes.len() && is_sql_identifier_character(bytes[index] as char) {
                    index += 1;
                }
                tokens.push(SqlToken {
                    value: sql[start..index].to_ascii_lowercase(),
                    kind: SqlTokenKind::Bare,
                });
            }
            _ => index += 1,
        }
    }
    Ok(tokens)
}

pub(crate) fn is_sql_identifier_character(character: char) -> bool {
    character == '_' || character.is_ascii_alphanumeric()
}
