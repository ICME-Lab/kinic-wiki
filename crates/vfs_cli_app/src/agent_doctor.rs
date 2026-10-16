//! Bounded read-only diagnostics. No engine processes, model calls, queue open or repairs.
use crate::{agent_config::AgentConfig, agent_setup::path_candidates, learning::cli::DoctorArgs};
use anyhow::Result;
use serde::Serialize;
use serde_json::json;
use std::path::{Path, PathBuf};
use vfs_cli::{
    cli::ConnectionArgs,
    connection::{ResolvedConnection, resolve_connection_optional_canister},
};
use vfs_client::{CanisterVfsClient, VfsApi};
use vfs_types::{ExportSnapshotRequest, NodeRevisionRequest, ScopeRevisionRequest};

#[derive(Serialize)]
pub struct Check {
    pub id: String,
    pub status: &'static str,
    pub code: &'static str,
    pub evidence: &'static str,
    pub remedy: &'static str,
}
impl Check {
    fn new(
        id: impl Into<String>,
        status: &'static str,
        code: &'static str,
        evidence: &'static str,
        remedy: &'static str,
    ) -> Self {
        Self {
            id: id.into(),
            status,
            code,
            evidence,
            remedy,
        }
    }
}
pub fn exit_code(checks: &[Check], strict: bool) -> i32 {
    if checks
        .iter()
        .any(|c| c.status == "error" || strict && ["unknown", "warning"].contains(&c.status))
    {
        1
    } else {
        0
    }
}
fn classified(id: &str, error: &anyhow::Error) -> Check {
    // Inspect typed transport errors; never print provider or replica error bodies.
    if let Some(
        ic_agent::AgentError::CertifiedReject { reject, .. }
        | ic_agent::AgentError::UncertifiedReject { reject, .. },
    ) = error.downcast_ref::<ic_agent::AgentError>()
    {
        let message = reject.reject_message.to_lowercase();
        if message.contains("has no query method") || message.contains("query method not found") {
            return Check::new(
                id,
                "error",
                "api_unsupported",
                "Replica rejected a missing query method.",
                "Use a canister version supporting the required learning read APIs.",
            );
        }
        if message.contains("unauthorized")
            || message.contains("not authorized")
            || message.contains("access denied")
            || message.contains("permission denied")
            || message.contains("principal lacks required database role:")
            || message.contains("principal has no access to database:")
        {
            return Check::new(
                id,
                "error",
                "permission_denied",
                "Replica explicitly rejected this caller's read access.",
                "Check the selected identity and database membership.",
            );
        }
    }
    Check::new(
        id,
        "unknown",
        "remote_read_failed",
        "A read request failed; permission and API support were not established.",
        "Check connectivity, replica/canister selection and identity, then rerun doctor.",
    )
}
async fn read_check<T>(id: &str, future: impl std::future::Future<Output = Result<T>>) -> Check {
    match tokio::time::timeout(std::time::Duration::from_secs(5), future).await {
        Ok(Ok(_)) => Check::new(
            id,
            "ok",
            "read_observed",
            "Read-only API request completed.",
            "No action required for this read check.",
        ),
        Ok(Err(error)) => classified(id, &error),
        Err(_) => Check::new(
            id,
            "unknown",
            "read_timeout",
            "Read request timed out.",
            "Check connectivity and rerun; timeout does not establish API or permission failure.",
        ),
    }
}
pub async fn remote_checks(client: &impl VfsApi, db: &str, namespace: &str) -> Vec<Check> {
    let mut checks = vec![read_check("database.read", client.status(db)).await];
    if checks[0].status == "ok" {
        checks.push(
            read_check(
                "api.node_revision",
                client.current_node_revision(NodeRevisionRequest {
                    database_id: db.into(),
                    path: namespace.into(),
                }),
            )
            .await,
        );
        checks.push(
            read_check(
                "api.scope_revision",
                client.scope_revision(ScopeRevisionRequest {
                    database_id: db.into(),
                    prefix: namespace.into(),
                }),
            )
            .await,
        );
        checks.push(read_check("api.read_node", client.read_node(db, namespace)).await);
        checks.push(
            read_check(
                "api.export_snapshot",
                client.export_snapshot(ExportSnapshotRequest {
                    database_id: db.into(),
                    prefix: Some(namespace.into()),
                    limit: 1,
                    cursor: None,
                    snapshot_revision: None,
                    snapshot_session_id: None,
                }),
            )
            .await,
        );
    } else {
        checks.push(Check::new(
            "api.learning",
            "skipped",
            "read_prerequisite_failed",
            "Database read was not established.",
            "Resolve database.read first.",
        ));
    }
    checks.push(Check::new(
        "database.write_permission",
        "unknown",
        "write_permission_unverified",
        "Read success does not establish write or publication permission.",
        "Review membership separately; doctor performs no test writes.",
    ));
    checks
}
fn local_checks(config: &AgentConfig, args: &DoctorArgs, home: &Path) -> Vec<Check> {
    let mut checks = vec![Check::new(
        "configuration",
        "ok",
        "configuration_resolved",
        "TOML configuration loaded without modifications.",
        "Review configuration_sources for precedence.",
    )];
    match config.recall(None) {
        Ok(Some(recall)) => {
            checks.push(Check::new(
                "learning",
                "ok",
                "recall_configured",
                "Recall settings resolved; retrieval has not been executed.",
                "Use agent recall to perform retrieval.",
            ));
            if let Some(embedding) = recall.embedding {
                let available =
                    std::env::var_os(&embedding.api_key_env).is_some_and(|v| !v.is_empty());
                checks.push(Check::new(
                    "embedding.credentials",
                    if available { "ok" } else { "error" },
                    if available {
                        "credential_present"
                    } else {
                        "credential_missing"
                    },
                    "Only the configured credential environment variable's presence was checked.",
                    "Set the configured environment variable; model access remains unverified.",
                ));
            }
        }
        Ok(None) => checks.push(Check::new(
            "learning",
            "warning",
            "learning_unconfigured",
            "No recall configuration was found.",
            "Run agent setup or provide --recall-config when running recall.",
        )),
        Err(_) => checks.push(Check::new(
            "learning",
            "error",
            "recall_config_invalid",
            "Recall fields could not be resolved.",
            "Check budget_tokens and recall field types; parser input is withheld.",
        )),
    }
    let engines = args
        .engine
        .clone()
        .map(|e| vec![e])
        .unwrap_or_else(|| config.configured_engines());
    if engines.is_empty() {
        checks.push(Check::new(
            "engines",
            "warning",
            "engine_unconfigured",
            "No engine was selected or configured.",
            "Run agent setup --engine codex or dsh.",
        ));
    }
    for engine in engines {
        let prefix = format!("engine.{engine}");
        match config.runner(Some(&engine), None) {
            Ok(runner) => {
                let candidates = path_candidates(&runner.executable);
                checks.push(Check::new(format!("{prefix}.executable"),if candidates.is_empty(){"error"}else{"ok"},if candidates.is_empty(){"executable_missing"}else{"executable_present"},"Checked filesystem existence and executable attributes only; no executable was started.","Configure an executable path in agent setup; this does not establish model connectivity."));
                if runner.timeout_seconds == 0 || runner.max_output_bytes == 0 {
                    checks.push(Check::new(
                        format!("{prefix}.limits"),
                        "error",
                        "runner_limits_invalid",
                        "Runner timeout and output limits must be positive.",
                        "Set positive timeout_seconds and max_output_bytes.",
                    ));
                }
            }
            Err(_) => checks.push(Check::new(
                format!("{prefix}.configuration"),
                "error",
                "runner_config_invalid",
                "Runner fields could not be resolved.",
                "Check agents settings and field types.",
            )),
        }
        checks.push(Check::new(
            format!("{prefix}.model"),
            "unknown",
            "model_unverified",
            "No model session was started.",
            "Run a normal task to observe model access. This doctor has no --probe mode.",
        ));
        let plugin = if engine == "codex" {
            home.join(".codex/plugins/kinic-skill-recorder/hooks/hooks.json")
        } else {
            config
                .root
                .join(".kinic/plugins/dsh/kinic-learning.patch.yml")
        };
        checks.push(Check::new(
            format!("{prefix}.placement"),
            if plugin.is_file() { "ok" } else { "warning" },
            if plugin.is_file() {
                "payload_present"
            } else {
                "payload_missing"
            },
            "Checked the default hook/overlay file location only.",
            "Run setup; custom DSH output locations require separate inspection.",
        ));
        checks.push(Check::new(format!("{prefix}.activation"),"unknown","activation_unverified","File placement does not prove enablement, trust or observed hook operation.","Check the application's plugin/profile and hook activation, and restart when required."));
    }
    let state = std::env::var_os("KINIC_LEARNING_HOME")
        .map(PathBuf::from)
        .or_else(|| config.state_dir())
        .unwrap_or(home.join(".kinic/learning"));
    checks.push(Check::new(
        "storage",
        "unknown",
        if state.exists() {
            "storage_write_unverified"
        } else {
            "storage_absent"
        },
        "No directory, database or test file was created; write access was not tested.",
        "Review the configured state directory and its parent permissions.",
    ));
    checks
}
fn project_identity_check(expected: &str, actual: Option<&str>) -> Check {
    let (status, code) = match actual {
        Some(actual) if actual == expected => ("ok", "project_identity_matches"),
        Some(_) => ("error", "project_identity_mismatch"),
        None => ("unknown", "project_identity_unverified"),
    };
    Check::new(
        "project.identity",
        status,
        code,
        "Compared the stored caller with the portable project's fixed principal when available.",
        "Select the project's bound identity or explicitly reconfigure the project.",
    )
}
pub async fn run(args: &DoctorArgs, connection: &ConnectionArgs) -> Result<i32> {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let config = home.as_ref().map(|home| {
        AgentConfig::load(
            &std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")),
            home,
        )
    });
    let mut checks = match &config {
        Some(Ok(config)) => local_checks(config, args, home.as_ref().unwrap()),
        _ => vec![Check::new(
            "configuration",
            "error",
            "configuration_invalid",
            "Configuration could not be loaded; raw parser input is withheld.",
            "Check HOME, cwd, TOML syntax and field types.",
        )],
    };
    let portable = config
        .as_ref()
        .and_then(|settings| settings.as_ref().ok())
        .and_then(|settings| settings.portable_project(None).ok().flatten());
    let mut connection = connection.clone();
    if let Some(project) = &portable {
        if !connection.local && connection.replica_host.is_none() {
            connection.replica_host = Some(project.replica_host.clone());
        }
        if connection.canister_id.is_none() && std::env::var_os("VFS_CANISTER_ID").is_none() {
            connection.canister_id = Some(project.canister_id.clone());
        }
        if connection.database_id.is_none() && std::env::var_os("VFS_DATABASE_ID").is_none() {
            connection.database_id = Some(project.database_id.clone());
        }
    }
    let preview = resolve_connection_optional_canister(
        connection.local,
        connection.replica_host.clone(),
        connection.canister_id.clone(),
        connection.database_id.clone(),
    );
    let mut identity = None;
    let mut target = json!(null);
    match preview {
        Ok(preview) => {
            target = json!({"canister_id":preview.canister_id,"database_id":preview.database_id,"sources":{"replica_host":preview.replica_host_source,"canister_id":preview.canister_id_source,"database_id":preview.database_id_source}});
            if let (Some(project), Some(canister)) = (&portable, &preview.canister_id) {
                let resolved = ResolvedConnection {
                    replica_host: preview.replica_host.clone(),
                    canister_id: canister.clone(),
                    database_id: preview.database_id.clone(),
                    replica_host_source: preview.replica_host_source.clone(),
                    canister_id_source: preview.canister_id_source.clone().unwrap_or_default(),
                    database_id_source: preview.database_id_source.clone(),
                };
                let matches = project.validate_connection(&resolved).is_ok();
                checks.push(Check::new(
                    "project.connection",
                    if matches { "ok" } else { "error" },
                    if matches {
                        "project_connection_matches"
                    } else {
                        "project_connection_mismatch"
                    },
                    "Compared the resolved target with the portable project's fixed connection.",
                    "Use the project's bound destination or explicitly reconfigure the project.",
                ));
            }
            if let Some(canister) = preview.canister_id.as_deref() {
                match crate::identity::load_diagnostic_identity(canister,connection.allow_non_ii_identity) {
                    Ok(Some(found))=> {
                        if let Some(expected) = portable.as_ref().and_then(|project| project.principal.as_deref()) {
                            checks.push(project_identity_check(expected, found.sender().ok().map(|p| p.to_text()).as_deref()));
                        }
                        identity=Some(found); checks.push(Check::new("identity","ok","credential_loaded","Stored identity and delegation loaded read-only; authentication will be tested by a read request.","No credential was exported or refreshed.")); }
                    Ok(None)=>checks.push(Check::new("identity","unknown","credential_storage_unavailable","Identity storage cannot be accessed without an external credential operation.","Check the active icp-cli identity separately; doctor will identify any read as anonymous.")),
                    Err(_)=>checks.push(Check::new("identity","error","credential_missing_or_invalid","Active stored identity or delegation is missing, invalid or expired.","Configure/login to an icp-cli identity separately; doctor does not refresh it.")),
                }
            }
            if identity.is_none() {
                if let Some(expected) = portable
                    .as_ref()
                    .and_then(|project| project.principal.as_deref())
                {
                    checks.push(project_identity_check(expected, None));
                }
            }
            if let (Some(canister), Some(db)) = (
                preview.canister_id.as_deref(),
                preview.database_id.as_deref(),
            ) {
                let authenticated = identity.is_some();
                checks.push(Check::new("database.caller",if authenticated{"ok"}else{"unknown"},if authenticated{"authenticated_read_selected"}else{"anonymous_read_selected"},"Database checks identify whether a stored identity or anonymous caller is used.","Anonymous results do not establish the selected identity's access."));
                let client = tokio::time::timeout(std::time::Duration::from_secs(5), async {
                    if let Some(identity) = identity {
                        CanisterVfsClient::new_with_boxed_identity(
                            &preview.replica_host,
                            canister,
                            identity,
                        )
                        .await
                    } else {
                        CanisterVfsClient::new(&preview.replica_host, canister).await
                    }
                })
                .await;
                match client {
                    Ok(Ok(client)) => {
                        let namespace = config
                            .as_ref()
                            .and_then(|c| c.as_ref().ok())
                            .and_then(|c| c.recall(None).ok().flatten())
                            .map(|r| r.namespace)
                            .unwrap_or_else(|| "/Knowledge".into());
                        let mut remote = remote_checks(&client, db, &namespace).await;
                        if !authenticated {
                            for check in &mut remote {
                                if check.code == "permission_denied" {
                                    check.status = "unknown";
                                    check.code = "identity_access_unverified";
                                    check.evidence = "Anonymous read was denied; the selected stored identity's access was not tested.";
                                }
                            }
                        }
                        checks.extend(remote);
                    }
                    _ => checks.push(Check::new(
                        "database.read",
                        "unknown",
                        "connection_unavailable",
                        "Read client could not connect within its bound; details are withheld.",
                        "Check replica, canister and network settings.",
                    )),
                }
            } else {
                checks.push(Check::new(
                    "database.read",
                    "skipped",
                    "connection_incomplete",
                    "Database or canister is not configured.",
                    "Link a database or provide connection arguments.",
                ));
                checks.push(Check::new(
                    "database.configuration",
                    "error",
                    "database_missing",
                    "A database target is required for learning.",
                    "Use database link or --database-id.",
                ));
            }
        }
        Err(_) => checks.push(Check::new(
            "connection",
            "error",
            "connection_config_invalid",
            "Connection configuration could not be parsed.",
            "Check existing connection settings; other local checks remain available.",
        )),
    }
    let code = exit_code(&checks, args.strict);
    let value = json!({"schema_version":1,"checked_at":chrono::Utc::now().to_rfc3339(),"target":target,"configuration_sources":config.as_ref().and_then(|v|v.as_ref().ok()).map(|c|&c.sources),"checks":checks});
    if args.json {
        println!("{}", serde_json::to_string_pretty(&value)?);
    } else {
        for check in value["checks"].as_array().unwrap() {
            println!(
                "{} {} [{}]: {} {}",
                check["status"].as_str().unwrap(),
                check["id"].as_str().unwrap(),
                check["code"].as_str().unwrap(),
                check["evidence"].as_str().unwrap(),
                check["remedy"].as_str().unwrap()
            );
        }
    }
    Ok(code)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn rejection(message: &str) -> anyhow::Error {
        ic_agent::AgentError::CertifiedReject {
            reject: ic_agent::agent::RejectResponse {
                reject_code: ic_agent::agent::RejectCode::CanisterReject,
                reject_message: message.into(),
                error_code: None,
            },
            operation: None,
        }
        .into()
    }
    #[test]
    fn portable_identity_binding_distinguishes_mismatch_and_unavailable() {
        assert_eq!(
            project_identity_check("bound", Some("other")).code,
            "project_identity_mismatch"
        );
        assert_eq!(project_identity_check("bound", Some("bound")).status, "ok");
        assert_eq!(project_identity_check("bound", None).status, "unknown");
    }
    #[test]
    fn classifies_actual_database_access_errors_separately_from_unsupported_api() {
        for message in [
            "principal lacks required database role: private-db",
            "principal has no access to database: private-db",
        ] {
            assert_eq!(
                classified("database.read", &rejection(message)).code,
                "permission_denied"
            );
        }
        assert_eq!(
            classified(
                "api",
                &rejection("Canister has no query method 'scope_revision'")
            )
            .code,
            "api_unsupported"
        );
        let generic = anyhow::anyhow!("server offline secret=DO_NOT_ECHO permission denied");
        let check = classified("database.read", &generic);
        assert_eq!(check.status, "unknown");
        assert!(
            !serde_json::to_string(&check)
                .unwrap()
                .contains("DO_NOT_ECHO")
        );
    }
    #[test]
    fn strict_unknown_and_warnings_do_not_hide_errors_or_fail_on_targetless_skips() {
        let unknown = Check::new(
            "model",
            "unknown",
            "model_unverified",
            "not executed",
            "run a task",
        );
        assert_eq!(exit_code(&[unknown], false), 0);
        let warning = Check::new("plugin", "warning", "payload_missing", "missing", "setup");
        assert_eq!(exit_code(&[warning], true), 1);
        let skipped = Check::new(
            "optional",
            "skipped",
            "not_selected",
            "not selected",
            "none",
        );
        assert_eq!(exit_code(&[skipped], true), 0);
    }
}
