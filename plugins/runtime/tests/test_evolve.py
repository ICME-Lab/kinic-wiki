"""Where: plugins/runtime/tests/test_evolve.py
What: Regression tests for skill evolution frontmatter helpers.
Why: Job metadata parsing gates proposal application and source evidence reads.
"""

import unittest

from kinic_agent_runtime import evolve


class EvolveParsingTests(unittest.TestCase):
    def test_frontmatter_uses_whole_line_terminator(self) -> None:
        content = "---\nstatus: running\n---not-a-terminator\nskill_id: bad\n---\n# Body\n"
        self.assertEqual(evolve.frontmatter_scalar(content, "skill_id"), "bad")

    def test_frontmatter_unescapes_json_quoted_scalars(self) -> None:
        content = '---\nskill_id: "Skill\\nID"\nsource_runs:\n  - "/Sources/run\\\"1.md"\n---\n# Body\n'
        self.assertEqual(evolve.frontmatter_scalar(content, "skill_id"), "Skill\nID")
        self.assertEqual(evolve.source_runs_from_job(content), ['/Sources/run"1.md'])

    def test_identity_gate_requires_candidate_h1_when_current_has_h1(self) -> None:
        self.assertFalse(evolve.same_declared_identity("# Skill\n", "## Skill\n"))
        self.assertTrue(evolve.same_declared_identity("# Skill\n", "# Skill\n"))


if __name__ == "__main__":
    unittest.main()
