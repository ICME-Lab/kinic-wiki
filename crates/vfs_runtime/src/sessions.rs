// Where: crates/vfs_runtime/src/sessions.rs
// What: Source capture, ops answer, and source run session authorization.
// Why: Mechanical split out of lib.rs; a child module keeps same-crate private access.
use super::*;

impl VfsService {
    pub fn authorize_source_capture_trigger_session(
        &self,
        caller: &str,
        request: SourceCaptureTriggerSessionRequest,
        now: i64,
    ) -> Result<(), String> {
        validate_source_capture_trigger_session_request(&request)?;
        if caller == "2vxsx-fae" {
            return Err("anonymous caller not allowed".to_string());
        }
        self.require_role(&request.database_id, caller, RequiredRole::Writer)?;
        self.require_role(
            &request.database_id,
            DEFAULT_LLM_WRITER_PRINCIPAL,
            RequiredRole::Writer,
        )
        .map_err(|error| format!("LLM writer principal lacks writer access: {error}"))?;
        self.write_index(|conn| {
            purge_expired_source_capture_trigger_sessions(conn, now)?;
            conn.execute(
                "INSERT INTO source_capture_trigger_sessions
             (database_id, session_nonce, principal, expires_at_ms, created_at_ms,
              refreshed_at_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?5)
             ON CONFLICT(database_id, session_nonce) DO UPDATE SET
               principal = excluded.principal,
               expires_at_ms = excluded.expires_at_ms,
               refreshed_at_ms = excluded.refreshed_at_ms",
                params![
                    request.database_id,
                    request.session_nonce,
                    caller,
                    now + SOURCE_CAPTURE_TRIGGER_SESSION_TTL_MS,
                    now
                ],
            )
            .map_err(|error| error.to_string())?;
            Ok(())
        })
    }

