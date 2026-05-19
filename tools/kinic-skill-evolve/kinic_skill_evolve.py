"""Where: tools/kinic-skill-evolve/kinic_skill_evolve.py
What: Thin Kinic skill evolution runner.
Why: Python owns provider calls while Rust CLI owns VFS, etag, and proposal storage.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path
from typing import Any


def main() -> int:
    parser = argparse.ArgumentParser(prog="kinic-skill-evolve")
    subcommands = parser.add_subparsers(dest="command", required=True)
    evolve = subcommands.add_parser("evolve")
    evolve.add_argument("skill_id")
    evolve.add_argument("--provider", required=True)
    evolve.add_argument("--model", required=True)
    evolve.add_argument("--cli", default=os.environ.get("KINIC_VFS_CLI", "kinic-vfs-cli"))
    evolve.add_argument("--public", action="store_true")
    evolve.add_argument("--run-limit", type=int, default=5)
    evolve.add_argument("--proposal-id")
    args = parser.parse_args()
    if args.command == "evolve":
        return run_evolve(args)
    return 1


def run_evolve(args: argparse.Namespace) -> int:
    if args.provider != "openrouter":
        print("unsupported provider; use --provider openrouter", file=sys.stderr)
        return 2
    api_key = os.environ.get("OPENROUTER_API_KEY")
    if not api_key:
        print("OPENROUTER_API_KEY is required for --provider openrouter", file=sys.stderr)
        return 2

    root = "/Wiki/public-skills" if args.public else "/Wiki/skills"
    skill_path = f"{root}/{args.skill_id}/SKILL.md"
    current = read_node(args.cli, skill_path)
    runs = read_recent_runs(args.cli, args.skill_id, args.run_limit)
    candidate = request_candidate(api_key, args.model, current["content"], runs)
    proposal_id = args.proposal_id or str(int(time.time() * 1000))
    proposal_root = f"{root}/{args.skill_id}/proposals/{proposal_id}"
    ensure_folders(args.cli, [f"{root}/{args.skill_id}/proposals", proposal_root, f"{proposal_root}/candidate"])
    write_node(args.cli, f"{proposal_root}/candidate/SKILL.md", candidate)
    metrics = {
        "schema_version": 1,
        "skill_id": args.skill_id,
        "provider": args.provider,
        "model": args.model,
        "base_etag": current["etag"],
        "source_runs": [run["path"] for run in runs],
        "created_at_ms": int(time.time() * 1000),
        "optimizer": "gepa-compatible-initial",
    }
    write_node(args.cli, f"{proposal_root}/metrics.json", json.dumps(metrics, indent=2))
    print(json.dumps({"skill_id": args.skill_id, "proposal_id": proposal_id, "proposal_root": proposal_root}, indent=2))
    return 0


def run_cli(cli: str, *args: str) -> str:
    result = subprocess.run([cli, *args], check=True, text=True, capture_output=True)
    return result.stdout


def read_node(cli: str, path: str) -> dict[str, Any]:
    output = run_cli(cli, "read-node", "--path", path, "--fields", "content,etag")
    return json.loads(output)


def read_recent_runs(cli: str, skill_id: str, limit: int) -> list[dict[str, str]]:
    output = run_cli(cli, "recent-nodes", "--path", f"/Sources/skill-runs/{skill_id}", "--limit", str(limit), "--json")
    runs = json.loads(output)
    selected: list[dict[str, str]] = []
    for run in runs:
        path = run.get("path", "")
        if not path.endswith(".md") or ".correction." in path:
            continue
        try:
            node = read_node(cli, path)
        except subprocess.CalledProcessError:
            continue
        selected.append({"path": path, "content": node.get("content", "")})
    return selected


def ensure_folders(cli: str, paths: list[str]) -> None:
    for path in paths:
        subprocess.run([cli, "mkdir-node", "--path", path], check=False, text=True, capture_output=True)


def write_node(cli: str, path: str, content: str) -> None:
    with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False) as handle:
        handle.write(content)
        temp_path = Path(handle.name)
    try:
        run_cli(cli, "write-node", "--path", path, "--input", str(temp_path))
    finally:
        temp_path.unlink(missing_ok=True)


def request_candidate(api_key: str, model: str, current_skill: str, runs: list[dict[str, str]]) -> str:
    prompt = {
        "model": model,
        "messages": [
            {
                "role": "system",
                "content": "Improve the supplied SKILL.md using only the run evidence. Return only the full candidate SKILL.md.",
            },
            {
                "role": "user",
                "content": json.dumps({"current_skill": current_skill, "runs": runs}, indent=2),
            },
        ],
    }
    request = urllib.request.Request(
        "https://openrouter.ai/api/v1/chat/completions",
        data=json.dumps(prompt).encode(),
        headers={
            "authorization": f"Bearer {api_key}",
            "content-type": "application/json",
        },
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=120) as response:
        data = json.loads(response.read().decode())
    content = data["choices"][0]["message"]["content"]
    return strip_markdown_fence(content)


def strip_markdown_fence(content: str) -> str:
    text = content.strip()
    if not text.startswith("```"):
        return content
    lines = text.splitlines()
    if lines and lines[0].startswith("```"):
        lines = lines[1:]
    if lines and lines[-1].startswith("```"):
        lines = lines[:-1]
    return "\n".join(lines).strip() + "\n"


if __name__ == "__main__":
    raise SystemExit(main())
