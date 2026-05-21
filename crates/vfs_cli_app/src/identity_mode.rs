// Where: crates/vfs_cli_app/src/identity_mode.rs
// What: Resolve the effective canister identity mode for a CLI command.
// Why: Public database reads may stay anonymous while private reads use the active icp-cli identity.
use anyhow::{Result, anyhow, bail};
use vfs_client::VfsApi;

use crate::cli::{Command, IdentityModeArg};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClientIdentityMode {
    Anonymous,
    Identity,
}

pub fn resolve_client_identity_mode(
    command: &Command,
    requested: IdentityModeArg,
    anonymous_can_read_database: Option<bool>,
    identity_is_database_member: Option<bool>,
) -> Result<ClientIdentityMode> {
    match requested {
        IdentityModeArg::Identity => Ok(ClientIdentityMode::Identity),
        IdentityModeArg::Anonymous => {
            if command.requires_identity() {
                bail!(
                    "`--identity-mode anonymous` cannot run mutating or owner commands; use `--identity-mode identity`"
                );
            }
            Ok(ClientIdentityMode::Anonymous)
        }
        IdentityModeArg::Auto => {
            if command.requires_identity() || command.prefers_identity_in_auto() {
                return Ok(ClientIdentityMode::Identity);
            }
            if command.probes_anonymous_database_read() {
                return match anonymous_can_read_database {
                    Some(true) => match identity_is_database_member {
                        Some(true) => Ok(ClientIdentityMode::Identity),
                        Some(false) => Ok(ClientIdentityMode::Anonymous),
                        None => Ok(ClientIdentityMode::Anonymous),
                    },
                    Some(false) => Ok(ClientIdentityMode::Identity),
                    None => Err(anyhow!(
                        "anonymous database access was not checked; pass --identity-mode identity or --identity-mode anonymous"
                    )),
                };
            }
            Ok(ClientIdentityMode::Anonymous)
        }
    }
}

pub async fn anonymous_can_read_database(client: &impl VfsApi, database_id: &str) -> Result<bool> {
    match client.status(database_id).await {
        Ok(_) => Ok(true),
        Err(error) if is_database_access_denied(&error) => Ok(false),
        Err(error) => Err(error).map_err(|error| {
            anyhow!(
                "failed to determine anonymous database access; pass --identity-mode identity or --identity-mode anonymous: {error}"
            )
        }),
    }
}

pub async fn identity_is_database_member(client: &impl VfsApi, database_id: &str) -> Result<bool> {
    let databases = client.list_databases().await?;
    Ok(databases
        .iter()
        .any(|database| database.database_id == database_id))
}

fn is_database_access_denied(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| {
        let message = cause.to_string();
        message.contains("principal has no access to database")
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cli::{DatabaseCommand, SkillCommand};

    #[test]
    fn auto_public_read_falls_back_to_anonymous_when_membership_check_is_unavailable() {
        let command = Command::ReadNode {
            path: "/Wiki/index.md".to_string(),
            metadata_only: false,
            fields: None,
            json: false,
        };

        assert_eq!(
            resolve_client_identity_mode(&command, IdentityModeArg::Auto, Some(true), None)
                .unwrap(),
            ClientIdentityMode::Anonymous
        );
    }

    #[test]
    fn auto_public_read_uses_identity_when_identity_is_database_member() {
        let command = Command::ReadNode {
            path: "/Wiki/index.md".to_string(),
            metadata_only: false,
            fields: None,
            json: false,
        };

        assert_eq!(
            resolve_client_identity_mode(&command, IdentityModeArg::Auto, Some(true), Some(true))
                .unwrap(),
            ClientIdentityMode::Identity
        );
    }

    #[test]
    fn auto_private_read_requires_identity_when_anonymous_cannot_read() {
        let command = Command::ReadNode {
            path: "/Wiki/index.md".to_string(),
            metadata_only: false,
            fields: None,
            json: false,
        };

        assert_eq!(
            resolve_client_identity_mode(&command, IdentityModeArg::Auto, Some(false), None)
                .unwrap(),
            ClientIdentityMode::Identity
        );
    }

    #[test]
    fn mutating_commands_require_identity() {
        let command = Command::WriteNode {
            path: "/Wiki/index.md".to_string(),
            kind: crate::cli::NodeKindArg::File,
            input: "index.md".into(),
            metadata_json: "{}".to_string(),
            expected_etag: None,
            json: false,
        };

        assert_eq!(
            resolve_client_identity_mode(&command, IdentityModeArg::Auto, None, None).unwrap(),
            ClientIdentityMode::Identity
        );
        assert!(
            resolve_client_identity_mode(&command, IdentityModeArg::Anonymous, None, None).is_err()
        );
    }

    #[test]
    fn auto_uses_identity_for_database_list() {
        let command = Command::Database {
            command: DatabaseCommand::List { json: false },
        };

        assert_eq!(
            resolve_client_identity_mode(&command, IdentityModeArg::Auto, None, None).unwrap(),
            ClientIdentityMode::Identity
        );
    }

    #[test]
    fn skill_install_uses_identity() {
        let command = Command::Skill {
            command: SkillCommand::Install {
                id: "review".to_string(),
                lockfile: "skill.lock.json".into(),
                json: false,
            },
        };

        assert_eq!(
            resolve_client_identity_mode(&command, IdentityModeArg::Auto, Some(true), Some(false))
                .unwrap(),
            ClientIdentityMode::Identity
        );
    }

    #[test]
    fn access_denied_detection_checks_known_database_access_message() {
        let error = anyhow!("principal has no access to database: private")
            .context("query failed for status");

        assert!(is_database_access_denied(&error));
    }

    #[test]
    fn access_denied_detection_ignores_generic_permission_denied() {
        let error = anyhow!("permission denied").context("query failed for status");

        assert!(!is_database_access_denied(&error));
    }
}
