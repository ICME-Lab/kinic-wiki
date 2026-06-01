-- Rebuild derived fs_links rows with the wikilink-alias-aware Rust parser.
-- schema.rs post-migration hook repopulates fs_links from fs_nodes content.
DELETE FROM fs_links;
