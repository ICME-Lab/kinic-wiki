// Where: crates/wiki_cli/src/beam_bench/notes.rs
// What: Render BEAM conversations into structured wiki notes plus raw-source provenance.
// Why: Raw transcript belongs in `/Sources/raw/...`, while `/Wiki/...` keeps only organized knowledge notes.
use super::dataset::BeamConversation;
use super::note_extract::{extract_instruction_lines, render_turn_reference};
use super::note_support::{
    append_json_section, append_related_section, append_text_section, extract_fact_lines,
    extract_identifier_lines, flatten_chat,
};
use super::note_views::{
    open_questions_markdown, preferences_markdown, provenance_markdown, summary_markdown,
};
use super::plan_extract::extract_plan_lines;

pub fn build_documents(
    conversation: &BeamConversation,
    base_path: &str,
    raw_source_path: &str,
) -> Vec<(String, String)> {
    vec![
        (
            format!("{base_path}/index.md"),
            conversation_index_markdown(conversation, base_path),
        ),
        (
            format!("{base_path}/facts.md"),
            facts_markdown(conversation, base_path),
        ),
        (
            format!("{base_path}/events.md"),
            events_markdown(conversation, base_path),
        ),
        (
            format!("{base_path}/plans.md"),
            plans_markdown(conversation, base_path),
        ),
        (
            format!("{base_path}/preferences.md"),
            preferences_markdown(conversation, base_path),
        ),
        (
            format!("{base_path}/open_questions.md"),
            open_questions_markdown(conversation, base_path),
        ),
        (
            format!("{base_path}/summary.md"),
            summary_markdown(conversation, base_path),
        ),
        (
            format!("{base_path}/provenance.md"),
            provenance_markdown(raw_source_path, base_path),
        ),
        (
            raw_source_path.to_string(),
            raw_source_markdown(conversation),
        ),
    ]
}

fn conversation_index_markdown(conversation: &BeamConversation, base_path: &str) -> String {
    let mut out = String::from("# Conversation Index\n\n## Identifiers\n\n");
    for line in extract_identifier_lines(conversation) {
        out.push_str("- ");
        out.push_str(&line);
        out.push('\n');
    }
    out.push_str("\n## Note Roles\n\n");
    out.push_str(&format!(
        "- [facts.md]({base_path}/facts.md) - stable facts only, without topic-only mentions\n"
    ));
    out.push_str(&format!(
        "- [events.md]({base_path}/events.md) - exact timeline and event details only\n"
    ));
    out.push_str(&format!(
        "- [plans.md]({base_path}/plans.md) - explicit plans, open tasks, and next actions\n"
    ));
    out.push_str(&format!(
        "- [preferences.md]({base_path}/preferences.md) - stable preferences and decision criteria\n"
    ));
    out.push_str(&format!(
        "- [open_questions.md]({base_path}/open_questions.md) - unresolved questions, ambiguities, and contradictions\n"
    ));
    out.push_str(&format!(
        "- [summary.md]({base_path}/summary.md) - recap only, not exact or causal evidence\n"
    ));
    out.push_str(&format!(
        "- [provenance.md]({base_path}/provenance.md) - raw source references under /Sources/raw\n"
    ));
    out
}

fn plans_markdown(conversation: &BeamConversation, base_path: &str) -> String {
    let mut out = String::new();
    out.push_str("# Plans\n\n");
    append_related_section(
        &mut out,
        base_path,
        &["index.md", "facts.md", "preferences.md", "provenance.md"],
    );
    let plan_lines = extract_plan_lines(&conversation.conversation_plan);
    if !plan_lines.is_empty() {
        out.push_str("## Active Plan Signals\n\n");
        for line in plan_lines {
            out.push_str("- ");
            out.push_str(&line);
            out.push('\n');
        }
        out.push('\n');
    }
    let instruction_lines = extract_instruction_lines(conversation);
    if !instruction_lines.is_empty() {
        out.push_str("## Scope Directives\n\n");
        for line in instruction_lines {
            out.push_str("- ");
            out.push_str(&line);
            out.push('\n');
        }
        out.push('\n');
    }
    out
}

fn facts_markdown(conversation: &BeamConversation, base_path: &str) -> String {
    let mut out = String::new();
    out.push_str("# Facts\n\n");
    append_related_section(
        &mut out,
        base_path,
        &["index.md", "events.md", "plans.md", "provenance.md"],
    );
    out.push_str("## Extracted Facts\n\n");
    for line in extract_fact_lines(conversation) {
        out.push_str("- ");
        out.push_str(&line);
        out.push('\n');
    }
    out
}

