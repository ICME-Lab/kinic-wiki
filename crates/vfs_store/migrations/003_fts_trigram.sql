-- vfs_store:003_fts_trigram
-- Rebuild the FTS5 index with the trigram tokenizer so Japanese/CJK text can be
-- matched by substring without language segmentation. The unicode61 tokenizer
-- treated each CJK run as a single token, so Japanese queries required a manual
-- bigram workaround that matched many unrelated nodes.
--
-- FTS5 virtual tables cannot be altered in place, so the index is rebuilt:
-- create a new table, copy the rows, drop the old one, and rename.

CREATE VIRTUAL TABLE fs_nodes_fts_trigram USING fts5(
    path,
    title,
    content,
    tokenize = 'trigram case_sensitive 0'
);

INSERT INTO fs_nodes_fts_trigram(rowid, path, title, content)
    SELECT rowid, path, title, content FROM fs_nodes_fts;

DROP TABLE fs_nodes_fts;

ALTER TABLE fs_nodes_fts_trigram RENAME TO fs_nodes_fts;
