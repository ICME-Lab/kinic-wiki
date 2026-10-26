//! Public, non-production fixtures from ic-agent 0.49.2 (Apache-2.0).
//! Guard key formats, caller principals, and signatures across the crypto migration.
use ic_agent::identity::{Prime256v1Identity, Secp256k1Identity};
use k256::ecdsa::signature::Verifier;
use k256::pkcs8::DecodePublicKey;
use vfs_client::identity_from_pem;

// RFC 8032 section 7.1, TEST 1: public test seed, never a production key.
const ED25519_PKCS8: &str = "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIJ1hsZ3v/VpguoRK9JLsLMREScVpezJpGXA7rAMcrn9g\n-----END PRIVATE KEY-----\n";
const ED25519_PUBLIC_KEY: &str =
    "302a300506032b6570032100d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a";
const ED25519_EMPTY_SIGNATURE: &str = "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b";

const SECP256K1_SEC1: &str = r#"-----BEGIN EC PARAMETERS-----
BgUrgQQACg==
-----END EC PARAMETERS-----
-----BEGIN EC PRIVATE KEY-----
MHQCAQEEIAgy7nZEcVHkQ4Z1Kdqby8SwyAiyKDQmtbEHTIM+WNeBoAcGBSuBBAAK
oUQDQgAEgO87rJ1ozzdMvJyZQ+GABDqUxGLvgnAnTlcInV3NuhuPv4O3VGzMGzeB
N3d26cRxD99TPtm8uo2OuzKhSiq6EQ==
-----END EC PRIVATE KEY-----
"#;
const SECP256K1_PKCS8: &str = r#"-----BEGIN PRIVATE KEY-----
MIGEAgEAMBAGByqGSM49AgEGBSuBBAAKBG0wawIBAQQgCDLudkRxUeRDhnUp2pvL
xLDICLIoNCa1sQdMgz5Y14GhRANCAASA7zusnWjPN0y8nJlD4YAEOpTEYu+CcCdO
VwidXc26G4+/g7dUbMwbN4E3d3bpxHEP31M+2by6jY67MqFKKroR
-----END PRIVATE KEY-----
"#;
const SECP256K1_PUBLIC_KEY: &str = r#"3056301006072a8648ce3d020106052b8104000a0342000480ef3bac9d68cf374cbc9c9943e180043a94c462ef8270274e57089d5dcdba1b8fbf83b7546ccc1b3781377776e9c4710fdf533ed9bcba8d8ebb32a14a2aba11"#;
const P256_SEC1: &str = r#"-----BEGIN EC PRIVATE KEY-----
MHcCAQEEIL1ybmbwx+uKYsscOZcv71MmKhrNqfPP0ke1unET5AY4oAoGCCqGSM49
AwEHoUQDQgAEUbbZV4NerZTPWfbQ749/GNLu8TaH8BUS/I7/+ipsu+MPywfnBFIZ
Sks4xGbA/ZbazsrMl4v446U5UIVxCGGaKw==
-----END EC PRIVATE KEY-----
"#;
const P256_PKCS8: &str = r#"-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgvXJuZvDH64piyxw5
ly/vUyYqGs2p88/SR7W6cRPkBjihRANCAARRttlXg16tlM9Z9tDvj38Y0u7xNofw
FRL8jv/6Kmy74w/LB+cEUhlKSzjEZsD9ltrOysyXi/jjpTlQhXEIYZor
-----END PRIVATE KEY-----
"#;
const P256_PUBLIC_KEY: &str = r#"3059301306072a8648ce3d020106082a8648ce3d0301070342000451b6d957835ead94cf59f6d0ef8f7f18d2eef13687f01512fc8efffa2a6cbbe30fcb07e70452194a4b38c466c0fd96dacecacc978bf8e3a53950857108619a2b"#;

