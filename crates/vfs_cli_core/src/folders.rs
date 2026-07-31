use anyhow::Result;
use std::collections::BTreeSet;
use vfs_client::VfsApi;
use vfs_types::MkdirNodeRequest;

pub async fn ensure_parent_folders(
    client: &impl VfsApi,
    database_id: &str,
    path: &str,
) -> Result<()> {
    ensure_parent_folders_for_paths(client, database_id, std::iter::once(path)).await
}

pub async fn ensure_parent_folders_for_paths<'a>(
    client: &impl VfsApi,
    database_id: &str,
    paths: impl IntoIterator<Item = &'a str>,
) -> Result<()> {
    let mut folders = BTreeSet::new();
    for path in paths {
        let segments = path.split('/').filter(|segment| !segment.is_empty());
        let mut current = String::new();
        let mut segments = segments.peekable();
        while let Some(segment) = segments.next() {
            if segments.peek().is_none() {
                break;
            }
            current.push('/');
            current.push_str(segment);
            folders.insert(current.clone());
        }
    }
    for path in folders {
        client
            .mkdir_node(MkdirNodeRequest {
                database_id: database_id.to_string(),
                path,
            })
            .await?;
    }
    Ok(())
}
