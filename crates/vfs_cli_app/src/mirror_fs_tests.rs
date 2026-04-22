use crate::mirror::{
    MirrorFrontmatter, TrackedNodeState, deleted_tracked_nodes, find_deleted_tracked_nodes,
    local_path_for_remote, parse_managed_metadata, serialize_mirror_file, strip_frontmatter,
};
use tempfile::tempdir;
use vfs_types::NodeKind;

#[test]
fn frontmatter_roundtrip_uses_path_and_etag() {
    let content = serialize_mirror_file(
        &MirrorFrontmatter {
            path: "/Wiki/foo.md".to_string(),
            kind: NodeKind::File,
            etag: "etag-1".to_string(),
            updated_at: 42,
            mirror: true,
        },
        "# Foo\n",
    );
    let metadata = parse_managed_metadata(&content).expect("frontmatter should parse");
    assert_eq!(metadata.path, "/Wiki/foo.md");
    assert_eq!(metadata.etag, "etag-1");
    assert_eq!(strip_frontmatter(&content).trim(), "# Foo");
}

#[test]
fn remote_paths_map_directly_under_mirror_root() {
    let path = local_path_for_remote(std::path::Path::new("/tmp/Wiki"), "/Wiki/nested/bar.md")
        .expect("path should convert");
    assert_eq!(path, std::path::Path::new("/tmp/Wiki/nested/bar.md"));
}

#[test]
fn deleted_tracked_nodes_helper_keeps_existing_files_even_without_frontmatter() {
    let tracked = vec![TrackedNodeState {
        path: "/Wiki/foo.md".to_string(),
        kind: NodeKind::File,
        etag: "etag-1".to_string(),
    }];
    let deleted = find_deleted_tracked_nodes(
        &tracked,
        |remote_path| local_path_for_remote(std::path::Path::new("/tmp/Wiki"), remote_path),
        |local_path| local_path == std::path::Path::new("/tmp/Wiki/foo.md"),
    )
    .expect("helper should succeed");
    assert!(deleted.is_empty());
}

#[test]
fn deleted_tracked_nodes_returns_only_missing_files() {
    let tracked = vec![
        TrackedNodeState {
            path: "/Wiki/foo.md".to_string(),
            kind: NodeKind::File,
            etag: "etag-1".to_string(),
        },
        TrackedNodeState {
            path: "/Wiki/missing.md".to_string(),
            kind: NodeKind::File,
            etag: "etag-2".to_string(),
        },
    ];
    let deleted = find_deleted_tracked_nodes(
        &tracked,
        |remote_path| local_path_for_remote(std::path::Path::new("/tmp/Wiki"), remote_path),
        |local_path| local_path == std::path::Path::new("/tmp/Wiki/foo.md"),
    )
    .expect("helper should succeed");
    assert_eq!(deleted, vec![tracked[1].clone()]);
}

#[test]
fn deleted_tracked_nodes_uses_file_existence_not_frontmatter() {
    let dir = tempdir().expect("temp dir should exist");
    let root = dir.path().join("Wiki");
    std::fs::create_dir_all(root.join("nested")).expect("mirror root should exist");
    std::fs::write(root.join("nested/foo.md"), "# broken\n").expect("file should write");

    let deleted = deleted_tracked_nodes(
        &root,
        &[TrackedNodeState {
            path: "/Wiki/nested/foo.md".to_string(),
            kind: NodeKind::File,
            etag: "etag-1".to_string(),
        }],
    )
    .expect("delete detection should succeed");

    assert!(deleted.is_empty());
}
