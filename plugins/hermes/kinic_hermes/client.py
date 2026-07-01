"""Where: plugins/hermes/kinic_hermes/client.py
What: kinic-vfs-cli subprocess boundary for Hermes plugin recording.
Why: The plugin stays thin; Kinic CLI owns identity, DB selection, and VFS writes.
"""

from __future__ import annotations

import os
import sys
import time
from pathlib import Path
from typing import Any

PLUGIN_ROOT = Path(__file__).resolve().parents[1]
LOCAL_RUNTIME_ROOT = PLUGIN_ROOT
REPO_RUNTIME_ROOT = Path(__file__).resolve().parents[2] / "runtime"
for runtime_root in (LOCAL_RUNTIME_ROOT, REPO_RUNTIME_ROOT):
    if runtime_root.joinpath("kinic_agent_runtime").is_dir() and str(runtime_root) not in sys.path:
        sys.path.insert(0, str(runtime_root))

from kinic_agent_runtime import evidence as runtime_evidence
from kinic_agent_runtime.cli import resolve_cli


class KinicClient:
    def __init__(self, cli: str | None = None) -> None:
        self.kinic_home = Path(os.environ.get("KINIC_HOME", str(Path.home() / ".kinic")))
        self.pending_dir = self.kinic_home / "pending-runs"
        self.projection_dir = self.kinic_home / "hermes-current" / "skills"
        self.log_path = self.kinic_home / "hermes-plugin.log"
        self.cli = self._resolve_cli(cli)

    def record_run(self, skill_id: str, evidence: dict[str, Any]) -> bool:
        evidence = dict(evidence)
        evidence["recorded_by"] = "hermes-plugin"
        if not self.cli:
            self._log("kinic-vfs-cli not found; saving pending run")
            self.save_pending(skill_id, evidence, "kinic-vfs-cli not found")
            return False
        recorded, error = runtime_evidence.record_run(self.cli, skill_id, evidence, "hermes-plugin")
        if recorded:
            self._log(f"recorded run for {skill_id}")
            return True
        self._log(f"record-run failed for {skill_id}: {error}")
        self.save_pending(skill_id, evidence, str(error))
        return False

    def save_pending(self, skill_id: str, evidence: dict[str, Any], recording_error: str) -> Path:
        return runtime_evidence.save_pending(self.pending_dir, skill_id, evidence, recording_error)

    def _resolve_cli(self, cli: str | None) -> str | None:
        return resolve_cli(cli)

    def _log(self, message: str) -> None:
        try:
            self.kinic_home.mkdir(parents=True, exist_ok=True)
            with self.log_path.open("a") as handle:
                handle.write(f"{int(time.time())} {message}\n")
        except OSError:
            pass
