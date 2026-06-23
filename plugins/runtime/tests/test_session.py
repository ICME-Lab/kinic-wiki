"""Where: plugins/runtime/tests/test_session.py
What: Regression tests for Claude SessionEnd capture rendering.
Why: Raw session sources must stay compact and redact secrets before local persistence.
"""

import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from kinic_agent_runtime import session


class SessionCaptureTests(unittest.TestCase):
    def test_redacts_text_metadata_tool_input_and_result(self) -> None:
        payload = {
            "session_id": "s1",
            "source": "Bearer abcdefghijklmnopqrstuvwxyz",
            "transcript": [
                {
                    "role": "assistant",
                    "content": "api_key=secret-value",
                    "tool_name": "shell",
                    "tool_input": {"token": "open-sesame", "cmd": "echo ok"},
                    "tool_result": "password=hunter2",
                }
            ],
        }
        rendered = session.render_session_source(payload)
        text = json.dumps(rendered)
        self.assertIn("[REDACTED]", text)
        self.assertNotIn("secret-value", text)
        self.assertNotIn("open-sesame", text)
        self.assertNotIn("hunter2", text)
        self.assertTrue(rendered["redacted"])

    def test_large_tool_result_uses_head_tail_compaction(self) -> None:
        payload = {
            "session_id": "s2",
            "transcript": [{"role": "tool", "tool_name": "run", "tool_result": "a" * 50 + "TAIL"}],
        }
        with mock.patch.dict(os.environ, {"KINIC_SESSION_MAX_TOOL_RESULT_CHARS": "20"}):
            rendered = session.render_session_source(payload)
        self.assertIn("omitted", rendered["content"])
        self.assertIn("TAIL", rendered["content"])
        self.assertTrue(rendered["truncated"])
        self.assertEqual(rendered["tool_result_refs"][0]["tool"], "run")
        self.assertNotIn("hash", json.dumps(rendered).lower())

    def test_final_content_size_cap_and_pending_save(self) -> None:
        payload = {"session_id": "s/3", "transcript": [{"role": "user", "content": "x" * 1000}]}
        with tempfile.TemporaryDirectory() as tmp:
            with mock.patch.dict(os.environ, {"KINIC_SESSION_MAX_CONTENT_CHARS": "120"}):
                path = session.save_pending_session(payload, Path(tmp))
            saved = json.loads(path.read_text())
        self.assertLessEqual(len(saved["content"]), 120)
        self.assertTrue(saved["truncated"])
        self.assertEqual(saved["source_kind"], "claude_session_end")
        self.assertTrue(path.name.endswith("s-3.json"))


if __name__ == "__main__":
    unittest.main()
