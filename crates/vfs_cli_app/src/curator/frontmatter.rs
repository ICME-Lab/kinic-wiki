use super::*;

pub(crate) fn is_entry_document(path: &str) -> bool {
    path.ends_with("/index.md") || path.ends_with("/manifest.md") || path.ends_with("/SKILL.md")
}

pub(crate) fn frontmatter_parts(content: &str) -> Option<(&str, &str, usize)> {
    let rest = content.strip_prefix("---\n")?;
    let relative_end = rest.find("\n---\n").or_else(|| {
        rest.ends_with("\n---")
            .then_some(rest.len() - "\n---".len())
    })?;
    let header = &rest[..relative_end];
    let delimiter_start = 4 + relative_end;
    let body_start = if content[delimiter_start..].starts_with("\n---\n") {
        delimiter_start + 5
    } else {
        content.len()
    };
    Some((header, &content[body_start..], body_start))
}

pub(crate) fn upsert_curator_block(header: &str, block: &str) -> Result<String> {
    let mut block_start = None;
    let mut block_end = header.len();
    let mut offset = 0;
    for line in header.split_inclusive('\n') {
        let value = line.strip_suffix('\n').unwrap_or(line);
        if block_start.is_none() {
            if value == "curator:" {
                block_start = Some(offset);
            }
        } else if !value.starts_with("  ") && !value.is_empty() {
            block_end = offset;
            break;
        }
        offset += line.len();
    }
    let Some(start) = block_start else {
        return Ok(if header.is_empty() {
            block.to_string()
        } else {
            format!("{header}\n{block}")
        });
    };
    let mut next = String::with_capacity(header.len() + block.len());
    next.push_str(&header[..start]);
    next.push_str(block);
    if block_end < header.len() {
        next.push('\n');
        next.push_str(&header[block_end..]);
    }
    Ok(next)
}
