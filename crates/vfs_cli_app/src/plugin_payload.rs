// Where: crates/vfs_cli_app/src/plugin_payload.rs
// What: Embedded plugin/runtime payload files for local agent setup.
// Why: Installed kinic-vfs-cli binaries must not depend on a repo checkout.
use anyhow::{Context, Result};
use std::fs;
use std::path::Path;

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
        path: "scripts/evolve-job.sh",
        content: include_str!("../../../plugins/codex/scripts/evolve-job.sh"),
        executable: true,
    },
    PayloadFile {
        path: "scripts/record-run.sh",
        content: include_str!("../../../plugins/codex/scripts/record-run.sh"),
        executable: true,
    },
    PayloadFile {
        path: "skills/kinic-evolve-skill-job/SKILL.md",
        content: include_str!("../../../plugins/codex/skills/kinic-evolve-skill-job/SKILL.md"),
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
        path: "scripts/evolve-job.sh",
        content: include_str!("../../../plugins/claude-code/scripts/evolve-job.sh"),
        executable: true,
    },
    PayloadFile {
        path: "scripts/record-run.sh",
        content: include_str!("../../../plugins/claude-code/scripts/record-run.sh"),
        executable: true,
    },
    PayloadFile {
        path: "skills/kinic-evolve-skill-job/SKILL.md",
        content: include_str!(
            "../../../plugins/claude-code/skills/kinic-evolve-skill-job/SKILL.md"
        ),
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
        path: "kinic_hermes/evolve.py",
        content: include_str!("../../../plugins/hermes/kinic_hermes/evolve.py"),
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
        path: "kinic_agent_runtime/evolve.py",
        content: include_str!("../../../plugins/runtime/kinic_agent_runtime/evolve.py"),
        executable: false,
    },
];

pub fn replace_dir_with_payload(target: &Path, groups: &[&[PayloadFile]]) -> Result<()> {
    if target.exists() {
        fs::remove_dir_all(target)
            .with_context(|| format!("failed to replace {}", target.display()))?;
    }
    fs::create_dir_all(target).with_context(|| format!("failed to create {}", target.display()))?;
    for group in groups {
        write_payload_files(target, group)?;
    }
    Ok(())
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
