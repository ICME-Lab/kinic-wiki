"""Where: plugins/runtime/tests/test_session.py
What: Regression tests for Claude Code session source capture.
Why: SessionEnd hooks must retain evidence without leaking obvious secrets.
"""

import json
import os
import stat
import tempfile
import unittest
from unittest import mock
from pathlib import Path
import sys


RUNTIME_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RUNTIME_ROOT))

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

        expected_source_id = session.source_id_for_session(
            "abc/../session",
            transcript,
            "2024-05-01T00:00:00.123Z",
        )
        self.assertEqual(source.path, f"/Sources/sessions/claudecode/{expected_source_id}.md")
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

    def test_redacts_common_secret_key_names(self) -> None:
        for key in [
            "access_token",
            "refresh_token",
            "id_token",
            "auth_token",
            "client_secret",
            "session_cookie",
            "x_api_key",
        ]:
            with self.subTest(key=key):
                redacted, changed = session.redact_value({key: "shortfixture"})

                self.assertTrue(changed)
                self.assertEqual(redacted[key], session.REDACTED)

    def test_build_source_redacts_common_raw_secret_shapes(self) -> None:
        # GitHub push protection rejects committed Slack token-shaped fixtures.
        # Keep coverage by assembling the exact raw shape only at test runtime.
        slack_token = "".join(
            [
                "xo",
                "xb",
                "-",
                "123456789012",
                "-",
                "123456789012",
                "-",
                "abcdefghijklmnopqrstuv",
            ]
        )
        secrets = [
            "AKIAIOSFODNN7EXAMPLE",
            "ASIAIOSFODNN7EXAMPLE",
            "ghp_abcdefghijklmnopqrstuvwxyz1234567890",
            "github_pat_abcdefghijklmnopqrstuvwxyz_1234567890",
            slack_token,
            "-----BEGIN OPENSSH PRIVATE KEY-----\nopenssh-private\n-----END OPENSSH PRIVATE KEY-----",
            "-----BEGIN PRIVATE KEY-----\npem-private\n-----END PRIVATE KEY-----",
        ]
        with tempfile.TemporaryDirectory() as tmp:
            transcript = Path(tmp) / "session.jsonl"
            transcript.write_text(
                json.dumps(
                    {
                        "type": "user",
                        "message": {
                            "role": "user",
                            "content": "\n".join(secrets),
                        },
                    }
                )
            )
            hook = session.HookInput("session-raw-secrets", transcript, "/repo", "exit")

            source = session.build_source(hook)

        self.assertTrue(source.metadata["redacted"])
        for leaked in secrets:
            self.assertNotIn(leaked, source.content)
        self.assertNotIn("openssh-private", source.content)
        self.assertNotIn("pem-private", source.content)
        self.assertIn(session.REDACTED, source.content)

    def test_redacts_dot_separated_api_key_in_raw_text(self) -> None:
        redacted_text, changed = session.redact('api.key=short-secret\n{"api.key": "json-secret"}')

        self.assertTrue(changed)
        self.assertIn("api.key=[REDACTED]", redacted_text)
        self.assertIn('"api.key": "[REDACTED]"', redacted_text)
        self.assertNotIn("short-secret", redacted_text)
        self.assertNotIn("json-secret", redacted_text)

    def test_build_source_redacts_common_secret_key_names_in_tool_io(self) -> None:
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
                                            "id": "toolu_secret",
                                            "name": "Fetch",
                                            "input": {
                                                "access_token": "short-access",
                                                "refresh_token": "short-refresh",
                                                "id_token": "short-id",
                                                "auth_token": "short-auth",
                                                "client_secret": "short-client",
                                                "session_cookie": "short-cookie",
                                                "x_api_key": "short-key",
                                            },
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
                                            "tool_use_id": "toolu_secret",
                                            "content": "client_secret=result-client\naccess_token=result-access\napi.key=result-api-key",
                                        }
                                    ],
                                },
                            }
                        ),
                    ]
                )
            )
            hook = session.HookInput("session-common-secrets", transcript, "/repo", "exit")

            source = session.build_source(hook)
            pending = session.save_pending(Path(tmp) / "pending", source, now_ms=1)
            pending_payload = pending.read_text()

        self.assertTrue(source.metadata["redacted"])
        for leaked in [
            "short-access",
            "short-refresh",
            "short-id",
            "short-auth",
            "short-client",
            "short-cookie",
            "short-key",
            "result-client",
            "result-access",
            "result-api-key",
        ]:
            self.assertNotIn(leaked, source.content)
            self.assertNotIn(leaked, pending_payload)
        self.assertIn('"access_token": "[REDACTED]"', source.content)
        self.assertIn('"client_secret": "[REDACTED]"', source.content)

    def test_save_pending_uses_owner_only_permissions(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            pending_dir = Path(tmp) / "pending"
            pending_dir.mkdir(mode=0o755)
            pending_dir.chmod(0o755)
            source = session.SourcePayload(
                "/Sources/sessions/claudecode/session.md",
                "# Session\n",
                {"provider": "claude-code"},
            )
            old_umask = os.umask(0o022)
            try:
                pending = session.save_pending(pending_dir, source, now_ms=1)
            finally:
                os.umask(old_umask)
            payload = json.loads(pending.read_text())

            self.assertEqual(stat.S_IMODE(pending_dir.stat().st_mode), 0o700)
            self.assertEqual(stat.S_IMODE(pending.stat().st_mode), 0o600)
            self.assertEqual(payload["path"], "/Sources/sessions/claudecode/session.md")
            self.assertEqual(payload["content"], "# Session\n")

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
        expected_source_id = session.source_id_for_session(
            "sess-token=abc123456789012345",
            transcript,
            "2024-05-01T00:00:00.123Z",
        )
        self.assertEqual(source.path, f"/Sources/sessions/claudecode/{expected_source_id}.md")
        for leaked in [
            "abc123456789012345",
            "meta-secret-value-123",
            "metaBearerSecret123",
            "pathsecret1234567890",
        ]:
            self.assertNotIn(leaked, source.content)
            self.assertNotIn(leaked, source.path)
            self.assertNotIn(leaked, pending_content)

    def test_build_source_avoids_source_path_collision_for_redacted_session_ids(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            transcript = root / "session.jsonl"
            transcript.write_text(json.dumps({"type": "user", "message": {"role": "user", "content": "hello"}}))

            first = session.build_source(
                session.HookInput("sess-token=firstsecret1234567890", transcript, "/repo", "exit"),
                now_ms=1_714_521_600_123,
            )
            second = session.build_source(
                session.HookInput("sess-token=secondsecret1234567890", transcript, "/repo", "exit"),
                now_ms=1_714_521_600_123,
            )

        self.assertNotEqual(first.path, second.path)
        self.assertNotIn("firstsecret1234567890", first.path)
        self.assertNotIn("secondsecret1234567890", second.path)
        self.assertEqual(first.metadata["session_id"], "sess-token=[REDACTED]")
        self.assertEqual(second.metadata["session_id"], "sess-token=[REDACTED]")

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

    def test_build_source_streams_transcript_lines_without_read_text(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            transcript = Path(tmp) / "session.jsonl"
            transcript.write_text(
                "\n".join(
                    [
                        json.dumps({"type": "user", "message": {"role": "user", "content": "first"}}),
                        json.dumps({"type": "assistant", "message": {"role": "assistant", "content": "second"}}),
                    ]
                )
            )
            hook = session.HookInput("session-streaming", transcript, "/repo", "exit")

            with mock.patch.object(Path, "read_text", side_effect=AssertionError("read_text called")):
                source = session.build_source(hook)

        self.assertEqual(source.metadata["message_count"], 2)
        self.assertIn("first", source.content)
        self.assertIn("second", source.content)

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

    def test_record_session_saves_current_pending_before_flushing_old_pending(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            pending_dir = root / "pending"
            pending_dir.mkdir()
            old_pending = pending_dir / "1-old.json"
            old_pending.write_text(
                json.dumps(
                    {
                        "path": "/Sources/sessions/claudecode/old.md",
                        "content": "# Old\n",
                        "metadata_json": "{}",
                    }
                )
            )
            transcript = root / "session.jsonl"
            transcript.write_text(json.dumps({"type": "user", "message": {"role": "user", "content": "hello"}}))
            fake_cli = root / "kinic-vfs-cli"
            calls = root / "calls.jsonl"
            fake_cli.write_text(
                "#!/usr/bin/env bash\n"
                "python3 - \"$@\" <<'PY'\n"
                "import json, sys\n"
                "args = sys.argv[1:]\n"
                "path = args[args.index('--path') + 1]\n"
                f"with open({str(calls)!r}, 'a') as handle: handle.write(json.dumps(path) + '\\n')\n"
                "PY\n"
            )
            fake_cli.chmod(0o755)
            hook = json.dumps(
                {"session_id": "session-current", "transcript_path": str(transcript), "cwd": "/repo", "reason": "exit"}
            )

            result = session.record_session(hook, str(fake_cli), pending_dir, now_ms=1000)

            paths = [json.loads(line) for line in calls.read_text().splitlines()]
            expected_current = (
                "/Sources/sessions/claudecode/"
                + session.source_id_for_session("session-current", transcript, "1970-01-01T00:00:01.000Z")
                + ".md"
            )
            self.assertTrue(result["recorded"])
            self.assertEqual(
                paths,
                [
                    "/Sources/sessions",
                    "/Sources/sessions/claudecode",
                    expected_current,
                    "/Sources/sessions",
                    "/Sources/sessions/claudecode",
                    "/Sources/sessions/claudecode/old.md",
                ],
            )
            self.assertFalse(old_pending.exists())

    def test_record_session_reports_success_when_current_pending_cleanup_fails(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            pending_dir = root / "pending"
            pending_dir.mkdir()
            old_pending = pending_dir / "1-old.json"
            old_pending.write_text(
                json.dumps(
                    {
                        "path": "/Sources/sessions/claudecode/old.md",
                        "content": "# Old\n",
                        "metadata_json": "{}",
                    }
                )
            )
            transcript = root / "session.jsonl"
            transcript.write_text(json.dumps({"type": "user", "message": {"role": "user", "content": "hello"}}))
            current_source_id = session.source_id_for_session(
                "session-current",
                transcript,
                "1970-01-01T00:00:01.000Z",
            )
            current_pending = pending_dir / f"1000-{current_source_id}.json"
            current_recorded = pending_dir / f"{current_pending.name}.recorded"
            fake_cli = root / "kinic-vfs-cli"
            calls = root / "calls.jsonl"
            fake_cli.write_text(
                "#!/usr/bin/env bash\n"
                "python3 - \"$@\" <<'PY'\n"
                "import json, sys\n"
                "args = sys.argv[1:]\n"
                "path = args[args.index('--path') + 1]\n"
                f"with open({str(calls)!r}, 'a') as handle: handle.write(json.dumps(path) + '\\n')\n"
                "PY\n"
            )
            fake_cli.chmod(0o755)
            hook = json.dumps(
                {"session_id": "session-current", "transcript_path": str(transcript), "cwd": "/repo", "reason": "exit"}
            )
            original_unlink = Path.unlink

            def unlink_with_current_failure(path: Path, *args: object, **kwargs: object) -> None:
                if path == current_pending:
                    raise OSError("current pending cleanup failed")
                original_unlink(path, *args, **kwargs)

            with mock.patch.object(Path, "unlink", unlink_with_current_failure):
                result = session.record_session(hook, str(fake_cli), pending_dir, now_ms=1000)

            paths = [json.loads(line) for line in calls.read_text().splitlines()]

            self.assertTrue(result["recorded"])
            self.assertIn("current pending cleanup failed", result["cleanup_error"])
            self.assertEqual(result["flushed_pending"], 1)
            self.assertEqual(result["failed_pending"], 0)
            self.assertEqual(result["invalid_pending"], 0)
            self.assertEqual(
                paths,
                [
                    "/Sources/sessions",
                    "/Sources/sessions/claudecode",
                    f"/Sources/sessions/claudecode/{current_source_id}.md",
                    "/Sources/sessions",
                    "/Sources/sessions/claudecode",
                    "/Sources/sessions/claudecode/old.md",
                ],
            )
            self.assertFalse(current_pending.exists())
            self.assertTrue(current_recorded.is_file())
            self.assertFalse(old_pending.exists())

    def test_record_session_skips_old_pending_flush_when_current_write_fails(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            pending_dir = root / "pending"
            pending_dir.mkdir()
            invalid = pending_dir / "1-bad.json"
            invalid.write_text("{bad")
            transcript = root / "session.jsonl"
            transcript.write_text(json.dumps({"type": "user", "message": {"role": "user", "content": "hello"}}))
            fake_cli = root / "kinic-vfs-cli"
            fake_cli.write_text("#!/usr/bin/env bash\nexit 3\n")
            fake_cli.chmod(0o755)
            hook = json.dumps({"session_id": "session-1", "transcript_path": str(transcript), "cwd": "/repo", "reason": "exit"})

            result = session.record_session(hook, str(fake_cli), pending_dir, now_ms=1000)

            current_pending = Path(result["pending_path"])
            self.assertFalse(result["recorded"])
            self.assertTrue(current_pending.is_file())
            self.assertTrue(invalid.is_file())
            self.assertFalse((pending_dir / "1-bad.json.invalid").exists())
            self.assertEqual(result["invalid_pending"], 0)

    def test_record_session_leaves_old_pending_when_current_cli_fails(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            pending_dir = root / "pending"
            pending_dir.mkdir()
            old_pending = pending_dir / "1-old.json"
            old_pending.write_text(
                json.dumps(
                    {
                        "path": "/Sources/sessions/claudecode/old.md",
                        "content": "# Old\n",
                        "metadata_json": "{}",
                    }
                )
            )
            transcript = root / "session.jsonl"
            transcript.write_text(json.dumps({"type": "user", "message": {"role": "user", "content": "hello"}}))
            fake_cli = root / "kinic-vfs-cli"
            calls = root / "calls.jsonl"
            fake_cli.write_text(
                "#!/usr/bin/env bash\n"
                "python3 - \"$@\" <<'PY'\n"
                "import json, sys\n"
                "args = sys.argv[1:]\n"
                "path = args[args.index('--path') + 1]\n"
                f"with open({str(calls)!r}, 'a') as handle: handle.write(json.dumps(path) + '\\n')\n"
                "if args[0] == 'write-node': sys.exit(7)\n"
                "PY\n"
            )
            fake_cli.chmod(0o755)
            hook = json.dumps({"session_id": "session-1", "transcript_path": str(transcript), "cwd": "/repo", "reason": "exit"})

            result = session.record_session(hook, str(fake_cli), pending_dir, now_ms=1000)

            paths = [json.loads(line) for line in calls.read_text().splitlines()]
            self.assertFalse(result["recorded"])
            self.assertEqual(paths[:2], ["/Sources/sessions", "/Sources/sessions/claudecode"])
            self.assertEqual(len(paths), 3)
            self.assertTrue(old_pending.is_file())
            self.assertEqual(result["flushed_pending"], 0)
            self.assertEqual(result["failed_pending"], 0)

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

    def test_build_codex_source_reads_transcript_and_skips_reasoning_ciphertext(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            transcript = root / "codex.jsonl"
            transcript.write_text(
                "\n".join(
                    [
                        json.dumps(
                            {
                                "type": "session_meta",
                                "payload": {"id": "codex-session", "cwd": "/repo"},
                            }
                        ),
                        json.dumps(
                            {
                                "type": "event_msg",
                                "payload": {
                                    "type": "user_message",
                                    "message": "hello token=abc123456789012345",
                                },
                            }
                        ),
                        json.dumps(
                            {
                                "type": "response_item",
                                "payload": {
                                    "type": "reasoning",
                                    "encrypted_content": "ciphertext-secret",
                                    "summary": [],
                                },
                            }
                        ),
                        json.dumps(
                            {
                                "type": "response_item",
                                "payload": {
                                    "type": "function_call",
                                    "call_id": "call_1",
                                    "name": "Bash",
                                    "arguments": json.dumps({"command": "echo ok", "api_key": "tool-secret"}),
                                },
                            }
                        ),
                        json.dumps(
                            {
                                "type": "response_item",
                                "payload": {
                                    "type": "function_call_output",
                                    "call_id": "call_1",
                                    "output": "authorization=Bearer output-secret-value",
                                },
                            }
                        ),
                        json.dumps(
                            {
                                "type": "event_msg",
                                "payload": {"type": "agent_message", "message": "done"},
                            }
                        ),
                    ]
                )
            )
            hook = session.HookInput("codex-session", transcript, "/repo", "Stop")

            source = session.build_codex_source(hook, now_ms=1_714_521_600_123)

        expected_source_id = session.source_id_for_session(
            "codex-session",
            transcript,
            "2024-05-01T00:00:00.123Z",
        )
        self.assertEqual(source.path, f"/Sources/sessions/codex/{expected_source_id}.md")
        self.assertEqual(source.metadata["provider"], "codex")
        self.assertTrue(source.metadata["redacted"])
        self.assertIn("# Raw Codex Session", source.content)
        self.assertIn('- provider: "codex"', source.content)
        self.assertIn("[tool_use: Bash]", source.content)
        self.assertIn("done", source.content)
        self.assertNotIn("ciphertext-secret", source.content)
        self.assertNotIn("abc123456789012345", source.content)
        self.assertNotIn("tool-secret", source.content)
        self.assertNotIn("output-secret-value", source.content)

    def test_record_codex_session_keeps_pending_when_cli_fails(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            transcript = root / "codex.jsonl"
            transcript.write_text(
                json.dumps(
                    {
                        "type": "event_msg",
                        "payload": {
                            "type": "user_message",
                            "message": "hello token=abc123456789012345",
                        },
                    }
                )
            )
            fake_cli = root / "kinic-vfs-cli"
            fake_cli.write_text("#!/usr/bin/env bash\nexit 3\n")
            fake_cli.chmod(0o755)
            hook = json.dumps(
                {
                    "session_id": "codex-session",
                    "transcript_path": str(transcript),
                    "cwd": "/repo",
                    "hook_event_name": "Stop",
                }
            )

            result = session.record_codex_session(hook, str(fake_cli), root / "pending", now_ms=1000)

            pending = Path(result["pending_path"])
            pending_payload = json.loads(pending.read_text())
            self.assertFalse(result["recorded"])
            self.assertTrue(pending.is_file())
            self.assertEqual(pending_payload["kind"], "codex_session_source")
            self.assertEqual(pending_payload["path"].split("/")[3], "codex")
            self.assertNotIn("abc123456789012345", pending_payload["content"])

    def test_record_codex_session_creates_codex_parent_folders_before_write(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            transcript = root / "codex.jsonl"
            transcript.write_text(
                json.dumps(
                    {
                        "type": "event_msg",
                        "payload": {"type": "user_message", "message": "hello"},
                    }
                )
            )
            fake_cli = root / "kinic-vfs-cli"
            calls = root / "calls.jsonl"
            fake_cli.write_text(
                "#!/usr/bin/env bash\n"
                "python3 - \"$@\" <<'PY'\n"
                "import json, sys\n"
                "args = sys.argv[1:]\n"
                "path = args[args.index('--path') + 1]\n"
                f"with open({str(calls)!r}, 'a') as handle: handle.write(json.dumps(path) + '\\n')\n"
                "PY\n"
            )
            fake_cli.chmod(0o755)
            hook = json.dumps(
                {
                    "session_id": "codex-session",
                    "transcript_path": str(transcript),
                    "cwd": "/repo",
                    "hook_event_name": "Stop",
                }
            )

            result = session.record_codex_session(hook, str(fake_cli), root / "pending", now_ms=1000)

            expected_source_id = session.source_id_for_session(
                "codex-session",
                transcript,
                "1970-01-01T00:00:01.000Z",
            )
            paths = [json.loads(line) for line in calls.read_text().splitlines()]
            self.assertTrue(result["recorded"])
            self.assertEqual(
                paths,
                [
                    "/Sources/sessions",
                    "/Sources/sessions/codex",
                    f"/Sources/sessions/codex/{expected_source_id}.md",
                ],
            )

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
                        "path": "/Sources/sessions/claudecode/session.md",
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
                "args = sys.argv[1:]\n"
                "path = args[args.index('--path') + 1]\n"
                "record = {'command': args[0], 'path': path, 'args': args}\n"
                f"with open({str(calls)!r}, 'a') as handle: handle.write(json.dumps(record) + '\\n')\n"
                "PY\n"
            )
            fake_cli.chmod(0o755)

            flushed = session.flush_pending(str(fake_cli), pending_dir)

            self.assertEqual(len(flushed), 1)
            self.assertFalse(pending.exists())
            records = [json.loads(line) for line in calls.read_text().splitlines()]
            self.assertEqual(
                [(record["command"], record["path"]) for record in records],
                [
                    ("mkdir-node", "/Sources/sessions"),
                    ("mkdir-node", "/Sources/sessions/claudecode"),
                    ("write-node", "/Sources/sessions/claudecode/session.md"),
                ],
            )
            argv = records[-1]["args"]
            self.assertIn("write-node", argv)
            self.assertIn("--kind", argv)
            self.assertIn("source", argv)

    def test_flush_pending_quarantines_invalid_file_and_continues(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            pending_dir = root / "pending"
            pending_dir.mkdir()
            invalid = pending_dir / "1-bad.json"
            invalid.write_text("{bad")
            good = pending_dir / "2-good.json"
            good.write_text(
                json.dumps(
                    {
                        "path": "/Sources/sessions/claudecode/good.md",
                        "content": "# Good\n",
                        "metadata_json": "{}",
                    }
                )
            )
            fake_cli = root / "kinic-vfs-cli"
            calls = root / "calls.txt"
            fake_cli.write_text("#!/usr/bin/env bash\n" f"printf '%s\\n' \"$@\" >> {str(calls)!r}\n")
            fake_cli.chmod(0o755)

            result = session.flush_pending_report(str(fake_cli), pending_dir)

            self.assertEqual(result.flushed, [good])
            self.assertEqual(result.invalid, [pending_dir / "1-bad.json.invalid"])
            self.assertEqual(result.failed, [])
            self.assertFalse(good.exists())
            self.assertFalse(invalid.exists())
            self.assertTrue((pending_dir / "1-bad.json.invalid").is_file())
            self.assertIn("/Sources/sessions/claudecode/good.md", calls.read_text())

    def test_flush_pending_keeps_failed_write_for_retry_and_continues(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            pending_dir = root / "pending"
            pending_dir.mkdir()
            failed = pending_dir / "1-fail.json"
            failed.write_text(
                json.dumps(
                    {
                        "path": "/Sources/sessions/claudecode/fail.md",
                        "content": "# Fail\n",
                        "metadata_json": "{}",
                    }
                )
            )
            good = pending_dir / "2-good.json"
            good.write_text(
                json.dumps(
                    {
                        "path": "/Sources/sessions/claudecode/good.md",
                        "content": "# Good\n",
                        "metadata_json": "{}",
                    }
                )
            )
            fake_cli = root / "kinic-vfs-cli"
            calls = root / "calls.txt"
            fake_cli.write_text(
                "#!/usr/bin/env bash\n"
                "for arg in \"$@\"; do\n"
                "  if [ \"$arg\" = \"/Sources/sessions/claudecode/fail.md\" ]; then exit 7; fi\n"
                "done\n"
                f"printf '%s\\n' \"$@\" >> {str(calls)!r}\n"
            )
            fake_cli.chmod(0o755)

            result = session.flush_pending_report(str(fake_cli), pending_dir)

            self.assertEqual(result.flushed, [good])
            self.assertEqual(result.failed, [failed])
            self.assertEqual(result.invalid, [])
            self.assertFalse(good.exists())
            self.assertTrue(failed.is_file())
            self.assertFalse((pending_dir / "1-fail.json.failed").exists())
            self.assertIn("/Sources/sessions/claudecode/good.md", calls.read_text())

            fake_cli.write_text("#!/usr/bin/env bash\n" f"printf '%s\\n' \"$@\" >> {str(calls)!r}\n")
            result = session.flush_pending_report(str(fake_cli), pending_dir)

            self.assertEqual(result.flushed, [failed])
            self.assertEqual(result.failed, [])
            self.assertFalse(failed.exists())

    def test_flush_pending_quarantines_unlink_failure_and_continues(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            pending_dir = root / "pending"
            pending_dir.mkdir()
            unlink_fail = pending_dir / "1-unlink-fail.json"
            unlink_fail.write_text(
                json.dumps(
                    {
                        "path": "/Sources/sessions/claudecode/unlink-fail.md",
                        "content": "# Unlink fail\n",
                        "metadata_json": "{}",
                    }
                )
            )
            good = pending_dir / "2-good.json"
            good.write_text(
                json.dumps(
                    {
                        "path": "/Sources/sessions/claudecode/good.md",
                        "content": "# Good\n",
                        "metadata_json": "{}",
                    }
                )
            )
            fake_cli = root / "kinic-vfs-cli"
            calls = root / "calls.txt"
            fake_cli.write_text("#!/usr/bin/env bash\n" f"printf '%s\\n' \"$@\" >> {str(calls)!r}\n")
            fake_cli.chmod(0o755)
            original_unlink = Path.unlink

            def unlink_with_failure(path: Path, *args: object, **kwargs: object) -> None:
                if path == unlink_fail:
                    raise OSError("unlink failed")
                original_unlink(path, *args, **kwargs)

            with mock.patch.object(Path, "unlink", unlink_with_failure):
                result = session.flush_pending_report(str(fake_cli), pending_dir)

            self.assertEqual(result.flushed, [good])
            self.assertEqual(result.failed, [pending_dir / "1-unlink-fail.json.failed"])
            self.assertEqual(result.invalid, [])
            self.assertFalse(good.exists())
            self.assertFalse(unlink_fail.exists())
            self.assertTrue((pending_dir / "1-unlink-fail.json.failed").is_file())
            calls_text = calls.read_text()
            self.assertIn("/Sources/sessions/claudecode/unlink-fail.md", calls_text)
            self.assertIn("/Sources/sessions/claudecode/good.md", calls_text)


if __name__ == "__main__":
    unittest.main()