    pub fn check_source_capture_trigger_session(
        &self,
        request: SourceCaptureTriggerSessionCheckRequest,
        now: i64,
    ) -> Result<(), String> {
        validate_source_capture_trigger_session_check_request(&request)?;
        self.require_role(
            &request.database_id,
            DEFAULT_LLM_WRITER_PRINCIPAL,
            RequiredRole::Writer,
        )
        .map_err(|error| format!("LLM writer principal lacks writer access: {error}"))?;
        let principal: String = self.read_index(|conn| {
            conn.query_row(
                "SELECT principal FROM source_capture_trigger_sessions
                 WHERE database_id = ?1
                   AND session_nonce = ?2
                   AND expires_at_ms >= ?3",
                params![request.database_id, request.session_nonce, now],
                |row| crate::sqlite::row_get(row, 0),
            )
            .optional()
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "source capture trigger session is missing or expired".to_string())
        })?;
        let node = self
            .read_node(&request.database_id, &principal, &request.request_path)?
            .ok_or_else(|| format!("source capture request not found: {}", request.request_path))?;
        validate_source_capture_request_node(&node, &principal)?;
        self.require_database_write_cycles_available(&request.database_id)
    }

    pub fn authorize_ops_answer_session(
        &self,
        caller: &str,
        request: OpsAnswerSessionRequest,
        now: i64,
    ) -> Result<(), String> {
        validate_ops_answer_session_request(&request)?;
        if caller == "2vxsx-fae" {
            return Err("anonymous caller not allowed".to_string());
        }
        self.require_role(&request.database_id, caller, RequiredRole::Reader)?;
        self.write_index(|conn| {
            purge_expired_ops_answer_sessions(conn, now)?;
            conn.execute(
                "INSERT INTO ops_answer_sessions
             (database_id, session_nonce, principal, expires_at_ms, created_at_ms,
              refreshed_at_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?5)
             ON CONFLICT(database_id, session_nonce) DO UPDATE SET
               principal = excluded.principal,
               expires_at_ms = excluded.expires_at_ms,
               refreshed_at_ms = excluded.refreshed_at_ms",
                params![
                    request.database_id,
                    request.session_nonce,
                    caller,
                    now + OPS_ANSWER_SESSION_TTL_MS,
                    now
                ],
            )
            .map_err(|error| error.to_string())?;
            Ok(())
        })
    }

    pub fn check_ops_answer_session(
        &self,
        request: OpsAnswerSessionCheckRequest,
        now: i64,
    ) -> Result<OpsAnswerSessionCheckResult, String> {
        validate_ops_answer_session_check_request(&request)?;
        let principal: String = self.read_index(|conn| {
            conn.query_row(
                "SELECT principal FROM ops_answer_sessions
                 WHERE database_id = ?1
                   AND session_nonce = ?2
                   AND expires_at_ms >= ?3",
                params![request.database_id, request.session_nonce, now],
                |row| crate::sqlite::row_get(row, 0),
            )
            .optional()
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "ops answer session is missing or expired".to_string())
        })?;
        self.require_role(&request.database_id, &principal, RequiredRole::Reader)?;
        self.require_database_write_cycles_available(&request.database_id)?;
        Ok(OpsAnswerSessionCheckResult { principal })
    }

    pub fn check_source_run_session(
        &self,
        request: SourceRunSessionCheckRequest,
        now: i64,
    ) -> Result<(), String> {
        validate_source_run_session_check_request(&request)?;
        self.require_role(
            &request.database_id,
            DEFAULT_LLM_WRITER_PRINCIPAL,
            RequiredRole::Writer,
        )
        .map_err(|error| format!("LLM writer principal lacks writer access: {error}"))?;
        let principal: String = self.read_index(|conn| {
            conn.query_row(
                "SELECT principal FROM source_run_sessions
                 WHERE database_id = ?1
                   AND source_path = ?2
                   AND source_etag = ?3
                   AND session_nonce = ?4
                   AND expires_at_ms >= ?5",
                params![
                    request.database_id,
                    request.source_path,
                    request.source_etag,
                    request.session_nonce,
                    now
                ],
                |row| crate::sqlite::row_get(row, 0),
            )
            .optional()
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "source run session is missing or expired".to_string())
        })?;
        self.require_role(&request.database_id, &principal, RequiredRole::Writer)?;
        let source = self
            .read_node(&request.database_id, &principal, &request.source_path)?
            .ok_or_else(|| format!("source node not found: {}", request.source_path))?;
        if source.kind != NodeKind::Source {
            return Err("source run session target is not a source node".to_string());
        }
        if source.etag != request.source_etag {
            return Err("source run session source etag is stale".to_string());
        }
        self.require_database_write_cycles_available(&request.database_id)?;
        Ok(())
    }

    pub(crate) fn write_source_run_session(
        &self,
        database_id: &str,
        source_path: &str,
        source_etag: &str,
        session_nonce: &str,
        principal: &str,
        now: i64,
    ) -> Result<(), String> {
        self.write_index(|conn| {
            purge_expired_source_run_sessions(conn, now)?;
            conn.execute(
                "INSERT INTO source_run_sessions
                 (database_id, source_path, source_etag, session_nonce, principal,
                  expires_at_ms, created_at_ms, refreshed_at_ms)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
                 ON CONFLICT(database_id, session_nonce) DO UPDATE SET
                   source_path = excluded.source_path,
                   source_etag = excluded.source_etag,
                   principal = excluded.principal,
                   expires_at_ms = excluded.expires_at_ms,
                   refreshed_at_ms = excluded.refreshed_at_ms",
                params![
                    database_id,
                    source_path,
                    source_etag,
                    session_nonce,
                    principal,
                    now + SOURCE_RUN_SESSION_TTL_MS,
                    now
                ],
            )
            .map_err(|error| error.to_string())?;
            Ok(())
        })
    }
}

fn validate_source_capture_trigger_session_request(
    request: &SourceCaptureTriggerSessionRequest,
) -> Result<(), String> {
    if request.database_id.trim().is_empty() {
        return Err("database_id is required".to_string());
    }
    validate_source_capture_trigger_session_nonce(&request.session_nonce)
}

fn validate_source_capture_trigger_session_check_request(
    request: &SourceCaptureTriggerSessionCheckRequest,
) -> Result<(), String> {
    if request.database_id.trim().is_empty() {
        return Err("database_id is required".to_string());
    }
    validate_source_capture_trigger_session_nonce(&request.session_nonce)?;
    validate_source_capture_request_path(&request.request_path)
}

