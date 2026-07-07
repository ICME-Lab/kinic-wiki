// Where: crates/vfs_store/src/fs_store/marketplace.rs
// What: Marketplace listing preview queries.
// Why: Mechanical split out of fs_store.rs; a child module keeps private access.
use super::*;

impl FsStore {
    pub fn marketplace_preview(
        &self,
    ) -> Result<(MarketListingVerifiedStats, MarketListingPreview), String> {
        self.read_conn(|conn| {
            let mut stats = load_marketplace_verified_stats(conn)?;
            stats.logical_size_bytes = logical_size_bytes_for_conn(conn)?;
            let preview = MarketListingPreview {
                top_level_paths: load_marketplace_top_level_paths(conn)?,
                excerpts: load_marketplace_preview_excerpts(conn)?,
                category_graph: load_marketplace_category_graph(conn)?,
                graph_links: load_graph_links(conn, "/Knowledge", 100)?,
                preview_stale: false,
            };
            Ok((stats, preview))
        })
    }
}

pub(crate) fn load_marketplace_top_level_paths(conn: &Connection) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT child.path
             FROM fs_nodes child
             JOIN fs_nodes parent ON parent.id = child.parent_id
             WHERE parent.path = '/Knowledge'
             ORDER BY CASE child.kind WHEN 'folder' THEN 0 WHEN 'file' THEN 1 ELSE 2 END,
                      child.path ASC
             LIMIT 12",
        )
        .map_err(|error| error.to_string())?;
    crate::sqlite::query_map(&mut stmt, params![], |row| crate::sqlite::row_get(row, 0))
        .map_err(|error| error.to_string())
}

pub(crate) fn load_marketplace_preview_excerpts(
    conn: &Connection,
) -> Result<Vec<MarketPreviewExcerpt>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT path,
                    etag,
                    substr(content, 1, 240),
                    length(content)
             FROM fs_nodes
             WHERE kind = 'file'
               AND (path = '/Knowledge' OR path LIKE '/Knowledge/%')
             ORDER BY path ASC
             LIMIT ?1",
        )
        .map_err(|error| error.to_string())?;
    crate::sqlite::query_map(&mut stmt, params![MARKETPLACE_PREVIEW_NODE_LIMIT], |row| {
        let content_chars = crate::sqlite::row_get::<i64>(row, 3)?;
        Ok(MarketPreviewExcerpt {
            path: crate::sqlite::row_get(row, 0)?,
            etag: crate::sqlite::row_get(row, 1)?,
            excerpt: crate::sqlite::row_get(row, 2)?,
            content_chars: content_chars.max(0) as u64,
        })
    })
    .map_err(|error| error.to_string())
}

pub(crate) fn load_marketplace_category_graph(
    conn: &Connection,
) -> Result<MarketCategoryGraph, String> {
    let mut stmt = conn
        .prepare(
            "SELECT path
             FROM fs_nodes
             WHERE path = '/Knowledge' OR path LIKE '/Knowledge/%'
             ORDER BY path ASC",
        )
        .map_err(|error| error.to_string())?;
    let paths = crate::sqlite::query_map(&mut stmt, params![], |row| {
        crate::sqlite::row_get::<String>(row, 0)
    })
    .map_err(|error| error.to_string())?;
    let mut counts = BTreeMap::<String, u64>::new();
    for path in paths {
        if let Some(category) = marketplace_top_category(&path) {
            *counts.entry(category).or_insert(0) += 1;
        }
    }
    let mut nodes = counts
        .into_iter()
        .map(|(category, node_count)| MarketCategoryGraphNode {
            category,
            node_count,
        })
        .collect::<Vec<_>>();
    nodes.sort_by(|left, right| {
        right
            .node_count
            .cmp(&left.node_count)
            .then_with(|| left.category.cmp(&right.category))
    });
    nodes.truncate(12);
    let selected = nodes
        .iter()
        .map(|node| node.category.clone())
        .collect::<BTreeSet<_>>();

    let mut stmt = conn
        .prepare(
            "SELECT source_path, target_path
             FROM fs_links
             WHERE (source_path = '/Knowledge' OR source_path LIKE '/Knowledge/%')
               AND (target_path = '/Knowledge' OR target_path LIKE '/Knowledge/%')",
        )
        .map_err(|error| error.to_string())?;
    let edges = crate::sqlite::query_map(&mut stmt, params![], |row| {
        Ok((
            crate::sqlite::row_get::<String>(row, 0)?,
            crate::sqlite::row_get::<String>(row, 1)?,
        ))
    })
    .map_err(|error| error.to_string())?;
    let mut edge_counts = BTreeMap::<(String, String), u64>::new();
    for (source_path, target_path) in edges {
        let Some(source_category) = marketplace_top_category(&source_path) else {
            continue;
        };
        let Some(target_category) = marketplace_top_category(&target_path) else {
            continue;
        };
        if source_category == target_category
            || !selected.contains(&source_category)
            || !selected.contains(&target_category)
        {
            continue;
        }
        *edge_counts
            .entry((source_category, target_category))
            .or_insert(0) += 1;
    }
    let mut edges = edge_counts
        .into_iter()
        .map(
            |((source_category, target_category), link_count)| MarketCategoryGraphEdge {
                source_category,
                target_category,
                link_count,
            },
        )
        .collect::<Vec<_>>();
    edges.sort_by(|left, right| {
        right
            .link_count
            .cmp(&left.link_count)
            .then_with(|| left.source_category.cmp(&right.source_category))
            .then_with(|| left.target_category.cmp(&right.target_category))
    });
    edges.truncate(30);
    Ok(MarketCategoryGraph { nodes, edges })
}

pub(crate) fn marketplace_top_category(path: &str) -> Option<String> {
    let rest = path.strip_prefix("/Knowledge/")?;
    let segment = rest.split('/').next()?.trim();
    if segment.is_empty() {
        None
    } else {
        Some(format!("/Knowledge/{segment}"))
    }
}
