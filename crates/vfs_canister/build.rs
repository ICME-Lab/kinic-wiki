// Where: crates/vfs_canister/build.rs
// What: Rebuild the canister when local II origin compilation changes.
// Why: The certified ii-alternative-origins body is selected at compile time.
fn main() {
    println!("cargo:rerun-if-env-changed=KINIC_VFS_LOCAL_II_ORIGINS");
}
