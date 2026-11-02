//! User-owned, project- and destination-scoped authorization for keyring identities.
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};
use vfs_cli::connection::ResolvedConnection;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Grant {
    pub project_root: PathBuf,
    pub replica_host: String,
    pub canister_id: String,
    pub database_id: String,
    pub identity_name: String,
    pub principal: String,
}
impl Grant {
    /// Check the operation as well as its connection before accessing credentials.
    /// Positional database arguments must not widen a saved connection grant.
    pub fn check_command(&self, command: &crate::cli::Command) -> Result<()> {
        use crate::cli::{Command, DatabaseCommand};
        match command {
            Command::Database { command } => match command {
                DatabaseCommand::Metadata { database_id, .. }
                | DatabaseCommand::PurchaseCycles { database_id, .. }
                | DatabaseCommand::CyclesHistory { database_id, .. }
                | DatabaseCommand::CyclesPending { database_id, .. }
                | DatabaseCommand::Grant { database_id, .. }
                | DatabaseCommand::GrantCurrentIdentity { database_id, .. }
                | DatabaseCommand::Revoke { database_id, .. }
                | DatabaseCommand::Members { database_id, .. }
                | DatabaseCommand::Link { database_id }
                | DatabaseCommand::Cycles { database_id, .. } => ensure!(
                    database_id == &self.database_id,
                    "scoped identity grant command database mismatch; use the authorized database"
                ),
                DatabaseCommand::Create { .. } | DatabaseCommand::List { .. } => {
                    anyhow::bail!(
                        "scoped identity grant cannot authorize this command; use a separately authorized administration workspace"
                    );
                }
                DatabaseCommand::Current { .. } | DatabaseCommand::Unlink => {}
            },
            Command::Market { .. } | Command::Cycles { .. } | Command::ReadPublicNode { .. } => {
                anyhow::bail!(
                    "scoped identity grant cannot authorize this command; use a separately authorized administration workspace"
                );
            }
            // These commands use the checked connection's database (or are local).
            // Keep this exhaustive so new command families require a scope decision.
            Command::Agent { .. }
            | Command::Learn { .. }
            | Command::Eval { .. }
            | Command::Dsh { .. }
            | Command::Identity { .. }
            | Command::Skill { .. }
            | Command::Hermes { .. }
            | Command::Codex { .. }
            | Command::Claude { .. }
            | Command::Github { .. }
            | Command::ContextPack { .. }
            | Command::RebuildIndex
            | Command::RebuildScopeIndex { .. }
            | Command::GenerateConversationWiki { .. }
            | Command::ReadNode { .. }
            | Command::PublishNode { .. }
            | Command::GetNodePublication { .. }
            | Command::UnpublishNode { .. }
            | Command::ListNodes { .. }
            | Command::ListChildren { .. }
            | Command::WriteNode { .. }
            | Command::WriteNodes { .. }
            | Command::AppendNode { .. }
            | Command::EditNode { .. }
            | Command::DeleteNode { .. }
            | Command::DeleteTree { .. }
            | Command::PurgeSourceCapture { .. }
            | Command::MkdirNode { .. }
            | Command::MoveNode { .. }
            | Command::GlobNodes { .. }
            | Command::ReadNodeContext { .. }
            | Command::GraphNeighborhood { .. }
            | Command::GraphLinks { .. }
            | Command::IncomingLinks { .. }
            | Command::OutgoingLinks { .. }
            | Command::MultiEditNode { .. }
            | Command::SearchRemote { .. }
            | Command::SearchPathRemote { .. }
            | Command::QuerySql { .. }
            | Command::MemoryManifest { .. }
            | Command::QueryContext { .. }
            | Command::SourceEvidence { .. }
            | Command::ExportSnapshot { .. }
            | Command::FetchUpdates { .. }
            | Command::Status { .. } => {}
        }
        Ok(())
    }

    pub fn check_target(&self, connection: &ResolvedConnection) -> Result<()> {
        ensure!(
            self.replica_host.trim_end_matches('/')
                == connection.replica_host.trim_end_matches('/')
                && self.canister_id == connection.canister_id
                && Some(self.database_id.as_str()) == connection.database_id.as_deref(),
            "scoped identity grant destination mismatch; review agent setup --authorize-keyring"
        );
        Ok(())
    }
    pub fn check_identity(&self, name: &str, kind: &str, principal: &str) -> Result<()> {
        self.check_name(name, kind)?;
        ensure!(
            self.principal == principal,
            "scoped identity grant principal mismatch"
        );
        Ok(())
    }
    pub fn check_name(&self, name: &str, kind: &str) -> Result<()> {
        ensure!(
            self.identity_name == name && kind == "keyring",
            "scoped identity grant identity mismatch"
        );
        Ok(())
    }
}

