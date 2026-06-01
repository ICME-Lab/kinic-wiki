"""Where: plugins/runtime/kinic_agent_runtime/evolve.py
What: Thin Kinic skill evolution proposal/apply helper.
Why: Agent adapters own LLM generation while this helper owns VFS, etag, and proposal storage.
"""

from __future__ import annotations

import argparse
import difflib
import json
import os
import re
import secrets
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

from .cli import cli_command, run_cli as run_cli_process


def main() -> int:
    parser = argparse.ArgumentParser(prog="kinic-skill-evolve")
    subcommands = parser.add_subparsers(dest="command", required=True)

    prepare_job = subcommands.add_parser("prepare-job")
    prepare_job.add_argument("job_id", nargs="?")
    prepare_job.add_argument("--cli", default=os.environ.get("KINIC_VFS_CLI", "kinic-vfs-cli"))
    prepare_job.add_argument("--json", action="store_true")

    finish_job = subcommands.add_parser("finish-job")
    finish_job.add_argument("job_id")
    finish_job.add_argument("--candidate-file", required=True)
    finish_job.add_argument("--cli", default=os.environ.get("KINIC_VFS_CLI", "kinic-vfs-cli"))
    finish_job.add_argument("--projection-dir")
    finish_job.add_argument("--generator", default="hermes-plugin")
    finish_job.add_argument("--llm-route", default="hermes-ctx-llm")

    sync_local = subcommands.add_parser("sync-local")
    sync_local.add_argument("skill_id")
    sync_local.add_argument("--cli", default=os.environ.get("KINIC_VFS_CLI", "kinic-vfs-cli"))
    sync_local.add_argument("--projection-dir", required=True)

    history = subcommands.add_parser("history")
    history.add_argument("skill_id")
    history.add_argument("--cli", default=os.environ.get("KINIC_VFS_CLI", "kinic-vfs-cli"))

    args = parser.parse_args()
    if args.command == "prepare-job":
        return prepare_job_command(args)
    if args.command == "finish-job":
        return finish_job_command(args)
    if args.command == "sync-local":
        return sync_local_command(args)
    if args.command == "history":
        return history_command(args)
    return 1


def prepare_job_command(args: argparse.Namespace) -> int:
    try:
        payload = prepare_job(args.cli, args.job_id)
        print(json.dumps(payload, indent=2))
        return 0
    except Exception as error:
        print(str(error), file=sys.stderr)
        return 3


def prepare_job(cli: str, job_id: str | None = None) -> dict[str, Any]:
    selected_job_id = job_id or oldest_queued_job_id(cli)
    if not selected_job_id:
        raise RuntimeError("no queued Kinic skill evolution jobs")
    claim = claim_job(cli, selected_job_id)
    if claim.get("status") != "running":
        raise RuntimeError(f"job not claimed: {claim}")
    skill_id = str(claim.get("skill_id", ""))
    if not skill_id:
        raise RuntimeError("claimed job is missing skill_id")
    job = read_node(cli, str(claim.get("path", f"/Wiki/skill-evolution-jobs/{selected_job_id}.md")))
    current = read_node(cli, f"/Wiki/skills/{skill_id}/SKILL.md")
    runs = read_run_paths(cli, source_runs_from_job(str(job.get("content", ""))))
    if not runs:
        raise RuntimeError("job has no readable source runs")
    corrections = read_corrections(cli, skill_id)
    messages = build_prepare_messages(skill_id, str(current.get("content", "")), runs, corrections)
    return {
        "job_id": selected_job_id,
        "skill_id": skill_id,
        "messages": messages,
        "source_runs": [run["path"] for run in runs],
        "corrections": [correction["path"] for correction in corrections],
    }


def oldest_queued_job_id(cli: str) -> str | None:
    output = run_cli(cli, "skill", "evolve-jobs", "list", "--status", "queued", "--json")
    jobs = json.loads(output).get("jobs", [])
    if not jobs:
        return None
    ordered = sorted(jobs, key=lambda job: (job.get("updated_at", 0), job.get("path", "")))
    job_id = ordered[0].get("job_id")
    return str(job_id) if job_id else None


def claim_job(cli: str, job_id: str) -> dict[str, Any]:
    output = run_cli(cli, "skill", "evolve-jobs", "claim", job_id, "--json")
    return json.loads(output)


