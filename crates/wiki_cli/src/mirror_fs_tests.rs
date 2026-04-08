use crate::mirror::{
    MirrorFrontmatter, local_path_for_remote, parse_managed_metadata, serialize_mirror_file,
    strip_frontmatter,
};
use wiki_types::NodeKind;

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
