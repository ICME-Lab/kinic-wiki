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
            transcript.write_text(json.dumps({"type": "user", "message": {"role": "user", "content": "x" * 2_000}}))
            hook = session.HookInput("session-1", transcript, "/repo", "exit")

            source = session.build_source(hook, max_chars=800)

        self.assertTrue(source.metadata["truncated"])
        self.assertLessEqual(len(source.content), 800)
        self.assertIn("[truncated: original_chars=", source.content)

    def test_build_source_truncates_large_tool_result_without_dropping_followup(self) -> None:
        large_result = "head-start\n" + ("r" * 12_000) + "\ntail-error"
        with tempfile.TemporaryDirectory() as tmp:
            transcript = Path(tmp) / "session.jsonl"
            transcript.write_text(
                "\n".join(
                    [
                        json.dumps(
                            {
                                "type": "assistant",
                                "message": {
                                    "role": "assistant",
                                    "content": [
                                        {
                                            "type": "tool_use",
                                            "id": "toolu_1",
                                            "name": "Bash",
                                            "input": {"command": "run-big-command"},
                                        }
                                    ],
                                },
                            }
                        ),
                        json.dumps(
                            {
                                "type": "assistant",
                                "message": {
                                    "role": "assistant",
                                    "content": [{"type": "tool_result", "tool_use_id": "toolu_1", "content": large_result}],
                                },
                            }
                        ),
                        json.dumps(
                            {
                                "type": "assistant",
                                "message": {"role": "assistant", "content": "after-large-tool"},
                            }
                        ),
                    ]
                )
            )
            hook = session.HookInput("session-tool-result", transcript, "/repo", "exit")

            source = session.build_source(hook)

        self.assertTrue(source.metadata["truncated"])
        self.assertEqual(source.metadata["truncated_parts"], 1)
        self.assertGreater(source.metadata["omitted_chars"], 0)
        self.assertEqual(source.metadata["tool_result_original_chars"], len(large_result))
        self.assertEqual(source.metadata["tool_result_saved_chars"], session.TOOL_RESULT_HEAD_CHARS + session.TOOL_RESULT_TAIL_CHARS)
        self.assertEqual(source.metadata["tool_result_refs"][0]["tool"], "Bash")
        self.assertEqual(source.metadata["tool_result_refs"][0]["tool_use_id"], "toolu_1")
        self.assertGreater(source.metadata["tool_result_refs"][0]["omitted_chars"], 0)
        self.assertIn("[tool_result: Bash]", source.content)
        self.assertIn('tool_use_id: "toolu_1"', source.content)
        self.assertIn('command: "run-big-command"', source.content)
        self.assertNotIn("sha256", source.content)
        self.assertIn("--- head ---", source.content)
        self.assertIn("--- tail ---", source.content)
        self.assertIn("head-start", source.content)
        self.assertIn("tail-error", source.content)
        self.assertIn("after-large-tool", source.content)
        self.assertNotIn("r" * (session.TOOL_RESULT_HEAD_CHARS + session.TOOL_RESULT_TAIL_CHARS + 1), source.content)

    def test_build_source_keeps_small_tool_result_full(self) -> None:
        small_result = "small result body"
        with tempfile.TemporaryDirectory() as tmp:
            transcript = Path(tmp) / "session.jsonl"
            transcript.write_text(
                "\n".join(
                    [
                        json.dumps(
                            {
                                "type": "assistant",
                                "message": {
                                    "role": "assistant",
                                    "content": [
                                        {
                                            "type": "tool_use",
                                            "id": "toolu_read",
                                            "name": "Read",
                                            "input": {"file_path": "/tmp/a.txt", "offset": 1, "limit": 10},
                                        }
                                    ],
                                },
                            }
                        ),
                        json.dumps(
                            {
                                "type": "assistant",
                                "message": {
                                    "role": "assistant",
                                    "content": [{"type": "tool_result", "tool_use_id": "toolu_read", "content": small_result}],
                                },
                            }
                        ),
                    ]
                )
            )
            hook = session.HookInput("session-small-tool-result", transcript, "/repo", "exit")

            source = session.build_source(hook)

        self.assertFalse(source.metadata["truncated"])
        self.assertEqual(source.metadata["tool_result_original_chars"], len(small_result))
        self.assertEqual(source.metadata["tool_result_saved_chars"], len(small_result))
        self.assertEqual(source.metadata["tool_result_refs"][0]["tool"], "Read")
        self.assertEqual(source.metadata["tool_result_refs"][0]["tool_use_id"], "toolu_read")
        self.assertIn("[tool_result: Read]", source.content)
        self.assertIn('tool_use_id: "toolu_read"', source.content)
        self.assertIn('file_path: "/tmp/a.txt"', source.content)
        self.assertIn("truncated: false", source.content)
        self.assertIn(small_result, source.content)

    def test_build_source_structures_medium_tool_result_without_overlap(self) -> None:
        medium_result = "head\n" + ("m" * 5_000) + "\ntail"
        with tempfile.TemporaryDirectory() as tmp:
            transcript = Path(tmp) / "session.jsonl"
            transcript.write_text(
                json.dumps(
                    {
                        "type": "assistant",
                        "message": {
                            "role": "assistant",
                            "content": [{"type": "tool_result", "name": "unknown", "content": medium_result}],
                        },
                    }
                )
            )
            hook = session.HookInput("session-medium-tool-result", transcript, "/repo", "exit")

            source = session.build_source(hook)

        self.assertFalse(source.metadata["truncated"])
        self.assertEqual(source.metadata["omitted_chars"], 0)
        self.assertEqual(source.metadata["tool_result_saved_chars"], len(medium_result))
        self.assertEqual(source.metadata["tool_result_refs"][0]["saved_chars"], len(medium_result))
        self.assertIn("truncated: false", source.content)
        self.assertNotIn("sha256", source.content)
        self.assertIn("head", source.content)
        self.assertIn("tail", source.content)

    def test_build_source_keeps_structured_bash_result_status_and_output(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            transcript = Path(tmp) / "session.jsonl"
            transcript.write_text(
                "\n".join(
                    [
                        json.dumps(
                            {
                                "type": "assistant",
                                "message": {
                                    "role": "assistant",
                                    "content": [
                                        {
                                            "type": "tool_use",
                                            "id": "toolu_bash_dict",
                                            "name": "Bash",
                                            "input": {"command": "exit 7"},
                                        }
                                    ],
                                },
                            }
                        ),
                        json.dumps(
                            {
                                "type": "assistant",
                                "message": {
                                    "role": "assistant",
                                    "content": [
                                        {
                                            "type": "tool_result",
                                            "tool_use_id": "toolu_bash_dict",
                                            "content": {"exit_code": 7, "stdout": "ok", "stderr": "failed"},
                                        }
                                    ],
                                },
                            }
                        ),
                    ]
                )
            )
            hook = session.HookInput("session-bash-dict", transcript, "/repo", "exit")

            source = session.build_source(hook)

        self.assertIn("[tool_result: Bash]", source.content)
        self.assertIn("status: 7", source.content)
        self.assertIn("exit_code: 7", source.content)
        self.assertIn('tool_use_id: "toolu_bash_dict"', source.content)
        self.assertIn('command: "exit 7"', source.content)
        self.assertIn("--- stdout ---", source.content)
        self.assertIn("--- stderr ---", source.content)
        self.assertIn("failed", source.content)
        self.assertIn("ok", source.content)

    def test_build_source_tool_result_budget_exhaustion_keeps_placeholder(self) -> None:
        result = "z" * 10_000
        with tempfile.TemporaryDirectory() as tmp:
            transcript = Path(tmp) / "session.jsonl"
            lines = []
            for index in range(18):
                lines.append(
                    json.dumps(
                        {
                            "type": "assistant",
                            "message": {
                                "role": "assistant",
                                "content": [{"type": "tool_result", "name": "Search", "content": f"{index}:{result}"}],
                            },
                        }
                    )
                )
            transcript.write_text("\n".join(lines))
            hook = session.HookInput("session-tool-budget", transcript, "/repo", "exit")

            source = session.build_source(hook)

        self.assertTrue(source.metadata["truncated"])
        self.assertIn("budget_exhausted: true", source.content)
        self.assertNotIn("sha256", source.content)
        self.assertGreater(len(source.metadata["tool_result_refs"]), 1)
        self.assertTrue(any(ref["budget_exhausted"] for ref in source.metadata["tool_result_refs"]))
        self.assertGreater(source.metadata["tool_result_original_chars"], source.metadata["tool_result_saved_chars"])

    def test_build_source_redacts_tool_result_before_excerpt(self) -> None:
        raw_result = "Bearer secret-token-value-1234567890\n" + ("x" * 5_000) + "\nfinal"
        with tempfile.TemporaryDirectory() as tmp:
            transcript = Path(tmp) / "session.jsonl"
            transcript.write_text(
                json.dumps(
                    {
                        "type": "assistant",
                        "message": {
                            "role": "assistant",
                            "content": [{"type": "tool_result", "name": "unknown", "content": raw_result}],
                        },
                    }
                )
            )
            hook = session.HookInput("session-tool-secret", transcript, "/repo", "exit")

            source = session.build_source(hook)

        self.assertTrue(source.metadata["redacted"])
        self.assertNotIn("secret-token-value-1234567890", source.content)
        self.assertIn("[REDACTED]", source.content)
        self.assertNotIn("sha256", source.content)
        self.assertNotIn("tool_result_hashes", source.metadata)

    def test_build_source_unknown_tool_result_uses_fallback_policy(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            transcript = Path(tmp) / "session.jsonl"
            transcript.write_text(
                json.dumps(
                    {
                        "type": "assistant",
                        "message": {
                            "role": "assistant",
                            "content": [{"type": "tool_result", "content": "unknown output"}],
                        },
                    }
                )
            )
            hook = session.HookInput("session-unknown-tool", transcript, "/repo", "exit")

            source = session.build_source(hook)

        self.assertIn("[tool_result: unknown]", source.content)

    def test_build_source_truncates_large_tool_input_after_redaction(self) -> None:
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
                                    "name": "Write",
                                    "input": {
                                        "api_key": "abc123-large-input-secret",
                                        "payload": "p" * (session.MAX_TOOL_INPUT_CHARS + 5_000),
                                    },
                                }
                            ],
                        },
                    }
                )
            )
            hook = session.HookInput("session-tool-input", transcript, "/repo", "exit")

            source = session.build_source(hook)

        self.assertTrue(source.metadata["redacted"])
        self.assertTrue(source.metadata["truncated"])
        self.assertEqual(source.metadata["truncated_parts"], 1)
        self.assertIn('"api_key": "[REDACTED]"', source.content)
        self.assertIn("[truncated: original_chars=", source.content)
        self.assertNotIn("abc123-large-input-secret", source.content)
        self.assertNotIn("p" * (session.MAX_TOOL_INPUT_CHARS + 1), source.content)

    def test_build_source_truncates_large_text_part(self) -> None:
        large_text = "t" * (session.MAX_TEXT_PART_CHARS + 5_000)
        with tempfile.TemporaryDirectory() as tmp:
            transcript = Path(tmp) / "session.jsonl"
            transcript.write_text(json.dumps({"type": "user", "message": {"role": "user", "content": large_text}}))
            hook = session.HookInput("session-large-text", transcript, "/repo", "exit")

            source = session.build_source(hook)

        self.assertTrue(source.metadata["truncated"])
        self.assertEqual(source.metadata["truncated_parts"], 1)
        self.assertEqual(source.metadata["omitted_chars"], 5_000)
        self.assertIn("[truncated: original_chars=", source.content)
        self.assertNotIn("t" * (session.MAX_TEXT_PART_CHARS + 1), source.content)

    def test_build_source_redacts_raw_text_secret_before_truncate(self) -> None:
        secret = "sk-" + ("a" * 30)
        large_text = ("x" * (session.MAX_TEXT_PART_CHARS - 6)) + " " + secret
        with tempfile.TemporaryDirectory() as tmp:
            transcript = Path(tmp) / "session.jsonl"
            transcript.write_text(json.dumps({"type": "user", "message": {"role": "user", "content": large_text}}))
            hook = session.HookInput("session-text-boundary-secret", transcript, "/repo", "exit")

            source = session.build_source(hook)

        self.assertTrue(source.metadata["redacted"])
        self.assertTrue(source.metadata["truncated"])
        self.assertNotIn(secret, source.content)
        self.assertNotIn("sk-", source.content)
        self.assertIn("[REDACTED]", source.content)

    def test_build_source_redacts_text_part_secret_before_truncate(self) -> None:
        secret = "sk-" + ("b" * 30)
        large_text = ("y" * (session.MAX_TEXT_PART_CHARS - 6)) + " " + secret
        with tempfile.TemporaryDirectory() as tmp:
            transcript = Path(tmp) / "session.jsonl"
            transcript.write_text(
                json.dumps({"type": "assistant", "message": {"role": "assistant", "content": [{"type": "text", "text": large_text}]}})
            )
            hook = session.HookInput("session-text-part-boundary-secret", transcript, "/repo", "exit")

            source = session.build_source(hook)

        self.assertTrue(source.metadata["redacted"])
        self.assertTrue(source.metadata["truncated"])
        self.assertNotIn(secret, source.content)
        self.assertNotIn("sk-", source.content)
        self.assertIn("[REDACTED]", source.content)

    def test_build_source_redacts_bearer_text_secret_before_truncate(self) -> None:
        secret = "Bearer " + ("c" * 30)
        large_text = ("z" * (session.MAX_TEXT_PART_CHARS - 11)) + " " + secret
        with tempfile.TemporaryDirectory() as tmp:
            transcript = Path(tmp) / "session.jsonl"
            transcript.write_text(json.dumps({"type": "user", "message": {"role": "user", "content": large_text}}))
            hook = session.HookInput("session-bearer-boundary-secret", transcript, "/repo", "exit")

            source = session.build_source(hook)

        self.assertTrue(source.metadata["redacted"])
        self.assertTrue(source.metadata["truncated"])
        self.assertNotIn(secret, source.content)
        self.assertNotIn("Bearer c", source.content)
        self.assertIn("[REDACTED]", source.content)

    def test_build_source_final_cap_still_applies(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            transcript = Path(tmp) / "session.jsonl"
            transcript.write_text(json.dumps({"type": "user", "message": {"role": "user", "content": "x" * 2_000}}))
            hook = session.HookInput("session-final-cap", transcript, "/repo", "exit")

            source = session.build_source(hook, max_chars=800)

        self.assertTrue(source.metadata["truncated"])
        self.assertEqual(source.metadata["truncated_parts"], 1)
        self.assertGreater(source.metadata["omitted_chars"], 0)
        self.assertLessEqual(len(source.content), 800)
        self.assertEqual(source.metadata["saved_chars"], len(source.content))
        self.assertEqual(source.metadata["budget"]["total"]["used"], len(source.content))
        self.assertEqual(source.metadata["budget"]["metadata"]["used"], len(session.render_source_content(source.metadata, "")))
        self.assertIn("[truncated: original_chars=", source.content)

    def test_build_source_hard_caps_tiny_max_chars(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            transcript = Path(tmp) / "session.jsonl"
            transcript.write_text(json.dumps({"type": "user", "message": {"role": "user", "content": "x" * 200}}))
            hook = session.HookInput("session-tiny-cap", transcript, "/repo", "exit")

            source = session.build_source(hook, max_chars=80)

        self.assertLessEqual(len(source.content), 80)
        self.assertEqual(source.metadata["saved_chars"], len(source.content))

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
            self.assertNotIn("sha256", pending_content)
            self.assertNotIn("tool_result_hashes", pending_payload["metadata_json"])
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
