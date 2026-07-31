use anyhow::{Context, Result, anyhow};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub(crate) fn required_home_dir(purpose: &str) -> Result<PathBuf> {
    std::env::var_os("HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .ok_or_else(|| anyhow!("HOME is required for {purpose}"))
}

pub(crate) fn unique_backup_path(path: &Path, fallback_name: &str) -> PathBuf {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or(fallback_name);
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis())
        .unwrap_or(0);
    let mut candidate = parent.join(format!("{name}.backup.{millis}"));
    let mut suffix = 1;
    while candidate.exists() {
        candidate = parent.join(format!("{name}.backup.{millis}.{suffix}"));
        suffix += 1;
    }
    candidate
}

pub(crate) fn backup_existing_file(
    path: &Path,
    fallback_name: &str,
    description: &str,
) -> Result<()> {
    if !path.is_file() {
        return Ok(());
    }
    let backup = unique_backup_path(path, fallback_name);
    fs::copy(path, &backup).with_context(|| {
        format!(
            "failed to backup {} to {}",
            path.display(),
            backup.display()
        )
    })?;
    eprintln!("warning: backed up {description}: {}", backup.display());
    Ok(())
}
