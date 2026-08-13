// Where: crates/vfs_cli_app/src/bin/curator_accuracy_bench.rs
// What: Golden-corpus precision/recall benchmark for deterministic Curator findings.
// Why: Curator quality needs reproducible positive and adversarial negative cases, not latency data.
use anyhow::{Result, bail};
use clap::Parser;
use serde::Serialize;
use std::collections::BTreeMap;
use std::path::PathBuf;
use vfs_cli_app::curator::{
    CuratorEvidenceRef, CuratorLink, CuratorScanNode, CuratorStatus, CuratorStore,
    deterministic_findings_for_nodes,
};
use vfs_types::NodeKind;

const DAY_MS: i64 = 24 * 60 * 60 * 1_000;
const NOW_MS: i64 = 200 * DAY_MS;
const STALE_AFTER_DAYS: u32 = 90;

#[derive(Debug, Parser)]
#[command(about = "Measure deterministic Curator finding precision and recall")]
struct Args {
    #[arg(long)]
    output_json: Option<PathBuf>,
    #[arg(long, default_value_t = 0.90)]
    require_min_f1: f64,
}

struct GoldenCase {
    id: &'static str,
    rule: &'static str,
    focus_path: &'static str,
    expected: bool,
    nodes: Vec<CuratorScanNode>,
}

#[derive(Debug, Serialize)]
struct CaseResult {
    id: String,
    rule: String,
    focus_path: String,
    expected: bool,
    actual: bool,
    passed: bool,
}

#[derive(Clone, Debug, Default, Serialize)]
struct Counts {
    true_positive: usize,
    true_negative: usize,
    false_positive: usize,
    false_negative: usize,
}

#[derive(Clone, Debug, Serialize)]
struct Metrics {
    counts: Counts,
    precision: f64,
    recall: f64,
    specificity: f64,
    f1: f64,
}

#[derive(Debug, Serialize)]
struct Report {
    benchmark: &'static str,
    corpus_version: &'static str,
    case_count: usize,
    required_min_f1: f64,
    meets_threshold: bool,
    overall: Metrics,
    by_rule: BTreeMap<String, Metrics>,
    failures: Vec<CaseResult>,
    cases: Vec<CaseResult>,
}

fn main() -> Result<()> {
    let args = Args::parse();
    if !(0.0..=1.0).contains(&args.require_min_f1) {
        bail!("require-min-f1 must be between 0 and 1");
    }
    let cases = golden_cases();
    let mut overall = Counts::default();
    let mut by_rule = BTreeMap::<String, Counts>::new();
    let mut results = Vec::with_capacity(cases.len());

    for case in cases {
        let findings = deterministic_findings_for_nodes(&case.nodes, STALE_AFTER_DAYS, NOW_MS);
        let actual = findings.iter().any(|finding| {
            finding.kind == case.rule
                && finding
                    .paths
                    .first()
                    .is_some_and(|path| path == case.focus_path)
        });
        record(&mut overall, case.expected, actual);
        record(
            by_rule.entry(case.rule.to_string()).or_default(),
            case.expected,
            actual,
        );
        results.push(CaseResult {
            id: case.id.to_string(),
            rule: case.rule.to_string(),
            focus_path: case.focus_path.to_string(),
            expected: case.expected,
            actual,
            passed: actual == case.expected,
        });
    }

    let overall = metrics(overall);
    let by_rule = by_rule
        .into_iter()
        .map(|(rule, counts)| (rule, metrics(counts)))
        .collect();
    let report = Report {
        benchmark: "curator_deterministic_finding_accuracy",
        corpus_version: "v1",
        case_count: results.len(),
        required_min_f1: args.require_min_f1,
        meets_threshold: overall.f1 >= args.require_min_f1,
        overall,
        by_rule,
        failures: results
            .iter()
            .filter(|result| !result.passed)
            .map(|result| CaseResult {
                id: result.id.clone(),
                rule: result.rule.clone(),
                focus_path: result.focus_path.clone(),
                expected: result.expected,
                actual: result.actual,
                passed: result.passed,
            })
            .collect(),
        cases: results,
    };
    let rendered = serde_json::to_string_pretty(&report)? + "\n";
    if let Some(path) = args.output_json {
        std::fs::write(path, &rendered)?;
    }
    print!("{rendered}");
    if !report.meets_threshold {
        bail!(
            "Curator diagnostic F1 {:.3} is below required {:.3}",
            report.overall.f1,
            report.required_min_f1
        );
    }
    Ok(())
}

