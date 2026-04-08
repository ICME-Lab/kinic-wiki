// Where: crates/wiki_cli/src/lint.rs
// What: Report-only lint command support for remote wiki health checks.
// Why: LLMs need deterministic issue reports before deciding how to repair the wiki.
use crate::client::WikiApi;
use anyhow::Result;
use wiki_types::HealthCheckReport;

pub async fn lint(client: &impl WikiApi) -> Result<HealthCheckReport> {
    client.lint_health().await
}

pub fn print_lint_report(report: &HealthCheckReport, json: bool) -> Result<()> {
    if json {
        println!("{}", serde_json::to_string_pretty(report)?);
        return Ok(());
    }

    if report.issues.is_empty() {
        println!("lint: no issues");
        return Ok(());
    }

    for issue in &report.issues {
        let slug = issue.page_slug.as_deref().unwrap_or("-");
        let section = issue.section_path.as_deref().unwrap_or("-");
        println!(
            "{}\t{}\t{}\t{}",
            format!("{:?}", issue.kind).to_ascii_lowercase(),
            slug,
            section,
            issue.message
        );
    }
    Ok(())
}
