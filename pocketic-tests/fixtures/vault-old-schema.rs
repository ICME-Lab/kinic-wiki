// Minimal old-format sentinel, not an archived implementation. Only fresh test canisters.
fn init(version: u8) {
    assert!((1..=6).contains(&version));
    state::fixture_old_schema(version);
}
