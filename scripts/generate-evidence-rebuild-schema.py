#!/usr/bin/env python3
"""Refresh the exact supported SQLite schema catalog; no application data is read."""
import json
import pathlib
import sqlite3

root = pathlib.Path(__file__).resolve().parents[1]
migrations = root / 'crates/vfs_store/migrations'
connection = sqlite3.connect(':memory:')
for name in ['000_schema_migrations.sql', 'fresh_fs_schema.sql',
             '004_node_revisions.sql', '005_evidence_storage.sql']:
    connection.executescript((migrations / name).read_text())

def catalog():
    return connection.execute(
        "SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name"
    ).fetchall()

legacy = catalog()
connection.executescript((migrations / '003_fts_trigram.sql').read_text())
legacy_renamed = catalog()
connection.executescript("""
DROP TABLE fs_nodes_fts;
CREATE VIRTUAL TABLE fs_nodes_fts USING fts5(path,title,content,
content='fs_search_content',content_rowid='id',tokenize='trigram case_sensitive 0');
""")
shared = catalog()
connection.execute('ANALYZE')
# STAT4 is compiled into the pinned native SQLite; Python may omit that feature.
# Both statistics tables are derived, optional, and must have these exact shapes.
statistics = connection.execute(
    "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name='sqlite_stat1'"
).fetchone()
output = migrations / '005_rebuild_schema.json'
output.write_text(json.dumps({'legacy': legacy, 'legacy_renamed': legacy_renamed, 'shared': shared,
                              'optional_statistics': [statistics,
                                  ['table', 'sqlite_stat4', 'sqlite_stat4',
                                   'CREATE TABLE sqlite_stat4(tbl,idx,neq,nlt,ndlt,sample)']]}, indent=2) + '\n')
print(output.relative_to(root))
