"""Where: plugins/hermes/kinic_hermes/tools.py
What: Optional user-facing Kinic helper tools for Hermes.
Why: Corrections should be explicit and append-only.
"""

from __future__ import annotations

import subprocess
import tempfile
import os
from pathlib import Path


def kinic_record_correction(skill_id: str, run_id: str, notes: str, cli: str | None = None) -> str:
    command = cli or os.environ.get("KINIC_VFS_CLI", "kinic-vfs-cli")
    with tempfile.NamedTemporaryFile("w", suffix=".md", delete=False) as handle:
        handle.write(notes)
        temp_path = Path(handle.name)
    try:
        result = subprocess.run(
            [
                command,
                "skill",
                "record-correction",
                skill_id,
                run_id,
                "--notes-file",
                str(temp_path),
                "--json",
            ],
            check=True,
            text=True,
            capture_output=True,
        )
        return result.stdout
    finally:
        temp_path.unlink(missing_ok=True)
