// Where: crates/vfs_cli_app/src/plugin_payload.rs
// What: Embedded plugin/runtime payload files for local agent setup.
// Why: Installed kinic-vfs-cli binaries must not depend on a repo checkout.
use anyhow::{Context, Result, anyhow};
use std::fs;
use std::io::ErrorKind;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

const MANAGED_MARKER_FILE: &str = ".kinic-managed-plugin";

pub struct PayloadFile {
    pub path: &'static str,
    pub content: &'static str,
    pub executable: bool,
}

pub const CODEX_PLUGIN_FILES: &[PayloadFile] = &[
    PayloadFile {
        path: ".codex-plugin/plugin.json",
        content: include_str!("../../../plugins/codex/.codex-plugin/plugin.json"),
        executable: false,
    },
    PayloadFile {
        path: "scripts/record-run.sh",
        content: include_str!("../../../plugins/codex/scripts/record-run.sh"),
        executable: true,
    },
    PayloadFile {
        path: "scripts/record-session.sh",
        content: include_str!("../../../plugins/codex/scripts/record-session.sh"),
        executable: true,
    },
    PayloadFile {
        path: "hooks/hooks.json",
        content: include_str!("../../../plugins/codex/hooks/hooks.json"),
        executable: false,
    },
    PayloadFile {
        path: "skills/kinic-record-skill-run/SKILL.md",
        content: include_str!("../../../plugins/codex/skills/kinic-record-skill-run/SKILL.md"),
        executable: false,
    },
];

pub const CLAUDE_PLUGIN_FILES: &[PayloadFile] = &[
    PayloadFile {
        path: ".claude-plugin/plugin.json",
        content: include_str!("../../../plugins/claude-code/.claude-plugin/plugin.json"),
        executable: false,
    },
    PayloadFile {
        path: "scripts/record-run.sh",
        content: include_str!("../../../plugins/claude-code/scripts/record-run.sh"),
        executable: true,
    },
    PayloadFile {
        path: "scripts/record-session.sh",
        content: include_str!("../../../plugins/claude-code/scripts/record-session.sh"),
        executable: true,
    },
    PayloadFile {
        path: "hooks/hooks.json",
        content: include_str!("../../../plugins/claude-code/hooks/hooks.json"),
        executable: false,
    },
    PayloadFile {
        path: "skills/kinic-record-skill-run/SKILL.md",
        content: include_str!(
            "../../../plugins/claude-code/skills/kinic-record-skill-run/SKILL.md"
        ),
        executable: false,
    },
];

pub const HERMES_PLUGIN_FILES: &[PayloadFile] = &[
    PayloadFile {
        path: "plugin.yaml",
        content: include_str!("../../../plugins/hermes/plugin.yaml"),
        executable: false,
    },
    PayloadFile {
        path: "kinic_hermes/__init__.py",
        content: include_str!("../../../plugins/hermes/kinic_hermes/__init__.py"),
        executable: false,
    },
    PayloadFile {
        path: "kinic_hermes/client.py",
        content: include_str!("../../../plugins/hermes/kinic_hermes/client.py"),
        executable: false,
    },
    PayloadFile {
        path: "kinic_hermes/schemas.py",
        content: include_str!("../../../plugins/hermes/kinic_hermes/schemas.py"),
        executable: false,
    },
    PayloadFile {
        path: "kinic_hermes/tools.py",
        content: include_str!("../../../plugins/hermes/kinic_hermes/tools.py"),
        executable: false,
    },
    PayloadFile {
        path: "kinic_hermes/usage.py",
        content: include_str!("../../../plugins/hermes/kinic_hermes/usage.py"),
        executable: false,
    },
];

pub const RUNTIME_FILES: &[PayloadFile] = &[
    PayloadFile {
        path: "kinic_agent_runtime/__init__.py",
        content: include_str!("../../../plugins/runtime/kinic_agent_runtime/__init__.py"),
        executable: false,
    },
    PayloadFile {
        path: "kinic_agent_runtime/cli.py",
        content: include_str!("../../../plugins/runtime/kinic_agent_runtime/cli.py"),
        executable: false,
    },
    PayloadFile {
        path: "kinic_agent_runtime/evidence.py",
        content: include_str!("../../../plugins/runtime/kinic_agent_runtime/evidence.py"),
        executable: false,
    },
    PayloadFile {
        path: "kinic_agent_runtime/session.py",
        content: include_str!("../../../plugins/runtime/kinic_agent_runtime/session.py"),
        executable: false,
    },
];

