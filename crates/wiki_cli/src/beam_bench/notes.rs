// Where: crates/wiki_cli/src/beam_bench/notes.rs
// What: Render BEAM conversations into conversation plus structured wiki notes.
// Why: The benchmark needs stable note roles, narrower facts, and stronger conversation identifiers.
use super::dataset::BeamConversation;
use super::note_support::{
    append_json_section, append_related_section, append_text_section, extract_fact_lines,
    extract_identifier_lines, flatten_chat,
};

pub fn build_documents(conversation: &BeamConversation, base_path: &str) -> Vec<(String, String)> {
    vec![
        (
            format!("{base_path}/index.md"),
            conversation_index_markdown(conversation, base_path),
        ),
        (
            format!("{base_path}/conversation.md"),
            conversation_markdown(conversation, base_path),
        ),
        (
            format!("{base_path}/profile.md"),
            profile_markdown(conversation, base_path),
        ),
        (
            format!("{base_path}/plan.md"),
            plan_markdown(conversation, base_path),
        ),
        (
            format!("{base_path}/facts.md"),
            facts_markdown(conversation, base_path),
        ),
        (
            format!("{base_path}/events.md"),
            events_markdown(conversation, base_path),
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
        "- [facts.md]({base_path}/facts.md) - stable facts and concise summaries\n"
    ));
    out.push_str(&format!(
        "- [plan.md]({base_path}/plan.md) - the explicit plan and user questions\n"
    ));
    out.push_str(&format!(
        "- [events.md]({base_path}/events.md) - exact timeline, turn order, and event details\n"
    ));
    out.push_str(&format!(
        "- [profile.md]({base_path}/profile.md) - seed and user profile details\n"
    ));
    out.push_str(&format!(
        "- [conversation.md]({base_path}/conversation.md) - raw transcript and surrounding context\n"
    ));
    out
}

fn conversation_markdown(conversation: &BeamConversation, base_path: &str) -> String {
    let turns = flatten_chat(&conversation.chat);
    let mut out = String::new();
    out.push_str("# Conversation\n\n");
    out.push_str(&format!(
        "- conversation_id: {}\n",
        conversation.conversation_id
    ));
    append_related_section(
        &mut out,
        base_path,
        &["facts.md", "plan.md", "events.md", "profile.md"],
    );
    append_json_section(&mut out, "Seed", &conversation.conversation_seed);
    append_text_section(&mut out, "Plan", &conversation.conversation_plan);
    append_text_section(&mut out, "Narratives", &conversation.narratives);
    append_json_section(&mut out, "User Questions", &conversation.user_questions);
    out.push_str("## Chat\n\n");
    for (index, turn) in turns.iter().enumerate() {
        out.push_str(&format!(
            "### Turn {:04}\n\n- role: {}\n\n{}\n\n",
            index + 1,
            turn.label(),
            turn.content.trim()
        ));
    }
    out
}

fn profile_markdown(conversation: &BeamConversation, base_path: &str) -> String {
    let mut out = String::new();
    out.push_str("# Profile\n\n");
    append_related_section(&mut out, base_path, &["index.md", "conversation.md"]);
    out.push_str("## Conversation Seed\n\n");
    out.push_str(
        &serde_json::to_string_pretty(&conversation.conversation_seed).map_or_else(
            |_| "```json\n{}\n```".to_string(),
            |json| format!("```json\n{json}\n```"),
        ),
    );
    out.push_str("\n\n## User Profile\n\n");
    out.push_str(
        &serde_json::to_string_pretty(&conversation.user_profile).map_or_else(
            |_| "```json\n{}\n```".to_string(),
            |json| format!("```json\n{json}\n```"),
        ),
    );
    out.push('\n');
    out
}

fn plan_markdown(conversation: &BeamConversation, base_path: &str) -> String {
    let mut out = String::new();
    out.push_str("# Plan\n\n");
    append_related_section(
        &mut out,
        base_path,
        &["index.md", "conversation.md", "facts.md"],
    );
    append_text_section(
        &mut out,
        "Conversation Plan",
        &conversation.conversation_plan,
    );
    append_json_section(&mut out, "User Questions", &conversation.user_questions);
    if !conversation.narratives.trim().is_empty() {
        append_text_section(&mut out, "Narratives", &conversation.narratives);
    }
    out
}

fn facts_markdown(conversation: &BeamConversation, base_path: &str) -> String {
    let mut out = String::new();
    out.push_str("# Facts\n\n");
    append_related_section(
        &mut out,
        base_path,
        &["index.md", "conversation.md", "events.md"],
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
    append_related_section(
        &mut out,
        base_path,
        &["index.md", "conversation.md", "facts.md"],
    );
    out.push_str("## Timeline\n\n");
    for (index, turn) in flatten_chat(&conversation.chat).iter().enumerate() {
        out.push_str(&format!(
            "- Turn {:04} {}: {}\n",
            index + 1,
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
        let documents = build_documents(&sample_conversation(), "/Wiki/run/conv-1");
        let paths = documents
            .iter()
            .map(|(path, _)| path.clone())
            .collect::<Vec<_>>();
        assert_eq!(
            paths,
            vec![
                "/Wiki/run/conv-1/index.md".to_string(),
                "/Wiki/run/conv-1/conversation.md".to_string(),
                "/Wiki/run/conv-1/profile.md".to_string(),
                "/Wiki/run/conv-1/plan.md".to_string(),
                "/Wiki/run/conv-1/facts.md".to_string(),
                "/Wiki/run/conv-1/events.md".to_string()
            ]
        );
        assert!(documents[0].1.contains("## Identifiers"));
        assert!(documents[0].1.contains("title: Calendar planning"));
        assert!(documents[1].1.contains("conversation_id"));
        assert!(documents[1].1.contains("March 15, 2024"));
        assert!(documents[1].1.contains("## Related"));
        assert!(documents[4].1.contains("conversation_plan"));
        assert!(documents[4].1.contains("March 15, 2024"));
        assert!(!documents[4].1.contains("Understood. I will remember"));
        assert!(documents[5].1.contains("Turn 0001"));
        assert!(
            documents
                .iter()
                .all(|(_, content)| !content.contains("probing_questions"))
        );
    }
}
