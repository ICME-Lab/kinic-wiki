// Public SEO reads over the verifying HTTP gateway. Only bounded certification
// hashes are retained; payloads are rebuilt from canonical storage on every read.
use super::*;
use std::collections::BTreeMap;

pub(super) const PREFIX: &str = "/api/wiki-seo/";
const MAX_ENTRIES: usize = 256;
const MAX_TEXT: usize = 16_000;
const MAX_RESPONSE_BYTES: usize = 128_000;
thread_local! {
    static ENTRIES: RefCell<BTreeMap<String, HttpCertificationTreeEntry<'static>>> = const { RefCell::new(BTreeMap::new()) };
}

pub(super) fn reset() {
    ENTRIES.with(|entries| entries.borrow_mut().clear());
    certify_http_responses();
}

pub(super) fn add_to_tree(tree: &mut HttpCertificationTree) {
    ENTRIES.with(|entries| {
        for entry in entries.borrow().values() {
            tree.insert(entry);
        }
    });
}

// Call only after authorization, in the same replicated message as a mutation.
// Prefix includes the trailing slash so similarly named databases stay independent.
pub(super) fn invalidate_database(database: &str) {
    let prefix = format!("{PREFIX}{database}/");
    let changed = ENTRIES.with(|entries| {
        let mut entries = entries.borrow_mut();
        let before = entries.len();
        entries.retain(|path, _| !path.starts_with(&prefix));
        before != entries.len()
    });
    if changed {
        certify_http_responses();
    }
}

pub(super) fn invalidate_metadata_mutation(method: &str, database: &str) {
    if matches!(
        method,
        "rename_database"
            | "update_database_metadata"
            | "grant_database_access"
            | "revoke_database_access"
            | "delete_database"
    ) {
        invalidate_database(database);
    }
}

pub(super) fn response(request: &HttpRequest, register: bool) -> HttpResponse {
    let path = request_path(&request.url);
    let Some((database_id, node_path)) = parse_path(path) else {
        return error(400);
    };
    // This closure only reads. In particular, registering one proof must not
    // invalidate proofs for other URLs as a normal state mutation would.
    let result = SERVICE.with(|slot| {
        slot.borrow()
            .as_ref()
            .ok_or_else(|| "service unavailable".to_string())
            .and_then(|service| payload(service, &database_id, &node_path))
    });
    let cel = DefaultCelBuilder::response_only_certification()
        .with_response_certification(DefaultResponseCertification::certified_response_headers(
            vec!["Content-Type", "Cache-Control"],
        ))
        .build();
    let headers = vec![
        (
            "Content-Type".into(),
            "application/json; charset=utf-8".into(),
        ),
        ("Cache-Control".into(), "no-store".into()),
        (CERTIFICATE_EXPRESSION_HEADER_NAME.into(), cel.to_string()),
    ];
    let mut response = match result {
        Ok(body) => CertifiedHttpResponse::ok(body, headers),
        Err(_) => CertifiedHttpResponse::not_found(b"null".to_vec(), headers),
    }
    .with_upgrade(false)
    .build();
    let certification =
        HttpCertification::response_only(&cel, &response, None).expect("public HTTP certification");
    let expression_path = HttpCertificationPath::exact(path.to_owned());
    let entry = HttpCertificationTreeEntry::new(expression_path.clone(), certification);
    if register {
        ENTRIES.with(|entries| {
            let mut entries = entries.borrow_mut();
            if entries.len() >= MAX_ENTRIES && !entries.contains_key(path) {
                entries.clear();
            }
            entries.insert(path.to_owned(), entry.clone());
        });
        certify_http_responses();
    }
    let known = ENTRIES.with(|entries| entries.borrow().get(path) == Some(&entry));
    if !known {
        return HttpResponse {
            status_code: 200,
            headers: text_headers(),
            body: Vec::new(),
            upgrade: Some(true),
        };
    }
    let tree = certified_http_tree();
    let witness = match tree.witness(&entry, path) {
        Ok(witness) => witness,
        Err(_) => {
            return HttpResponse {
                status_code: 200,
                headers: text_headers(),
                body: Vec::new(),
                upgrade: Some(true),
            };
        }
    };
    if let Some(certificate) = data_certificate() {
        add_v2_certificate_header(
            &certificate,
            &mut response,
            &witness,
            &expression_path.to_expr_path(),
        );
    }
    http_response_from_certified(response)
}

fn error(status_code: u16) -> HttpResponse {
    HttpResponse {
        status_code,
        headers: vec![("Cache-Control".into(), "no-store".into())],
        body: b"Not found".to_vec(),
        upgrade: Some(false),
    }
}

