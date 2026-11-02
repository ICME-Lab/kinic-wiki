import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

HERE = Path(__file__).resolve().parent


def load(name):
    spec = importlib.util.spec_from_file_location(name, HERE / (name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class PilotTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.prepare = load("prepare")
        cls.verifier = load("verify")

    def test_oracle_accepts_correct_and_rejects_wrong(self):
        for profile in ("legacy", "current"):
            for kind in ("sale", "refund"):
                with self.subTest(profile=profile, kind=kind):
                    correct = lambda event: self.verifier.expected(event, profile, kind)
                    self.assertEqual(self.verifier.check(correct, profile, kind), [])
                    self.assertTrue(
                        self.verifier.check(lambda event: {}, profile, kind)
                    )
                    other = "current" if profile == "legacy" else "legacy"
                    wrong_profile = lambda event: self.verifier.expected(
                        event, other, kind
                    )
                    self.assertTrue(self.verifier.check(wrong_profile, profile, kind))

    def test_external_verification_and_manifest_boundary(self):
        with tempfile.TemporaryDirectory(dir=HERE) as tmp:
            destination = Path(tmp) / "fixture"
            manifest_path = self.prepare.prepare(destination)
            manifest = json.loads(manifest_path.read_text())
            tasks = manifest["tasks"]
            self.assertEqual(len(tasks), 8)
            self.assertEqual(len({task["id"] for task in tasks}), 8)
            self.assertEqual(len({task["start_commit"] for task in tasks}), 1)
            repo = destination / "repo"
            tracked = subprocess.check_output(
                ["git", "-C", str(repo), "ls-tree", "-r", "--name-only", "HEAD"],
                text=True,
            ).splitlines()
            self.assertEqual(set(tracked), {"README.md", "adapter.py"})
            self.assertEqual(
                subprocess.check_output(
                    ["git", "-C", str(repo), "rev-list", "--count", "HEAD"], text=True
                ).strip(),
                "1",
            )
            for task in tasks:
                self.assertEqual(task["allowed_paths"], ["adapter.py"])
                self.assertEqual(task["split"], "train")
                verifier = Path(task["verification"][0][1])
                self.assertFalse(verifier.is_relative_to(repo))
                failed = subprocess.run(
                    task["verification"][0], cwd=repo, capture_output=True, text=True
                )
                self.assertNotEqual(failed.returncode, 0)
                self.assertIn("PROFILE_RULES", failed.stdout)
            with self.assertRaises(FileExistsError):
                self.prepare.prepare(destination)

    def test_cli_verifier_accepts_independent_solution(self):
        with tempfile.TemporaryDirectory(dir=HERE) as tmp:
            repo = Path(tmp)
            for profile in ("legacy", "current"):
                rounding = "ROUND_HALF_UP" if profile == "legacy" else "ROUND_HALF_EVEN"
                prefix = "acme" if profile == "legacy" else "nova"
                (
                    repo / "adapter.py"
                ).write_text(f'''from decimal import Decimal, {rounding}
def encode(event):
    return {{"key": "{prefix}:" + event["id"].strip(), "kind": "sale", "minor": int((Decimal(event["amount"]) * 100).quantize(Decimal("1"), rounding={rounding})), "currency": event["currency"].upper(), "tags": sorted({{x.strip().lower() for x in event["tags"] if x.strip()}})}}
''')
                result = subprocess.run(
                    [
                        sys.executable,
                        str(HERE / "verify.py"),
                        "--profile",
                        profile,
                        "--kind",
                        "sale",
                    ],
                    cwd=repo,
                    capture_output=True,
                    text=True,
                )
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


class ComparisonTests(unittest.TestCase):
    def test_stream_report_and_phase_aggregation(self):
        driver = load("run_comparison")
        steps = [{"task_id": "a", "success": True, "decision_elapsed_ms": 12}]
        self.assertEqual(driver.sample_rows({"completed": True, "steps": steps}), steps)
        with self.assertRaises(ValueError):
            driver.sample_rows({"completed": False, "steps": steps})
        result = driver.summarize(
            [
                {
                    "policy": "none",
                    "status": "complete",
                    "tasks": 2,
                    "successes": 1,
                    "wall_seconds": 3,
                    "decision_elapsed_ms": 20,
                    "revision_elapsed_ms": 10,
                    "write_elapsed_ms": 4,
                    "model_calls": 2,
                },
                {"policy": "none", "status": "failed"},
            ]
        )["none"]
        self.assertEqual(result["success_rate"], 0.5)
        self.assertEqual(result["mean_decision_ms_per_task"], 10)
        self.assertEqual(result["completed_trials"], 1)

    def test_dry_run_creates_unique_streams_without_cli(self):
        with tempfile.TemporaryDirectory(dir=HERE) as tmp:
            root = Path(tmp)
            manifest = load("prepare").prepare(root / "fixture")
            runner = root / "runner.json"
            runner.write_text("{}")
            result = subprocess.run(
                [
                    sys.executable,
                    str(HERE / "run_comparison.py"),
                    "--cli",
                    str(root / "nonexistent-cli"),
                    "--suite",
                    str(manifest),
                    "--runner-file",
                    str(runner),
                    "--project-id",
                    "0" * 32,
                    "--trials",
                    "2",
                    "--output",
                    str(root / "plan"),
                ],
                capture_output=True,
                text=True,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            report = json.loads((root / "plan" / "comparison.json").read_text())
            self.assertEqual(len(report["runs"]), 8)
            self.assertEqual(len({row["stream_id"] for row in report["runs"]}), 8)
            self.assertTrue(all(row["status"] == "planned" for row in report["runs"]))
            self.assertEqual(report["summary"], {})

    def test_cli_error_codes_are_static_and_bounded(self):
        driver = load("run_comparison")
        for code, patterns in driver.CLI_ERROR_PATTERNS:
            for pattern in patterns:
                with self.subTest(code=code, pattern=pattern):
                    self.assertEqual(
                        driver.classify_cli_error("", "SECRET " + pattern.upper()), code
                    )
                    self.assertEqual(
                        driver.classify_cli_error(pattern + " SECRET", ""), code
                    )
        self.assertEqual(
            driver.classify_cli_error("", "secret unknown diagnostic"),
            "unknown_cli_error",
        )
        self.assertEqual(
            driver.classify_cli_error(
                "", "x" * 40000 + "database cycles are suspended" + "x" * 40000
            ),
            "unknown_cli_error",
        )

    def test_failed_cli_preserves_only_safe_error_code(self):
        self.run_mock_comparison("cli_failure")

    def test_mock_cli_execution_aggregates_report(self):
        self.run_mock_comparison(None)

    def test_configuration_and_report_drift_is_rejected(self):
        for scenario in (
            "runner",
            "suite",
            "embedding",
            "metadata",
            "budget",
            "retrieval",
            "top_k",
        ):
            with self.subTest(scenario=scenario):
                self.run_mock_comparison(scenario)

    def run_mock_comparison(self, scenario):
        # A deterministic mock verifies orchestration only, never model quality.
        with tempfile.TemporaryDirectory(dir=HERE) as tmp:
            root = Path(tmp)
            manifest = load("prepare").prepare(root / "fixture")
            runner = root / "runner.json"
            runner.write_text("{}")
            cli = root / "mock-cli"
            cli.write_text(
                "#!"
                + sys.executable
                + "\n"
                + """import json, pathlib, sys
args = sys.argv
value = lambda flag: args[args.index(flag) + 1]
suite = json.loads(pathlib.Path(value('--suite')).read_text())
out = pathlib.Path(value('--output'))
out.mkdir()
report = {'schema_version': 1, 'completed': True, 'stream_id': value('--stream-id'), 'policy': value('--policy'), 'fidelity': ['mock-only'], 'runner': {'engine': 'codex', 'model': 'mock', 'reasoning_effort': None, 'timeout_seconds': 300}, 'retrieval': value('--retrieval'), 'top_k': int(value('--top-k')), 'steps': [{'task_id': task['id'], 'success': True, 'decision_elapsed_ms': 10, 'revision_elapsed_ms': 2, 'write_elapsed_ms': 1, 'model_calls': 1} for task in suite['tasks']]}
(out / 'report.json').write_text(json.dumps(report))
"""
            )
            if scenario:
                script = cli.read_text()
                if scenario == "cli_failure":
                    script += "\nprint('stdout-secret-token', flush=True)\nprint('database cycles are suspended: db-secret-id; bearer=stderr-secret-token', file=sys.stderr)\nsys.exit(1)\n"
                elif scenario in ("runner", "suite", "embedding"):
                    flag = {
                        "runner": "--runner-file",
                        "suite": "--suite",
                        "embedding": "--embedding-config",
                    }[scenario]
                    script += f"\npath = pathlib.Path(value({flag!r}))\npath.write_text(path.read_text() + ' ')\n"
                else:
                    mutation = {
                        "metadata": "report['runner']['model'] = 'changed-model'",
                        "budget": "report['runner']['timeout_seconds'] = 999",
                        "retrieval": "report['retrieval'] = 'embedding'",
                        "top_k": "report['top_k'] = 999",
                    }[scenario]
                    script += (
                        "\nif value('--policy') == 'reharness':\n    "
                        + mutation
                        + "\n    (out / 'report.json').write_text(json.dumps(report))\n"
                    )
                cli.write_text(script)
            embedding = root / "embedding.json"
            embedding.write_text("{}")
            cli.chmod(0o700)
            result = subprocess.run(
                [
                    sys.executable,
                    str(HERE / "run_comparison.py"),
                    "--cli",
                    str(cli),
                    "--suite",
                    str(manifest),
                    "--runner-file",
                    str(runner),
                    "--project-id",
                    "0" * 32,
                    "--policies",
                    "none",
                    "reharness",
                    "--execute",
                    "--embedding-config",
                    str(embedding),
                    "--output",
                    str(root / "result"),
                ],
                capture_output=True,
                text=True,
            )
            self.assertEqual(result.returncode, 1 if scenario else 0, result.stderr)
            report = json.loads((root / "result" / "comparison.json").read_text())
            self.assertEqual(
                set(report["input_sha256"]), {"runner", "suite", "embedding"}
            )
            if scenario:
                if scenario == "cli_failure":
                    self.assertTrue(
                        all(row["status"] == "failed" for row in report["runs"])
                    )
                    self.assertTrue(
                        all(
                            row["error_code"] == "database_cycles_suspended"
                            for row in report["runs"]
                        )
                    )
                    persisted = (root / "result" / "comparison.json").read_text()
                    for secret in (
                        "stdout-secret-token",
                        "stderr-secret-token",
                        "db-secret-id",
                    ):
                        self.assertNotIn(
                            secret, persisted + result.stdout + result.stderr
                        )
                    self.assertEqual(report["summary"], {})
                elif scenario in ("runner", "suite", "embedding"):
                    self.assertEqual(
                        [row["status"] for row in report["runs"]],
                        ["config-changed", "config-changed"],
                    )
                    self.assertFalse((root / "result" / "trial-1-reharness").exists())
                    self.assertEqual(report["summary"], {})
                else:
                    self.assertEqual(
                        [row["status"] for row in report["runs"]],
                        ["complete", "invalid-report"],
                    )
                    self.assertNotIn("reharness", report["summary"])
                return
            self.assertEqual(report["metadata"]["runner"]["model"], "mock")
            self.assertEqual(report["summary"]["reharness"]["success_rate"], 1)
            self.assertEqual(
                report["summary"]["reharness"]["mean_revision_ms_per_task"], 2
            )
            self.assertIsNone(report["summary"]["reharness"]["input_tokens"])
            self.assertEqual(report["runs"][0]["fidelity"], ["mock-only"])


if __name__ == "__main__":
    unittest.main()
