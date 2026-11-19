# Team access to an encrypted Vault

An owner adds a teammate using their Vault Internet Identity principal. The owner can change or revoke a grant through `set_vault_member(vault, principal, role)` and `remove_vault_member(vault, principal)`. `list_vault_members(vault)` returns the additional members. A Vault supports 100 additional principals. The immutable owner is the only administrator.

| Role | Permissions |
| --- | --- |
| Owner | Read, write, manage membership, purge objects and delete the Vault |
| Editor | Read content and history, save revisions, manage their own uploads and soft-delete objects |
| Viewer | Read content and history |

## Share a Vault in the workspace

1. The teammate signs in to Vault, opens **Account settings**, expands **Account & storage**, and copies the text under **Vault principal**. Internet Identity derives a separate principal for Wiki.
2. On the Vault card, the owner opens **Actions for [Vault name]** and chooses **Manage members**. This opens the member controls without retrieving the encryption key. The owner enters the teammate’s Vault principal, selects Viewer or Editor, and chooses **Add member**. The grant covers every document and its retained history in this Vault.
3. The teammate refreshes their Vault list. In the Wiki editor, **Insert private document** opens the Vault picker. Saving the article shares its opaque reference with Wiki readers. Each reader still needs a Vault membership to open the document.
4. The owner can change the role or choose **Remove member**. The canister checks each future shared call immediately. Open private views recheck on focus, when visibility resumes and every 30 seconds while visible. A view clears once it observes denied access. Revocation leaves any previously copied plaintext, files or keys in the recipient’s possession and does not rotate the encryption key.

The Vault’s recorded owner funds shared calls, including new key retrievals. If opening a shared Vault reports insufficient prepaid balance, contact the owner.

Vault clears the active view after 30 minutes of inactivity in the workspace, picker and document embed. Closing a Vault, signing out or timing out retains any saved nonextractable key handles in the browser. On reopen, Vault authenticates the caller and checks current access before using a saved handle. To remove your saved handles, go to **Account settings → Maintenance → Delete saved keys from this browser**. This closes open Vaults in that browser, keeps the documents, and may require a paid key retrieval when you reopen a Vault.

## Wire contract

All shared calls are authenticated updates. `list_accessible_vaults(after)` returns up to 20 entries ordered by Vault ID. Pass an empty blob for the first page and the returned `next` for the following page. `get_vault_access(vault)` resolves the recorded owner, header and current role. Clients must check access on each open, including when they hold a cached key.

The `shared_list_objects`, `shared_get_manifest`, `shared_get_chunk` and `shared_list_history` methods take the same arguments as the corresponding owner methods. `shared_get_quota(vault)` returns that Vault's current content bytes, active reservations and attributable storage charges. Account journals and other Vaults' usage remain private to the payer. Admission continues to apply both account and global limits.

`shared_mutate(vault, request)` checks the role and every target before looking up a journal receipt. The service namespaces operation and upload identifiers by caller and Vault. Reuse the original 16-byte operation and upload IDs on each retry. `BeginRevision.operation` (the nested operation in the begin request) identifies the upload and is returned in `Upload.id`. Pass that ID to put, commit, cancel and `shared_get_upload_status(vault, upload)`. The pending request and `shared_list_pending_uploads(vault, after)` return the same ID to the uploader. An owner can inspect or cancel uploads started by any caller through the existing owner-only API, using the handle returned by that API. Use the existing owner-only endpoint for `Collect` and for the full Vault deletion sequence, including its final retry after the Vault record is removed. Keep each retry sequence on the API that admitted it.

`shared_derive_vault_key(request)` derives the existing v3 context from the canister and recorded owner, Vault ID, nonce and key name. A member's principal never replaces the owner in the encryption context. The Vault owner pays existing read, write and vetKD charges. For an access page, the measured read cost is divided across the returned Vaults and consolidated by owner. Empty pages create no billing record.

Revocation prevents future shared reads, writes, receipt replays and key retrieval. A vetKD callback settles actual costs and checks access again before returning the key. Previously delivered plaintext and keys can still be retained by their recipients. Revocation leaves existing ciphertext and keys intact.

## Storage and upgrades

Schema 13 validates and upgrades the supported owner schemas 8, 9 and 10, grant-bearing schema 10, team schema 11, and subsidy schemas 11 and 12 in place. Migration preserves owner headers, encrypted documents, grants, upload provenance, accounting, subsidy consumption and mutation receipts. A rollback requires a separately validated schema-13-compatible build. See [Vault operations](operations.md) for upgrade order and rollback requirements.

Each grant consumes 512 bytes of logical capacity for the record and indexes plus a 512-byte cleanup credit. Vault deletion removes up to 100 member rows in one batch. A pending shared upload carries one small handle within its existing reservation. Committing or cancelling moves its caller and original wire ID into the terminal receipt and removes the live handle in the same transaction. The receipt's full byte length counts toward capacity, and its provenance expires with the receipt. The shared API requires that binding for every existing upload, including begin retries. Legacy owner-created uploads remain on the owner API.
