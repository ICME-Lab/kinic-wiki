// Where: crates/wiki_cli/src/lint_local_tests.rs
// What: Tests for local working copy lint checks.
// Why: Local lint should catch structural issues before adopt-draft or push.
use crate::lint_local::{lint_local, render_local_lint_report};
use std::fs;
use tempfile::tempdir;

#[test]
fn lint_local_reports_no_issues_for_valid_draft() {
    let dir = tempdir().unwrap();
    let pages = dir.path().join("Wiki/pages");
    fs::create_dir_all(&pages).unwrap();
    fs::write(
        pages.join("alpha.md"),
        "---\nslug: alpha\ntitle: Alpha\npage_type: query_note\ndraft: true\n---\n\n# Alpha\n\nThis draft has enough body text to avoid short page warnings and should stay above the local lint threshold.\n",
    )
    .unwrap();

    let report = lint_local(&dir.path().join("Wiki")).unwrap();
    assert!(report.issues.is_empty());
    assert_eq!(render_local_lint_report(&report), "lint-local: no issues");
}

#[test]
fn lint_local_reports_missing_managed_metadata() {
    let dir = tempdir().unwrap();
    let pages = dir.path().join("Wiki/pages");
    fs::create_dir_all(&pages).unwrap();
    fs::write(
        pages.join("broken-managed.md"),
        "---\npage_id: page_1\nslug: broken-managed\nmirror: true\n---\n\n# Broken\n\nThis page is missing revision metadata.\n",
    )
    .unwrap();

    let report = lint_local(&dir.path().join("Wiki")).unwrap();
    assert!(
        report
            .issues
            .iter()
            .any(|issue| issue.kind.as_str() == "missing_managed_metadata")
    );
}

#[test]
fn lint_local_reports_missing_draft_metadata() {
    let dir = tempdir().unwrap();
    let pages = dir.path().join("Wiki/pages");
    fs::create_dir_all(&pages).unwrap();
    fs::write(
        pages.join("broken-draft.md"),
        "---\nslug: broken-draft\ndraft: true\n---\n\n# Broken Draft\n\nThis page is missing title and page type.\n",
    )
    .unwrap();

    let report = lint_local(&dir.path().join("Wiki")).unwrap();
    assert!(
        report
            .issues
            .iter()
            .any(|issue| issue.kind.as_str() == "missing_draft_metadata")
    );
}

#[test]
fn lint_local_reports_duplicate_slug_and_title() {
    let dir = tempdir().unwrap();
    let pages = dir.path().join("Wiki/pages");
    fs::create_dir_all(&pages).unwrap();
    fs::write(
        pages.join("one.md"),
        "---\nslug: shared\ntitle: Shared Title\npage_type: query_note\ndraft: true\n---\n\n# Shared Title\n\nThis is a sufficiently long first page body.\n",
    )
    .unwrap();
    fs::write(
        pages.join("two.md"),
        "---\nslug: shared\ntitle: Shared Title\npage_type: comparison\ndraft: true\n---\n\n# Shared Title\n\nThis is a sufficiently long second page body.\n",
    )
    .unwrap();

    let report = lint_local(&dir.path().join("Wiki")).unwrap();
    assert!(
        report
            .issues
            .iter()
            .any(|issue| issue.kind.as_str() == "duplicate_slug")
    );
    assert!(
        report
            .issues
            .iter()
            .any(|issue| issue.kind.as_str() == "duplicate_title")
    );
}

#[test]
fn lint_local_reports_broken_wikilink_and_short_pages() {
    let dir = tempdir().unwrap();
    let pages = dir.path().join("Wiki/pages");
    fs::create_dir_all(&pages).unwrap();
    fs::write(
        pages.join("alpha.md"),
        "---\nslug: alpha\ntitle: Alpha\npage_type: query_note\ndraft: true\n---\n\n# Alpha\n\nSee [[missing-page|Missing]].\n",
    )
    .unwrap();
    fs::write(
        pages.join("empty.md"),
        "---\nslug: empty\ntitle: Empty\npage_type: query_note\ndraft: true\n---\n\n",
    )
    .unwrap();

    let report = lint_local(&dir.path().join("Wiki")).unwrap();
    assert!(
        report
            .issues
            .iter()
            .any(|issue| issue.kind.as_str() == "broken_wikilink")
    );
    assert!(
        report
            .issues
            .iter()
            .any(|issue| issue.kind.as_str() == "empty_page")
    );
    assert!(
        report
            .issues
            .iter()
            .any(|issue| issue.kind.as_str() == "short_page")
    );
}