#[test]
fn existing_ec_keys_keep_their_principals_and_valid_wire_signatures() {
    for (curve, sec1, pkcs8, public_key) in [
        (
            "secp256k1",
            SECP256K1_SEC1,
            SECP256K1_PKCS8,
            SECP256K1_PUBLIC_KEY,
        ),
        ("p256", P256_SEC1, P256_PKCS8, P256_PUBLIC_KEY),
    ] {
        let expected_key = hex::decode(public_key).unwrap();
        let expected_sender = ic_agent::export::Principal::self_authenticating(&expected_key);
        let no_parameters = sec1
            .find("-----BEGIN EC PRIVATE KEY-----")
            .map(|i| &sec1[i..])
            .unwrap();
        for pem in [sec1, no_parameters, pkcs8] {
            let identity = identity_from_pem(pem.as_bytes()).unwrap();
            assert_eq!(identity.sender().unwrap(), expected_sender);
            assert_eq!(identity.public_key().unwrap(), expected_key);
            let message = b"kinic identity migration compatibility";
            let signed = identity.sign_arbitrary(message).unwrap();
            assert_eq!(signed.public_key.unwrap(), expected_key);
            let signature = signed.signature.unwrap();
            assert_eq!(signature.len(), 64);
            if curve == "secp256k1" {
                let key = k256::ecdsa::VerifyingKey::from_public_key_der(&expected_key).unwrap();
                let sig = k256::ecdsa::Signature::try_from(signature.as_slice()).unwrap();
                key.verify(message, &sig).unwrap();
                assert!(key.verify(b"tampered", &sig).is_err());
            } else {
                let key = p256::ecdsa::VerifyingKey::from_public_key_der(&expected_key).unwrap();
                let sig = p256::ecdsa::Signature::try_from(signature.as_slice()).unwrap();
                key.verify(message, &sig).unwrap();
                assert!(key.verify(b"tampered", &sig).is_err());
            }
        }
    }
}

#[test]
fn ec_parsers_reject_wrong_curves_and_malformed_private_keys() {
    assert!(Secp256k1Identity::from_pem(P256_PKCS8).is_err());
    assert!(Prime256v1Identity::from_pem(SECP256K1_PKCS8).is_err());
    for bad in [
        "",
        "not a key",
        "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----",
    ] {
        assert!(identity_from_pem(bad.as_bytes()).is_err());
    }
}

#[test]
fn ed25519_pkcs8_retains_the_rfc8032_public_key_and_signature() {
    let identity = identity_from_pem(ED25519_PKCS8.as_bytes()).unwrap();
    let expected_key = hex::decode(ED25519_PUBLIC_KEY).unwrap();
    assert_eq!(identity.public_key().unwrap(), expected_key);
    assert_eq!(
        identity.sender().unwrap(),
        ic_agent::export::Principal::self_authenticating(&expected_key)
    );
    let signed = identity.sign_arbitrary(b"").unwrap();
    assert_eq!(
        hex::encode(signed.signature.unwrap()),
        ED25519_EMPTY_SIGNATURE
    );
}

#[test]
fn ec_delegation_chains_verify_and_reject_tampered_signatures() {
    use ic_agent::{
        Identity,
        identity::{DelegatedIdentity, Delegation, SignedDelegation},
    };
    for root_pem in [SECP256K1_PKCS8, P256_PKCS8] {
        let root = identity_from_pem(root_pem.as_bytes()).unwrap();
        let session = identity_from_pem(ED25519_PKCS8.as_bytes()).unwrap();
        let delegation = Delegation {
            pubkey: session.public_key().unwrap(),
            expiration: u64::MAX,
            targets: None,
            permissions: None,
        };
        let signature = root
            .sign_delegation(&delegation)
            .unwrap()
            .signature
            .unwrap();
        let signed = SignedDelegation {
            delegation,
            signature,
        };
        let delegated =
            DelegatedIdentity::new(root.public_key().unwrap(), session, vec![signed.clone()])
                .unwrap();
        assert_eq!(delegated.sender().unwrap(), root.sender().unwrap());
        assert_eq!(
            hex::encode(delegated.sign_arbitrary(b"").unwrap().signature.unwrap()),
            ED25519_EMPTY_SIGNATURE
        );

        let mut tampered = signed;
        tampered.signature[0] ^= 1;
        let session = identity_from_pem(ED25519_PKCS8.as_bytes()).unwrap();
        assert!(
            DelegatedIdentity::new(root.public_key().unwrap(), session, vec![tampered]).is_err()
        );
    }
}
