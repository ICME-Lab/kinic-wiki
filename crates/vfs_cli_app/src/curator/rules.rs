// Where: crates/vfs_cli_app/src/curator/rules.rs
// What: Canonical deterministic Curator rule identifiers and descriptions.
// Why: Runtime findings and accuracy evaluation must use one rule registry.

pub(crate) const AGE_REVIEW_DUE: &str = "age_review_due";
pub(crate) const BROKEN_INTERNAL_LINK: &str = "broken_internal_link";
pub(crate) const FACTS_FUTURE_ITEM: &str = "facts_future_item";
pub(crate) const INVALID_CURATOR_STATUS: &str = "invalid_curator_status";
pub(crate) const ISOLATED_NODE: &str = "isolated_node";
pub(crate) const OPEN_QUESTION_RESOLVED: &str = "open_question_resolved";
pub(crate) const ORPHAN_SOURCE_EVIDENCE: &str = "orphan_source_evidence";
pub(crate) const PREFERENCE_ACTION_ITEM: &str = "preference_action_item";
pub(crate) const PROVENANCE_SOURCE_MISSING: &str = "provenance_source_missing";
pub(crate) const SESSION_EVIDENCE_MISSING: &str = "session_evidence_missing";
pub(crate) const SKILL_MANIFEST_MISSING: &str = "skill_manifest_missing";
pub(crate) const SKILL_PROVENANCE_MISSING: &str = "skill_provenance_missing";
pub(crate) const SKILL_RUN_EVIDENCE_MISSING: &str = "skill_run_evidence_missing";
pub(crate) const SOURCE_EVIDENCE_MISSING: &str = "source_evidence_missing";
pub(crate) const SOURCE_NEWER_THAN_NODE: &str = "source_newer_than_node";
pub(crate) const SUMMARY_EXACT_EVIDENCE: &str = "summary_exact_evidence";

pub const DETERMINISTIC_RULES: [&str; 16] = [
    AGE_REVIEW_DUE,
    BROKEN_INTERNAL_LINK,
    FACTS_FUTURE_ITEM,
    INVALID_CURATOR_STATUS,
    ISOLATED_NODE,
    OPEN_QUESTION_RESOLVED,
    ORPHAN_SOURCE_EVIDENCE,
    PREFERENCE_ACTION_ITEM,
    PROVENANCE_SOURCE_MISSING,
    SESSION_EVIDENCE_MISSING,
    SKILL_MANIFEST_MISSING,
    SKILL_PROVENANCE_MISSING,
    SKILL_RUN_EVIDENCE_MISSING,
    SOURCE_EVIDENCE_MISSING,
    SOURCE_NEWER_THAN_NODE,
    SUMMARY_EXACT_EVIDENCE,
];

pub(crate) const DETERMINISTIC_RULE_DEFINITIONS: [(&str, &str); 16] = [
    (
        AGE_REVIEW_DUE,
        "The node is older than stale_after_days at snapshot_generated_at.",
    ),
    (
        BROKEN_INTERNAL_LINK,
        "An outgoing internal wiki link targets a path absent from this snapshot.",
    ),
    (
        FACTS_FUTURE_ITEM,
        "A facts.md note contains a future or pending action instead of a durable fact.",
    ),
    (
        INVALID_CURATOR_STATUS,
        "Raw YAML frontmatter has curator.status other than active, stale, or archived.",
    ),
    (
        ISOLATED_NODE,
        "An organized mutable node has neither incoming nor outgoing internal links.",
    ),
    (
        OPEN_QUESTION_RESOLVED,
        "An open_questions.md note states that a question or decision is resolved.",
    ),
    (
        ORPHAN_SOURCE_EVIDENCE,
        "A /Sources evidence node has no incoming reference from an organized node.",
    ),
    (
        PREFERENCE_ACTION_ITEM,
        "A preferences.md note contains an unresolved action item rather than a preference.",
    ),
    (
        PROVENANCE_SOURCE_MISSING,
        "A provenance.md note has no /Sources evidence reference.",
    ),
    (
        SESSION_EVIDENCE_MISSING,
        "A /Sessions note has no valid session evidence reference under /Sources.",
    ),
    (
        SKILL_MANIFEST_MISSING,
        "A Skill root containing SKILL.md has no manifest.md sibling.",
    ),
    (
        SKILL_PROVENANCE_MISSING,
        "A Skill root containing SKILL.md has no provenance.md sibling.",
    ),
    (
        SKILL_RUN_EVIDENCE_MISSING,
        "A Skill has no valid run-evidence reference under /Sources/skill-runs.",
    ),
    (
        SOURCE_EVIDENCE_MISSING,
        "An organized mutable node has no /Sources evidence reference.",
    ),
    (
        SOURCE_NEWER_THAN_NODE,
        "Referenced source evidence was updated after the organized node.",
    ),
    (
        SUMMARY_EXACT_EVIDENCE,
        "A summary.md note repeats exact evidence-level facts instead of summarizing them.",
    ),
];
