#!/usr/bin/env python3
"""Behavioral oracle kept outside all exported agent workspaces."""
import importlib.util
import json
from pathlib import Path
import sys

workspace = Path(sys.argv[1]).resolve()
case_id = sys.argv[2]
cases_file = Path(sys.argv[3]) if len(sys.argv) > 3 else Path(__file__).parent.parent / "synthetic_cases.json"
cases = json.loads(cases_file.read_text())
case = next(case for case in cases if case["id"] == case_id)
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("policy", workspace / "policy.py")
policy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(policy)
for record, expected in case["cases"]:
    actual = policy.decide(record)
    assert actual == expected, f"{case_id}: {record!r}: got {actual!r}, expected {expected!r}"
