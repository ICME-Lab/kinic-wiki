//! Closed semantic schema catalog. A rebuild must never discard unknown protection.
use super::*;
use serde::Deserialize;
type Object = (String, String, String, Option<String>);
#[derive(Deserialize)]
struct Catalog {
    legacy: Vec<Object>,
    legacy_renamed: Vec<Object>,
    shared: Vec<Object>,
    optional_statistics: Vec<Object>,
}
// Generated only from checked-in migrations; never learned from the source DB.
const CATALOG: &str = include_str!("../../migrations/005_rebuild_schema.json");

pub(super) fn validate(conn: &Connection) -> Result<Vec<Object>, String> {
    let expected: Catalog = serde_json::from_str(CATALOG).map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name LIMIT 257")
        .map_err(|e| e.to_string())?;
    let actual = crate::sqlite::query_map(&mut stmt, params![], |r| {
        Ok((
            crate::sqlite::row_get(r, 0)?,
            crate::sqlite::row_get(r, 1)?,
            crate::sqlite::row_get(r, 2)?,
            crate::sqlite::row_get(r, 3)?,
        ))
    })
    .map_err(|e| e.to_string())?;
    if actual.len() > 256
        || actual
            .iter()
            .map(|r: &Object| r.3.as_ref().map_or(0, String::len))
            .sum::<usize>()
            > 1024 * 1024
    {
        return Err("unknown rebuild source schema: catalog exceeds budget".into());
    }
    let mut objects = actual.clone();
    for statistics in &expected.optional_statistics {
        if let Some(index) = objects.iter().position(|r| r.1 == statistics.1) {
            if normalized(&objects[index])? != normalized(statistics)? {
                return Err("unknown rebuild source schema: statistics definition".into());
            }
            objects.remove(index);
        }
    }
    let normalized_objects = normalize(&objects)?;
    if normalized_objects != normalize(&expected.legacy)?
        && normalized_objects != normalize(&expected.legacy_renamed)?
        && normalized_objects != normalize(&expected.shared)?
    {
        return Err(
            "unknown rebuild source schema: unsupported definitions, triggers or indexes".into(),
        );
    }
    Ok(actual)
}
fn normalize(objects: &[Object]) -> Result<Vec<Normalized>, String> {
    objects.iter().map(normalized).collect()
}
type Normalized = (String, String, String, Option<Vec<String>>);
fn normalized(object: &Object) -> Result<Normalized, String> {
    Ok((
        object.0.clone(),
        object.1.clone(),
        object.2.clone(),
        object.3.as_deref().map(tokens).transpose()?,
    ))
}
// Ignore spelling/spacing of unquoted keywords and quoted identifiers, while
// retaining token boundaries and exact string literals, operators and numbers.
// This accepts SQLite's quoted FTS rename without accepting changed predicates.
fn tokens(sql: &str) -> Result<Vec<String>, String> {
    let b = sql.as_bytes();
    let mut i = 0;
    let mut out = Vec::new();
    while i < b.len() {
        if b[i].is_ascii_whitespace() {
            i += 1;
            continue;
        }
        if b[i..].starts_with(b"--") {
            while i < b.len() && b[i] != b'\n' {
                i += 1;
            }
            continue;
        }
        if b[i..].starts_with(b"/*") {
            i += 2;
            while i + 1 < b.len() && !b[i..].starts_with(b"*/") {
                i += 1;
            }
            if i + 1 >= b.len() {
                return Err("invalid schema comment".into());
            }
            i += 2;
            continue;
        }
        if b[i] == b'\'' || b[i] == b'"' || b[i] == b'`' || b[i] == b'[' {
            let quote = b[i];
            let end = if quote == b'[' { b']' } else { quote };
            i += 1;
            let mut value = Vec::new();
            let mut closed = false;
            while i < b.len() {
                if b[i] == end {
                    i += 1;
                    if end != b']' && i < b.len() && b[i] == end {
                        value.push(end);
                        i += 1;
                    } else {
                        closed = true;
                        break;
                    }
                } else {
                    value.push(b[i]);
                    i += 1;
                }
            }
            if !closed {
                return Err("invalid schema quote".into());
            }
            let value = String::from_utf8(value).map_err(|e| e.to_string())?;
            out.push(if quote == b'\'' {
                format!("literal:{value}")
            } else {
                format!("word:{}", value.to_ascii_lowercase())
            });
        } else if b[i].is_ascii_alphanumeric() || b[i] == b'_' {
            let start = i;
            i += 1;
            while i < b.len() && (b[i].is_ascii_alphanumeric() || b[i] == b'_' || b[i] == b'$') {
                i += 1;
            }
            out.push(format!("word:{}", sql[start..i].to_ascii_lowercase()));
        } else if b[i].is_ascii() {
            out.push(format!("punct:{}", b[i] as char));
            i += 1;
        } else {
            return Err("unknown schema token".into());
        }
    }
    Ok(out)
}
