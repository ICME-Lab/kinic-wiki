# Team Access to an Encrypted Vault

See [Vault overview](README.md) for context and [protocol](protocol.md) for the v3 encryption model.

## Roles and Permissions

An owner adds a teammate using their **Vault** Internet Identity principal (derived separately from Wiki). The owner manages grants with `set_vault_member(vault, principal, role)`, `remove_vault_member(vault, principal)`, and `list_vault_members(vault)`. A Vault supports up to **100 additional principals**. The immutable owner is the only administrator.

| Role | Permissions |
| --- | --- |
| Owner | Read, write, manage membership, purge objects, rename and delete the Vault |
| Editor | Read content and history, save revisions, manage their own uploads, and soft-delete objects |
| Viewer | Read content and history |

## Sharing Workflow

1. The teammate signs in to Vault, opens **Account settings**, expands **Account & storage**, and copies their **Vault principal**.
2. On the Vault card, the owner opens **Actions for [Vault name]** → **Manage members**. This opens member controls without retrieving the encryption key or requiring a key fee. The owner enters the teammate's Vault principal, selects **Viewer** or **Editor**, and chooses **Add member**. Grants apply to every document and its retained history in that Vault.
3. The teammate refreshes their Vault list. In the Wiki editor, **Insert private document** opens the Vault picker. Saving the article shares only the opaque reference with Wiki readers; each reader still needs a Vault membership to open the document.
4. The owner can change the role or choose **Remove member**. The canister checks each future shared call immediately. Open private views recheck on focus, when visibility resumes, and every 30 seconds while visible, clearing the view once access is denied.

The Vault's recorded owner funds all shared calls, including new key retrievals. If opening a shared Vault reports insufficient prepaid balance, contact the owner.

Session timeouts and browser device-key caching follow the rules in [operations](operations.md#browser-session-and-device-keys): closing, signing out, or timing out keeps non-extractable key handles in IndexedDB until deleted via **Account settings → Maintenance → Delete saved keys from this browser**, and reopening always re-authenticates and rechecks current access.

## Wire Contract

All shared calls are authenticated update calls:

- `list_accessible_vaults(after)` returns up to 20 entries ordered by Vault ID. Pass an empty blob for the first page and the returned `next` cursor for subsequent pages.
- `get_vault_access(vault)` resolves the recorded owner, header, and current role. Clients must check access on each open, including when holding a cached device key.
- `shared_list_objects`, `shared_get_manifest`, `shared_get_chunk`, and `shared_list_history` take the same arguments as the corresponding owner methods.
- `shared_get_quota(vault)` returns that Vault's current content bytes, active reservations, and attributable storage charges. Account journals and other Vaults' usage remain private to the owner. Admission continues to apply both account and global limits.
- `shared_mutate(vault, request)` checks the role and every target before looking up a journal receipt. Operation and upload identifiers are namespaced by caller and Vault; reuse the original 16-byte operation and upload IDs on each retry. `BeginRevision.operation` identifies the upload and is returned in `Upload.id` for put, commit, cancel, and `shared_get_upload_status(vault, upload)`. `shared_list_pending_uploads(vault, after)` returns the same ID to the uploader. An owner can inspect or cancel uploads started by any caller through the owner API using the handle returned there. Use the owner API for `Collect` and for full Vault deletion (including its final retry after the Vault row is removed). Keep each retry sequence on the API that admitted it.
- `shared_derive_vault_key(request)` derives the v3 context from the canister and **recorded owner**, Vault ID, nonce, and key name. A member's principal never replaces the owner in the encryption context. The Vault owner pays read, write, and vetKD charges. For `list_accessible_vaults`, the measured read cost is divided across returned Vaults and consolidated by owner; empty pages create no billing record.

### Revocation Limits

Revocation immediately blocks future shared reads, writes, receipt replays, and key retrieval. A vetKD callback settles actual costs and rechecks access before returning the key. However, revocation **does not rotate the encryption key** and cannot erase plaintext, files, or key material already copied or retained by a previous recipient.

## Storage and Upgrades

Schema 14 validates and upgrades supported historical layouts (owner schemas 8, 9, and 10, grant-bearing schema 10, team schema 11, subsidy schemas 11 and 12, and combined schema 13) in place while preserving grants, upload provenance, headers, encrypted documents, accounting, subsidy consumption, and mutation receipts. See [operations](operations.md#schema-14-and-upgrades) for upgrade order and rollback constraints.

Each grant consumes 512 bytes of logical capacity (for the record and indexes) plus a 512-byte cleanup credit. Vault deletion removes up to 100 member rows in one batch. A pending shared upload carries one small handle within its existing reservation; committing or cancelling moves its caller and original wire ID into the terminal receipt and removes the live handle in the same transaction. The receipt's full byte length counts toward capacity, and its provenance expires with the receipt. The shared API requires that binding for every existing upload, including begin retries. Legacy owner-created uploads remain on the owner API.
