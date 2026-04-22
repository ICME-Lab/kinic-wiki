// Where: crates/wiki_cli/src/beam_bench/plan_extract.rs
// What: Reduce raw conversation-plan dossiers into short plan signals for plans.md.
// Why: plans.md should expose active plan state, not mirror the full BEAM batch dossier.
pub fn extract_plan_lines(text: &str) -> Vec<String> {
    let mut selected = Vec::new();
    let mut fallback = Vec::new();
    for raw_line in text.lines() {
        let trimmed = raw_line.trim();
        if trimmed.is_empty() || is_batch_heading(trimmed) || is_excluded_line(trimmed) {
            continue;
        }
        let normalized = normalize_plan_line(trimmed);
        if normalized.is_empty() {
            continue;
        }
        if normalized.len() <= 160 {
            fallback.push(normalized.clone());
        }
        if is_plan_signal(&normalized) {
            selected.push(normalized);
        }
    }
    if selected.is_empty() {
        dedupe(fallback).into_iter().take(3).collect()
    } else {
        dedupe(selected).into_iter().take(10).collect()
    }
}

fn is_batch_heading(line: &str) -> bool {
    let lowered = line.to_ascii_lowercase();
    lowered.starts_with("batch ") && lowered.ends_with("plan")
}

fn is_excluded_line(line: &str) -> bool {
    [
        "**logical contradiction:**",
        "**user instruction:**",
        "**current situation:**",
    ]
    .iter()
    .any(|needle| line.to_ascii_lowercase().contains(needle))
}

fn normalize_plan_line(line: &str) -> String {
    let line = line
        .trim_start_matches('•')
        .trim()
        .replace("**", "")
        .replace("  ", " ")
        .trim()
        .to_string();
    squeeze(&line)
}

fn is_plan_signal(line: &str) -> bool {
    let lowered = line.to_ascii_lowercase();
    [
        "time anchor:",
        "deadline",
        "sprint",
        "milestone",
        "target",
        "goal",
        "estimate",
        "estimated",
        "plan to",
        "planning",
        "planned",
        "next ",
        "next:",
        "focus",
        "schedule",
        "scheduled",
        "mvp",
        "trying to",
        "need to",
        "looking to",
        "aiming to",
        "complete by",
        "finish ",
        "finishes ",
        "task estimation",
        "information update",
    ]
    .iter()
    .any(|needle| lowered.contains(needle))
}

fn squeeze(line: &str) -> String {
    let mut out = line.split_whitespace().collect::<Vec<_>>().join(" ");
    if out.len() > 180 {
        out.truncate(177);
        out.push_str("...");
    }
    out
}

fn dedupe(lines: Vec<String>) -> Vec<String> {
    let mut out = Vec::new();
    for line in lines {
        if !out.contains(&line) {
            out.push(line);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::extract_plan_lines;

    #[test]
    fn extract_plan_lines_keeps_future_or_deadline_signals() {
        let text = "BATCH 1 PLAN\n• **Time Anchor:** March 15, 2024\n• **Project Planning:** Defined MVP scope by April 15 deadline.\n• **Feature Development:** Implemented transaction CRUD routes.";
        let lines = extract_plan_lines(text);
        assert!(
            lines
                .iter()
                .any(|line| line.contains("Time Anchor: March 15, 2024"))
        );
        assert!(lines.iter().any(|line| line.contains("April 15 deadline")));
        assert!(
            !lines
                .iter()
                .any(|line| line.contains("Implemented transaction CRUD"))
        );
    }

    #[test]
    fn extract_plan_lines_falls_back_for_short_concise_plan_text() {
        let text = "Discuss one meeting date and confirm it.";
        let lines = extract_plan_lines(text);
        assert_eq!(lines, vec!["Discuss one meeting date and confirm it."]);
    }
}
