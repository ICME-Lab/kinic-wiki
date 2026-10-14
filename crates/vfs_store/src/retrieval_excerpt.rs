//! Bounded producer-side excerpt, matching the frozen retrieval experiment.
//! UTF-16 budgets agree with the Worker; stored content is never modified.

fn js_space(c: char) -> bool {
    c.is_whitespace() || c == '\u{feff}'
}

fn prefix(value: &str, budget: usize) -> &str {
    let mut units = 0;
    for (index, c) in value.char_indices() {
        units += c.len_utf16();
        if units > budget {
            return &value[..index];
        }
    }
    value
}

fn terms(intent: &str) -> Vec<String> {
    let stop = "a an the how what when why which is are was were be been to of on in for by with and or do does can could use using get set from as this that tell explain please";
    let mut result = Vec::new();
    let input = prefix(intent, 512).as_bytes();
    let mut i = 0;
    while i < input.len() && result.len() < 16 {
        if !(input[i].is_ascii_alphabetic() || b"_$".contains(&input[i])) {
            i += 1;
            continue;
        }
        let start = i;
        i += 1;
        while i < input.len() && (input[i].is_ascii_alphanumeric() || b"_.$-".contains(&input[i])) {
            i += 1;
        }
        let word = intent[start..i].to_ascii_lowercase();
        if word.len() > 1 && !stop.split(' ').any(|s| s == word) && !result.contains(&word) {
            result.push(word);
        }
    }
    result
}

fn citation_line(line: &str) -> bool {
    let line = line.trim_start_matches(js_space);
    if ["Source evidence:", "Canonical citation:", "Refs:"]
        .iter()
        .any(|s| line.starts_with(s))
    {
        return true;
    }
    let line = line.strip_prefix("- ").unwrap_or(line);
    if let Some(rest) = line.strip_prefix('[') {
        let n = rest.bytes().take_while(u8::is_ascii_digit).count();
        return n > 0 && rest[n..].starts_with(" source]");
    }
    false
}

pub(crate) fn excerpt(intent: &str, raw: &str) -> String {
    let head = prefix(raw, 40_000);
    let section = if head.contains("## Content\n") {
        head.split("## Content\n").nth(1).unwrap_or("")
    } else {
        head
    };
    let body = section
        .split("## Metadata")
        .next()
        .unwrap_or("")
        .split('\n')
        .filter(|line| !citation_line(line))
        .collect::<Vec<_>>()
        .join("\n");
    let body = body.trim_matches(js_space);
    let utf16: Vec<u16> = body.encode_utf16().collect();
    let terms = terms(intent);
    let mut best = 0;
    let mut best_score = None;
    for offset in (0..utf16.len()).step_by(256) {
        let window = String::from_utf16_lossy(&utf16[offset..(offset + 512).min(utf16.len())])
            .to_lowercase();
        let score = terms
            .iter()
            .filter(|term| window.contains(term.as_str()))
            .count();
        if best_score.is_none_or(|s| score > s) {
            best = offset;
            best_score = Some(score);
        }
        // The first complete match wins; no later window can improve its score.
        if score == terms.len() {
            break;
        }
    }
    let mut end = (best + 512).min(utf16.len());
    if best < end && (0xdc00..=0xdfff).contains(&utf16[best]) {
        best += 1;
    }
    if best < end && (0xd800..=0xdbff).contains(&utf16[end - 1]) {
        end -= 1;
    }
    String::from_utf16(&utf16[best..end]).expect("excerpt keeps Unicode boundaries")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selects_body_and_keeps_embedded_bom_nul_and_unicode() {
        let body = "日本語\0\u{feff} 😀 app.request";
        assert_eq!(
            excerpt(
                "app.request",
                &format!(
                    "metadata\n## Content\nSource evidence: skip\n{body}\n## Metadata\nignore"
                )
            ),
            body
        );
        assert_eq!(excerpt("query", ""), "");
    }

    #[test]
    fn bounds_scan_and_never_splits_surrogates() {
        let text = format!("{}needle", "😀".repeat(20_000));
        let result = excerpt("needle", &text);
        assert_eq!(result.encode_utf16().count(), 512);
        assert!(!result.contains("needle"));
        assert!(!result.contains('\u{fffd}'));
    }
}