def build_prepare_messages(
    skill_id: str,
    current_skill: str,
    runs: list[dict[str, str]],
    corrections: list[dict[str, str]],
) -> list[dict[str, str]]:
    return [
        {
            "role": "system",
            "content": (
                "Improve an Agent Skill SKILL.md using only supplied Kinic evidence. "
                "Return the full candidate SKILL.md only. Preserve frontmatter, declared identity, "
                "scope, and permissions. Do not expand permissions. Prefer explicit corrections over run evidence."
            ),
        },
        {
            "role": "user",
            "content": build_prepare_prompt(skill_id, current_skill, runs, corrections),
        },
    ]


def build_prepare_prompt(
    skill_id: str,
    current_skill: str,
    runs: list[dict[str, str]],
    corrections: list[dict[str, str]],
) -> str:
    payload = {
        "skill_id": skill_id,
        "current_skill": current_skill,
        "corrections_priority": corrections,
        "source_runs": runs,
        "instructions": [
            "Use corrections first; use source runs only to support concrete changes.",
            "Keep the same skill identity and frontmatter structure.",
            "Return only the complete candidate SKILL.md.",
        ],
    }
    return json.dumps(payload, indent=2)


def finish_job_command(args: argparse.Namespace) -> int:
    try:
        job_path = f"/Wiki/skill-evolution-jobs/{args.job_id}.md"
        job = read_node(args.cli, job_path)
        status = frontmatter_scalar(str(job.get("content", "")), "status")
        if status != "running":
            raise RuntimeError(f"job must be running before finish-job, current status: {status}")
        skill_id = skill_id_from_job_content(str(job.get("content", "")))
        if not skill_id:
            raise RuntimeError("job is missing skill_id")
        current = read_node(args.cli, f"/Wiki/skills/{skill_id}/SKILL.md")
        runs = read_run_paths(args.cli, source_runs_from_job(job.get("content", "")))
        if not runs:
            raise RuntimeError("job has no readable source runs")
        corrections = read_corrections(args.cli, skill_id)
        candidate = Path(args.candidate_file).read_text()
        proposal_id = new_proposal_id(args.job_id)
        result = write_proposal(
            args.cli,
            "/Wiki/skills",
            skill_id,
            proposal_id,
            current,
            candidate,
            runs,
            corrections,
            generator=args.generator,
            llm_route=args.llm_route,
        )
        if not result["gate_passed"]:
            completion_error = complete_job_error(args.cli, args.job_id, "failed", "proposal gate failed")
            output = dict(result["output"])
            if completion_error:
                output["completion_error"] = completion_error
            print(json.dumps(output, indent=2))
            return 3
        apply_args = ["skill", "apply-proposal", skill_id, proposal_id, "--job-id", args.job_id, "--json"]
        if args.projection_dir:
            apply_args.extend(["--projection-dir", args.projection_dir])
        applied = json.loads(run_cli(args.cli, *apply_args))
        apply_status = applied.get("status")
        job_status = job_status_from_apply_status(apply_status)
        completion_error = complete_job_error(args.cli, args.job_id, job_status, apply_summary(applied))
        output = {"proposal": result["output"], "apply": applied, "job_status": job_status}
        if completion_error:
            output["completion_error"] = completion_error
        print(json.dumps(output, indent=2))
        return 0 if job_status == "done" and not completion_error else 3
    except Exception as error:
        completion_error = complete_job_error(args.cli, args.job_id, "failed", str(error))
        if completion_error:
            print(json.dumps({"job_id": args.job_id, "status": "failed", "error": str(error), "completion_error": completion_error}, indent=2))
        print(str(error), file=sys.stderr)
        return 3


def sync_local_command(args: argparse.Namespace) -> int:
    out = Path(args.projection_dir) / args.skill_id
    command = ["skill", "export", args.skill_id, "--out", str(out), "--json"]
    print(run_cli(args.cli, *command), end="")
    return 0


def history_command(args: argparse.Namespace) -> int:
    command = ["skill", "history", args.skill_id, "--json"]
    print(run_cli(args.cli, *command), end="")
    return 0


