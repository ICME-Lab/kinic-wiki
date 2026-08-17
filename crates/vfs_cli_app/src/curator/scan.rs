use super::*;

pub(super) async fn ensure_snapshot_revision_current(
    client: &impl VfsApi,
    database_id: &str,
    snapshot_revision: &str,
) -> Result<()> {
    let page = client
        .export_snapshot(ExportSnapshotRequest {
            database_id: database_id.to_string(),
            prefix: Some("/".to_string()),
            limit: 1,
            cursor: None,
            snapshot_revision: Some(snapshot_revision.to_string()),
            snapshot_session_id: None,
        })
        .await
        .context(
            "curator snapshot changed during link and evidence inspection; rerun curator scan",
        )?;
    if page.snapshot_revision != snapshot_revision {
        bail!(
            "curator snapshot revision changed during link and evidence inspection; rerun curator scan"
        );
    }
    Ok(())
}

pub(super) async fn export_complete_snapshot(
    client: &impl VfsApi,
    database_id: &str,
) -> Result<(String, Vec<Node>)> {
    let mut cursor = None;
    let mut revision = None;
    let mut nodes = Vec::new();
    loop {
        let page = client
            .export_snapshot(ExportSnapshotRequest {
                database_id: database_id.to_string(),
                prefix: Some("/".to_string()),
                limit: SNAPSHOT_PAGE_SIZE,
                cursor: cursor.clone(),
                snapshot_revision: revision.clone(),
                snapshot_session_id: None,
            })
            .await
            .context("curator snapshot changed or could not be read; rerun curator scan")?;
        match &revision {
            Some(expected) if expected != &page.snapshot_revision => {
                bail!("curator snapshot revision changed between pages; rerun curator scan")
            }
            None => revision = Some(page.snapshot_revision.clone()),
            _ => {}
        }
        nodes.extend(page.nodes);
        cursor = page.next_cursor;
        if cursor.is_none() {
            break;
        }
    }
    Ok((
        revision.ok_or_else(|| anyhow!("curator snapshot did not return a revision"))?,
        nodes,
    ))
}
