//! Narrow native bridge to DFINITY's verified vetKey implementation.
use ic_cdk_management_canister::{VetKDCurve, VetKDKeyId};
use ic_vetkeys::{DerivedPublicKey, EncryptedVetKey, MasterPublicKey, TransportSecretKey};
use zeroize::Zeroizing;

fn anchored_public_key(canister: &[u8], key: &str, local: bool) -> Result<Vec<u8>, ()> {
    if canister.is_empty() || canister.len() > 29 || canister == [4] {
        return Err(());
    }
    let key_id = VetKDKeyId {
        curve: VetKDCurve::Bls12_381_G2,
        name: key.to_owned(),
    };
    let master = if local {
        MasterPublicKey::for_pocketic_key(&key_id)
    } else {
        MasterPublicKey::for_mainnet_key(&key_id)
    }
    .ok_or(())?;
    Ok(master
        .derive_canister_key(canister)
        .derive_sub_key(b"kinic-vault/ii-only/v1")
        .serialize())
}

fn derive_root(secret: &[u8], request: &[u8], local: bool) -> Result<Zeroizing<Vec<u8>>, ()> {
    let mut rest = request;
    let mut fields = Vec::with_capacity(6);
    for _ in 0..6 {
        let length =
            u32::from_be_bytes(rest.get(..4).ok_or(())?.try_into().map_err(|_| ())?) as usize;
        rest = rest.get(4..).ok_or(())?;
        fields.push(rest.get(..length).ok_or(())?);
        rest = rest.get(length..).ok_or(())?;
    }
    if !rest.is_empty()
        || fields[1].is_empty()
        || fields[1].len() > 64
        || fields[2].is_empty()
        || fields[2].len() > 256
        || fields[3].len() != 96
        || fields[4].len() != 96
        || fields[5].len() != 192
    {
        return Err(());
    }
    let name = std::str::from_utf8(fields[1]).map_err(|_| ())?;
    let anchor = anchored_public_key(fields[0], name, local)?;
    if anchor != fields[3] || anchor != fields[4] {
        return Err(());
    }
    let public = DerivedPublicKey::deserialize(&anchor).map_err(|_| ())?;
    let secret = TransportSecretKey::deserialize(secret).map_err(|_| ())?;
    let encrypted = EncryptedVetKey::deserialize(fields[5]).map_err(|_| ())?;
    let key = encrypted
        .decrypt_and_verify(&secret, &public, fields[2])
        .map_err(|_| ())?;
    Ok(Zeroizing::new(
        key.derive_symmetric_key("kinic-vault/root/v3", 32),
    ))
}

/// # Safety
/// seed, secret, and public must point to readable32, writable32, writable48 bytes,
/// respectively; output buffers must not overlap inputs or each other.
#[no_mangle]
pub unsafe extern "C" fn kinic_vault_transport(
    seed: *const u8,
    secret: *mut u8,
    public: *mut u8,
) -> i32 {
    if seed.is_null() || secret.is_null() || public.is_null() {
        return -1;
    }
    let result = std::panic::catch_unwind(|| {
        let seed = unsafe { std::slice::from_raw_parts(seed, 32) };
        let transport = TransportSecretKey::from_seed(seed.to_vec()).map_err(|_| ())?;
        let raw = Zeroizing::new(transport.serialize());
        let pk = transport.public_key();
        unsafe {
            std::ptr::copy_nonoverlapping(raw.as_ptr(), secret, 32);
            std::ptr::copy_nonoverlapping(pk.as_ptr(), public, 48);
        }
        Ok::<_, ()>(())
    });
    if matches!(result, Ok(Ok(()))) {
        0
    } else {
        unsafe {
            std::ptr::write_bytes(secret, 0, 32);
            std::ptr::write_bytes(public, 0, 48);
        }
        -1
    }
}

/// # Safety
/// secret points to readable32 bytes; request points to readable len bytes;
/// out points to writable32 bytes disjoint from both inputs. len is at most1024.
#[no_mangle]
pub unsafe extern "C" fn kinic_vault_root(
    secret: *const u8,
    request: *const u8,
    len: usize,
    local: bool,
    out: *mut u8,
) -> i32 {
    if out.is_null() {
        return -1;
    }
    unsafe {
        std::ptr::write_bytes(out, 0, 32);
    }
    if secret.is_null() || request.is_null() || len > 1024 {
        return -1;
    }
    let result = std::panic::catch_unwind(|| {
        let root = derive_root(
            unsafe { std::slice::from_raw_parts(secret, 32) },
            unsafe { std::slice::from_raw_parts(request, len) },
            local,
        )?;
        unsafe {
            std::ptr::copy_nonoverlapping(root.as_ptr(), out, 32);
        }
        Ok::<_, ()>(())
    });
    if matches!(result, Ok(Ok(()))) {
        0
    } else {
        unsafe {
            std::ptr::write_bytes(out, 0, 32);
        }
        -1
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn independently_anchors_web_public_key() {
        let pk = anchored_public_key(&[0, 0, 0, 0, 0, 0, 0, 1, 1, 1], "test_key_1", false).unwrap();
        assert_eq!(hex::encode(pk),"853a8097215dd610f2ff403e0c497ac1f572e8a2e03968717708777ed1f1022d24670a42dd94e874d48fb1133630a74b115d0352b7305351d16a951fe0602d6600c073608e661641b3bc24d89310157bfab5ffb4bf93115d287c5fd409c7e6ca");
        assert!(anchored_public_key(&[1], "unknown", false).is_err());
    }
}

#[cfg(test)]
mod ffi_tests {
    use super::*;
    #[test]
    fn generates_transport_and_rejects_invalid_requests_without_leaving_output() {
        let mut secret = [0u8; 32];
        let mut public = [0u8; 48];
        assert_eq!(
            unsafe {
                kinic_vault_transport([7u8; 32].as_ptr(), secret.as_mut_ptr(), public.as_mut_ptr())
            },
            0
        );
        assert!(public.iter().any(|b| *b != 0));
        let mut output = [99u8; 32];
        assert_ne!(
            unsafe {
                kinic_vault_root(
                    secret.as_ptr(),
                    [0u8; 4].as_ptr(),
                    4,
                    false,
                    output.as_mut_ptr(),
                )
            },
            0
        );
        assert_eq!(output, [0u8; 32]);
    }
}