def write_proposal(
    cli: str,
    root: str,
    skill_id: str,
    proposal_id: str,
    current: dict[str, Any],
    candidate: str,
    runs: list[dict[str, str]],
    corrections: list[dict[str, str]],
    generator: str = "hermes-plugin",
    llm_route: str = "hermes-ctx-llm",
) -> dict[str, Any]:
    gates = evaluate_gates(current["content"], candidate)
    gate_passed = all(value == "pass" for value in gates.values())
    proposal_root = f"{root}/{skill_id}/proposals/{proposal_id}"
    ensure_folders(cli, [f"{root}/{skill_id}/proposals", proposal_root, f"{proposal_root}/candidate"])
    write_node(cli, f"{proposal_root}/proposal.md", proposal_markdown(skill_id, proposal_id, current, runs, gates))
    write_node(cli, f"{proposal_root}/candidate/SKILL.md", candidate)
    write_node(cli, f"{proposal_root}/diff.md", unified_diff(current["content"], candidate))
    metrics = {
        "schema_version": 1,
        "skill_id": skill_id,
        "llm_route": llm_route,
        "base_etag": current["etag"],
        "base_hash": f"sha256:{sha256_label(current['content'])}",
        "candidate_hash": f"sha256:{sha256_label(candidate)}",
        "source_runs": [run["path"] for run in runs],
        "corrections": [correction["path"] for correction in corrections],
        "created_at_ms": int(time.time() * 1000),
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "generator": generator,
        "baseline_score": 1.0,
        "candidate_score": 1.0 if gates["candidate_score_gate"] == "pass" else 0.0,
        "candidate_score_gate": gates["candidate_score_gate"],
        "heading_consistency_gate": gates["heading_consistency_gate"],
        "permission_gate": gates["permission_gate"],
        "gates": gates,
        "scores": {"gate": gates},
    }
    write_node(cli, f"{proposal_root}/metrics.json", json.dumps(metrics, indent=2))
    return {
        "gate_passed": gate_passed,
        "gates": gates,
        "output": {"skill_id": skill_id, "proposal_id": proposal_id, "proposal_root": proposal_root, "gates": gates},
    }


def run_cli(cli: str, *args: str) -> str:
    result = run_cli_process(cli, *args)
    return result.stdout


def read_node(cli: str, path: str) -> dict[str, Any]:
    output = run_cli(cli, "read-node", "--path", path, "--fields", "content,etag")
    return json.loads(output)


def read_run_paths(cli: str, paths: list[str]) -> list[dict[str, str]]:
    selected: list[dict[str, str]] = []
    for path in paths:
        try:
            node = read_node(cli, path)
        except subprocess.CalledProcessError:
            continue
        selected.append({"path": path, "content": node.get("content", "")})
    return selected


def read_corrections(cli: str, skill_id: str) -> list[dict[str, str]]:
    output = run_cli(cli, "list-nodes", "--prefix", f"/Sources/skill-runs/{skill_id}", "--recursive", "--json")
    entries = json.loads(output)
    paths = [
        entry.get("path", "")
        for entry in entries
        if ".correction." in entry.get("path", "") or "shadow-correction-" in entry.get("path", "")
    ]
    return read_run_paths(cli, paths)


def ensure_folders(cli: str, paths: list[str]) -> None:
    for path in paths:
        result = subprocess.run(cli_command(cli, "mkdir-node", "--path", path), check=False, text=True, capture_output=True)
        if result.returncode != 0:
            detail = (result.stderr or result.stdout or f"exit {result.returncode}").strip()
            raise RuntimeError(f"mkdir-node failed for {path}: {detail}")


def write_node(cli: str, path: str, content: str) -> None:
    with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False) as handle:
        handle.write(content)
        temp_path = Path(handle.name)
    try:
        run_cli(cli, "write-node", "--path", path, "--input", str(temp_path))
    finally:
        temp_path.unlink(missing_ok=True)


def complete_job(cli: str, job_id: str, status: str, summary: str) -> None:
    run_cli(cli, "skill", "evolve-jobs", "complete", job_id, "--status", status, "--summary", summary[:500], "--json")


def complete_job_error(cli: str, job_id: str, status: str, summary: str) -> str | None:
    try:
        complete_job(cli, job_id, status, summary)
        return None
    except Exception as error:
        message = f"failed to complete job {job_id} as {status}: {error}"
        print(message, file=sys.stderr)
        return message


def job_status_from_apply_status(apply_status: object) -> str:
    if apply_status in {"auto_applied", "auto_applied_sync_failed"}:
        return "done"
    if apply_status == "conflict":
        return "conflict"
    return "failed"


def apply_summary(applied: dict[str, Any]) -> str:
    status = applied.get("status")
    sync_error = applied.get("sync_error")
    if sync_error:
        if status == "auto_applied_sync_failed":
            return f"remote apply succeeded; local_projection_sync_failed: {sync_error}"
        return f"apply status: {status}; sync_error: {sync_error}"
    error = applied.get("error")
    if error:
        return f"apply status: {status}; error: {error}"
    return f"apply status: {status}"