pub fn replace_dir_with_payload(target: &Path, groups: &[&[PayloadFile]]) -> Result<()> {
    match fs::symlink_metadata(target) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() {
                return Err(anyhow!(
                    "refusing to replace symlinked plugin directory: {}",
                    target.display()
                ));
            }
            if !metadata.is_dir() {
                return Err(anyhow!(
                    "refusing to replace non-directory plugin path: {}",
                    target.display()
                ));
            }
            if target.join(MANAGED_MARKER_FILE).is_file() {
                eprintln!(
                    "warning: replacing managed plugin directory: {}",
                    target.display()
                );
                fs::remove_dir_all(target)
                    .with_context(|| format!("failed to replace {}", target.display()))?;
            } else if directory_has_entries(target)? {
                let backup = unique_backup_path(target);
                eprintln!(
                    "warning: replacing unmanaged plugin directory: {} backup={}",
                    target.display(),
                    backup.display()
                );
                fs::rename(target, &backup).with_context(|| {
                    format!(
                        "failed to backup {} to {}",
                        target.display(),
                        backup.display()
                    )
                })?;
            } else {
                fs::remove_dir_all(target)
                    .with_context(|| format!("failed to replace {}", target.display()))?;
            }
        }
        Err(error) if error.kind() == ErrorKind::NotFound => {}
        Err(error) => {
            return Err(error).with_context(|| format!("failed to inspect {}", target.display()));
        }
    }
    fs::create_dir_all(target).with_context(|| format!("failed to create {}", target.display()))?;
    for group in groups {
        write_payload_files(target, group)?;
    }
    fs::write(
        target.join(MANAGED_MARKER_FILE),
        "managed by kinic-vfs-cli setup\n",
    )
    .with_context(|| format!("failed to write managed marker in {}", target.display()))?;
    Ok(())
}

fn directory_has_entries(path: &Path) -> Result<bool> {
    Ok(fs::read_dir(path)
        .with_context(|| format!("failed to read {}", path.display()))?
        .next()
        .is_some())
}

fn unique_backup_path(target: &Path) -> std::path::PathBuf {
    let parent = target.parent().unwrap_or_else(|| Path::new("."));
    let name = target
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("plugin");
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

fn write_payload_files(target: &Path, files: &[PayloadFile]) -> Result<()> {
    for file in files {
        let path = target.join(file.path);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .with_context(|| format!("failed to create {}", parent.display()))?;
        }
        fs::write(&path, file.content)
            .with_context(|| format!("failed to write {}", path.display()))?;
        if file.executable {
            set_executable(&path)?;
        }
    }
    Ok(())
}

#[cfg(unix)]
fn set_executable(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;

    let mut permissions = fs::metadata(path)
        .with_context(|| format!("failed to stat {}", path.display()))?
        .permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(path, permissions)
        .with_context(|| format!("failed to chmod {}", path.display()))
}

#[cfg(not(unix))]
fn set_executable(_path: &Path) -> Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{CLAUDE_PLUGIN_FILES, CODEX_PLUGIN_FILES, RUNTIME_FILES};

    #[test]
    fn codex_payload_includes_session_hook_files() {
        let codex_paths = CODEX_PLUGIN_FILES
            .iter()
            .map(|file| file.path)
            .collect::<Vec<_>>();
        let runtime_paths = RUNTIME_FILES
            .iter()
            .map(|file| file.path)
            .collect::<Vec<_>>();

        assert!(codex_paths.contains(&"hooks/hooks.json"));
        assert!(codex_paths.contains(&"scripts/record-session.sh"));
        assert!(runtime_paths.contains(&"kinic_agent_runtime/session.py"));
    }

    #[test]
    fn claude_payload_includes_session_hook_files() {
        let claude_paths = CLAUDE_PLUGIN_FILES
            .iter()
            .map(|file| file.path)
            .collect::<Vec<_>>();
        let runtime_paths = RUNTIME_FILES
            .iter()
            .map(|file| file.path)
            .collect::<Vec<_>>();

        assert!(claude_paths.contains(&"hooks/hooks.json"));
        assert!(claude_paths.contains(&"scripts/record-session.sh"));
        assert!(runtime_paths.contains(&"kinic_agent_runtime/session.py"));
    }
}
