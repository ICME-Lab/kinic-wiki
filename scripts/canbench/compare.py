"""Where: scripts/canbench/compare.py
What: Compare two aggregated canbench scale result files.
Why: Design review needs before/after diffs under identical benchmark shapes.
"""

from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path

from scripts.canbench.config import COMPARE_CSV, COMPARE_JSON, COMPARE_MD


def load_aggregated(path: Path) -> dict[tuple[str, int, str], dict[str, object]]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    result: dict[tuple[str, int, str], dict[str, object]] = {}
    for row in payload["aggregated"]:
        key = (row["operation"], int(row["n"]), row["shape"])
        result[key] = row
    return result


def compare_rows(baseline: dict[str, object], candidate: dict[str, object]) -> dict[str, object]:
    for field in ("node_count", "depth", "content_size", "updated_count"):
        if baseline[field] != candidate[field]:
            raise ValueError(f"shape mismatch on {field}: {baseline[field]} != {candidate[field]}")
    base_instructions = float(baseline["instructions"]["mean"])
    cand_instructions = float(candidate["instructions"]["mean"])
    return {
        "operation": candidate["operation"],
        "n": candidate["n"],
        "shape": candidate["shape"],
        "instructions_diff_abs": cand_instructions - base_instructions,
        "instructions_diff_pct": ((cand_instructions - base_instructions) / base_instructions) * 100.0,
        "heap_diff": float(candidate["heap_increase"]["mean"]) - float(baseline["heap_increase"]["mean"]),
        "stable_diff": float(candidate["stable_memory_increase"]["mean"])
        - float(baseline["stable_memory_increase"]["mean"]),
    }


def write_outputs(output_dir: Path, rows: list[dict[str, object]]) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / COMPARE_JSON).write_text(json.dumps({"comparison": rows}, indent=2), encoding="utf-8")
    with (output_dir / COMPARE_CSV).open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(
            handle,
            fieldnames=["operation", "n", "shape", "instructions_diff_abs", "instructions_diff_pct", "heap_diff", "stable_diff"],
        )
        writer.writeheader()
        writer.writerows(rows)
    lines = [
        "# canbench Comparison",
        "",
        "| operation | N | instructions_diff_abs | instructions_diff_pct | heap_diff | stable_diff |",
        "| --- | --- | --- | --- | --- | --- |",
    ]
    for row in rows:
        lines.append(
            f"| {row['operation']} | {row['n']} | {row['instructions_diff_abs']:.2f} | {row['instructions_diff_pct']:.2f}% | {row['heap_diff']:.2f} | {row['stable_diff']:.2f} |"
        )
    (output_dir / COMPARE_MD).write_text("\n".join(lines) + "\n", encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--baseline", type=Path, required=True)
    parser.add_argument("--candidate", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()

    baseline = load_aggregated(args.baseline)
    candidate = load_aggregated(args.candidate)
    if set(baseline) != set(candidate):
        raise ValueError("baseline and candidate benchmark keys do not match")

    rows = [compare_rows(baseline[key], candidate[key]) for key in sorted(candidate)]
    write_outputs(args.output_dir, rows)


if __name__ == "__main__":
    main()