fn validate_ops_answer_session_request(request: &OpsAnswerSessionRequest) -> Result<(), String> {
    if request.database_id.trim().is_empty() {
        return Err("database_id is required".to_string());
    }
    validate_session_nonce(&request.session_nonce)
}

fn validate_ops_answer_session_check_request(
    request: &OpsAnswerSessionCheckRequest,
) -> Result<(), String> {
    if request.database_id.trim().is_empty() {
        return Err("database_id is required".to_string());
    }
    validate_session_nonce(&request.session_nonce)
}

pub(crate) fn validate_source_for_generation_request(
    request: &WriteSourceForGenerationRequest,
) -> Result<(), String> {
    if request.database_id.trim().is_empty() {
        return Err("database_id is required".to_string());
    }
    validate_session_nonce(&request.session_nonce)
}

fn validate_source_run_session_check_request(
    request: &SourceRunSessionCheckRequest,
) -> Result<(), String> {
    if request.database_id.trim().is_empty() {
        return Err("database_id is required".to_string());
    }
    if request.source_etag.trim().is_empty() {
        return Err("source_etag is required".to_string());
    }
    validate_session_nonce(&request.session_nonce)
}

fn validate_source_capture_trigger_session_nonce(session_nonce: &str) -> Result<(), String> {
    validate_session_nonce(session_nonce)
}

fn validate_session_nonce(session_nonce: &str) -> Result<(), String> {
    if session_nonce.trim().is_empty() {
        return Err("session_nonce is required".to_string());
    }
    if session_nonce.len() > 128 {
        return Err("session_nonce is too long".to_string());
    }
    Ok(())
}

fn validate_source_capture_request_path(request_path: &str) -> Result<(), String> {
    if !request_path.starts_with("/Sources/source-capture-requests/")
        || !request_path.ends_with(".md")
    {
        return Err("request_path must be a source capture request path".to_string());
    }
    Ok(())
}

fn validate_source_capture_request_node(node: &Node, caller: &str) -> Result<(), String> {
    if node.kind != NodeKind::File {
        return Err("source capture request must be a file node".to_string());
    }
    let frontmatter = parse_frontmatter_fields(&node.content)?;
    expect_frontmatter(&frontmatter, "kind", "kinic.source_capture_request")?;
    expect_frontmatter(&frontmatter, "schema_version", "1")?;
    let status = frontmatter
        .get("status")
        .and_then(|value| value.as_deref())
        .ok_or_else(|| "source capture request status is required".to_string())?;
    if status != "queued"
        && status != "fetching"
        && status != "source_written"
        && status != "generating"
    {
        return Err("source capture request is not triggerable".to_string());
    }
    let requested_by = frontmatter
        .get("requested_by")
        .and_then(|value| value.as_deref())
        .ok_or_else(|| "source capture request requested_by is required".to_string())?;
    if requested_by != caller {
        return Err("source capture request caller mismatch".to_string());
    }
    Ok(())
}

pub(crate) fn parse_frontmatter_fields(
    content: &str,
) -> Result<BTreeMap<String, Option<String>>, String> {
    let rest = content
        .strip_prefix("---\n")
        .ok_or_else(|| "source capture request frontmatter is required".to_string())?;
    let end = frontmatter_end(rest)
        .ok_or_else(|| "source capture request frontmatter is not closed".to_string())?;
    let frontmatter = &rest[..end];
    let mut fields = BTreeMap::new();
    for line in frontmatter.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let Some((key, value)) = trimmed.split_once(':') else {
            return Err("source capture request frontmatter is invalid".to_string());
        };
        fields.insert(key.trim().to_string(), frontmatter_scalar(value.trim())?);
    }
    Ok(fields)
}

fn frontmatter_scalar(value: &str) -> Result<Option<String>, String> {
    if value == "null" || value == "~" {
        return Ok(None);
    }
    if value.len() >= 2 && value.starts_with('"') && value.ends_with('"') {
        return parse_json_string_literal(value).map(Some);
    }
    if value.len() >= 2 && value.starts_with('\'') && value.ends_with('\'') {
        return Ok(Some(value[1..value.len() - 1].replace("''", "'")));
    }
    Ok(Some(value.to_string()))
}

fn frontmatter_end(rest: &str) -> Option<usize> {
    rest.find("\n---\n").or_else(|| {
        rest.ends_with("\n---")
            .then_some(rest.len() - "\n---".len())
    })
}

