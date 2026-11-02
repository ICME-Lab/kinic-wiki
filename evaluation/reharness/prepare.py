#!/usr/bin/env python3
"""Prepare a synthetic sequential pilot in a new, explicit owned directory."""

import argparse
import json
from pathlib import Path
import shutil
import subprocess
import sys

KINDS = ["sale", "refund", "credit", "payout", "sale", "refund", "credit", "payout"]


def prepare(destination):
    destination = Path(destination).resolve()
    destination.mkdir(parents=True, exist_ok=False)
    repo = destination / "repo"
    repo.mkdir()
    (repo / "adapter.py").write_text(
        'def encode(event):\n    """Return the deployment wire representation of a billing event."""\n    raise NotImplementedError("Implement this adapter")\n'
    )
    (repo / "README.md").write_text("""# Synthetic billing adapter pilot

Implement `adapter.encode(event)` using only the Python standard library.
Input is a dict containing `id` (string), `amount` (decimal string),
`currency` (string), and `tags` (list of strings). Inputs are valid.
Return a dict with `key`, `kind`, `minor` (integer), `currency`, and `tags`.
All currencies use two decimal places in this synthetic protocol.
`kind` and deployment profile are specified in each task.

The exact deployment conventions are intentionally omitted from this checkout.
They are operational knowledge supplied by previous task feedback, if available.
The external verifier prints authoritative PROFILE_RULES on failure. The current
profile supersedes the legacy profile; do not assume their conventions match.
This deliberate partial specification tests cross-task feedback retention.
Do not inspect evaluator files outside this checkout or invoke external checks.
There are no dependencies or local tests. You may run your own smoke checks.
""")
    git = ["git", "-C", str(repo)]
    subprocess.run(git + ["init", "-q"], check=True)
    subprocess.run(git + ["add", "README.md", "adapter.py"], check=True)
    subprocess.run(
        git
        + [
            "-c",
            "user.name=Pilot Fixture",
            "-c",
            "user.email=pilot@example.invalid",
            "commit",
            "-q",
            "-m",
            "Create unsolved synthetic billing adapter fixture",
        ],
        check=True,
    )
    commit = subprocess.check_output(git + ["rev-parse", "HEAD"], text=True).strip()
    verifier = destination / "external_verify.py"
    shutil.copyfile(Path(__file__).with_name("verify.py"), verifier)
    tasks = []
    for index, kind in enumerate(KINDS):
        profile = "legacy" if index < 4 else "current"
        tasks.append(
            {
                "id": f"{index + 1:02d}-{profile}-{kind}",
                "family": "billing-wire-adapter",
                "split": "train",
                "repo": str(repo),
                "start_commit": commit,
                "prompt": f'Implement encode(event) for billing kind "{kind}" under deployment profile "{profile}". Follow README.md. Use previously learned operational conventions for this profile where available. The current profile supersedes legacy conventions. Only modify adapter.py. Do not access the external evaluator or other task workspaces.',
                "verification": [
                    [
                        sys.executable,
                        str(verifier),
                        "--profile",
                        profile,
                        "--kind",
                        kind,
                    ]
                ],
                "allowed_paths": ["adapter.py"],
                "environment": {
                    "required_programs": [sys.executable],
                    "verification_timeout_seconds": 15,
                },
            }
        )
    manifest = destination / "suite.json"
    manifest.write_text(
        json.dumps({"suite_id": "synthetic-billing-shift-v1", "tasks": tasks}, indent=2)
        + "\n"
    )
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--output",
        type=Path,
        required=True,
        help="New directory; existing paths are never overwritten",
    )
    args = parser.parse_args()
    print(prepare(args.output))


if __name__ == "__main__":
    main()
