"""Where: plugins/hermes/tests/test_plugin.py
What: Unit coverage for Kinic Hermes plugin behavior.
Why: Recording failures must not break Hermes turns and duplicate skill signals must collapse.
"""

from __future__ import annotations

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
sys.path.insert(0, str(PLUGIN_ROOT))
sys.path.insert(0, str(RUNTIME_ROOT))


class HermesKinicPluginTests(unittest.TestCase):
    def test_usage_diff_counts_only_increases(self) -> None:
        from kinic_hermes import usage

        delta = usage.usage_diff(
            {"legal": {"use_count": 1, "view_count": 2}},
            {"legal": {"use_count": 3, "view_count": 1}, "debug": {"patch_count": 1}},
        )
        self.assertEqual(delta, {"legal": {"use_count": 2}, "debug": {"patch_count": 1}})

    def test_usage_diff_ignores_corrupt_counts(self) -> None:
        from kinic_hermes import usage

        delta = usage.usage_diff(
            {"legal": {"use_count": "not-a-number", "view_count": None}},
            {"legal": {"use_count": "2", "view_count": -1, "patch_count": None}},
        )
        self.assertEqual(delta, {"legal": {"use_count": 2}})

    def test_invalid_usage_json_reports_not_ok(self) -> None:
        from kinic_hermes import usage

        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / ".usage.json"
            path.write_text("{")
            self.assertEqual(usage.read_usage_checked(path), ({}, False))

    def test_run_buffer_redacts_and_truncates_raw_capture(self) -> None:
        from kinic_hermes.schemas import RunBuffer, ToolTrace

        buffer = RunBuffer(
            tool_trace=[ToolTrace("http", {"api_key": "secret", "query": "x" * 40}, "Bearer abcdefghijklmnopqrstuvwxyz")],
            final_response=f"ok sk-{'a' * 32}",
        )
        with mock.patch.dict(os.environ, {"KINIC_HERMES_MAX_TOOL_ARGS_CHARS": "24", "KINIC_HERMES_MAX_FINAL_RESPONSE_CHARS": "16"}, clear=False):
            evidence = buffer.to_json("legal-review", {})

        self.assertTrue(evidence["redacted"])
        self.assertTrue(evidence["truncated"])
        self.assertEqual(evidence["tool_trace"][0]["args"], '{"api_key": "[REDACTED]"')
        self.assertNotIn("sk-", evidence["final_response"])
        self.assertEqual(evidence["max_chars"]["tool_args"], 24)

    def test_run_buffer_raw_capture_can_be_disabled(self) -> None:
        from kinic_hermes.schemas import RunBuffer, ToolTrace

        buffer = RunBuffer(
            tool_trace=[ToolTrace("http", {"token": "secret"}, "secret result")],
            final_response="secret final",
        )
        with mock.patch.dict(os.environ, {"KINIC_HERMES_CAPTURE_RAW": "0"}, clear=False):
            evidence = buffer.to_json("legal-review", {})

        self.assertEqual(evidence["tool_trace"], [])
        self.assertEqual(evidence["raw_evidence_excerpt"], "")
        self.assertEqual(evidence["final_response"], "")
        self.assertFalse(evidence["redacted"])
        self.assertFalse(evidence["truncated"])

    def test_run_buffer_caps_tool_trace_items(self) -> None:
        from kinic_hermes.schemas import RunBuffer, ToolTrace

        buffer = RunBuffer(
            tool_trace=[
                ToolTrace(f"browser-step-{index}", {"payload": "x" * 100}, "dom snapshot " + ("y" * 100))
                for index in range(8)
            ],
            final_response="done",
        )
        with mock.patch.dict(os.environ, {"KINIC_HERMES_MAX_TOOL_TRACE_ITEMS": "3"}, clear=False):
            evidence = buffer.to_json("browser-skill", {})

        self.assertEqual(evidence["tool_trace_total"], 8)
        self.assertEqual(evidence["tool_trace_omitted"], 5)
        self.assertEqual([item["name"] for item in evidence["tool_trace"]], ["browser-step-5", "browser-step-6", "browser-step-7"])
        self.assertTrue(evidence["truncated"])
        self.assertEqual(evidence["max_chars"]["tool_trace_items"], 3)

    def test_missing_cli_saves_pending_with_metadata(self) -> None:
        from kinic_hermes import client as client_module

        with tempfile.TemporaryDirectory() as tmp:
            with mock.patch.dict(os.environ, {"KINIC_HOME": tmp}, clear=False):
                client = client_module.KinicClient(cli="/missing/kinic-vfs-cli")
                self.assertFalse(client.record_run("legal-review", {"summary": "x"}))
                pending = list((Path(tmp) / "pending-runs").glob("*.json"))
                self.assertEqual(len(pending), 1)
                payload = json.loads(pending[0].read_text())
                self.assertEqual(payload["schema_version"], 1)
                self.assertEqual(payload["skill_id"], "legal-review")
                self.assertIn("recording_error", payload)
                self.assertIn("recorded_locally_at", payload)
                self.assertEqual(payload["plugin_version"], "0.1.2")

    def test_record_run_does_not_create_ready_jobs(self) -> None:
        from kinic_hermes import client as client_module
        from kinic_agent_runtime import cli as runtime_cli

        completed = subprocess.CompletedProcess(["kinic-vfs-cli"], 0, stdout="{}", stderr="")
        payloads: list[dict] = []

        def fake_run(command, **_kwargs):
            evidence_path = Path(command[command.index("--evidence-json") + 1])
            payloads.append(json.loads(evidence_path.read_text()))
            return completed

        with tempfile.TemporaryDirectory() as tmp:
            with mock.patch.dict(os.environ, {"KINIC_HOME": tmp}, clear=False), mock.patch.object(runtime_cli.subprocess, "run", side_effect=fake_run) as run:
                client = client_module.KinicClient(cli=sys.executable)
                self.assertTrue(client.record_run("legal-review", {"summary": "x", "recorded_by": "wrong-plugin"}))

        command = run.call_args.args[0]
        self.assertEqual(command[0], sys.executable)
        self.assertNotIn("--create-ready-jobs", command)
        self.assertEqual(payloads[0]["recorded_by"], "hermes-plugin")

    def test_record_run_pending_forces_hermes_recorded_by(self) -> None:
        from kinic_hermes import client as client_module

        with tempfile.TemporaryDirectory() as tmp:
            with mock.patch.dict(os.environ, {"KINIC_HOME": tmp}, clear=False):
                client = client_module.KinicClient(cli="/missing/kinic-vfs-cli")
                self.assertFalse(client.record_run("legal-review", {"summary": "x", "recorded_by": "wrong-plugin"}))
                pending = list((Path(tmp) / "pending-runs").glob("*.json"))

            self.assertEqual(len(pending), 1)
            self.assertEqual(json.loads(pending[0].read_text())["recorded_by"], "hermes-plugin")

    def test_runtime_record_run_file_injects_recorded_by_without_mutating_source(self) -> None:
        from kinic_agent_runtime import cli as runtime_cli
        from kinic_agent_runtime import evidence as runtime_evidence

        completed = subprocess.CompletedProcess(["kinic-vfs-cli"], 0, stdout="{}", stderr="")
        payloads: list[dict] = []

        def fake_run(command, **_kwargs):
            evidence_path = Path(command[command.index("--evidence-json") + 1])
            payloads.append(json.loads(evidence_path.read_text()))
            return completed

        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "evidence.json"
            source.write_text(json.dumps({"summary": "x", "recorded_by": "wrong-plugin"}))
            with mock.patch.object(runtime_cli.subprocess, "run", side_effect=fake_run):
                runtime_evidence.record_run_file("kinic-vfs-cli", "legal-review", source, "codex-plugin")
                runtime_evidence.record_run_file("kinic-vfs-cli", "legal-review", source, "claude-code-plugin")

            self.assertEqual(json.loads(source.read_text()), {"summary": "x", "recorded_by": "wrong-plugin"})

        self.assertEqual([payload["recorded_by"] for payload in payloads], ["codex-plugin", "claude-code-plugin"])

    def test_agent_record_run_scripts_pass_resolved_cli(self) -> None:
        script_cases = [
            (PLUGIN_ROOT.parent / "codex/scripts/record-run.sh", "codex-plugin"),
            (PLUGIN_ROOT.parent / "claude-code/scripts/record-run.sh", "claude-code-plugin"),
        ]
        for script, recorded_by in script_cases:
            with self.subTest(script=script):
                with tempfile.TemporaryDirectory() as tmp:
                    root = Path(tmp)
                    runtime = root / "runtime"
                    package = runtime / "kinic_agent_runtime"
                    package.mkdir(parents=True)
                    (package / "__init__.py").write_text("")
                    (package / "evidence.py").write_text(
                        "import json, os, sys\n"
                        "with open(os.environ['KINIC_CAPTURE_ARGS'], 'w') as handle:\n"
                        "    json.dump(sys.argv, handle)\n"
                    )
                    fake_cli = root / "kinic-vfs-cli"
                    fake_cli.write_text("#!/usr/bin/env bash\nexit 0\n")
                    fake_cli.chmod(0o755)
                    evidence = root / "evidence.json"
                    evidence.write_text(json.dumps({"summary": "x"}))
                    capture = root / "argv.json"
                    env = {
                        **os.environ,
                        "KINIC_AGENT_RUNTIME_ROOT": str(runtime),
                        "KINIC_VFS_CLI": str(fake_cli),
                        "KINIC_CAPTURE_ARGS": str(capture),
                        "PATH": "/usr/bin:/bin",
                    }

                    result = subprocess.run(
                        ["/bin/bash", str(script), "legal-review", str(evidence)],
                        check=False,
                        text=True,
                        capture_output=True,
                        env=env,
                    )

                    self.assertEqual(result.returncode, 0, result.stderr)
                    argv = json.loads(capture.read_text())
                    self.assertIn("--cli", argv)
                    self.assertEqual(argv[argv.index("--cli") + 1], str(fake_cli))
                    self.assertEqual(argv[argv.index("--recorded-by") + 1], recorded_by)

    def test_claude_session_hook_uses_exec_form_for_plugin_script(self) -> None:
        hook_path = PLUGIN_ROOT.parent / "claude-code/hooks/hooks.json"
        config = json.loads(hook_path.read_text())
        hook = config["hooks"]["SessionEnd"][0]["hooks"][0]

        self.assertEqual(hook["type"], "command")
        self.assertEqual(hook["command"], "${CLAUDE_PLUGIN_ROOT}/scripts/record-session.sh")
        self.assertEqual(hook["args"], [])
        self.assertTrue(hook["async"])
        self.assertNotIn("timeout", hook)

    def test_codex_session_hook_uses_stop_without_async(self) -> None:
        hook_path = PLUGIN_ROOT.parent / "codex/hooks/hooks.json"
        config = json.loads(hook_path.read_text())
        hook = config["hooks"]["Stop"][0]["hooks"][0]

        self.assertEqual(hook["type"], "command")
        self.assertIn("record-session.sh", hook["command"])
        self.assertEqual(hook["timeout"], 10)
        self.assertNotIn("async", hook)

    def test_codex_record_session_script_passes_resolved_cli(self) -> None:
        script = PLUGIN_ROOT.parent / "codex/scripts/record-session.sh"
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            runtime = root / "runtime"
            package = runtime / "kinic_agent_runtime"
            package.mkdir(parents=True)
            (package / "__init__.py").write_text("")
            (package / "session.py").write_text(
                "import json, os, sys\n"
                "with open(os.environ['KINIC_CAPTURE_ARGS'], 'w') as handle:\n"
                "    json.dump(sys.argv, handle)\n"
            )
            fake_cli = root / "kinic-vfs-cli"
            fake_cli.write_text("#!/usr/bin/env bash\nexit 0\n")
            fake_cli.chmod(0o755)
            capture = root / "argv.json"
            env = {
                **os.environ,
                "KINIC_AGENT_RUNTIME_ROOT": str(runtime),
                "KINIC_VFS_CLI": str(fake_cli),
                "KINIC_CAPTURE_ARGS": str(capture),
                "PATH": "/usr/bin:/bin",
            }

            result = subprocess.run(
                ["/bin/bash", str(script)],
                input=json.dumps({"session_id": "s", "transcript_path": "/tmp/t.jsonl"}),
                check=False,
                text=True,
                capture_output=True,
                env=env,
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            argv = json.loads(capture.read_text())
            self.assertIn("record-codex-session", argv)
            self.assertIn("--cli", argv)
            self.assertEqual(argv[argv.index("--cli") + 1], str(fake_cli))

    def test_allow_non_ii_env_adds_cli_flag(self) -> None:
        from kinic_hermes import client as client_module
        from kinic_agent_runtime import cli as runtime_cli

        completed = subprocess.CompletedProcess(["kinic-vfs-cli"], 0, stdout="{}", stderr="")
        with tempfile.TemporaryDirectory() as tmp:
            with mock.patch.dict(os.environ, {"KINIC_HOME": tmp, "KINIC_VFS_CLI_ALLOW_NON_II": "1"}, clear=False), mock.patch.object(runtime_cli.subprocess, "run", return_value=completed) as run:
                client = client_module.KinicClient(cli=sys.executable)
                self.assertTrue(client.record_run("legal-review", {"summary": "x"}))

        command = run.call_args.args[0]
        self.assertEqual(command[:2], [sys.executable, "--allow-non-ii-identity"])

    def test_allow_non_ii_env_unset_keeps_cli_shape(self) -> None:
        from kinic_hermes import client as client_module
        from kinic_agent_runtime import cli as runtime_cli

        completed = subprocess.CompletedProcess(["kinic-vfs-cli"], 0, stdout="{}", stderr="")
        with tempfile.TemporaryDirectory() as tmp:
            with mock.patch.dict(os.environ, {"KINIC_HOME": tmp}, clear=False), mock.patch.object(runtime_cli.subprocess, "run", return_value=completed) as run:
                client = client_module.KinicClient(cli=sys.executable)
                self.assertTrue(client.record_run("legal-review", {"summary": "x"}))

        command = run.call_args.args[0]
        self.assertEqual(command[0], sys.executable)
        self.assertNotIn("--allow-non-ii-identity", command)

    def test_skill_view_and_usage_diff_record_one_run(self) -> None:
        import kinic_hermes as plugin_module

        with tempfile.TemporaryDirectory() as tmp:
            hermes_home = Path(tmp) / "hermes"
            usage_path = hermes_home / "skills" / ".usage.json"
            usage_path.parent.mkdir(parents=True)
            usage_path.write_text(json.dumps({"legal-review": {"use_count": 1}}))
            with mock.patch.dict(os.environ, {"HERMES_HOME": str(hermes_home)}, clear=False):
                plugin = plugin_module.KinicPlugin()
                records: list[tuple[str, dict]] = []
                plugin.client = mock.Mock()
                plugin.client.record_run.side_effect = lambda skill_id, evidence: records.append((skill_id, evidence))
                plugin.post_tool_call("skill_view", {"name": "legal-review"}, "viewed", 10)
                usage_path.write_text(json.dumps({"legal-review": {"use_count": 2}}))
                plugin.post_llm_call()
                self.assertEqual(len(records), 1)
                self.assertEqual(records[0][0], "legal-review")
                self.assertEqual(records[0][1]["usage_delta"], {"use_count": 1})
                self.assertEqual(records[0][1]["agent_outcome"], "unknown")

    def test_post_llm_call_logs_pending_recording(self) -> None:
        import kinic_hermes as plugin_module

        with tempfile.TemporaryDirectory() as tmp:
            hermes_home = Path(tmp) / "hermes"
            usage_path = hermes_home / "skills" / ".usage.json"
            usage_path.parent.mkdir(parents=True)
            usage_path.write_text(json.dumps({"legal-review": {"use_count": 1}}))
            with mock.patch.dict(os.environ, {"HERMES_HOME": str(hermes_home)}, clear=False):
                plugin = plugin_module.KinicPlugin()
                plugin.ctx = mock.Mock(llm=mock.Mock(complete=mock.Mock()))
                plugin.client = mock.Mock()
                plugin.client.record_run.return_value = False

                plugin.post_tool_call("skill_view", {"name": "legal-review"}, "viewed", 10)
                usage_path.write_text(json.dumps({"legal-review": {"use_count": 2}}))
                plugin.post_llm_call()

        plugin.client._log.assert_called_with("run recording saved pending evidence")

    def test_agent_skill_docs_record_run_only(self) -> None:
        cases = [
            PLUGIN_ROOT.parent / "codex/skills/kinic-record-skill-run/SKILL.md",
            PLUGIN_ROOT.parent / "claude-code/skills/kinic-record-skill-run/SKILL.md",
        ]
        for path in cases:
            with self.subTest(path=path):
                content = path.read_text()
                self.assertIn("record-run", content)
                self.assertNotIn("kinic-evolve-skill-job", content)
                self.assertNotIn("queued evolution job", content)

    def test_register_tool_uses_hermes_keyword_api(self) -> None:
        import kinic_hermes as plugin_module

        class Ctx:
            def __init__(self) -> None:
                self.tools: list[dict] = []
                self.hooks: list[str] = []
                self.commands: dict[str, object] = {}

            def register_hook(self, name, _handler):
                self.hooks.append(name)

            def register_tool(self, **kwargs):
                self.tools.append(kwargs)

            def register_command(self, name, handler, _description):
                self.commands[name] = handler

        ctx = Ctx()
        plugin_module.register(ctx)
        self.assertIn("on_session_end", ctx.hooks)
        self.assertNotIn("kinic_evolve_job", ctx.commands)
        self.assertEqual(ctx.tools[0]["name"], "kinic_record_correction")
        self.assertEqual(ctx.tools[0]["toolset"], "kinic")
        self.assertIn("schema", ctx.tools[0])
        self.assertIn("handler", ctx.tools[0])


if __name__ == "__main__":
    unittest.main()
