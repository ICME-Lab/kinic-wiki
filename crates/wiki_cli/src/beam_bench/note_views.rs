// Where: crates/wiki_cli/src/beam_bench/note_views.rs
// What: Additional BEAM note renderers beyond the core facts/events/plans notes.
// Why: Keep note-role renderers small while matching the repo-local wiki schema.
use super::dataset::BeamConversation;
use super::note_extract::{
    extract_open_question_lines, extract_preference_lines, extract_summary_lines,
};
use super::note_support::append_related_section;

pub fn preferences_markdown(conversation: &BeamConversation, base_path: &str) -> String {
    let mut out = String::new();
    out.push_str("# Preferences\n\n");
    append_related_section(
        &mut out,
        base_path,
        &["index.md", "facts.md", "summary.md", "provenance.md"],
    );
    out.push_str("## Stable Preferences\n\n");
    for line in extract_preference_lines(conversation) {
        out.push_str("- ");
        out.push_str(&line);
        out.push('\n');
    }
    out
}

pub fn open_questions_markdown(conversation: &BeamConversation, base_path: &str) -> String {
    let mut out = String::new();
    out.push_str("# Open Questions\n\n");
    append_related_section(
        &mut out,
        base_path,
        &["index.md", "facts.md", "events.md", "provenance.md"],
    );
    out.push_str("## Unresolved Questions And Conflicts\n\n");
    for line in extract_open_question_lines(conversation) {
        out.push_str("- ");
        out.push_str(&line);
        out.push('\n');
    }
    out
}

pub fn summary_markdown(conversation: &BeamConversation, base_path: &str) -> String {
    let mut out = String::new();
    out.push_str("# Summary\n\n");
    append_related_section(&mut out, base_path, &["index.md", "facts.md", "events.md"]);
    out.push_str("## Synthesized Overview\n\n");
    for line in extract_summary_lines(conversation) {
        out.push_str("- ");
        out.push_str(&line);
        out.push('\n');
    }
    out
}

pub fn provenance_markdown(raw_source_path: &str, base_path: &str) -> String {
    let mut out = String::new();
    out.push_str("# Provenance\n\n");
    append_related_section(
        &mut out,
        base_path,
        &["index.md", "facts.md", "events.md", "open_questions.md"],
    );
    out.push_str("## Raw Sources\n\n");
    out.push_str(&format!("- source_path: {raw_source_path}\n"));
    out
}
