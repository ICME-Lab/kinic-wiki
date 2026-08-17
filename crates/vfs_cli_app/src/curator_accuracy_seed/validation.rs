use super::*;

pub(super) fn seed_roots(seed_id: &str) -> Vec<String> {
    vec![
        format!("/Memory/{seed_id}"),
        format!("/Knowledge/{seed_id}"),
        format!("/Skills/{seed_id}"),
        format!("/Sessions/{seed_id}"),
        format!("/Sources/{seed_id}"),
        format!("/Sources/sessions/{seed_id}"),
        format!("/Sources/skill-runs/{seed_id}-"),
    ]
}

pub(super) fn path_is_within_root(path: &str, root: &str) -> bool {
    path == root
        || path
            .strip_prefix(root)
            .is_some_and(|suffix| root.ends_with('-') || suffix.starts_with('/'))
}

pub(super) fn validate_seed_id(seed_id: &str) -> Result<()> {
    if seed_id.is_empty()
        || seed_id.len() > 48
        || !seed_id
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
    {
        bail!("seed-id must use 1..48 lowercase ASCII letters, digits, or hyphens");
    }
    Ok(())
}

pub(super) fn canonical_seed_path(path: &str) -> bool {
    path.starts_with('/')
        && path.len() > 1
        && !path.ends_with('/')
        && !path.contains("//")
        && !path.split('/').any(|segment| matches!(segment, "." | ".."))
}

pub(super) fn is_sha256(value: &str) -> bool {
    value.len() == 71
        && value.starts_with("sha256:")
        && value[7..].bytes().all(|byte| byte.is_ascii_hexdigit())
}

pub(super) fn sha256(content: &str) -> String {
    format!("sha256:{:x}", Sha256::digest(content.as_bytes()))
}

pub(super) fn read_private<T: for<'de> Deserialize<'de>>(path: &Path, label: &str) -> Result<T> {
    require_private_file(path)?;
    let bytes =
        fs::read(path).with_context(|| format!("failed to read {label}: {}", path.display()))?;
    serde_json::from_slice(&bytes).map_err(|error| anyhow!("invalid {label} JSON: {error}"))
}
