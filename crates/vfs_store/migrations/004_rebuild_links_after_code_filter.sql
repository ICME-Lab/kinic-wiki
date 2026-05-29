-- Rebuild derived fs_links rows with the Rust parser that ignores code spans and blocks.
-- schema.rs post-migration hook repopulates fs_links from fs_nodes content.
DELETE FROM fs_links;
