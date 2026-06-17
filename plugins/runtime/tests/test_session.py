"""Where: plugins/runtime/tests/test_session.py
What: Regression tests for Claude Code session source capture.
Why: SessionEnd hooks must retain evidence without leaking obvious secrets.
"""

import json
import tempfile
import unittest
from pathlib import Path

from kinic_agent_runtime import session


class SessionCaptureTests(unittest.TestCase):
    def test_parse_hook_input_requires_session_and_transcript(self) -> None:
        with self.assertRaisesRegex(ValueError, "session_id"):
            session.parse_hook_input(json.dumps({"transcript_path": "/tmp/t.jsonl"}))

    def test_build_source_reads_transcript_and_redacts_secrets(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            transcript = Path(tmp) / "session.jsonl"
            transcript.write_text(
                "\n".join(
                    [
                        json.dumps({"type": "user", "message": {"role": "user", "content": "hello token=abc123456789012345"}}),
                        json.dumps({"type": "assistant", "message": {"role": "assistant", "content": [{"type": "text", "text": "answer"}]}}),
                        json.dumps({"type": "assistant", "message": {"role": "assistant", "content": [{"type": "tool_use", "name": "Bash", "input": {"command": "ls"}}]}}),
                    ]
                )
            )
            hook = session.HookInput(
                session_id="abc/../session",
                transcript_path=transcript,
                cwd="/repo",
                reason="exit",
            )

            source = session.build_source(hook, now_ms=1_714_521_600_123)

        self.assertEqual(source.path, "/Sources/raw/claudecode/abc-session.md")
        self.assertEqual(source.metadata["message_count"], 3)
        self.assertTrue(source.metadata["redacted"])
        self.assertIn("[REDACTED]", source.content)
        self.assertNotIn("abc123456789012345", source.content)
        self.assertIn("[tool_use: Bash]", source.content)

    def test_build_source_redacts_json_tool_input_secrets(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            transcript = Path(tmp) / "session.jsonl"
            transcript.write_text(
                json.dumps(
                    {
                        "type": "assistant",
                        "message": {
                            "role": "assistant",
                            "content": [
                                {
                                    "type": "tool_use",
                                    "name": "Fetch",
                                    "input": {
                                        "api_key": "abc123-json-secret",
                                        "password": "super-secret",
                                        "authorization": "Bearer real-token-value",
                                        "headers": {
                                            "authorization": ["Basic nested-auth-secret"],
                                        },
                                        "credentials": {
                                            "password": {"value": "nested-password-secret"},
                                        },
                                        "url": "https://example.com",
                                    },
                                }
                            ],
                        },
                    }
                )
            )
            hook = session.HookInput("session-json", transcript, "/repo", "exit")

            source = session.build_source(hook)

        self.assertTrue(source.metadata["redacted"])
        self.assertIn('"api_key": "[REDACTED]"', source.content)
        self.assertIn('"password": "[REDACTED]"', source.content)
        self.assertIn('"authorization": "[REDACTED]"', source.content)
        self.assertNotIn("abc123-json-secret", source.content)
        self.assertNotIn("super-secret", source.content)
        self.assertNotIn("Bearer real-token-value", source.content)
        self.assertNotIn("nested-auth-secret", source.content)
        self.assertNotIn("nested-password-secret", source.content)

    def test_build_source_redacts_hook_metadata_before_saving(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            transcript = root / "session-token=pathsecret1234567890.jsonl"
            transcript.write_text(json.dumps({"type": "user", "message": {"role": "user", "content": "hello"}}))
            hook = session.HookInput(
                session_id="sess-token=abc123456789012345",
                transcript_path=transcript,
                cwd="/repo?token=meta-secret-value-123",
                reason="Bearer metaBearerSecret123",
            )

            source = session.build_source(hook, now_ms=1_714_521_600_123)
            pending = session.save_pending(root / "pending", source, now_ms=1)
            pending_content = pending.read_text()

        self.assertTrue(source.metadata["redacted"])
        self.assertEqual(source.path, "/Sources/raw/claudecode/sess-token-REDACTED.md")
        for leaked in [
            "abc123456789012345",
            "meta-secret-value-123",
            "metaBearerSecret123",
            "pathsecret1234567890",
        ]:
            self.assertNotIn(leaked, source.content)
            self.assertNotIn(leaked, source.path)
            self.assertNotIn(leaked, pending_content)

    def test_build_source_marks_truncated_content(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            transcript = Path(tmp) / "session.jsonl"
            transcript.write_text(json.dumps({"type": "user", "message": {"role": "user", "content": "x" * 200}}))
            hook = session.HookInput("session-1", transcript, "/repo", "exit")

            source = session.build_source(hook, max_chars=80)

        self.assertTrue(source.metadata["truncated"])
        self.assertIn("[truncated]", source.content)

    def test_record_session_keeps_pending_when_cli_fails(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            transcript = root / "session.jsonl"
            transcript.write_text(json.dumps({"type": "user", "message": {"role": "user", "content": "hello"}}))
            fake_cli = root / "kinic-vfs-cli"
            fake_cli.write_text("#!/usr/bin/env bash\nexit 3\n")
            fake_cli.chmod(0o755)
            hook = json.dumps({"session_id": "session-1", "transcript_path": str(transcript), "cwd": "/repo", "reason": "exit"})

            result = session.record_session(hook, str(fake_cli), root / "pending", now_ms=1000)

            pending = Path(result["pending_path"])
            self.assertFalse(result["recorded"])
            self.assertTrue(pending.is_file())

    def test_record_session_pending_payload_redacts_json_tool_input_secrets(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            transcript = root / "session.jsonl"
            transcript.write_text(
                json.dumps(
                    {
                        "type": "assistant",
                        "message": {
                            "role": "assistant",
                            "content": [
                                {
                                    "type": "tool_use",
                                    "name": "Fetch",
                                    "input": {
                                        "api_key": "abc123-pending-secret",
                                        "password": "super-secret",
                                        "authorization": "Bearer real-pending-token",
                                        "headers": {
                                            "authorization": ["Basic pending-nested-auth"],
                                        },
                                        "credentials": {
                                            "password": {"value": "pending-nested-password"},
                                        },
                                    },
                                }
                            ],
                        },
                    }
                )
            )
            fake_cli = root / "kinic-vfs-cli"
            fake_cli.write_text("#!/usr/bin/env bash\nexit 3\n")
            fake_cli.chmod(0o755)
            hook = json.dumps({"session_id": "session-1", "transcript_path": str(transcript), "cwd": "/repo", "reason": "exit"})

            result = session.record_session(hook, str(fake_cli), root / "pending", now_ms=1000)

            pending_payload = json.loads(Path(result["pending_path"]).read_text())
            pending_content = pending_payload["content"]
            self.assertNotIn("abc123-pending-secret", pending_content)
            self.assertNotIn("super-secret", pending_content)
            self.assertNotIn("Bearer real-pending-token", pending_content)
            self.assertNotIn("pending-nested-auth", pending_content)
            self.assertNotIn("pending-nested-password", pending_content)
            self.assertIn('"api_key": "[REDACTED]"', pending_content)
            self.assertIn('"password": "[REDACTED]"', pending_content)
            self.assertIn('"authorization": "[REDACTED]"', pending_content)

    def test_runtime_cli_repo_root_points_to_checkout_root(self) -> None:
        from kinic_agent_runtime import cli as runtime_cli

        self.assertTrue((runtime_cli.REPO_ROOT / "Cargo.toml").is_file())
        self.assertTrue((runtime_cli.REPO_ROOT / "plugins/runtime/kinic_agent_runtime/cli.py").is_file())
        self.assertEqual(runtime_cli.REPO_DEBUG_CLI, runtime_cli.REPO_ROOT / "target/debug/kinic-vfs-cli")

    def test_flush_pending_deletes_file_after_successful_write(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            pending_dir = root / "pending"
            pending_dir.mkdir()
            pending = pending_dir / "1-session.json"
            pending.write_text(
                json.dumps(
                    {
                        "path": "/Sources/raw/claudecode/session.md",
                        "content": "# Session\n",
                        "metadata_json": "{}",
                    }
                )
            )
            fake_cli = root / "kinic-vfs-cli"
            calls = root / "calls.json"
            fake_cli.write_text(
                "#!/usr/bin/env bash\n"
                "python3 - \"$@\" <<'PY'\n"
                "import json, sys\n"
                f"open({str(calls)!r}, 'w').write(json.dumps(sys.argv[1:]))\n"
                "PY\n"
            )
            fake_cli.chmod(0o755)

            flushed = session.flush_pending(str(fake_cli), pending_dir)

            self.assertEqual(len(flushed), 1)
            self.assertFalse(pending.exists())
            argv = json.loads(calls.read_text())
            self.assertIn("write-node", argv)
            self.assertIn("--kind", argv)
            self.assertIn("source", argv)


if __name__ == "__main__":
    unittest.main()
