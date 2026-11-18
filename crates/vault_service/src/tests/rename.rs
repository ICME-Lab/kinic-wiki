use super::*;

#[test]
fn rename_is_owned_durable_and_replayable_without_changing_key_context() {
    let e = Env::new();
    let h = e.create();
    let input = key_input(Principal::from_slice(&[9]), e.owner.get(), &h).unwrap();
    let action = Action::RenameVault {
        vault: h.id.clone(),
        name: "仕事".into(),
        expected_sequence: h.sequence,
    };
    e.change(10, action.clone()).unwrap();
    e.change(10, action).unwrap();
    let renamed = e.transaction(|db| store::header(db, &h.id)).unwrap();
    assert_eq!(renamed.name.as_deref(), Some("仕事"));
    assert_eq!(renamed.sequence, h.sequence + 1);
    assert_eq!(
        key_input(Principal::from_slice(&[9]), e.owner.get(), &renamed).unwrap(),
        input
    );
    assert_eq!(
        serde_json::from_str::<Header>(&serde_json::to_string(&renamed).unwrap()).unwrap(),
        renamed
    );
    e.owner.set(Principal::from_slice(&[2]));
    assert!(matches!(
        e.change(
            11,
            Action::RenameVault {
                vault: h.id.clone(),
                name: "Other".into(),
                expected_sequence: renamed.sequence
            }
        ),
        Err(Error::NotFound)
    ));
    e.owner.set(Principal::anonymous());
    assert!(matches!(
        e.change(
            12,
            Action::RenameVault {
                vault: h.id,
                name: "Anonymous".into(),
                expected_sequence: renamed.sequence
            }
        ),
        Err(Error::Unauthorized)
    ));
}

#[test]
fn rename_rejects_stale_names_and_invalid_input_and_reads_legacy_headers() {
    let e = Env::new();
    let h = e.create();
    let mut old = serde_json::to_value(&h).unwrap();
    old.as_object_mut().unwrap().remove("name");
    assert_eq!(serde_json::from_value::<Header>(old).unwrap().name, None);
    #[derive(candid::CandidType)]
    struct LegacyHeader {
        id: Id,
        nonce: Vec<u8>,
        state: VaultState,
        sequence: u64,
        key_name: String,
        public_key: Vec<u8>,
    }
    let old = LegacyHeader {
        id: h.id.clone(),
        nonce: h.nonce.clone(),
        state: h.state.clone(),
        sequence: h.sequence,
        key_name: h.key_name.clone(),
        public_key: h.public_key.clone(),
    };
    assert_eq!(
        candid::decode_one::<Header>(&candid::encode_one(old).unwrap())
            .unwrap()
            .name,
        None
    );
    for name in ["".to_string(), " ".into(), "a\nb".into(), "x".repeat(65)] {
        assert!(matches!(
            e.change(
                10,
                Action::RenameVault {
                    vault: h.id.clone(),
                    name,
                    expected_sequence: h.sequence
                }
            ),
            Err(Error::InvalidInput)
        ));
    }
    e.change(
        10,
        Action::RenameVault {
            vault: h.id.clone(),
            name: "Personal".into(),
            expected_sequence: h.sequence,
        },
    )
    .unwrap();
    assert!(matches!(
        e.change(
            11,
            Action::RenameVault {
                vault: h.id,
                name: "Stale".into(),
                expected_sequence: h.sequence
            }
        ),
        Err(Error::Conflict)
    ));
}
