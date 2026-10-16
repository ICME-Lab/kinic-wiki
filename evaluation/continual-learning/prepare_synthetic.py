#!/usr/bin/env python3
"""Materialize a disposable six-category suite without exposing its oracle.

Usage: python3 prepare_synthetic.py /absolute/new/output
This prepares fixtures; it never calls a model or changes the live knowledge store.
"""
import json
import os
from pathlib import Path
import subprocess
import sys

root = Path(sys.argv[1]).resolve()
if str(root).startswith("/private/tmp/"):
    raise SystemExit("choose a project-local output directory, not /private/tmp")
root.mkdir()
repo = root / "source"
repo.mkdir()
(repo / "policy.py").write_text('def decide(record):\n    raise NotImplementedError("Implement the requested policy")\n')
(repo / "README.md").write_text("Implement policy.decide according to the task prompt.\n")
def git(*args):
    return subprocess.check_output(["git", "-C", str(repo), *args], text=True, env={"PATH":os.environ.get("PATH","/usr/bin:/bin"),"GIT_CONFIG_NOSYSTEM":"1","GIT_CONFIG_GLOBAL":"/dev/null"}).strip()
git("init", "--quiet")
git("add", "policy.py", "README.md")
git("-c", "user.name=Evaluation", "-c", "user.email=evaluation@invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "--quiet", "-m", "Synthetic source baseline")
commit = git("rev-parse", "HEAD")
fixtures = Path(__file__).parent.resolve()
cases = json.loads((fixtures / "synthetic_cases.json").read_text())
tasks = []
contexts = {}
for case in cases:
    tasks.append({"id": case["id"], "family": case["family"], "split": case["split"], "repo": str(repo), "start_commit": commit,
                  "prompt": case["prompt"] + " record is a Python dict containing JSON-native values; use mapping key access, not object attributes. JSON null means Python None. Change only policy.py. Use Python standard library.",
                  "verification": [[sys.executable, str(fixtures / "verifiers/synthetic.py"), "{workspace}", case["id"], str(fixtures / "synthetic_cases.json")]],
                  "allowed_paths": ["policy.py"], "environment": {"required_programs": [sys.executable], "verification_timeout_seconds": 10}})
    contexts[case["id"]] = {mode: {"snapshot_id": "synthetic-v1-" + mode, "content": "" if mode == "none" else case[mode]} for mode in ("none", "raw", "current", "revision")}
(root / "suite.json").write_text(json.dumps({"suite_id": "synthetic-six-categories-v1", "tasks": tasks}, indent=2) + "\n")
(root / "contexts.json").write_text(json.dumps(contexts, indent=2) + "\n")
print(root / "suite.json")
