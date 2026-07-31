// Where: crates/vfs_canister/src/candid_normalization.rs
// What: Normalize exported Candid names to the stable public request types.
// Why: Derive output can reuse structurally identical request types with the wrong public name.

pub(super) fn normalize(interface: String) -> String {
    let normalized = normalize_candid_method_input(
        &interface,
        "list_children",
        "PublishNodeRequest",
        "ListChildrenRequest",
    );
    let normalized = normalize_candid_method_input(
        &normalized,
        "publish_node",
        "MkdirNodeRequest",
        "PublishNodeRequest",
    );
    let normalized = normalize_candid_method_input(
        &normalized,
        "unpublish_node",
        "MkdirNodeRequest",
        "PublishNodeRequest",
    );
    let normalized = normalize_candid_method_input(
        &normalized,
        "outgoing_links",
        "IncomingLinksRequest",
        "OutgoingLinksRequest",
    );
    let normalized = normalize_candid_method_input(
        &normalized,
        "authorize_source_capture_trigger_session",
        "OpsAnswerSessionRequest",
        "SourceCaptureTriggerSessionRequest",
    );
    let normalized = normalize_candid_method_input(
        &normalized,
        "rename_database",
        "CreateDatabaseResult",
        "RenameDatabaseRequest",
    );
    ensure_source_capture_trigger_session_request(ensure_rename_database_request(
        ensure_update_database_metadata_request(ensure_outgoing_links_request(
            ensure_list_children_request(normalized),
        )),
    ))
}

fn normalize_candid_method_input(
    interface: &str,
    method: &str,
    exported_input: &str,
    public_input: &str,
) -> String {
    let mut normalized = interface
        .lines()
        .map(|line| {
            let prefix = format!("  {method} : ({exported_input}) -> (");
            if line.starts_with(&prefix) {
                line.replacen(
                    &format!("{method} : ({exported_input})"),
                    &format!("{method} : ({public_input})"),
                    1,
                )
            } else {
                line.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join("\n");
    if interface.ends_with('\n') {
        normalized.push('\n');
    }
    normalized
}

fn ensure_outgoing_links_request(interface: String) -> String {
    if interface.contains("type OutgoingLinksRequest = record {") {
        return interface;
    }
    interface.replace(
        "type LinkEdge = record {",
        "type OutgoingLinksRequest = record { path : text; limit : nat32; database_id : text };\ntype LinkEdge = record {",
    )
}

fn ensure_list_children_request(interface: String) -> String {
    if interface.contains("type ListChildrenRequest = record {") {
        return interface;
    }
    interface.replace(
        "type ListNodesRequest = record {",
        "type ListChildrenRequest = record { path : text; database_id : text };\ntype ListNodesRequest = record {",
    )
}

fn ensure_update_database_metadata_request(interface: String) -> String {
    if interface.contains("type UpdateDatabaseMetadataRequest = record {") {
        return interface;
    }
    interface.replace(
        "type DatabaseMember = record {",
        "type UpdateDatabaseMetadataRequest = record { llm_summary : opt text; name : text; description : text; database_id : text; tags_json : text };\ntype DatabaseMember = record {",
    )
}

fn ensure_rename_database_request(interface: String) -> String {
    if interface.contains("type RenameDatabaseRequest = record {") {
        return interface;
    }
    interface.replace(
        "type DeleteNodeRequest = record {",
        "type RenameDatabaseRequest = record { name : text; database_id : text };\ntype DeleteNodeRequest = record {",
    )
}

fn ensure_source_capture_trigger_session_request(interface: String) -> String {
    if interface.contains("type SourceCaptureTriggerSessionRequest = record {") {
        return interface;
    }
    interface.replace(
        "type WriteNodeItem = record {",
        "type SourceCaptureTriggerSessionRequest = record {\n  session_nonce : text;\n  database_id : text;\n};\ntype WriteNodeItem = record {",
    )
}
