//! Logical value bounds, independent of SQLite pages/indexes and Wasm heap usage.
//! Each string/blob has a four-byte length prefix and its UTF-8/raw bytes; every
//! scalar (including nullable integers) occupies eight bytes at maximum width.
pub const KEY_ROWS: usize = 4096;
pub const KEY_OWNER_ROWS: usize = 512;
pub const KEY_ROW: usize = 256;
/// Existing conservative owner storage tariff, independent of global row-value accounting.
pub const KEY_OWNER_CHARGE: u64 = 4096;
pub const ACCOUNTING_POOL: u64 = 16 * 1024 * 1024;
pub const ACCOUNTS: usize = 1024;
pub const PAYMENTS: usize = 1024;
pub const FEE_FLIGHTS: usize = 8;
pub const RESERVATIONS: usize = 10000;
pub const AUDIT: usize = 10000;
pub const SMALL_ROW: usize = 512;
pub const PAYMENT_ROW: usize = 4096;
pub const SETTINGS: usize = 64 * 1024;
pub const SETTING_SLOTS: usize = 7;
pub const SETTING_ROW: usize = 8192;
pub const BILLING_CURSOR_ROW: usize = 512;
/// Current global keys; two prepaid setting slots remain for future bounded jobs.
pub const GLOBAL_SETTING_KEYS: &[&str] = &[
    "config",
    "funding",
    "generation",
    "quote_fee_serial",
    "cleanup-budget",
];
pub const PRINCIPAL_TEXT: usize = 63;
pub const TOKEN: usize = 128;
pub const KIND: usize = 32;
pub fn row_size(variable: &[usize], scalars: usize) -> Option<usize> {
    variable.iter().try_fold(scalars.checked_mul(8)?, |sum, n| {
        sum.checked_add(4)?.checked_add(*n)
    })
}
#[test]
fn worst_case_pool_and_rows_fit() {
    let total = ACCOUNTS * SMALL_ROW
        + PAYMENTS * PAYMENT_ROW
        + FEE_FLIGHTS * PAYMENT_ROW
        + RESERVATIONS * SMALL_ROW
        + AUDIT * SMALL_ROW
        + SETTINGS
        + KEY_ROWS * KEY_ROW;
    assert_eq!(total, 16_105_472);
    assert!(SETTING_SLOTS * SETTING_ROW + BILLING_CURSOR_ROW <= SETTINGS);
    assert!(GLOBAL_SETTING_KEYS.len() <= SETTING_SLOTS);
    assert_eq!(ACCOUNTING_POOL as usize - total, 671_744);
    assert!(row_size(&[PRINCIPAL_TEXT, TOKEN, PRINCIPAL_TEXT], 8).unwrap() <= SMALL_ROW);
    assert!(row_size(&[PRINCIPAL_TEXT, KIND, 16], 4).unwrap() <= SMALL_ROW);
    assert!(row_size(&[29, 32], 9).unwrap() <= KEY_ROW);
    assert!((KEY_OWNER_ROWS as u64) * KEY_OWNER_CHARGE < ACCOUNTING_POOL);
    assert_eq!(row_size(&[usize::MAX], 1), None);
}
