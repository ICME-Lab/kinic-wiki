"""Where: plugins/hermes/kinic_hermes/client.py
What: kinic-vfs-cli subprocess boundary for Hermes plugin recording.
Why: The plugin stays thin; Kinic CLI owns identity, DB selection, and VFS writes.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
import tempfile
from pathlib import Path
from typing import Any

PLUGIN_ROOT = Path(__file__).resolve().parents[1]
LOCAL_RUNTIME_ROOT = PLUGIN_ROOT
REPO_RUNTIME_ROOT = Path(__file__).resolve().parents[2] / "runtime"
for runtime_root in (LOCAL_RUNTIME_ROOT, REPO_RUNTIME_ROOT):
    if runtime_root.joinpath("kinic_agent_runtime").is_dir() and str(runtime_root) not in sys.path:
        sys.path.insert(0, str(runtime_root))

from kinic_agent_runtime import evidence as runtime_evidence
from kinic_agent_runtime.cli import cli_command, resolve_cli, resolve_runner


class KinicClient:
    def __init__(self, cli: str | None = None) -> None:
        self.kinic_home = Path(os.environ.get("KINIC_HOME", str(Path.home() / ".kinic")))
        self.pending_dir = self.kinic_home / "pending-runs"
        self.projection_dir = self.kinic_home / "hermes-current" / "skills"
        self.log_path = self.kinic_home / "hermes-plugin.log"
        self.cli = self._resolve_cli(cli)
        self.runner = self._resolve_runner()

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

    def create_ready_jobs(self) -> None:
        if not self.cli:
            return
        try:
            subprocess.run(
                self._cli_command("skill", "evolve-jobs", "create-ready", "--json"),
                check=True,
                text=True,
                capture_output=True,
            )
        except subprocess.CalledProcessError as error:
            self._log(f"evolve job creation failed: {error.stderr or error}")

    def prepare_job(self, job_id: str | None) -> dict[str, Any]:
        if not self.runner:
            raise RuntimeError("kinic-skill-evolve not found")
        if not self.cli:
            raise RuntimeError("kinic-vfs-cli not found")
        command = [*self.runner, "prepare-job"]
        if job_id:
            command.append(job_id)
        command.extend(["--cli", self.cli, "--json"])
        result = subprocess.run(command, check=True, text=True, capture_output=True)
        return json.loads(result.stdout)

    def finish_job(self, job_id: str, candidate: str) -> str:
        if not self.runner:
            raise RuntimeError("kinic-skill-evolve not found")
        if not self.cli:
            raise RuntimeError("kinic-vfs-cli not found")
        with tempfile.NamedTemporaryFile("w", suffix=".md", delete=False) as handle:
            handle.write(candidate)
            temp_path = Path(handle.name)
        try:
            result = subprocess.run(
                [
                    *self.runner,
                    "finish-job",
                    job_id,
                    "--candidate-file",
                    str(temp_path),
                    "--cli",
                    self.cli,
                    "--projection-dir",
                    str(self.projection_dir),
                    "--generator",
                    "hermes-plugin",
                    "--llm-route",
                    "hermes-ctx-llm",
                ],
                check=False,
                text=True,
                capture_output=True,
            )
            if result.returncode != 0:
                self._log(f"finish-job returned {result.returncode} for {job_id}: {result.stderr or result.stdout}")
            output = result.stdout.strip()
            if result.stderr.strip():
                output = f"{output}\n{result.stderr.strip()}".strip()
            if not output:
                output = json.dumps({"job_id": job_id, "status": "finish_job_failed", "exit_code": result.returncode})
            return output
        finally:
            temp_path.unlink(missing_ok=True)

    def complete_job(self, job_id: str, status: str, summary: str) -> None:
        if not self.cli:
            raise RuntimeError("kinic-vfs-cli not found")
        subprocess.run(
            self._cli_command(
                "skill",
                "evolve-jobs",
                "complete",
                job_id,
                "--status",
                status,
                "--summary",
                summary[:500],
                "--json",
            ),
            check=True,
            text=True,
            capture_output=True,
        )

    def save_pending(self, skill_id: str, evidence: dict[str, Any], recording_error: str) -> Path:
        return runtime_evidence.save_pending(self.pending_dir, skill_id, evidence, recording_error)

    def _resolve_cli(self, cli: str | None) -> str | None:
        return resolve_cli(cli)

    def _resolve_runner(self) -> list[str] | None:
        runner = resolve_runner()
        if runner:
            return runner
        local_runner = Path(__file__).with_name("evolve.py")
        if local_runner.is_file():
            return [sys.executable, str(local_runner)]
        return None

    def _cli_command(self, *args: str) -> list[str]:
        if not self.cli:
            raise RuntimeError("kinic-vfs-cli not found")
        return cli_command(self.cli, *args)

    def _log(self, message: str) -> None:
        try:
            self.kinic_home.mkdir(parents=True, exist_ok=True)
            with self.log_path.open("a") as handle:
                handle.write(f"{int(time.time())} {message}\n")
        except OSError:
            pass
