// Private Vault wire contract. Validated against vfs.did by the existing generator.
export const vaultTypes = {
  "Envelope": {
    "kind": "record",
    "fields": {
      "ciphertext": "blob",
      "version": "nat8",
      "nonce": "blob"
    }
  },
  "VaultState": {
    "kind": "variant",
    "cases": {
      "Active": "null",
      "Restoring": "null",
      "Pending": "null"
    }
  },
  "Header": {
    "kind": "record",
    "fields": {
      "id": "blob",
      "normal": "opt Envelope",
      "epoch": "nat64",
      "backup_sequence": "opt nat64",
      "state": "VaultState",
      "key_name": "text",
      "recovery": "opt Envelope",
      "sequence": "nat64",
      "backup_at": "opt nat64"
    }
  },
  "Error": {
    "kind": "variant",
    "cases": {
      "Storage": "null",
      "InvalidInput": "null",
      "Busy": "null",
      "InvalidProof": "null",
      "KeyService": "null",
      "NotFound": "null",
      "ExportInProgress": "null",
      "Unauthorized": "null",
      "Expired": "null",
      "QuotaExceeded": "null",
      "Conflict": "null"
    }
  },
  "ResultVaultHeader": {
    "kind": "variant",
    "cases": {
      "Ok": "Header",
      "Err": "Error"
    }
  },
  "Activate": {
    "kind": "record",
    "fields": {
      "normal": "Envelope",
      "attempt": "opt blob",
      "vault": "blob",
      "registration": "opt text",
      "assertion": "opt text",
      "operation": "blob",
      "recovery": "Envelope"
    }
  },
  "Export": {
    "kind": "record",
    "fields": {
      "id": "blob",
      "expires": "nat64",
      "vault": "blob",
      "plain_bytes": "nat64",
      "state": "text",
      "chunk_count": "nat64",
      "sequence": "nat64",
      "record_count": "nat64",
      "header": "Header"
    }
  },
  "ResultVaultExport": {
    "kind": "variant",
    "cases": {
      "Ok": "Export",
      "Err": "Error"
    }
  },
  "BeginRestore": {
    "kind": "record",
    "fields": {
      "count": "nat64",
      "root": "blob",
      "operation": "blob",
      "reserved_bytes": "nat64",
      "header": "Header"
    }
  },
  "Revision": {
    "kind": "record",
    "fields": {
      "deleted": "bool",
      "object": "blob",
      "vault": "blob",
      "chunk_hashes": "vec blob",
      "revision": "nat64",
      "manifest": "blob",
      "plain_size": "nat64",
      "sequence": "nat64"
    }
  },
  "ResultVaultUnit": {
    "kind": "variant",
    "cases": {
      "Ok": "null",
      "Err": "Error"
    }
  },
  "BeginRevision": {
    "kind": "record",
    "fields": {
      "object": "blob",
      "vault": "blob",
      "chunk_hashes": "vec blob",
      "operation": "blob",
      "manifest": "blob",
      "plain_size": "nat64",
      "expected_revision": "nat64"
    }
  },
  "Upload": {
    "kind": "record",
    "fields": {
      "id": "blob",
      "expires": "nat64",
      "revision": "nat64"
    }
  },
  "ResultVaultUpload": {
    "kind": "variant",
    "cases": {
      "Ok": "Upload",
      "Err": "Error"
    }
  },
  "Purpose": {
    "kind": "variant",
    "cases": {
      "Unlock": "null",
      "Activate": "null",
      "AddCredential": "null",
      "RemoveCredential": "null"
    }
  },
  "BeginUnlock": {
    "kind": "record",
    "fields": {
      "attempt": "opt blob",
      "vault": "blob",
      "transport": "blob",
      "epoch": "nat64",
      "target": "blob",
      "purpose": "Purpose"
    }
  },
  "Challenge": {
    "kind": "record",
    "fields": {
      "expires": "nat64",
      "registration": "bool",
      "credential_ids": "vec blob",
      "bytes": "blob"
    }
  },
  "ResultVaultChallenge": {
    "kind": "variant",
    "cases": {
      "Ok": "Challenge",
      "Err": "Error"
    }
  },
  "ResultVaultNat64": {
    "kind": "variant",
    "cases": {
      "Ok": "nat64",
      "Err": "Error"
    }
  },
  "RestoreProgress": {
    "kind": "record",
    "fields": {
      "count": "nat64",
      "root": "blob",
      "sequence": "nat64"
    }
  },
  "ResultVaultRestoreProgress": {
    "kind": "variant",
    "cases": {
      "Ok": "RestoreProgress",
      "Err": "Error"
    }
  },
  "ResultVaultRevision": {
    "kind": "variant",
    "cases": {
      "Ok": "Revision",
      "Err": "Error"
    }
  },
  "Derive": {
    "kind": "record",
    "fields": {
      "attempt": "opt blob",
      "vault": "blob",
      "transport": "blob",
      "epoch": "nat64",
      "assertion": "opt text"
    }
  },
  "KeyReply": {
    "kind": "record",
    "fields": {
      "encrypted_key": "blob",
      "public_key": "blob"
    }
  },
  "ResultVaultKeyReply": {
    "kind": "variant",
    "cases": {
      "Ok": "KeyReply",
      "Err": "Error"
    }
  },
  "ExportPage": {
    "kind": "record",
    "fields": {
      "next": "opt nat64",
      "entries": "vec Revision"
    }
  },
  "ResultVaultExportPage": {
    "kind": "variant",
    "cases": {
      "Ok": "ExportPage",
      "Err": "Error"
    }
  },
  "ResultVaultOptExport": {
    "kind": "variant",
    "cases": {
      "Ok": "opt Export",
      "Err": "Error"
    }
  },
  "ResultVaultBlob": {
    "kind": "variant",
    "cases": {
      "Ok": "blob",
      "Err": "Error"
    }
  },
  "VaultConfig": {
    "kind": "record",
    "fields": {
      "minimum_cycles": "nat64",
      "origin": "text",
      "key_name": "text",
      "rp_id": "text"
    }
  },
  "ResultVaultOptVaultConfig": {
    "kind": "variant",
    "cases": {
      "Ok": "opt VaultConfig",
      "Err": "Error"
    }
  },
  "ResultVaultOptText": {
    "kind": "variant",
    "cases": {
      "Ok": "opt text",
      "Err": "Error"
    }
  },
  "Quota": {
    "kind": "record",
    "fields": {
      "reserved": "nat64",
      "limit": "nat64",
      "current": "nat64",
      "charged": "nat64"
    }
  },
  "ResultVaultQuota": {
    "kind": "variant",
    "cases": {
      "Ok": "Quota",
      "Err": "Error"
    }
  },
  "CredentialInfo": {
    "kind": "record",
    "fields": {
      "id": "blob"
    }
  },
  "ResultVaultVecCredentialInfo": {
    "kind": "variant",
    "cases": {
      "Ok": "vec CredentialInfo",
      "Err": "Error"
    }
  },
  "ObjectPage": {
    "kind": "record",
    "fields": {
      "next": "opt blob",
      "entries": "vec Revision"
    }
  },
  "ResultVaultObjectPage": {
    "kind": "variant",
    "cases": {
      "Ok": "ObjectPage",
      "Err": "Error"
    }
  },
  "UnfinishedVault": {
    "kind": "record",
    "fields": {
      "expires": "nat64",
      "cleaning": "bool",
      "attempt": "blob",
      "vault": "blob",
      "state": "VaultState"
    }
  },
  "ResultVaultVecUnfinishedVault": {
    "kind": "variant",
    "cases": {
      "Ok": "vec UnfinishedVault",
      "Err": "Error"
    }
  },
  "ResultVaultVecHeader": {
    "kind": "variant",
    "cases": {
      "Ok": "vec Header",
      "Err": "Error"
    }
  },
  "ManageCredential": {
    "kind": "record",
    "fields": {
      "remove": "opt blob",
      "vault": "blob",
      "registration": "opt text",
      "assertion": "text"
    }
  },
  "Reserve": {
    "kind": "record",
    "fields": {
      "vault": "blob",
      "operation": "blob"
    }
  }
};