fn record(counts: &mut Counts, expected: bool, actual: bool) {
    match (expected, actual) {
        (true, true) => counts.true_positive += 1,
        (false, false) => counts.true_negative += 1,
        (false, true) => counts.false_positive += 1,
        (true, false) => counts.false_negative += 1,
    }
}

fn metrics(counts: Counts) -> Metrics {
    let precision = ratio(
        counts.true_positive,
        counts.true_positive + counts.false_positive,
    );
    let recall = ratio(
        counts.true_positive,
        counts.true_positive + counts.false_negative,
    );
    let specificity = ratio(
        counts.true_negative,
        counts.true_negative + counts.false_positive,
    );
    let f1 = if precision + recall == 0.0 {
        0.0
    } else {
        2.0 * precision * recall / (precision + recall)
    };
    Metrics {
        counts,
        precision,
        recall,
        specificity,
        f1,
    }
}

fn ratio(numerator: usize, denominator: usize) -> f64 {
    if denominator == 0 {
        1.0
    } else {
        numerator as f64 / denominator as f64
    }
}

fn node(path: &str, content: &str) -> CuratorScanNode {
    let store = if path.starts_with("/Memory/") {
        CuratorStore::Memory
    } else if path.starts_with("/Knowledge/") {
        CuratorStore::Knowledge
    } else if path.starts_with("/Skills/") {
        CuratorStore::Skill
    } else if path.starts_with("/Sessions/") {
        CuratorStore::Session
    } else {
        CuratorStore::SourceEvidence
    };
    CuratorScanNode {
        path: path.to_string(),
        store,
        kind: if store == CuratorStore::SourceEvidence {
            NodeKind::Source
        } else {
            NodeKind::File
        },
        content: content.to_string(),
        body: content.to_string(),
        metadata_json: "{}".to_string(),
        created_at: NOW_MS - DAY_MS,
        updated_at: NOW_MS - DAY_MS,
        etag: format!("etag-{}", path.replace('/', "-")),
        curator_status: CuratorStatus::Active,
        outgoing_links: Vec::new(),
        source_evidence: Vec::new(),
    }
}

fn linked(mut source: CuratorScanNode, target: &str) -> CuratorScanNode {
    source.outgoing_links.push(CuratorLink {
        target_path: target.to_string(),
        raw_href: target.to_string(),
        link_text: "target".to_string(),
        link_kind: "markdown".to_string(),
    });
    source
}

fn evidenced(mut target: CuratorScanNode, source: &str, source_updated_at: i64) -> CuratorScanNode {
    target.source_evidence.push(CuratorEvidenceRef {
        source_path: source.to_string(),
        via_path: target.path.clone(),
        source_etag: Some("source-etag".to_string()),
        source_updated_at: Some(source_updated_at),
    });
    target
}

fn case(
    id: &'static str,
    rule: &'static str,
    focus_path: &'static str,
    expected: bool,
    nodes: Vec<CuratorScanNode>,
) -> GoldenCase {
    GoldenCase {
        id,
        rule,
        focus_path,
        expected,
        nodes,
    }
}

