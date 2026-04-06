CREATE VIRTUAL TABLE wiki_sections_fts USING fts5(
    section_key UNINDEXED,
    page_id UNINDEXED,
    page_type UNINDEXED,
    slug,
    title,
    summary,
    section_path UNINDEXED,
    text
);

INSERT INTO wiki_sections_fts (
    section_key,
    page_id,
    page_type,
    slug,
    title,
    summary,
    section_path,
    text
)
SELECT
    wiki_pages.id || ':' || wiki_sections.section_path AS section_key,
    wiki_pages.id,
    wiki_pages.page_type,
    wiki_pages.slug,
    wiki_pages.title,
    wiki_pages.summary_1line,
    wiki_sections.section_path,
    wiki_sections.text
FROM wiki_sections
JOIN wiki_pages ON wiki_pages.id = wiki_sections.page_id
WHERE wiki_sections.is_current = 1;
