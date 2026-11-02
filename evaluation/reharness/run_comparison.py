#!/usr/bin/env python3
"""Plan/run independent synthetic streams. Dry-run by default; no shell expansion."""

import argparse
from collections import defaultdict
import json
import hashlib
from pathlib import Path
import re
import statistics
import subprocess
import time
import uuid

POLICIES = ("none", "raw", "append-only", "reharness")


# Codes and patterns are static: never persist a captured diagnostic substring.
CLI_ERROR_PATTERNS = (
    ("database_cycles_suspended", ("database cycles are suspended",)),
    (
        "incomplete_agent_execution",
        (
            "decision incomplete; rollout halted",
            "incomplete evaluator evidence",
            "agent did not complete:",
            "memory inference was interrupted",
        ),
    ),
    (
        "invalid_memory_output",
        (
            "reflection must be strict json",
            "reflection must be an object",
            "reflection contains unexpected fields",
            "reflection field missing",
            "reflection is empty or exceeds 32 kib",
        ),
    ),
    ("state_size_limit", ("stream checkpoint exceeds 900 kb",)),
    ("binding_changed", ("stream binding changed; use a new stream id",)),
)


def classify_cli_error(stdout, stderr):
    """Inspect at most 64 Ki characters per stream; emit only an allowlisted code."""
    diagnostics = [
        (output[:32768] + "\n" + output[-32768:]).lower() for output in (stderr, stdout)
    ]
    for code, patterns in CLI_ERROR_PATTERNS:
        if any(pattern in output for pattern in patterns for output in diagnostics):
            return code
    return "unknown_cli_error"


def sample_rows(report):
    """Read stream rows, with ordinary EvaluationSample reports also supported."""
    if report.get("quality_eligible") is False:
        raise ValueError("Test-only reports are ineligible for quality comparison")
    if isinstance(report.get("steps"), list):
        if report.get("completed") is not True:
            raise ValueError("Stream is incomplete")
        return report["steps"]
    if isinstance(report.get("samples"), list):
        return report["samples"]
    rows = report.get("tasks")
    if isinstance(rows, list):
        return [row["sample"] for row in rows]
    raise ValueError("Report must contain samples or tasks[].sample")


def summarize(rows):
    groups = defaultdict(list)
    for row in rows:
        if row.get("status") == "complete":
            groups[row["policy"]].append(row)
    result = {}
    for policy, runs in groups.items():
        total = sum(run["tasks"] for run in runs)
        result[policy] = {
            "completed_trials": len(runs),
            "task_observations": total,
            "success_rate": sum(run["successes"] for run in runs) / total
            if total
            else None,
            "mean_stream_wall_seconds": statistics.mean(
                run["wall_seconds"] for run in runs
            ),
            "mean_trial_success_rate": statistics.mean(
                run["successes"] / run["tasks"] for run in runs
            ),
            "mean_decision_ms_per_task": sum(run["decision_elapsed_ms"] for run in runs)
            / total,
            "mean_revision_ms_per_task": sum(run["revision_elapsed_ms"] for run in runs)
            / total,
            "mean_write_ms_per_task": sum(run["write_elapsed_ms"] for run in runs)
            / total,
            "model_calls": sum(run["model_calls"] for run in runs),
            "input_tokens": sum(run["input_tokens"] for run in runs)
            if all(run.get("input_tokens") is not None for run in runs)
            else None,
            "output_tokens": sum(run["output_tokens"] for run in runs)
            if all(run.get("output_tokens") is not None for run in runs)
            else None,
        }
    return result


def build_command(args, policy, stream_id, output):
    command = [
        args.cli,
        *args.connection_arg,
        "learn",
        "stream",
        "--suite",
        str(args.suite),
        "--runner-file",
        str(args.runner_file),
        "--stream-id",
        stream_id,
        "--project-id",
        args.project_id,
        "--policy",
        policy,
        "--retrieval",
        args.retrieval,
        "--top-k",
        str(args.top_k),
        "--output",
        str(output),
        "--json",
    ]
    if args.embedding_config:
        command += ["--embedding-config", str(args.embedding_config)]
    return command