fn golden_cases() -> Vec<GoldenCase> {
    let mut stale = node("/Knowledge/stale.md", "stale");
    stale.updated_at = NOW_MS - i64::from(STALE_AFTER_DAYS) * DAY_MS;
    let mut fresh = node("/Knowledge/fresh.md", "fresh");
    fresh.updated_at = NOW_MS - i64::from(STALE_AFTER_DAYS) * DAY_MS + 1;

    vec![
        case(
            "broken-positive",
            "broken_internal_link",
            "/Knowledge/a.md",
            true,
            vec![linked(
                node("/Knowledge/a.md", "a"),
                "/Knowledge/missing.md",
            )],
        ),
        case(
            "broken-negative",
            "broken_internal_link",
            "/Knowledge/a.md",
            false,
            vec![
                linked(node("/Knowledge/a.md", "a"), "/Knowledge/b.md"),
                node("/Knowledge/b.md", "b"),
            ],
        ),
        case(
            "isolated-positive",
            "isolated_node",
            "/Knowledge/alone.md",
            true,
            vec![node("/Knowledge/alone.md", "alone")],
        ),
        case(
            "isolated-negative",
            "isolated_node",
            "/Knowledge/a.md",
            false,
            vec![
                linked(node("/Knowledge/a.md", "a"), "/Knowledge/b.md"),
                node("/Knowledge/b.md", "b"),
            ],
        ),
        case(
            "source-newer-positive",
            "source_newer_than_node",
            "/Knowledge/a.md",
            true,
            vec![evidenced(
                node("/Knowledge/a.md", "a"),
                "/Sources/web/a.md",
                NOW_MS,
            )],
        ),
        case(
            "source-newer-negative",
            "source_newer_than_node",
            "/Knowledge/a.md",
            false,
            vec![evidenced(
                node("/Knowledge/a.md", "a"),
                "/Sources/web/a.md",
                NOW_MS - 2 * DAY_MS,
            )],
        ),
        case(
            "age-positive",
            "age_review_due",
            "/Knowledge/stale.md",
            true,
            vec![stale],
        ),
        case(
            "age-negative",
            "age_review_due",
            "/Knowledge/fresh.md",
            false,
            vec![fresh],
        ),
        case(
            "evidence-positive",
            "source_evidence_missing",
            "/Knowledge/a.md",
            true,
            vec![node("/Knowledge/a.md", "a")],
        ),
        case(
            "evidence-negative",
            "source_evidence_missing",
            "/Knowledge/a.md",
            false,
            vec![evidenced(
                node("/Knowledge/a.md", "a"),
                "/Sources/web/a.md",
                NOW_MS - DAY_MS,
            )],
        ),
        case(
            "status-positive",
            "invalid_curator_status",
            "/Knowledge/a.md",
            true,
            vec![node(
                "/Knowledge/a.md",
                "---\ncurator:\n  status: promoted\n---\nbody",
            )],
        ),
        case(
            "status-negative",
            "invalid_curator_status",
            "/Knowledge/a.md",
            false,
            vec![node(
                "/Knowledge/a.md",
                "---\ncurator:\n  status: active\n---\nbody",
            )],
        ),
        case(
            "facts-positive",
            "facts_future_item",
            "/Memory/facts.md",
            true,
            vec![node("/Memory/facts.md", "Next deadline is tomorrow.")],
        ),
        case(
            "facts-negation-negative",
            "facts_future_item",
            "/Memory/facts.md",
            false,
            vec![node("/Memory/facts.md", "There is no pending work.")],
        ),
        case(
            "facts-source-negative",
            "facts_future_item",
            "/Sources/web/facts.md",
            false,
            vec![node("/Sources/web/facts.md", "Deadline is tomorrow.")],
        ),
        case(
            "facts-policy-negative",
            "facts_future_item",
            "/Memory/facts.md",
            false,
            vec![node(
                "/Memory/facts.md",
                "The deadline policy is a stable project rule.",
            )],
        ),
        case(
            "facts-japanese-positive",
            "facts_future_item",
            "/Memory/facts.md",
            true,
            vec![node("/Memory/facts.md", "明日までに対応予定です。")],
        ),
        case(
            "facts-japanese-negation-negative",
            "facts_future_item",
            "/Memory/facts.md",
            false,
            vec![node("/Memory/facts.md", "保留中の作業はありません。")],
        ),
        case(
            "summary-date-positive",
            "summary_exact_evidence",
            "/Knowledge/summary.md",
            true,
            vec![node("/Knowledge/summary.md", "Released on 2026-08-13.")],
        ),
        case(
            "summary-version-positive",
            "summary_exact_evidence",
            "/Knowledge/summary.md",
            true,
            vec![node("/Knowledge/summary.md", "Current version is 2.1.")],
        ),
        case(
            "summary-negative",
            "summary_exact_evidence",
            "/Knowledge/summary.md",
            false,
            vec![node("/Knowledge/summary.md", "Architecture overview.")],
        ),
        case(
            "summary-section-negative",
            "summary_exact_evidence",
            "/Knowledge/summary.md",
            false,
            vec![node(
                "/Knowledge/summary.md",
                "See section 2.1 for the architecture overview.",
            )],
        ),
        case(
            "open-resolved-positive",
            "open_question_resolved",
            "/Memory/open_questions.md",
            true,
            vec![node("/Memory/open_questions.md", "Resolved: choose auth.")],
        ),
        case(
            "open-unresolved-negative",
            "open_question_resolved",
            "/Memory/open_questions.md",
            false,
            vec![node(
                "/Memory/open_questions.md",
                "Unresolved: choose auth.",
            )],
        ),
        case(
            "open-japanese-resolved-positive",
            "open_question_resolved",
            "/Memory/open_questions.md",
            true,
            vec![node("/Memory/open_questions.md", "解決済み: 認証方式")],
        ),
        case(
            "open-japanese-unresolved-negative",
            "open_question_resolved",
            "/Memory/open_questions.md",
            false,
            vec![node("/Memory/open_questions.md", "未解決: 認証方式")],
        ),
        case(
            "preference-action-positive",
            "preference_action_item",
            "/Memory/preferences.md",
            true,
            vec![node("/Memory/preferences.md", "TODO: choose a theme.")],
        ),
        case(
            "preference-word-negative",
            "preference_action_item",
            "/Memory/preferences.md",
            false,
            vec![node(
                "/Memory/preferences.md",
                "Prefer TODO comments in example code.",
            )],
        ),
        case(
            "preference-japanese-action-positive",
            "preference_action_item",
            "/Memory/preferences.md",
            true,
            vec![node(
                "/Memory/preferences.md",
                "次のアクション: テーマを選ぶ",
            )],
        ),
        case(
            "provenance-positive",
            "provenance_source_missing",
            "/Skills/review/provenance.md",
            true,
            vec![node("/Skills/review/provenance.md", "Imported manually.")],
        ),
        case(
            "provenance-negative",
            "provenance_source_missing",
            "/Skills/review/provenance.md",
            false,
            vec![node(
                "/Skills/review/provenance.md",
                "Source: /Sources/github/review.md",
            )],
        ),
        case(
            "skill-manifest-positive",
            "skill_manifest_missing",
            "/Skills/review/SKILL.md",
            true,
            vec![node("/Skills/review/SKILL.md", "# Review")],
        ),
        case(
            "skill-manifest-negative",
            "skill_manifest_missing",
            "/Skills/review/SKILL.md",
            false,
            vec![
                node("/Skills/review/SKILL.md", "# Review"),
                node("/Skills/review/manifest.md", "manifest"),
            ],
        ),
        case(
            "skill-provenance-positive",
            "skill_provenance_missing",
            "/Skills/review/SKILL.md",
            true,
            vec![node("/Skills/review/SKILL.md", "# Review")],
        ),
        case(
            "skill-provenance-negative",
            "skill_provenance_missing",
            "/Skills/review/SKILL.md",
            false,
            vec![
                node("/Skills/review/SKILL.md", "# Review"),
                node(
                    "/Skills/review/provenance.md",
                    "Source: /Sources/github/review.md",
                ),
            ],
        ),
        case(
            "skill-run-positive",
            "skill_run_evidence_missing",
            "/Skills/review/SKILL.md",
            true,
            vec![node("/Skills/review/SKILL.md", "# Review")],
        ),
        case(
            "skill-run-negative",
            "skill_run_evidence_missing",
            "/Skills/review/SKILL.md",
            false,
            vec![
                node("/Skills/review/SKILL.md", "# Review"),
                node("/Sources/skill-runs/review/run.md", "run"),
            ],
        ),
        case(
            "session-positive",
            "session_evidence_missing",
            "/Sessions/s1.md",
            true,
            vec![node("/Sessions/s1.md", "session")],
        ),
        case(
            "session-negative",
            "session_evidence_missing",
            "/Sessions/s1.md",
            false,
            vec![evidenced(
                node("/Sessions/s1.md", "session"),
                "/Sources/sessions/s1.md",
                NOW_MS - DAY_MS,
            )],
        ),
        case(
            "orphan-positive",
            "orphan_source_evidence",
            "/Sources/web/a.md",
            true,
            vec![node("/Sources/web/a.md", "source")],
        ),
        case(
            "orphan-negative",
            "orphan_source_evidence",
            "/Sources/web/a.md",
            false,
            vec![
                linked(node("/Knowledge/a.md", "a"), "/Sources/web/a.md"),
                node("/Sources/web/a.md", "source"),
            ],
        ),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn curator_accuracy_corpus_meets_default_f1_threshold() {
        let mut counts = Counts::default();
        for case in golden_cases() {
            let actual = deterministic_findings_for_nodes(&case.nodes, STALE_AFTER_DAYS, NOW_MS)
                .iter()
                .any(|finding| {
                    finding.kind == case.rule
                        && finding
                            .paths
                            .first()
                            .is_some_and(|path| path == case.focus_path)
                });
            record(&mut counts, case.expected, actual);
        }
        let result = metrics(counts);
        assert!(result.f1 >= 0.90, "accuracy F1 was {}", result.f1);
    }
}