fn parse_json_string_literal(value: &str) -> Result<String, String> {
    let body = value
        .strip_prefix('"')
        .and_then(|inner| inner.strip_suffix('"'))
        .ok_or_else(|| "source capture request frontmatter quoted scalar is invalid".to_string())?;
    let mut chars = body.chars();
    let mut decoded = String::new();
    while let Some(ch) = chars.next() {
        if ch == '\\' {
            let escaped = chars.next().ok_or_else(invalid_quoted_scalar)?;
            decode_json_escape(escaped, &mut chars, &mut decoded)?;
            continue;
        }
        if ch.is_control() {
            return Err(invalid_quoted_scalar());
        }
        decoded.push(ch);
    }
    Ok(decoded)
}

fn decode_json_escape(
    escaped: char,
    chars: &mut std::str::Chars<'_>,
    decoded: &mut String,
) -> Result<(), String> {
    match escaped {
        '"' => decoded.push('"'),
        '\\' => decoded.push('\\'),
        '/' => decoded.push('/'),
        'b' => decoded.push('\u{0008}'),
        'f' => decoded.push('\u{000c}'),
        'n' => decoded.push('\n'),
        'r' => decoded.push('\r'),
        't' => decoded.push('\t'),
        'u' => {
            let code = parse_json_hex4(chars)?;
            if (0xD800..=0xDBFF).contains(&code) {
                let slash = chars.next().ok_or_else(invalid_quoted_scalar)?;
                let marker = chars.next().ok_or_else(invalid_quoted_scalar)?;
                if slash != '\\' || marker != 'u' {
                    return Err(invalid_quoted_scalar());
                }
                let low = parse_json_hex4(chars)?;
                if !(0xDC00..=0xDFFF).contains(&low) {
                    return Err(invalid_quoted_scalar());
                }
                let scalar = 0x10000 + ((code - 0xD800) << 10) + (low - 0xDC00);
                decoded.push(char::from_u32(scalar).ok_or_else(invalid_quoted_scalar)?);
            } else if (0xDC00..=0xDFFF).contains(&code) {
                return Err(invalid_quoted_scalar());
            } else {
                decoded.push(char::from_u32(code).ok_or_else(invalid_quoted_scalar)?);
            }
        }
        _ => return Err(invalid_quoted_scalar()),
    }
    Ok(())
}

fn parse_json_hex4(chars: &mut std::str::Chars<'_>) -> Result<u32, String> {
    let mut code = 0u32;
    for _ in 0..4 {
        code *= 16;
        code += chars
            .next()
            .and_then(|ch| ch.to_digit(16))
            .ok_or_else(invalid_quoted_scalar)?;
    }
    Ok(code)
}

fn invalid_quoted_scalar() -> String {
    "source capture request frontmatter quoted scalar is invalid".to_string()
}

fn expect_frontmatter(
    frontmatter: &BTreeMap<String, Option<String>>,
    key: &str,
    expected: &str,
) -> Result<(), String> {
    let value = frontmatter
        .get(key)
        .and_then(|value| value.as_deref())
        .ok_or_else(|| format!("source capture request {key} is required"))?;
    if value == expected {
        Ok(())
    } else {
        Err(format!("source capture request {key} is invalid"))
    }
}

fn purge_expired_source_capture_trigger_sessions(
    conn: &Connection,
    now: i64,
) -> Result<(), String> {
    conn.execute(
        "DELETE FROM source_capture_trigger_sessions WHERE expires_at_ms < ?1",
        params![now],
    )
    .map(|_| ())
    .map_err(|error| error.to_string())
}

fn purge_expired_ops_answer_sessions(conn: &Connection, now: i64) -> Result<(), String> {
    conn.execute(
        "DELETE FROM ops_answer_sessions WHERE expires_at_ms < ?1",
        params![now],
    )
    .map(|_| ())
    .map_err(|error| error.to_string())
}

fn purge_expired_source_run_sessions(conn: &Connection, now: i64) -> Result<(), String> {
    conn.execute(
        "DELETE FROM source_run_sessions WHERE expires_at_ms < ?1",
        params![now],
    )
    .map(|_| ())
    .map_err(|error| error.to_string())
}