pub fn project_root(cwd: &Path) -> Result<PathBuf> {
    if let Some(config) = crate::learning::project::discover_config(cwd)? {
        return Ok(config
            .parent()
            .context("project config has no parent")?
            .canonicalize()?);
    }
    Ok(vfs_cli::connection::find_workspace_root_at(cwd)?.unwrap_or(cwd.canonicalize()?))
}
fn grant_path(home: &Path, root: &Path) -> PathBuf {
    home.join(".config/kinic-vfs-cli/identity-grants")
        .join(format!(
            "{}.json",
            crate::learning::hash(&root.to_string_lossy())
        ))
}
fn read_grant(path: &Path) -> Result<Grant> {
    let metadata = fs::symlink_metadata(path).context("cannot inspect scoped identity grant")?;
    ensure!(
        metadata.is_file(),
        "scoped identity grant must be a regular file"
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        ensure!(
            metadata.permissions().mode() & 0o077 == 0,
            "scoped identity grant must have private permissions"
        );
    }
    serde_json::from_slice(&vfs_cli::connection::read_local_config_bytes(path)?)
        .map_err(|_| anyhow::anyhow!("invalid scoped identity grant"))
}
pub fn lookup(home: &Path, root: &Path, connection: &ResolvedConnection) -> Result<Option<Grant>> {
    let path = grant_path(home, root);
    if !path.try_exists()? {
        return Ok(None);
    }
    let grant = read_grant(&path)?;
    ensure!(
        grant.project_root == root,
        "scoped identity grant project mismatch"
    );
    grant.check_target(connection)?;
    Ok(Some(grant))
}
pub fn save(home: &Path, grant: &Grant) -> Result<()> {
    let path = grant_path(home, &grant.project_root);
    if path.try_exists()? {
        let existing = read_grant(&path)?;
        ensure!(
            existing == *grant,
            "existing scoped identity grant differs; explicit reconciliation required"
        );
        return Ok(());
    }
    let parent = path.parent().context("grant parent missing")?;
    ensure!(
        !parent.is_symlink(),
        "identity grant directory must not be a symlink"
    );
    fs::create_dir_all(parent)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(parent, fs::Permissions::from_mode(0o700))?;
    }
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&path)?;
    file.write_all(&serde_json::to_vec_pretty(grant)?)?;
    file.sync_all()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn grant() -> Grant {
        Grant {
            project_root: PathBuf::from("/project"),
            replica_host: "https://icp-api.io".into(),
            canister_id: "canister".into(),
            database_id: "private-db".into(),
            identity_name: "wiki".into(),
            principal: "principal-a".into(),
        }
    }
    fn connection() -> ResolvedConnection {
        ResolvedConnection {
            replica_host: "https://icp-api.io/".into(),
            canister_id: "canister".into(),
            database_id: Some("private-db".into()),
            replica_host_source: "test".into(),
            canister_id_source: "test".into(),
            database_id_source: None,
        }
    }
    #[test]
    fn scoped_grant_rejects_each_changed_destination() {
        let g = grant();
        let base = connection();
        assert!(g.check_target(&base).is_ok());
        let mut changed = base.clone();
        changed.replica_host = "https://foreign.example".into();
        assert!(g.check_target(&changed).is_err());
        let mut changed = base.clone();
        changed.canister_id = "foreign".into();
        assert!(g.check_target(&changed).is_err());
        let mut changed = base;
        changed.database_id = Some("foreign".into());
        assert!(g.check_target(&changed).is_err());
    }
    #[test]
    fn scoped_grant_requires_same_keyring_identity_and_principal() {
        let g = grant();
        assert!(g.check_identity("wiki", "keyring", "principal-a").is_ok());
        assert!(g.check_identity("other", "keyring", "principal-a").is_err());
        assert!(g.check_identity("wiki", "keyring", "principal-b").is_err());
        assert!(g.check_identity("wiki", "pem", "principal-a").is_err());
    }
    #[cfg(unix)]
    #[test]
    fn grant_must_be_private_regular_file() {
        use std::os::unix::fs::{PermissionsExt, symlink};
        let temp = tempfile::tempdir().unwrap();
        let g = grant();
        save(temp.path(), &g).unwrap();
        let path = grant_path(temp.path(), &g.project_root);
        fs::set_permissions(&path, fs::Permissions::from_mode(0o666)).unwrap();
        assert!(lookup(temp.path(), &g.project_root, &connection()).is_err());
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        let other = temp.path().join("other.json");
        fs::rename(&path, &other).unwrap();
        symlink(&other, &path).unwrap();
        assert!(lookup(temp.path(), &g.project_root, &connection()).is_err());
    }
    #[test]
    fn grants_are_user_owned_isolated_and_idempotent() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let g = grant();
        save(&home, &g).unwrap();
        assert_eq!(
            lookup(&home, &g.project_root, &connection()).unwrap(),
            Some(g.clone())
        );
        assert!(
            lookup(&home, Path::new("/other-project"), &connection())
                .unwrap()
                .is_none()
        );
        save(&home, &g).unwrap();
        let mut changed = g.clone();
        changed.principal = "other".into();
        assert!(save(&home, &changed).is_err());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(grant_path(&home, &g.project_root))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
    }
}
