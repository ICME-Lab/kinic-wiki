use tempfile::tempdir;
use vfs_runtime::VfsService;
use vfs_types::DatabaseRole;

#[test]
fn index_sql_json_treats_literal_keywords_and_markers_as_data() {
    let dir = tempdir().unwrap();
    let service = VfsService::new(
        dir.path().join("index.sqlite3"),
        dir.path().join("databases"),
    );
    let result = service
        .query_index_sql_json(
            "SELECT json_object('select;--from', 'owner''s update /* notes */') LIMIT 1",
            1,
        )
        .expect("SQL syntax inside literal keys and values should be data");
    assert_eq!(
        result.rows,
        vec![r#"{"select;--from":"owner's update /* notes */"}"#]
    );
    assert!(
        service
            .query_index_sql_json("SELECT json_object('ok', 1) /* comment */", 1)
            .is_ok()
    );
    for sql in [
        "SELECT json_object('ok', 1); SELECT json_object('ok', 2)",
        "SELECT json_object('ok', 1) /* comment */; DELETE FROM databases",
        "SELECT json_object('ok', 'unclosed)",
    ] {
        assert!(service.query_index_sql_json(sql, 1).is_err(), "{sql}");
    }
}

#[test]
fn database_reader_cannot_use_decoy_to_read_internal_schema_table() {
    let dir = tempdir().unwrap();
    let service = VfsService::new(
        dir.path().join("index.sqlite3"),
        dir.path().join("databases"),
    );
    service.run_index_migrations().unwrap();
    service.create_database("reader-probe", "owner", 1).unwrap();
    service
        .grant_database_access("reader-probe", "owner", "reader", DatabaseRole::Reader, 2)
        .unwrap();
    for sql in [
        "SELECT json_object('version', version) FROM schema_migrations LIMIT 1",
        "SELECT json_object(\"from\", \"fs_nodes\", \"where\", version) FROM schema_migrations LIMIT 1",
        "SELECT json_object('internal_hit', id IN publication_mutation_commits) FROM fs_nodes LIMIT 1",
    ] {
        assert!(
            service
                .query_database_sql_json("reader-probe", "reader", sql, 1)
                .is_err(),
            "reader accessed internal table: {sql}"
        );
    }
}
