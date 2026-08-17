use super::*;

pub(crate) fn repository_snapshot(conn: &Connection) -> Result<GitRepositorySnapshot, String> {
    let head = head(conn)?.ok_or_else(|| "Git repository HEAD is missing".to_string())?;
    Ok(GitRepositorySnapshot {
        object_format: "sha1".to_string(),
        head_ref: HEAD_REF.to_string(),
        head_commit_oid: head.commit_oid,
        change_id: u64::try_from(head.change_id)
            .map_err(|_| format!("invalid Git snapshot change id: {}", head.change_id))?,
    })
}

pub(crate) fn list_objects(
    conn: &Connection,
    snapshot_change_id: i64,
    cursor: Option<&str>,
    limit: u32,
) -> Result<ListGitObjectsResponse, String> {
    validate_snapshot(conn, snapshot_change_id)?;
    let limit = limit.min(OBJECT_PAGE_LIMIT_MAX);
    if limit == 0 {
        return Err("limit must be greater than zero".to_string());
    }
    if let Some(cursor) = cursor {
        validate_oid(cursor)?;
    }
    let mut stmt = conn
        .prepare(
            "SELECT oid, object_type, size
             FROM git_objects
             WHERE first_change_id <= ?1 AND (?2 IS NULL OR oid > ?2)
             ORDER BY oid ASC LIMIT ?3",
        )
        .map_err(|error| error.to_string())?;
    let values = vec![
        crate::sqlite::integer_value(snapshot_change_id),
        crate::sqlite::nullable_text_value(cursor.map(str::to_string)),
        crate::sqlite::integer_value(i64::from(limit) + 1),
    ];
    let params = crate::sqlite::params_from_values(&values);
    let mut objects = crate::sqlite::query_map(&mut stmt, params, |row| {
        let size = crate::sqlite::row_get::<i64>(row, 2)?;
        Ok(GitObjectSummary {
            oid: crate::sqlite::row_get(row, 0)?,
            object_type: crate::sqlite::row_get(row, 1)?,
            size: size as u64,
        })
    })
    .map_err(|error| error.to_string())?;
    let has_more = objects.len() > limit as usize;
    objects.truncate(limit as usize);
    let next_cursor = has_more
        .then(|| objects.last().map(|item| item.oid.clone()))
        .flatten();
    Ok(ListGitObjectsResponse {
        objects,
        next_cursor,
    })
}

pub(crate) fn read_object_chunk(
    conn: &Connection,
    snapshot_change_id: i64,
    oid: &str,
    offset: u64,
    limit: u32,
) -> Result<Option<GitObjectChunk>, String> {
    validate_snapshot(conn, snapshot_change_id)?;
    validate_oid(oid)?;
    if limit == 0 || limit > OBJECT_CHUNK_BYTES_MAX {
        return Err(format!(
            "limit must be between 1 and {OBJECT_CHUNK_BYTES_MAX}"
        ));
    }
    let offset_i64 = i64::try_from(offset).map_err(|_| "offset is too large".to_string())?;
    let start = offset_i64
        .checked_add(1)
        .ok_or_else(|| "offset is too large".to_string())?;
    let row = conn
        .query_row(
            "SELECT object_type, size, COALESCE(substr(data, ?3, ?4), X'') FROM git_objects
             WHERE oid = ?1 AND first_change_id <= ?2",
            params![oid, snapshot_change_id, start, i64::from(limit)],
            |row| {
                Ok((
                    crate::sqlite::row_get::<String>(row, 0)?,
                    crate::sqlite::row_get::<i64>(row, 1)?,
                    crate::sqlite::row_get::<Option<Vec<u8>>>(row, 2)?.unwrap_or_default(),
                ))
            },
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let Some((object_type, size, data)) = row else {
        return Ok(None);
    };
    let size = u64::try_from(size).map_err(|_| "Git object size is invalid".to_string())?;
    if offset > size {
        return Err("offset exceeds Git object size".to_string());
    }
    let end = offset.saturating_add(u64::from(limit)).min(size);
    let expected_len = usize::try_from(end - offset)
        .map_err(|_| "Git object chunk length is invalid".to_string())?;
    if data.len() != expected_len {
        return Err("Git object chunk length does not match stored size".to_string());
    }
    Ok(Some(GitObjectChunk {
        oid: oid.to_string(),
        object_type,
        size,
        offset,
        data,
        next_offset: (end < size).then_some(end),
    }))
}

fn validate_snapshot(conn: &Connection, requested: i64) -> Result<(), String> {
    let current = head(conn)?.ok_or_else(|| "Git repository HEAD is missing".to_string())?;
    if requested < 0 || requested > current.change_id {
        return Err(format!("invalid Git snapshot change id: {requested}"));
    }
    Ok(())
}

fn validate_oid(oid: &str) -> Result<(), String> {
    if oid.len() != 40
        || !oid.bytes().all(|byte| byte.is_ascii_hexdigit())
        || oid.bytes().any(|byte| byte.is_ascii_uppercase())
    {
        return Err(format!("invalid Git object id: {oid}"));
    }
    Ok(())
}
