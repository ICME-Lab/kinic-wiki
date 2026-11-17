// NONDEPLOYABLE boundary setup/inspection. No cryptography or authorization changes.
#[ic_cdk::update]
fn fixture_execute(sql: String) {
    assert!(ic_cdk::api::is_controller(&ic_cdk::api::msg_caller()));
    state::transaction(|db| db.execute_batch(&sql).map_err(|_| Error::Storage)).unwrap();
}
#[ic_cdk::query]
fn fixture_read(sql: String) -> String {
    assert!(ic_cdk::api::is_controller(&ic_cdk::api::msg_caller()));
    state::transaction(|db| {
        db.query_row(&sql, kinic_sqlite_compat::params![], |r| {
            kinic_sqlite_compat::row_get(r, 0)
        })
        .map_err(|_| Error::Storage)
    })
    .unwrap()
}
