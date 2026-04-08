// Where: crates/wiki_cli/src/mirror_fixture_tests.rs
// What: Golden tests for the CLI mirror output.
// Why: The CLI and plugin must keep the same mirror file contract over time.
use crate::mirror::write_snapshot_mirror;
use std::fs;
use std::path::{Path, PathBuf};
use tempfile::tempdir;
use wiki_types::{SystemPageSnapshot, WikiPageSnapshot};

#[test]
fn write_snapshot_mirror_matches_shared_golden_files() {
    let fixture_root = fixture_root();
    let pages = load_pages(&fixture_root.join("pages.json"));
    let system_pages = load_system_pages(&fixture_root.join("system_pages.json"));
    let temp_dir = tempdir().expect("tempdir should create");
    let mirror_root = temp_dir.path().join("Wiki");

    write_snapshot_mirror(&mirror_root, &pages, &system_pages)
        .expect("mirror write should succeed");

    assert_dirs_equal(&fixture_root.join("golden"), &mirror_root);
}

fn fixture_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/mirror_spec")
}

fn load_pages(path: &Path) -> Vec<WikiPageSnapshot> {
    serde_json::from_str(&fs::read_to_string(path).expect("pages fixture should read"))
        .expect("pages fixture should parse")
}

fn load_system_pages(path: &Path) -> Vec<SystemPageSnapshot> {
    serde_json::from_str(&fs::read_to_string(path).expect("system pages fixture should read"))
        .expect("system pages fixture should parse")
}

fn assert_dirs_equal(expected_root: &Path, actual_root: &Path) {
    let expected_files = collect_relative_files(expected_root, expected_root);
    let actual_files = collect_relative_files(actual_root, actual_root);
    assert_eq!(
        expected_files, actual_files,
        "mirror file set should match golden"
    );

    for relative in expected_files {
        let expected =
            fs::read_to_string(expected_root.join(&relative)).expect("expected file should read");
        let actual =
            fs::read_to_string(actual_root.join(&relative)).expect("actual file should read");
        assert_eq!(
            actual,
            expected,
            "content mismatch for {}",
            relative.display()
        );
    }
}

fn collect_relative_files(root: &Path, current: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    for entry in fs::read_dir(current).expect("directory should read") {
        let entry = entry.expect("entry should load");
        let path = entry.path();
        if path.is_dir() {
            files.extend(collect_relative_files(root, &path));
            continue;
        }
        files.push(
            path.strip_prefix(root)
                .expect("relative path")
                .to_path_buf(),
        );
    }
    files.sort();
    files
}
