// Where: crates/wiki_agent_schema/src/lib.rs
// What: Default agent-facing wiki maintenance rules and templates.
// Why: The runtime can expose a stable schema layer without hard-coding long prompts into application logic.
pub const INGEST_STEPS: &[&str] = &[
    "Read the raw source body before editing any wiki page.",
    "Create or update /Wiki/sources/<source_id>.md when the source adds durable knowledge.",
    "Update related /Wiki/entities/... and /Wiki/concepts/... pages when the source changes them.",
    "Keep visible citations in markdown and maintain a ## Sources section on durable wiki pages.",
];

pub const QUERY_FILE_BACK_RULES: &[&str] = &[
    "Read index.md before broad exploration.",
    "Use path search and content search before concluding recall is absent.",
    "Treat path search as basename/path recall and content search as FTS recall.",
    "Do not answer from search output alone; read at least one supporting note.",
    "Do not auto-save query answers as query-note pages.",
    "If durable knowledge should update the wiki, use explicit node commands after the read-only query step.",
    "Prefer updating an existing durable page before creating a new durable page.",
    "Before creating a new durable page, confirm the target path by reading index.md, candidate pages, and related durable pages.",
    "Place entity pages under /Wiki/entities/... and concept pages under /Wiki/concepts/...",
    "Use the durable page templates as the starting structure for new entity and concept pages.",
    "New durable pages must keep a ## Sources section.",
];

pub const LINT_CHECKS: &[&str] = &[
    "Find orphan pages with no inbound wiki links.",
    "Find pages that make claims without visible source markers.",
    "Surface pages that explicitly mention contradictions or staleness markers.",
    "Detect durable pages that do not live under /Wiki/entities, /Wiki/concepts, or /Wiki/sources.",
];

pub const PAGE_TEMPLATES: &[(&str, &str)] = &[
    (
        "entity",
        "# Title\n\n## Summary\n\n## Details\n\n## Sources",
    ),
    ("concept", "# Title\n\n## Thesis\n\n## Notes\n\n## Sources"),
    (
        "source_summary",
        "# Title\n\n## Source\n\n## Key Takeaways\n\n## Cross-References\n\n## Sources",
    ),
];

#[cfg(test)]
mod tests {
    use super::{INGEST_STEPS, LINT_CHECKS, PAGE_TEMPLATES, QUERY_FILE_BACK_RULES};

    #[test]
    fn page_templates_match_supported_durable_page_types() {
        let names: Vec<_> = PAGE_TEMPLATES.iter().map(|(name, _)| *name).collect();
        assert_eq!(names, vec!["entity", "concept", "source_summary"]);
    }

    #[test]
    fn all_page_templates_include_sources_section() {
        for (_, template) in PAGE_TEMPLATES {
            assert!(template.contains("## Sources"));
        }
    }

    #[test]
    fn query_rules_are_index_first_and_non_persistent() {
        assert!(
            QUERY_FILE_BACK_RULES
                .iter()
                .any(|rule| rule.contains("Read index.md before broad exploration."))
        );
        assert!(QUERY_FILE_BACK_RULES.iter().any(|rule| {
            rule.contains("Use path search and content search before concluding recall is absent.")
        }));
        assert!(QUERY_FILE_BACK_RULES.iter().any(|rule| {
            rule.contains(
                "Treat path search as basename/path recall and content search as FTS recall.",
            )
        }));
        assert!(
            QUERY_FILE_BACK_RULES
                .iter()
                .any(|rule| { rule.contains("Do not answer from search output alone") })
        );
        assert!(
            QUERY_FILE_BACK_RULES
                .iter()
                .any(|rule| rule.contains("Do not auto-save query answers"))
        );
        assert!(QUERY_FILE_BACK_RULES.iter().any(|rule| {
            rule.contains("Before creating a new durable page, confirm the target path")
        }));
        assert!(
            QUERY_FILE_BACK_RULES
                .iter()
                .any(|rule| rule.contains("/Wiki/entities"))
        );
        assert!(
            QUERY_FILE_BACK_RULES
                .iter()
                .any(|rule| rule.contains("## Sources"))
        );
    }

    #[test]
    fn ingest_and_lint_rules_reference_current_paths() {
        assert!(
            INGEST_STEPS
                .iter()
                .any(|step| step.contains("/Wiki/sources/<source_id>.md"))
        );
        assert!(
            LINT_CHECKS
                .iter()
                .any(|check| check.contains("/Wiki/entities"))
        );
    }
}