def source_runs_from_job(content: str) -> list[str]:
    lines = frontmatter_lines(content)
    if lines is None:
        return []
    paths: list[str] = []
    in_source_runs = False
    for line in lines:
        if line.startswith("source_runs:"):
            in_source_runs = True
            continue
        if in_source_runs:
            if line.startswith("  - "):
                paths.append(line[4:].strip().strip('"'))
                continue
            if line and not line.startswith(" "):
                break
    return paths


def frontmatter_scalar(content: str, key: str) -> str | None:
    lines = frontmatter_lines(content)
    if lines is None:
        return None
    for line in lines:
        if line.startswith(" ") or line.startswith("\t") or ":" not in line:
            continue
        field, value = line.split(":", 1)
        if field.strip() == key:
            return value.strip().strip('"')
    return None


def frontmatter_lines(content: str) -> list[str] | None:
    if not content.startswith("---\n"):
        return None
    end = content.find("\n---", 4)
    if end < 0:
        return None
    return content[4:end].splitlines()


def skill_id_from_job_content(content: str) -> str | None:
    return frontmatter_scalar(content, "skill_id")


def proposal_markdown(skill_id: str, proposal_id: str, current: dict[str, Any], runs: list[dict[str, str]], gates: dict[str, str]) -> str:
    run_lines = "\n".join(f"  - {run['path']}" for run in runs)
    gate_lines = "\n".join(f"- {name}: {status}" for name, status in gates.items())
    return (
        "---\n"
        "kind: kinic.skill_evolution_proposal\n"
        "schema_version: 1\n"
        f"skill_id: {skill_id}\n"
        f"proposal_id: {proposal_id}\n"
        "status: proposed\n"
        f"base_etag: {json.dumps(str(current['etag']))}\n"
        "source_runs:\n"
        f"{run_lines}\n"
        "---\n"
        "# Skill Evolution Proposal\n\n"
        "## Gates\n\n"
        f"{gate_lines}\n"
    )


def unified_diff(before: str, after: str) -> str:
    return "".join(difflib.unified_diff(before.splitlines(True), after.splitlines(True), fromfile="current/SKILL.md", tofile="candidate/SKILL.md"))


def evaluate_gates(current_skill: str, candidate: str) -> dict[str, str]:
    basic = validate_candidate(current_skill, candidate)
    return {
        "candidate_score_gate": "pass" if basic["passed"] else "fail",
        "heading_consistency_gate": "pass" if same_declared_identity(current_skill, candidate) else "fail",
        "permission_gate": "pass" if not permissions_expanded(current_skill, candidate) else "fail",
    }


def new_proposal_id(job_id: str) -> str:
    safe_job_id = re.sub(r"[^A-Za-z0-9_.-]+", "-", job_id).strip("-") or "job"
    return f"{safe_job_id}-{int(time.time() * 1000)}-{secrets.token_hex(3)}"


def validate_candidate(current_skill: str, candidate: str) -> dict[str, Any]:
    candidate_text = candidate.strip()
    current_text = current_skill.strip()
    has_heading = "\n# " in f"\n{candidate_text}" or "\n## " in f"\n{candidate_text}"
    length_ratio = len(candidate_text) / max(1, len(current_text))
    current_has_frontmatter = current_text.startswith("---\n")
    candidate_frontmatter_ok = not current_has_frontmatter or candidate_text.startswith("---\n")
    passed = bool(candidate_text) and has_heading and length_ratio >= 0.5 and candidate_frontmatter_ok
    return {"passed": passed, "non_empty": bool(candidate_text), "markdown_heading": has_heading, "length_ratio": round(length_ratio, 3), "frontmatter_preserved": candidate_frontmatter_ok}


def same_declared_identity(current_skill: str, candidate: str) -> bool:
    current_title = first_heading(current_skill)
    candidate_title = first_heading(candidate)
    return not current_title or not candidate_title or current_title.lower() == candidate_title.lower()


def first_heading(content: str) -> str | None:
    for line in content.splitlines():
        if line.startswith("# "):
            return line[2:].strip()
    return None


def permissions_expanded(current_skill: str, candidate: str) -> bool:
    current = permission_terms(current_skill)
    new = permission_terms(candidate)
    return bool(new - current)


def permission_terms(content: str) -> set[str]:
    terms = {"network", "shell", "filesystem", "file_write", "browser", "github", "credentials", "secrets"}
    lowered = content.lower()
    return {term for term in terms if re.search(rf"\b{re.escape(term)}\b", lowered)}


def sha256_label(content: str) -> str:
    import hashlib

    return hashlib.sha256(content.encode()).hexdigest()


if __name__ == "__main__":
    raise SystemExit(main())