def config_hashes(paths):
    return {
        name: hashlib.sha256(path.read_bytes()).hexdigest()
        for name, path in paths.items()
    }


def inputs_match(paths, expected):
    try:
        return config_hashes(paths) == expected
    except OSError:
        return False


def report_metadata(report, retrieval, top_k):
    runner = report.get("runner")
    if (
        not isinstance(runner, dict)
        or not {"engine", "model", "reasoning_effort", "timeout_seconds"}
        <= runner.keys()
    ):
        raise ValueError("Missing runner metadata")
    if (
        report.get("retrieval") != retrieval
        or type(report.get("top_k")) is not int
        or report["top_k"] != top_k
    ):
        raise ValueError("Retrieval configuration mismatch")
    return {
        "runner": runner,
        "retrieval": report["retrieval"],
        "top_k": report["top_k"],
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cli", default="kinic-vfs-cli")
    parser.add_argument(
        "--connection-arg",
        action="append",
        default=[],
        help="Repeat with =VALUE for each leading CLI connection argument; never put secrets here",
    )
    parser.add_argument("--suite", type=Path, required=True)
    parser.add_argument("--runner-file", type=Path, required=True)
    parser.add_argument("--project-id", required=True)
    parser.add_argument(
        "--output", type=Path, required=True, help="New comparison directory"
    )
    parser.add_argument("--trials", type=int, default=1)
    parser.add_argument(
        "--policies", nargs="+", choices=POLICIES, default=list(POLICIES)
    )
    parser.add_argument(
        "--retrieval", choices=("lexical", "embedding"), default="lexical"
    )
    parser.add_argument("--embedding-config", type=Path)
    parser.add_argument("--top-k", type=int, default=5)
    parser.add_argument(
        "--execute",
        action="store_true",
        help="Actually invoke the CLI; may incur provider charges",
    )
    args = parser.parse_args()
    if not re.fullmatch("[0-9a-fA-F]{32}", args.project_id):
        parser.error("--project-id must contain 32 hexadecimal characters")
    if args.trials < 1 or args.top_k < 1:
        parser.error("--trials and --top-k must be positive")
    if len(set(args.policies)) != len(args.policies):
        parser.error("--policies cannot contain duplicates")
    if args.retrieval == "embedding" and args.embedding_config is None:
        parser.error("embedding retrieval requires --embedding-config")
    for path in (args.suite, args.runner_file, args.embedding_config):
        if path is not None and not path.is_file():
            parser.error(f"Missing input file: {path}")
    args.suite = args.suite.resolve()
    args.runner_file = args.runner_file.resolve()
    args.output = args.output.resolve()
    if args.embedding_config:
        args.embedding_config = args.embedding_config.resolve()
    inputs = {"suite": args.suite, "runner": args.runner_file}
    if args.embedding_config:
        inputs["embedding"] = args.embedding_config
    pinned_hashes = config_hashes(inputs)
    baseline_metadata = None
    configuration_changed = False
    manifest = json.loads(args.suite.read_text())
    expected_ids = [task["id"] for task in manifest["tasks"]]
    if not expected_ids:
        parser.error("suite must contain tasks")
    args.output.mkdir(parents=True, exist_ok=False)
    comparison_id = uuid.uuid4().hex
    runs = []
    for trial in range(args.trials):
        # Rotate execution order across trials to reduce a fixed cache/order bias.
        offset = trial % len(args.policies)
        policies = args.policies[offset:] + args.policies[:offset]
        for policy in policies:
            stream_id = f"pilot-{comparison_id}-{trial + 1}-{policy}"
            output = args.output / f"trial-{trial + 1}-{policy}"
            row = {
                "trial": trial + 1,
                "policy": policy,
                "stream_id": stream_id,
                "output": str(output),
                "status": "planned",
            }
            configuration_changed = configuration_changed or not inputs_match(
                inputs, pinned_hashes
            )
            if configuration_changed:
                row["status"] = "config-changed"
            elif args.execute:
                started = time.monotonic()
                completed = subprocess.run(
                    build_command(args, policy, stream_id, output),
                    capture_output=True,
                    text=True,
                )
                row["wall_seconds"] = time.monotonic() - started
                row["exit_code"] = completed.returncode
                if completed.returncode:
                    # Retain only static classification and exit status, never raw diagnostics.
                    row["status"] = "failed"
                    row["error_code"] = classify_cli_error(
                        completed.stdout, completed.stderr
                    )
                else:
                    report_file = output / "report.json"
                    try:
                        if not inputs_match(inputs, pinned_hashes):
                            configuration_changed = True
                            row["status"] = "config-changed"
                            raise ValueError(
                                "Input configuration changed during execution"
                            )
                        report = json.loads(
                            report_file.read_text()
                            if report_file.exists()
                            else completed.stdout
                        )
                        if (
                            report.get("schema_version") != 1
                            or report.get("stream_id") != stream_id
                            or report.get("policy") != policy
                        ):
                            raise ValueError("Report identity mismatch")
                        row["metadata"] = {
                            key: report.get(key)
                            for key in ("runner", "retrieval", "top_k")
                        }
                        metadata = report_metadata(report, args.retrieval, args.top_k)
                        if (
                            baseline_metadata is not None
                            and metadata != baseline_metadata
                        ):
                            raise ValueError("Runner metadata changed between streams")
                        samples = sample_rows(report)
                        if any(
                            type(sample.get("success")) is not bool
                            for sample in samples
                        ):
                            raise ValueError("Invalid success value")
                        row["fidelity"] = report.get("fidelity")
                        for token_key in ("input_tokens", "output_tokens"):
                            values = [sample.get(token_key) for sample in samples]
                            row[token_key] = (
                                sum(values)
                                if all(isinstance(value, int) for value in values)
                                else None
                            )
                        if [sample["task_id"] for sample in samples] != expected_ids:
                            raise ValueError("Task order or count mismatch")
                        if baseline_metadata is None:
                            baseline_metadata = metadata
                        row.update(
                            status="complete",
                            tasks=len(samples),
                            successes=sum(
                                sample["success"] is True for sample in samples
                            ),
                            decision_elapsed_ms=sum(
                                sample.get("decision_elapsed_ms", 0)
                                for sample in samples
                            ),
                            revision_elapsed_ms=sum(
                                sample.get("revision_elapsed_ms", 0)
                                for sample in samples
                            ),
                            write_elapsed_ms=sum(
                                sample.get("write_elapsed_ms", 0) for sample in samples
                            ),
                            model_calls=sum(
                                sample.get("model_calls", 0) for sample in samples
                            ),
                            trajectory=[
                                {
                                    "task_id": sample["task_id"],
                                    "success": sample["success"],
                                }
                                for sample in samples
                            ],
                        )
                    except (OSError, ValueError, KeyError, TypeError):
                        if row["status"] != "config-changed":
                            row["status"] = "invalid-report"
            runs.append(row)
            result = {
                "synthetic_pilot": True,
                "comparison_id": comparison_id,
                "suite_id": manifest["suite_id"],
                "retrieval": args.retrieval,
                "top_k": args.top_k,
                "input_sha256": pinned_hashes,
                "metadata": baseline_metadata,
                "runs": runs,
                "summary": summarize(runs),
            }
            (args.output / "comparison.json").write_text(
                json.dumps(result, indent=2) + "\n"
            )
            print(
                json.dumps(
                    {
                        key: row[key]
                        for key in ("trial", "policy", "stream_id", "status")
                    }
                ),
                flush=True,
            )
    print(str(args.output / "comparison.json"))
    return (
        1
        if any(
            run["status"] in ("failed", "invalid-report", "config-changed")
            for run in runs
        )
        else 0
    )


if __name__ == "__main__":
    raise SystemExit(main())