export const vaultTypeAliases = {
  "ResultVaultHeader": "Result_56",
  "ResultVaultExport": "Result_57",
  "ResultVaultUnit": "Result_58",
  "ResultVaultUpload": "Result_59",
  "ResultVaultChallenge": "Result_60",
  "ResultVaultNat64": "Result_61",
  "ResultVaultRestoreProgress": "Result_62",
  "ResultVaultRevision": "Result_63",
  "ResultVaultKeyReply": "Result_64",
  "ResultVaultExportPage": "Result_65",
  "ResultVaultOptExport": "Result_66",
  "ResultVaultBlob": "Result_67",
  "ResultVaultOptVaultConfig": "Result_68",
  "ResultVaultOptText": "Result_69",
  "ResultVaultQuota": "Result_70",
  "ResultVaultVecCredentialInfo": "Result_71",
  "ResultVaultObjectPage": "Result_72",
  "ResultVaultVecUnfinishedVault": "Result_73",
  "ResultVaultVecHeader": "Result_74"
};

export const vaultMethods = {
  "vault_abort_export": {
    "input": [
      "blob"
    ],
    "output": "ResultVaultHeader",
    "mode": "update"
  },
  "vault_activate_vault": {
    "input": [
      "Activate"
    ],
    "output": "ResultVaultHeader",
    "mode": "update"
  },
  "vault_begin_export": {
    "input": [
      "blob",
      "blob"
    ],
    "output": "ResultVaultExport",
    "mode": "update"
  },
  "vault_begin_restore": {
    "input": [
      "BeginRestore"
    ],
    "output": "ResultVaultHeader",
    "mode": "update"
  },
  "vault_begin_restore_revision": {
    "input": [
      "blob",
      "Revision",
      "opt blob"
    ],
    "output": "ResultVaultUnit",
    "mode": "update"
  },
  "vault_begin_revision": {
    "input": [
      "BeginRevision"
    ],
    "output": "ResultVaultUpload",
    "mode": "update"
  },
  "vault_begin_unlock": {
    "input": [
      "BeginUnlock"
    ],
    "output": "ResultVaultChallenge",
    "mode": "update"
  },
  "vault_cancel_pending_key_derivation": {
    "input": [],
    "output": "ResultVaultUnit",
    "mode": "update"
  },
  "vault_cancel_vault_setup": {
    "input": [
      "blob",
      "blob"
    ],
    "output": "ResultVaultUnit",
    "mode": "update"
  },
  "vault_collect_garbage": {
    "input": [],
    "output": "ResultVaultNat64",
    "mode": "update"
  },
  "vault_commit_restore": {
    "input": [
      "Activate"
    ],
    "output": "ResultVaultHeader",
    "mode": "update"
  },
  "vault_commit_restore_revision": {
    "input": [
      "blob",
      "nat64",
      "opt blob"
    ],
    "output": "ResultVaultRestoreProgress",
    "mode": "update"
  },
  "vault_commit_revision": {
    "input": [
      "blob"
    ],
    "output": "ResultVaultRevision",
    "mode": "update"
  },
  "vault_delete_object": {
    "input": [
      "blob",
      "blob",
      "nat64",
      "blob"
    ],
    "output": "ResultVaultRevision",
    "mode": "update"
  },
  "vault_derive_vault_key": {
    "input": [
      "Derive"
    ],
    "output": "ResultVaultKeyReply",
    "mode": "update"
  },
  "vault_export_index": {
    "input": [
      "blob",
      "nat64"
    ],
    "output": "ResultVaultExportPage",
    "mode": "update"
  },
  "vault_finish_export": {
    "input": [
      "blob",
      "bool"
    ],
    "output": "ResultVaultHeader",
    "mode": "update"
  },
  "vault_get_active_export": {
    "input": [],
    "output": "ResultVaultOptExport",
    "mode": "update"
  },
  "vault_get_active_export_for_vault": {
    "input": [
      "blob"
    ],
    "output": "ResultVaultOptExport",
    "mode": "update"
  },
  "vault_get_chunk": {
    "input": [
      "blob",
      "blob",
      "nat64",
      "nat32"
    ],
    "output": "ResultVaultBlob",
    "mode": "update"
  },
  "vault_get_config": {
    "input": [],
    "output": "ResultVaultOptVaultConfig",
    "mode": "update"
  },
  "vault_get_export_chunk": {
    "input": [
      "blob",
      "blob",
      "nat64",
      "nat32"
    ],
    "output": "ResultVaultBlob",
    "mode": "update"
  },
  "vault_get_manifest": {
    "input": [
      "blob",
      "blob",
      "nat64"
    ],
    "output": "ResultVaultRevision",
    "mode": "update"
  },
  "vault_get_payer": {
    "input": [],
    "output": "ResultVaultOptText",
    "mode": "update"
  },
  "vault_get_quota": {
    "input": [
      "blob"
    ],
    "output": "ResultVaultQuota",
    "mode": "update"
  },
  "vault_get_vault_header": {
    "input": [
      "blob"
    ],
    "output": "ResultVaultHeader",
    "mode": "update"
  },
  "vault_list_credentials": {
    "input": [],
    "output": "ResultVaultVecCredentialInfo",
    "mode": "update"
  },
  "vault_list_history": {
    "input": [
      "blob",
      "blob",
      "nat64"
    ],
    "output": "ResultVaultExportPage",
    "mode": "update"
  },
  "vault_list_objects": {
    "input": [
      "blob",
      "blob"
    ],
    "output": "ResultVaultObjectPage",
    "mode": "update"
  },
  "vault_list_unfinished_vaults": {
    "input": [],
    "output": "ResultVaultVecUnfinishedVault",
    "mode": "update"
  },
  "vault_list_vaults": {
    "input": [],
    "output": "ResultVaultVecHeader",
    "mode": "update"
  },
  "vault_manage_unlock_credential": {
    "input": [
      "ManageCredential"
    ],
    "output": "ResultVaultUnit",
    "mode": "update"
  },
  "vault_prepare_unlock_credential": {
    "input": [
      "blob",
      "text"
    ],
    "output": "ResultVaultBlob",
    "mode": "update"
  },
  "vault_purge_object": {
    "input": [
      "blob",
      "blob"
    ],
    "output": "ResultVaultUnit",
    "mode": "update"
  },
  "vault_put_chunk": {
    "input": [
      "blob",
      "nat32",
      "blob"
    ],
    "output": "ResultVaultUnit",
    "mode": "update"
  },
  "vault_put_restore_chunk": {
    "input": [
      "blob",
      "nat32",
      "blob",
      "opt blob"
    ],
    "output": "ResultVaultUnit",
    "mode": "update"
  },
  "vault_reserve_vault": {
    "input": [
      "Reserve"
    ],
    "output": "ResultVaultHeader",
    "mode": "update"
  },
  "vault_set_config": {
    "input": [
      "opt VaultConfig"
    ],
    "output": "ResultVaultUnit",
    "mode": "update"
  },
  "vault_set_payer": {
    "input": [
      "text"
    ],
    "output": "ResultVaultUnit",
    "mode": "update"
  }
};

export const vaultTypeOrder = Object.keys(vaultTypes);
export const vaultMethodOrder = Object.keys(vaultMethods);
