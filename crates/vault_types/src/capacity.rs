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
pub const CLEANUP_RECEIPTS: usize = 1024;
pub const CLEANUP_ROW: usize = 512;
/// Emergency key leases/results share prepaid capacity, independent of content receipts.
pub const KEY_CONTROL_ROWS: usize = 64;
pub const KEY_CONTROL_OWNER_ROWS: usize = 16;
pub const KEY_CONTROL_ROW: usize = 2048;
pub const KEY_CONTROL_RESULT: usize = 1024;
pub const DERIVE_CONTROLS: usize = 8;
pub const DERIVE_CONTROL_ROW: usize = 512;
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
    "gc-owner",
    "serial",
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
        + KEY_ROWS * KEY_ROW
        + CLEANUP_RECEIPTS * CLEANUP_ROW
        + KEY_CONTROL_ROWS * KEY_CONTROL_ROW
        + DERIVE_CONTROLS * DERIVE_CONTROL_ROW;
    assert_eq!(total, 16_764_928);
    const { assert!(SETTING_SLOTS * SETTING_ROW + BILLING_CURSOR_ROW <= SETTINGS) };
    assert!(GLOBAL_SETTING_KEYS.len() <= SETTING_SLOTS);
    assert_eq!(ACCOUNTING_POOL as usize - total, 12_288);
    assert!(row_size(&[29, 16, 32, KEY_CONTROL_RESULT], 4).unwrap() <= KEY_CONTROL_ROW);
    assert!(
        KEY_OWNER_ROWS as u64 * KEY_OWNER_CHARGE
            + ((KEY_CONTROL_OWNER_ROWS * KEY_CONTROL_ROW + DERIVE_CONTROL_ROW) as u64)
            < ACCOUNTING_POOL
    );
    assert!(row_size(&[PRINCIPAL_TEXT, TOKEN, PRINCIPAL_TEXT], 8).unwrap() <= SMALL_ROW);
    assert!(row_size(&[PRINCIPAL_TEXT, KIND, 16], 4).unwrap() <= SMALL_ROW);
    assert!(row_size(&[29, 32], 9).unwrap() <= KEY_ROW);
    assert!((KEY_OWNER_ROWS as u64) * KEY_OWNER_CHARGE < ACCOUNTING_POOL);
    assert_eq!(row_size(&[usize::MAX], 1), None);
}

#[test]
fn maximum_key_reply_fits_protected_receipt() {
    let principal = candid::Principal::from_slice(&[7; 29]);
    let header = crate::Header {
        id: vec![1; 16],
        nonce: vec![2; 32],
        state: crate::VaultState::Active,
        sequence: u64::MAX,
        key_name: "k".repeat(64),
        public_key: vec![3; 96],
    };
    let reply = crate::KeyReply {
        encrypted_key: vec![4; 192],
        public_key: header.public_key.clone(),
        input: crate::key_input(principal, principal, &header).unwrap(),
    };
    let size = candid::encode_one(reply).unwrap().len();
    assert!(size <= KEY_CONTROL_RESULT);
    assert!(row_size(&[29, 16, 32, size], 4).unwrap() <= KEY_CONTROL_ROW);
}