fn events_markdown(conversation: &BeamConversation, base_path: &str) -> String {
    let mut out = String::new();
    out.push_str("# Events\n\n");
    append_related_section(&mut out, base_path, &["index.md", "facts.md", "summary.md"]);
    out.push_str("## Timeline\n\n");
    for (index, turn) in flatten_chat(&conversation.chat).iter().enumerate() {
        out.push_str(&format!(
            "- {} {}: {}\n",
            render_turn_reference(turn, index + 1),
            turn.label(),
            turn.content.trim()
        ));
    }
    out
}

fn raw_source_markdown(conversation: &BeamConversation) -> String {
    let turns = flatten_chat(&conversation.chat);
    let mut out = String::new();
    out.push_str("# Raw Conversation Source\n\n");
    out.push_str(&format!(
        "- conversation_id: {}\n\n",
        conversation.conversation_id
    ));
    append_json_section(&mut out, "Seed", &conversation.conversation_seed);
    append_json_section(&mut out, "User Profile", &conversation.user_profile);
    append_text_section(&mut out, "Plan", &conversation.conversation_plan);
    append_text_section(&mut out, "Narratives", &conversation.narratives);
    append_json_section(&mut out, "User Questions", &conversation.user_questions);
    out.push_str("## Chat\n\n");
    for (index, turn) in turns.iter().enumerate() {
        out.push_str(&format!(
            "### {}\n\n- role: {}\n\n{}\n\n",
            render_turn_reference(turn, index + 1),
            turn.label(),
            turn.content.trim()
        ));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::{build_documents, flatten_chat};
    use crate::beam_bench::dataset::BeamConversation;
    use serde_json::json;

    fn sample_conversation() -> BeamConversation {
        BeamConversation {
            conversation_id: "conv-1".to_string(),
            conversation_seed: json!({"category":"General","title":"Calendar planning"}),
            narratives: "A short planning conversation about a meeting date.".to_string(),
            user_profile: json!({"user_info":"Sample user profile"}),
            conversation_plan: "Discuss one meeting date and confirm it.".to_string(),
            user_questions: json!([{"messages":["Can you help me remember the meeting date?"]}]),
            chat: json!([[{"role":"user","content":"Please remember that the meeting is on March 15, 2024."},{"role":"assistant","content":"Understood. I will remember March 15, 2024."}]]),
            probing_questions:
                "{\"factoid\":[{\"question\":\"What did the assistant say?\",\"answer\":\"hi\"}]}"
                    .to_string(),
        }
    }

    #[test]
    fn flatten_chat_preserves_message_order() {
        let messages = flatten_chat(&sample_conversation().chat);
        assert_eq!(messages.len(), 2);
        assert_eq!(
            messages[0].content,
            "Please remember that the meeting is on March 15, 2024."
        );
        assert_eq!(
            messages[1].content,
            "Understood. I will remember March 15, 2024."
        );
    }

    #[test]
    fn build_documents_emits_structured_note_set() {
        let documents = build_documents(
            &sample_conversation(),
            "/Wiki/run/conv-1",
            "/Sources/raw/run-conv-1/run-conv-1.md",
        );
        let paths = documents
            .iter()
            .map(|(path, _)| path.clone())
            .collect::<Vec<_>>();
        assert_eq!(
            paths,
            vec![
                "/Wiki/run/conv-1/index.md".to_string(),
                "/Wiki/run/conv-1/facts.md".to_string(),
                "/Wiki/run/conv-1/events.md".to_string(),
                "/Wiki/run/conv-1/plans.md".to_string(),
                "/Wiki/run/conv-1/preferences.md".to_string(),
                "/Wiki/run/conv-1/open_questions.md".to_string(),
                "/Wiki/run/conv-1/summary.md".to_string(),
                "/Wiki/run/conv-1/provenance.md".to_string(),
                "/Sources/raw/run-conv-1/run-conv-1.md".to_string()
            ]
        );
        assert!(documents[0].1.contains("## Identifiers"));
        assert!(documents[0].1.contains("title: Calendar planning"));
        assert!(documents[0].1.contains("stable facts only"));
        assert!(!documents[0].1.contains("instructions.md"));
        assert!(documents[0].1.contains("raw source references"));
        assert!(documents[1].1.contains("meeting date: March 15, 2024"));
        assert!(!documents[1].1.contains("Understood. I will remember"));
        assert!(documents[2].1.contains("Turn 0001"));
        assert!(documents[2].1.contains("March 15, 2024"));
        assert!(documents[3].1.contains("## Active Plan Signals"));
        assert!(documents[3].1.contains("## Scope Directives"));
        assert!(!documents[3].1.contains("## User Questions"));
        assert!(!documents[3].1.contains("## Narratives"));
        assert!(documents[4].1.contains("# Preferences"));
        assert!(documents[5].1.contains("# Open Questions"));
        assert!(documents[6].1.contains("# Summary"));
        assert!(documents[7].1.contains("# Provenance"));
        assert!(documents[8].1.contains("# Raw Conversation Source"));
        assert!(
            documents
                .iter()
                .all(|(_, content)| !content.contains("probing_questions"))
        );
    }
}
