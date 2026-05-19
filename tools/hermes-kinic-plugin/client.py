"""Where: tools/hermes-kinic-plugin/client.py
What: kinic-vfs-cli subprocess boundary for Hermes plugin recording.
Why: The plugin stays thin; Kinic CLI owns identity, DB selection, and VFS writes.
"""

from __future__ import annotations

import json
import os
import subprocess
import tempfile
from pathlib import Path
from typing import Any


class KinicClient:
    def __init__(self, cli: str | None = None) -> None:
        self.cli = cli or os.environ.get("KINIC_VFS_CLI", "kinic-vfs-cli")

    def record_run(self, skill_id: str, evidence: dict[str, Any]) -> None:
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as handle:
            json.dump(evidence, handle, indent=2)
            temp_path = Path(handle.name)
        try:
            subprocess.run(
                [self.cli, "skill", "record-run", skill_id, "--evidence-json", str(temp_path)],
                check=True,
                text=True,
                capture_output=True,
            )
        finally:
            temp_path.unlink(missing_ok=True)
