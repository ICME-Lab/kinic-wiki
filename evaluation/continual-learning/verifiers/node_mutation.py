#!/usr/bin/env python3
"""Held-out behavior checks, executed only after the agent exits.

The harness and Cargo artifacts live outside the exported source workspace.
No expected patch or reference implementation is copied into that workspace.
"""
import json
import os
import shutil
from pathlib import Path
import subprocess
import sys
import tempfile

workspace = Path(sys.argv[1]).resolve()
with tempfile.TemporaryDirectory(prefix="verification-", dir=workspace.parent) as directory:
    harness = Path(directory)
    (harness / "src").mkdir()
    (harness / "Cargo.toml").write_text(
        '[package]\nname="held-out-node-mutation"\nversion="0.0.0"\nedition="2024"\n'
        '[workspace]\n[dependencies]\ncandid="=0.10.26"\nserde_json="=1.0.149"\n'
        'vfs_types={package="kinic-vfs-types",path='
        + json.dumps(str(workspace / "crates/vfs_types")) + '}\n'
    )
    (harness / "src/lib.rs").write_text('''
#[cfg(test)] mod tests {
    use vfs_types::{NodeMutationError,NodeMutationErrorCode,WriteNodeResult};
    #[test] fn public_error_wire_contract() {
        for (code,json) in [
            (NodeMutationErrorCode::EtagConflict,"etag_conflict"),
            (NodeMutationErrorCode::NotFound,"not_found"),
            (NodeMutationErrorCode::Forbidden,"forbidden"),
            (NodeMutationErrorCode::WriteUnavailable,"write_unavailable"),
            (NodeMutationErrorCode::InvalidOperation,"invalid_operation"),
        ] {
            let bytes=candid::encode_one(code).unwrap();
            assert_eq!(candid::decode_one::<NodeMutationErrorCode>(&bytes).unwrap(),code);
            assert_eq!(serde_json::to_value(code).unwrap(),json);
        }
        let error=NodeMutationError::etag_conflict("node changed","/work/plan.md").with_failed_index(2);
        assert_eq!(candid::decode_one::<NodeMutationError>(&candid::encode_one(&error).unwrap()).unwrap(),error);
        let result:Result<WriteNodeResult,NodeMutationError>=Err(error);
        assert_eq!(candid::decode_one::<Result<WriteNodeResult,NodeMutationError>>(&candid::encode_one(&result).unwrap()).unwrap(),result);
    }
}
''')
    # Preserve the pinned source dependency resolution instead of silently using
    # newer cached libraries when this historical task is re-run later.
    shutil.copyfile(workspace / "Cargo.lock", harness / "Cargo.lock")
    environment = os.environ.copy()
    environment["CARGO_TARGET_DIR"] = str(workspace.parent / "verification-target")
    result = subprocess.run(["cargo", "test", "--offline", "--manifest-path", str(harness / "Cargo.toml")], env=environment)
    sys.exit(result.returncode)
