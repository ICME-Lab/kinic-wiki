"""Where: plugins/hermes/tests/test_evolve.py
What: Unit coverage for runner validation and configuration failures.
Why: Hermes calls are costly, so cheap gates should fail locally first.
"""

from __future__ import annotations

import argparse
import contextlib
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


PLUGIN_ROOT = Path(__file__).resolve().parents[1]
RUNTIME_ROOT = PLUGIN_ROOT.parent / "runtime"
sys.path.insert(0, str(RUNTIME_ROOT))
sys.path.insert(0, str(PLUGIN_ROOT))


def load_runner():
    from kinic_agent_runtime import evolve

    return evolve


class KinicSkillEvolveTests(unittest.TestCase):
    def setUp(self) -> None:
        self.runner = load_runner()

    def finish_args(self, candidate: Path, projection_dir: str | None = None) -> argparse.Namespace:
        return argparse.Namespace(
            job_id="job-1",
            candidate_file=str(candidate),
            cli="kinic-vfs-cli",
            projection_dir=projection_dir,
            generator="hermes-plugin",
            llm_route="hermes-ctx-llm",
        )

    def test_gate_rejects_empty_candidate(self) -> None:
        gate = self.runner.validate_candidate("# Current\n", "")
        self.assertFalse(gate["passed"])
        self.assertFalse(gate["non_empty"])

    def test_gate_rejects_missing_heading(self) -> None:
        gate = self.runner.validate_candidate("Current text", "plain text")
        self.assertFalse(gate["passed"])
        self.assertFalse(gate["markdown_heading"])

    def test_gate_rejects_extreme_shortening(self) -> None:
        gate = self.runner.validate_candidate("# Current\n" + ("body\n" * 20), "# New\n")
        self.assertFalse(gate["passed"])

    def test_gate_rejects_frontmatter_loss(self) -> None:
        gate = self.runner.validate_candidate("---\nname: x\n---\n# Current\n", "# Candidate\nMore text")
        self.assertFalse(gate["passed"])
        self.assertFalse(gate["frontmatter_preserved"])

    def test_gate_accepts_markdown_candidate(self) -> None:
        candidate = "---\nname: x\n---\n# Current\nUse evidence carefully.\n"
        gate = self.runner.validate_candidate("---\nname: x\n---\n# Current\nOld text.\n", candidate)
        self.assertTrue(gate["passed"])

    def test_oldest_queued_job_id_uses_oldest_updated_at(self) -> None:
        jobs = {
            "jobs": [
                {"job_id": "new", "path": "/Wiki/skill-evolution-jobs/new.md", "updated_at": 20},
                {"job_id": "old", "path": "/Wiki/skill-evolution-jobs/old.md", "updated_at": 10},
            ]
        }
        with mock.patch.object(self.runner, "run_cli", return_value=json.dumps(jobs)):
            self.assertEqual(self.runner.oldest_queued_job_id("kinic-vfs-cli"), "old")

    def test_run_cli_adds_allow_non_ii_flag_from_env(self) -> None:
        from kinic_agent_runtime import cli as runtime_cli

        with mock.patch.dict(os.environ, {"KINIC_VFS_CLI_ALLOW_NON_II": "1"}, clear=False):
            self.assertEqual(runtime_cli.cli_command("kinic-vfs-cli", "status"), ["kinic-vfs-cli", "--allow-non-ii-identity", "status"])

    def test_run_cli_keeps_default_command_shape(self) -> None:
        from kinic_agent_runtime import cli as runtime_cli

        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertEqual(runtime_cli.cli_command("kinic-vfs-cli", "status"), ["kinic-vfs-cli", "status"])

    def test_prepare_job_claims_and_builds_messages_without_route_config(self) -> None:
        with mock.patch.object(self.runner, "oldest_queued_job_id", return_value="job-1"), mock.patch.object(self.runner, "claim_job", return_value={"status": "running", "skill_id": "legal-review", "path": "/Wiki/skill-evolution-jobs/job-1.md"}), mock.patch.object(self.runner, "read_node") as read_node, mock.patch.object(self.runner, "read_run_paths", return_value=[{"path": "run.md", "content": "run evidence"}]), mock.patch.object(self.runner, "read_corrections", return_value=[{"path": "correction.md", "content": "fix this first"}]):
            read_node.side_effect = [
                {"content": "---\nsource_runs:\n  - run.md\n---\n# Job\n", "etag": "j1"},
                {"content": "# Legal Review\nOld guidance.\n", "etag": "s1"},
            ]

            prepared = self.runner.prepare_job("kinic-vfs-cli")

        self.assertEqual(prepared["job_id"], "job-1")
        self.assertEqual(prepared["skill_id"], "legal-review")
        serialized = json.dumps(prepared)
        self.assertNotIn("provider", serialized)
        self.assertNotIn("model", serialized)
        self.assertNotIn("API key", serialized)
        prompt = prepared["messages"][1]["content"]
        self.assertLess(prompt.index("corrections_priority"), prompt.index("source_runs"))
        self.assertIn("Return the full candidate SKILL.md only", prepared["messages"][0]["content"])

    def test_write_proposal_records_hermes_plugin_route(self) -> None:
        writes: dict[str, str] = {}

        def capture_write(_cli: str, path: str, content: str) -> None:
            writes[path] = content

        with mock.patch.object(self.runner, "ensure_folders"), mock.patch.object(self.runner, "write_node", capture_write):
            result = self.runner.write_proposal(
                "kinic-vfs-cli",
                "/Wiki/skills",
                "legal-review",
                "proposal-1",
                {"etag": "e1", "content": "# Legal Review\nOld guidance.\n"},
                "# Legal Review\nBetter guidance.\n",
                [{"path": "/Sources/skill-runs/legal-review/run.md", "content": "worked"}],
                [],
            )

        metrics = json.loads(writes["/Wiki/skills/legal-review/proposals/proposal-1/metrics.json"])
        self.assertEqual(metrics["llm_route"], "hermes-ctx-llm")
        self.assertEqual(metrics["generator"], "hermes-plugin")
        self.assertNotIn("provider", metrics)
        self.assertNotIn("model", metrics)
        self.assertEqual(metrics["heading_consistency_gate"], "pass")
        self.assertNotIn("semantic_drift_gate", metrics)
        self.assertTrue(result["gate_passed"])

    def test_new_proposal_id_includes_job_timestamp_and_random_suffix(self) -> None:
        with mock.patch.object(self.runner.time, "time", return_value=123.456), mock.patch.object(self.runner.secrets, "token_hex", return_value="abcdef"):
            self.assertEqual(self.runner.new_proposal_id("job/one"), "job-one-123456-abcdef")

    def test_write_proposal_records_codex_plugin_route(self) -> None:
        writes: dict[str, str] = {}

        def capture_write(_cli: str, path: str, content: str) -> None:
            writes[path] = content

        with mock.patch.object(self.runner, "ensure_folders"), mock.patch.object(self.runner, "write_node", capture_write):
            self.runner.write_proposal(
                "kinic-vfs-cli",
                "/Wiki/skills",
                "legal-review",
                "proposal-1",
                {"etag": "e1", "content": "# Legal Review\nOld guidance.\n"},
                "# Legal Review\nBetter guidance.\n",
                [{"path": "/Sources/skill-runs/legal-review/run.md", "content": "worked"}],
                [],
                generator="codex-plugin",
                llm_route="codex-skill",
            )

        metrics = json.loads(writes["/Wiki/skills/legal-review/proposals/proposal-1/metrics.json"])
        self.assertEqual(metrics["llm_route"], "codex-skill")
        self.assertEqual(metrics["generator"], "codex-plugin")

    def test_finish_job_reads_candidate_file(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            candidate = Path(tmp) / "candidate.md"
            candidate.write_text("# Legal Review\nBetter guidance.\n")
            args = self.finish_args(candidate)
            with mock.patch.object(self.runner, "read_node") as read_node, mock.patch.object(self.runner, "read_run_paths", return_value=[{"path": "run.md", "content": "worked"}]), mock.patch.object(self.runner, "read_corrections", return_value=[]), mock.patch.object(self.runner, "write_proposal", return_value={"gate_passed": True, "output": {"proposal_id": "p1"}}), mock.patch.object(self.runner, "run_cli", side_effect=[json.dumps({"status": "auto_applied"}), "{}"]):
                read_node.side_effect = [
                    {"content": "---\nstatus: running\nskill_id: legal-review\nsource_runs:\n  - run.md\n---\n# Job\n", "etag": "j1"},
                    {"content": "# Legal Review\nOld guidance.\n", "etag": "s1"},
                ]
                self.assertEqual(self.runner.finish_job_command(args), 0)

    def test_finish_job_forwards_projection_dir_to_apply(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            candidate = Path(tmp) / "candidate.md"
            candidate.write_text("# Legal Review\nBetter guidance.\n")
            args = self.finish_args(candidate, projection_dir="/projection")
            with mock.patch.object(self.runner, "read_node") as read_node, mock.patch.object(self.runner, "read_run_paths", return_value=[{"path": "run.md", "content": "worked"}]), mock.patch.object(self.runner, "read_corrections", return_value=[]), mock.patch.object(self.runner, "write_proposal", return_value={"gate_passed": True, "output": {"proposal_id": "p1"}}), mock.patch.object(self.runner, "run_cli", return_value=json.dumps({"status": "auto_applied"})) as run_cli, mock.patch.object(self.runner, "complete_job"):
                read_node.side_effect = [
                    {"content": "---\nstatus: running\nskill_id: legal-review\nsource_runs:\n  - run.md\n---\n# Job\n", "etag": "j1"},
                    {"content": "# Legal Review\nOld guidance.\n", "etag": "s1"},
                ]

                self.assertEqual(self.runner.finish_job_command(args), 0)

        run_cli.assert_called_once_with("kinic-vfs-cli", "skill", "apply-proposal", "legal-review", mock.ANY, "--job-id", "job-1", "--json", "--projection-dir", "/projection")

    def test_finish_job_treats_sync_failed_apply_as_done_with_warning(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            candidate = Path(tmp) / "candidate.md"
            candidate.write_text("# Legal Review\nBetter guidance.\n")
            args = self.finish_args(candidate)
            applied = {"status": "auto_applied_sync_failed", "sync_error": "projection unavailable"}
            with mock.patch.object(self.runner, "read_node") as read_node, mock.patch.object(self.runner, "read_run_paths", return_value=[{"path": "run.md", "content": "worked"}]), mock.patch.object(self.runner, "read_corrections", return_value=[]), mock.patch.object(self.runner, "write_proposal", return_value={"gate_passed": True, "output": {"proposal_id": "p1"}}), mock.patch.object(self.runner, "run_cli", return_value=json.dumps(applied)), mock.patch.object(self.runner, "complete_job") as complete_job:
                read_node.side_effect = [
                    {"content": "---\nstatus: running\nskill_id: legal-review\nsource_runs:\n  - run.md\n---\n# Job\n", "etag": "j1"},
                    {"content": "# Legal Review\nOld guidance.\n", "etag": "s1"},
                ]
                stdout = io.StringIO()
                with contextlib.redirect_stdout(stdout):
                    self.assertEqual(self.runner.finish_job_command(args), 0)
                payload = json.loads(stdout.getvalue())
                self.assertEqual(payload["apply"]["status"], "auto_applied_sync_failed")
                self.assertEqual(payload["job_status"], "done")
                complete_job.assert_called_once_with("kinic-vfs-cli", "job-1", "done", "remote apply succeeded; local_projection_sync_failed: projection unavailable")

    def test_finish_job_treats_gate_failed_apply_as_failed(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            candidate = Path(tmp) / "candidate.md"
            candidate.write_text("# Legal Review\nBetter guidance.\n")
            args = self.finish_args(candidate)
            applied = {"status": "gate_failed", "error": "permission_gate"}
            with mock.patch.object(self.runner, "read_node") as read_node, mock.patch.object(self.runner, "read_run_paths", return_value=[{"path": "run.md", "content": "worked"}]), mock.patch.object(self.runner, "read_corrections", return_value=[]), mock.patch.object(self.runner, "write_proposal", return_value={"gate_passed": True, "output": {"proposal_id": "p1"}}), mock.patch.object(self.runner, "run_cli", return_value=json.dumps(applied)), mock.patch.object(self.runner, "complete_job") as complete_job:
                read_node.side_effect = [
                    {"content": "---\nstatus: running\nskill_id: legal-review\nsource_runs:\n  - run.md\n---\n# Job\n", "etag": "j1"},
                    {"content": "# Legal Review\nOld guidance.\n", "etag": "s1"},
                ]
                self.assertEqual(self.runner.finish_job_command(args), 3)
                complete_job.assert_called_once_with("kinic-vfs-cli", "job-1", "failed", "apply status: gate_failed; error: permission_gate")

    def test_finish_job_treats_unknown_apply_status_as_failed(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            candidate = Path(tmp) / "candidate.md"
            candidate.write_text("# Legal Review\nBetter guidance.\n")
            args = self.finish_args(candidate)
            with mock.patch.object(self.runner, "read_node") as read_node, mock.patch.object(self.runner, "read_run_paths", return_value=[{"path": "run.md", "content": "worked"}]), mock.patch.object(self.runner, "read_corrections", return_value=[]), mock.patch.object(self.runner, "write_proposal", return_value={"gate_passed": True, "output": {"proposal_id": "p1"}}), mock.patch.object(self.runner, "run_cli", return_value=json.dumps({"status": "surprise"})), mock.patch.object(self.runner, "complete_job") as complete_job:
                read_node.side_effect = [
                    {"content": "---\nstatus: running\nskill_id: legal-review\nsource_runs:\n  - run.md\n---\n# Job\n", "etag": "j1"},
                    {"content": "# Legal Review\nOld guidance.\n", "etag": "s1"},
                ]
                self.assertEqual(self.runner.finish_job_command(args), 3)
                complete_job.assert_called_once_with("kinic-vfs-cli", "job-1", "failed", "apply status: surprise")

    def test_finish_job_preserves_original_failure_when_complete_fails(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            candidate = Path(tmp) / "candidate.md"
            candidate.write_text("# Legal Review\nBetter guidance.\n")
            args = self.finish_args(candidate)
            with mock.patch.object(self.runner, "read_node") as read_node, mock.patch.object(self.runner, "read_run_paths", return_value=[{"path": "run.md", "content": "worked"}]), mock.patch.object(self.runner, "read_corrections", return_value=[]), mock.patch.object(self.runner, "write_proposal", return_value={"gate_passed": True, "output": {"proposal_id": "p1"}}), mock.patch.object(self.runner, "run_cli", return_value="not json"), mock.patch.object(self.runner, "complete_job", side_effect=RuntimeError("complete failed")):
                read_node.side_effect = [
                    {"content": "---\nstatus: running\nskill_id: legal-review\nsource_runs:\n  - run.md\n---\n# Job\n", "etag": "j1"},
                    {"content": "# Legal Review\nOld guidance.\n", "etag": "s1"},
                ]
                stderr = io.StringIO()
                with contextlib.redirect_stderr(stderr):
                    self.assertEqual(self.runner.finish_job_command(args), 3)
                self.assertIn("Expecting value", stderr.getvalue())
                self.assertIn("failed to complete job job-1 as failed: complete failed", stderr.getvalue())

    def test_finish_job_returns_nonzero_when_apply_succeeds_but_complete_fails(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            candidate = Path(tmp) / "candidate.md"
            candidate.write_text("# Legal Review\nBetter guidance.\n")
            args = self.finish_args(candidate)
            with mock.patch.object(self.runner, "read_node") as read_node, mock.patch.object(self.runner, "read_run_paths", return_value=[{"path": "run.md", "content": "worked"}]), mock.patch.object(self.runner, "read_corrections", return_value=[]), mock.patch.object(self.runner, "write_proposal", return_value={"gate_passed": True, "output": {"proposal_id": "p1"}}), mock.patch.object(self.runner, "run_cli", return_value=json.dumps({"status": "auto_applied"})), mock.patch.object(self.runner, "complete_job", side_effect=RuntimeError("complete failed")):
                read_node.side_effect = [
                    {"content": "---\nstatus: running\nskill_id: legal-review\nsource_runs:\n  - run.md\n---\n# Job\n", "etag": "j1"},
                    {"content": "# Legal Review\nOld guidance.\n", "etag": "s1"},
                ]
                stdout = io.StringIO()
                with contextlib.redirect_stdout(stdout):
                    self.assertEqual(self.runner.finish_job_command(args), 3)
                payload = json.loads(stdout.getvalue())
                self.assertEqual(payload["job_status"], "done")
                self.assertIn("completion_error", payload)

    def test_finish_job_gate_fail_completes_failed(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            candidate = Path(tmp) / "candidate.md"
            candidate.write_text("plain text")
            args = self.finish_args(candidate)
            with mock.patch.object(self.runner, "read_node") as read_node, mock.patch.object(self.runner, "read_run_paths", return_value=[{"path": "run.md", "content": "worked"}]), mock.patch.object(self.runner, "read_corrections", return_value=[]), mock.patch.object(self.runner, "write_proposal", return_value={"gate_passed": False, "output": {"proposal_id": "p1"}}), mock.patch.object(self.runner, "complete_job") as complete_job, mock.patch.object(self.runner, "run_cli") as run_cli:
                read_node.side_effect = [
                    {"content": "---\nstatus: running\nskill_id: legal-review\nsource_runs:\n  - run.md\n---\n# Job\n", "etag": "j1"},
                    {"content": "# Legal Review\nOld guidance.\n", "etag": "s1"},
                ]
                self.assertEqual(self.runner.finish_job_command(args), 3)
                complete_job.assert_called_once_with("kinic-vfs-cli", "job-1", "failed", "proposal gate failed")
                run_cli.assert_not_called()

    def test_ensure_folders_fails_on_mkdir_error(self) -> None:
        failed = subprocess.CompletedProcess(
            ["kinic-vfs-cli", "mkdir-node"],
            1,
            stdout="",
            stderr="permission denied",
        )
        with mock.patch.object(self.runner.subprocess, "run", return_value=failed):
            with self.assertRaisesRegex(RuntimeError, "mkdir-node failed for /Wiki/skills: permission denied"):
                self.runner.ensure_folders("kinic-vfs-cli", ["/Wiki/skills"])

    def test_frontmatter_helpers_read_top_level_job_fields(self) -> None:
        content = (
            "---\n"
            "kind: job\n"
            "metadata:\n"
            "  status: ignored\n"
            "status: running\n"
            "skill_id: legal-review\n"
            "source_runs:\n"
            "  - \"/Sources/skill-runs/legal-review/run-1.md\"\n"
            "  - /Sources/skill-runs/legal-review/run-2.md\n"
            "---\n"
            "# Job\n"
        )
        self.assertEqual(self.runner.frontmatter_scalar(content, "status"), "running")
        self.assertEqual(self.runner.skill_id_from_job_content(content), "legal-review")
        self.assertEqual(
            self.runner.source_runs_from_job(content),
            [
                "/Sources/skill-runs/legal-review/run-1.md",
                "/Sources/skill-runs/legal-review/run-2.md",
            ],
        )

    def test_hermes_evolve_shim_uses_shared_runtime_main(self) -> None:
        from kinic_hermes import evolve as shim

        self.assertIs(shim.main, self.runner.main)


if __name__ == "__main__":
    unittest.main()