fn parse_path(path: &str) -> Option<(String, String)> {
    if path.len() > 4096 {
        return None;
    }
    let suffix = path.strip_prefix(PREFIX)?;
    let (database, encoded) = suffix.split_once('/')?;
    if database.is_empty()
        || database.len() > 128
        || !database
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return None;
    }
    let mut bytes = Vec::new();
    let mut input = encoded.bytes();
    while let Some(byte) = input.next() {
        if byte == b'%' {
            let hi = (input.next()? as char).to_digit(16)?;
            let lo = (input.next()? as char).to_digit(16)?;
            bytes.push((hi * 16 + lo) as u8);
        } else {
            bytes.push(byte);
        }
    }
    let decoded = String::from_utf8(bytes).ok()?;
    if decoded.chars().any(char::is_control)
        || decoded
            .split('/')
            .any(|segment| segment == "." || segment == ".." || segment.is_empty())
    {
        return None;
    }
    Some((database.to_owned(), format!("/{decoded}")))
}

// Budget the encoded JSON string, including escaping, without splitting UTF-8.
fn bounded(text: &str, byte_budget: usize) -> String {
    let mut used = 2; // surrounding JSON quotes
    text.chars()
        .take(MAX_TEXT)
        .take_while(|ch| {
            let bytes = match ch {
                '"' | '\\' | '\n' | '\r' | '\t' | '\u{8}' | '\u{c}' => 2,
                ch if (*ch as u32) < 32 => 6,
                ch => ch.len_utf8(),
            };
            used += bytes;
            used <= byte_budget
        })
        .collect()
}

// Keep valid JSON and only fields consumed by the SEO title/description helpers.
fn seo_metadata(raw: &str) -> String {
    let parsed: serde_json::Value = serde_json::from_str(raw).unwrap_or_default();
    let mut result = serde_json::Map::new();
    for key in ["title", "name", "description", "summary"] {
        if let Some(value) = parsed.get(key).and_then(|value| value.as_str()) {
            result.insert(key.into(), bounded(value, 512).into());
        }
    }
    let mut nested = serde_json::Map::new();
    for key in ["title", "name", "description", "summary"] {
        if let Some(value) = parsed
            .get("metadata")
            .and_then(|v| v.get(key))
            .and_then(|v| v.as_str())
        {
            nested.insert(key.into(), bounded(value, 512).into());
        }
    }
    if !nested.is_empty() {
        result.insert("metadata".into(), nested.into());
    }
    serde_json::Value::Object(result).to_string()
}

fn payload(service: &VfsService, database: &str, path: &str) -> Result<Vec<u8>, String> {
    const ANONYMOUS: &str = "2vxsx-fae";
    service.require_database_role(database, ANONYMOUS, RequiredRole::Reader)?;
    let summary = service
        .list_database_summaries_for_caller(ANONYMOUS)?
        .into_iter()
        .find(|summary| summary.database_id == database)
        .ok_or("database not found")?;
    let node = service.read_node(database, ANONYMOUS, path)?;
    let folder = node
        .as_ref()
        .is_none_or(|node| node.kind == vfs_types::NodeKind::Folder);
    let render_node = if folder {
        service.read_node(
            database,
            ANONYMOUS,
            &format!("{}/index.md", path.trim_end_matches('/')),
        )?
    } else {
        node
    };
    let children = if folder {
        service
            .list_children(
                ANONYMOUS,
                ListChildrenRequest {
                    database_id: database.into(),
                    path: path.into(),
                },
            )?
            .into_iter()
            .filter(|child| child.name != "index.md")
            .collect::<Vec<_>>()
    } else {
        Vec::new()
    };
    let metadata = summary.metadata.unwrap_or(DatabaseMetadata {
        name: summary.name,
        description: String::new(),
        tags_json: "[]".into(),
        llm_summary: None,
    });
    let mut body = serde_json::json!({
        "database": {"metadata": {"name": bounded(&metadata.name, 2_048), "description": bounded(&metadata.description, 8_192)}},
        "node": render_node.map(|node| serde_json::json!({"content": bounded(&node.content, 64_000), "metadataJson": seo_metadata(&node.metadata_json)})),
        "children": [],
        "childrenTruncated": false,
        "hasContent": true
    });
    let mut bytes = serde_json::to_vec(&body)
        .map_err(|error| error.to_string())?
        .len();
    let mut links = Vec::new();
    for child in children.iter().take(100) {
        let link = serde_json::json!({"path": child.path, "name": child.name});
        let link_bytes = serde_json::to_vec(&link)
            .map_err(|error| error.to_string())?
            .len()
            + usize::from(!links.is_empty());
        if bytes + link_bytes > MAX_RESPONSE_BYTES {
            break;
        }
        bytes += link_bytes;
        links.push(link);
    }
    // true is one byte shorter than the false used in the budget above.
    body["childrenTruncated"] = (links.len() < children.len()).into();
    body["children"] = links.into();
    serde_json::to_vec(&body).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encoded_string_budget_covers_all_escape_widths() {
        let text = "😀あ\u{0}\u{1}\n\r\t\u{8}\u{c}\\\"".repeat(20_000);
        for budget in [2, 3, 6, 512, 64_000] {
            let value = bounded(&text, budget);
            assert!(serde_json::to_vec(&value).unwrap().len() <= budget);
            assert!(text.starts_with(&value));
            assert!(value.chars().count() <= MAX_TEXT);
        }
    }
}
