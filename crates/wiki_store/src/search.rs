// Where: crates/wiki_store/src/search.rs
// What: App-DB-local FTS5/BM25 search over current wiki sections.
// Why: The wiki needs a minimal search API without reintroducing an external retrieval subsystem.
use rusqlite::{Connection, params};
use wiki_types::{SearchHit, SearchRequest, WikiPage, WikiPageType};

pub(crate) fn replace_page_sections_in_fts_tx(
    conn: &Connection,
    page: &WikiPage,
    sections: &[(String, Option<String>, String)],
) -> Result<(), String> {
    conn.execute(
        "DELETE FROM wiki_sections_fts WHERE page_id = ?1",
        params![page.id],
    )
    .map_err(|error| error.to_string())?;

    for (section_path, _heading, text) in sections {
        let section_key = format!("{}:{section_path}", page.id);
        conn.execute(
            "INSERT INTO wiki_sections_fts (
                section_key, page_id, page_type, slug, title, summary, section_path, text
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                section_key,
                page.id,
                page.page_type.as_str(),
                page.slug,
                page.title,
                page.summary_1line,
                section_path,
                text,
            ],
        )
        .map_err(|error| error.to_string())?;
    }

    Ok(())
}

pub(crate) fn search_sections(
    conn: &Connection,
    request: SearchRequest,
) -> Result<Vec<SearchHit>, String> {
    let Some(fts_query) = build_fts_query(&request.query_text) else {
        return Ok(Vec::new());
    };

    let top_k = i64::from(request.top_k.max(1));
    let exact_term = request.query_text.to_lowercase();
    let mut sql = String::from(
        "SELECT slug, title, page_type, section_path,
                snippet(wiki_sections_fts, 7, '[', ']', '...', 12) AS snippet,
                bm25(wiki_sections_fts) AS score,
                CASE
                    WHEN lower(slug) = ?2 THEN 0
                    WHEN lower(title) = ?2 THEN 1
                    ELSE 2
                END AS exact_priority
         FROM wiki_sections_fts
         WHERE wiki_sections_fts MATCH ?1",
    );

    if !request.page_types.is_empty() {
        let placeholders = (0..request.page_types.len())
            .map(|index| format!("?{}", index + 3))
            .collect::<Vec<_>>()
            .join(", ");
        sql.push_str(&format!(" AND page_type IN ({placeholders})"));
    }

    sql.push_str(&format!(
        " ORDER BY exact_priority ASC, score ASC, slug ASC, section_path ASC LIMIT {top_k}"
    ));

    let mut stmt = conn.prepare(&sql).map_err(|error| error.to_string())?;
    let mut values = vec![
        rusqlite::types::Value::from(fts_query),
        rusqlite::types::Value::from(exact_term.clone()),
    ];
    values.extend(
        request
            .page_types
            .into_iter()
            .map(|page_type| rusqlite::types::Value::from(page_type.as_str().to_string())),
    );

    stmt.query_map(rusqlite::params_from_iter(values.iter()), |row| {
        let slug: String = row.get(0)?;
        let title: String = row.get(1)?;
        let page_type_value: String = row.get(2)?;
        let exact_priority: i64 = row.get(6)?;
        let mut match_reasons = vec!["fts5_bm25".to_string()];
        if exact_priority == 0 {
            match_reasons.insert(0, "exact_slug".to_string());
        } else if exact_priority == 1 {
            match_reasons.insert(0, "exact_title".to_string());
        }
        Ok(SearchHit {
            slug,
            title,
            page_type: WikiPageType::from_str(&page_type_value).unwrap_or(WikiPageType::Overview),
            section_path: row.get(3)?,
            snippet: row.get(4)?,
            score: row.get(5)?,
            match_reasons,
        })
    })
    .map_err(|error| error.to_string())?
    .collect::<std::result::Result<Vec<_>, _>>()
    .map_err(|error| error.to_string())
}

fn build_fts_query(query_text: &str) -> Option<String> {
    let terms = query_text
        .split_whitespace()
        .map(str::trim)
        .filter(|term| !term.is_empty())
        .map(escape_fts_phrase)
        .collect::<Vec<_>>();
    if terms.is_empty() {
        None
    } else {
        Some(terms.join(" "))
    }
}

fn escape_fts_phrase(term: &str) -> String {
    format!("\"{}\"", term.replace('"', "\"\""))
}
