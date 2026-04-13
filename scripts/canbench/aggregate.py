"""Where: scripts/canbench/aggregate.py
What: Merge canbench YAML and canister metadata logs into review-friendly artifacts.
Why: canbench exposes raw performance counters, but design review needs shape metadata, statistics, and Markdown tables.
"""

from __future__ import annotations

import argparse
import csv
import json
import statistics
from collections import defaultdict
from pathlib import Path

from scripts.canbench.config import (
    ARTIFACT_ROOT,
    CERTIFICATION_NOTE,
    REPORT_MD,
    RESULTS_CSV,
    RESULTS_JSON,
    SNAPSHOT_SIZE_NOTE,
    STABLE_TOUCH_NOTE,
)


def parse_canbench_results(path: Path) -> dict[str, dict[str, int]]:
    benches: dict[str, dict[str, int]] = {}
    current: str | None = None
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        if raw_line.startswith("  ") and raw_line.endswith(":") and not raw_line.startswith("    "):
            current = raw_line.strip()[:-1]
            benches[current] = {}
            continue
        if current is None or not raw_line.startswith("      "):
            continue
        key, value = [part.strip() for part in raw_line.split(":", 1)]
        if key in {"calls", "instructions", "heap_increase", "stable_memory_increase"}:
            benches[current][key] = int(value)
    return benches


def parse_metadata_log(path: Path) -> dict[str, dict[str, object]]:
    metadata: dict[str, dict[str, object]] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        if "CANBENCH_META " not in line:
            continue
        payload = line.split("CANBENCH_META ", 1)[1]
        item = json.loads(payload)
        metadata[str(item["bench_name"])] = item
    return metadata


def ratio_or_none(current: float, previous: float | None) -> float | None:
    if previous in (None, 0):
        return None
    return current / previous


def sample_stats(values: list[int]) -> dict[str, float | int]:
    return {
        "min": min(values),
        "max": max(values),
        "mean": statistics.fmean(values),
        "stddev": statistics.pstdev(values) if len(values) > 1 else 0.0,
    }


def markdown_table(headers: list[str], rows: list[list[object]]) -> str:
    lines = ["| " + " | ".join(headers) + " |", "| " + " | ".join(["---"] * len(headers)) + " |"]
    for row in rows:
        lines.append("| " + " | ".join(str(value) for value in row) + " |")
    return "\n".join(lines)


def load_runs(runs_dir: Path) -> tuple[list[dict[str, object]], list[dict[str, object]]]:
    raw_records: list[dict[str, object]] = []
    grouped: dict[str, list[dict[str, object]]] = defaultdict(list)
    for run_dir in sorted(path for path in runs_dir.iterdir() if path.is_dir()):
        benches = parse_canbench_results(run_dir / "canbench_results.yml")
        metadata = parse_metadata_log(run_dir / "canbench.log")
        for bench_name, totals in benches.items():
            if bench_name not in metadata:
                raise ValueError(f"metadata missing for bench: {bench_name}")
            record = {"run_id": run_dir.name, "bench_name": bench_name, **metadata[bench_name], **totals}
            raw_records.append(record)
            grouped[bench_name].append(record)

    aggregated: list[dict[str, object]] = []
    growth_by_operation: dict[str, float] = {}
    for bench_name in sorted(grouped):
        samples = grouped[bench_name]
        first = samples[0]
        instructions = [int(item["instructions"]) for item in samples]
        heap = [int(item["heap_increase"]) for item in samples]
        stable = [int(item["stable_memory_increase"]) for item in samples]
        record = {
            "bench_name": bench_name,
            "operation": first["operation"],
            "shape": first["shape"],
            "n": int(first["n"]),
            "node_count": int(first["node_count"]),
            "depth": int(first["depth"]),
            "content_size": int(first["content_size"]),
            "updated_count": int(first["updated_count"]),
            "snapshot_node_count": int(first["snapshot_node_count"]),
            "snapshot_bytes": int(first["snapshot_bytes"]),
            "certificate_generation": first["certificate_generation"],
            "stable_memory_touch_bytes": first["stable_memory_touch_bytes"],
            "instruction_samples": instructions,
            "heap_samples": heap,
            "stable_memory_samples": stable,
            "instructions": sample_stats(instructions),
            "heap_increase": sample_stats(heap),
            "stable_memory_increase": sample_stats(stable),
        }
        op = str(record["operation"])
        previous = growth_by_operation.get(op)
        current = float(record["instructions"]["mean"])
        record["instructions_per_node"] = current / int(record["n"])
        record["instruction_growth_from_prev"] = ratio_or_none(current, previous)
        growth_by_operation[op] = current
        aggregated.append(record)
    return raw_records, aggregated


def write_csv(path: Path, rows: list[dict[str, object]]) -> None:
    fieldnames = [
        "bench_name",
        "operation",
        "shape",
        "n",
        "node_count",
        "depth",
        "content_size",
        "updated_count",
        "snapshot_node_count",
        "snapshot_bytes",
        "instruction_mean",
        "instruction_min",
        "instruction_max",
        "instruction_stddev",
        "instruction_growth_from_prev",
        "instructions_per_node",
        "heap_mean",
        "stable_mean",
    ]
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        for row in rows:
            writer.writerow(
                {
                    "bench_name": row["bench_name"],
                    "operation": row["operation"],
                    "shape": row["shape"],
                    "n": row["n"],
                    "node_count": row["node_count"],
                    "depth": row["depth"],
                    "content_size": row["content_size"],
                    "updated_count": row["updated_count"],
                    "snapshot_node_count": row["snapshot_node_count"],
                    "snapshot_bytes": row["snapshot_bytes"],
                    "instruction_mean": row["instructions"]["mean"],
                    "instruction_min": row["instructions"]["min"],
                    "instruction_max": row["instructions"]["max"],
                    "instruction_stddev": row["instructions"]["stddev"],
                    "instruction_growth_from_prev": row["instruction_growth_from_prev"],
                    "instructions_per_node": row["instructions_per_node"],
                    "heap_mean": row["heap_increase"]["mean"],
                    "stable_mean": row["stable_memory_increase"]["mean"],
                }
            )


def write_report(path: Path, rows: list[dict[str, object]], repeats: int) -> None:
    instruction_rows: list[list[object]] = []
    stats_rows: list[list[object]] = []
    metric_rows: list[list[object]] = []
    growth_rows: list[list[object]] = []
    for row in rows:
        instruction_rows.append([row["operation"], row["n"], f'{row["instructions"]["mean"]:.2f}'])
        stats_rows.append(
            [
                row["operation"],
                row["n"],
                row["instructions"]["min"],
                row["instructions"]["max"],
                f'{row["instructions"]["stddev"]:.2f}',
            ]
        )
        metric_rows.append(
            [
                row["operation"],
                row["n"],
                row["node_count"],
                row["depth"],
                row["updated_count"],
                row["snapshot_node_count"],
                row["snapshot_bytes"],
                f'{row["heap_increase"]["mean"]:.2f}',
                f'{row["stable_memory_increase"]["mean"]:.2f}',
            ]
        )
        growth_rows.append(
            [
                row["operation"],
                row["n"],
                "n/a" if row["instruction_growth_from_prev"] is None else f'{row["instruction_growth_from_prev"]:.3f}',
                f'{row["instructions_per_node"]:.2f}',
            ]
        )

    report = [
        "# canbench Scale Report",
        "",
        f"- run_count: {repeats}",
        f"- certification: {CERTIFICATION_NOTE}",
        f"- {SNAPSHOT_SIZE_NOTE}",
        f"- {STABLE_TOUCH_NOTE}",
        "",
        "## Instructions",
        markdown_table(["operation", "N", "mean_instructions"], instruction_rows),
        "",
        "## Growth",
        markdown_table(["operation", "N", "growth_from_prev", "instructions_per_node"], growth_rows),
        "",
        "## Stats",
        markdown_table(["operation", "N", "min", "max", "stddev"], stats_rows),
        "",
        "## Supplemental Metrics",
        markdown_table(
            [
                "operation",
                "N",
                "node_count",
                "depth",
                "updated_count",
                "snapshot_node_count",
                "snapshot_bytes",
                "heap_mean",
                "stable_mean",
            ],
            metric_rows,
        ),
        "",
        "## Comparison",
        "_baseline が未指定のため差分表は未生成です。`scripts/canbench/compare.py` を使用してください。_",
    ]
    path.write_text("\n".join(report) + "\n", encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--runs-dir", type=Path, default=ARTIFACT_ROOT / "runs")
    parser.add_argument("--output-dir", type=Path, default=ARTIFACT_ROOT)
    args = parser.parse_args()

    raw_records, aggregated = load_runs(args.runs_dir)
    args.output_dir.mkdir(parents=True, exist_ok=True)
    (args.output_dir / RESULTS_JSON).write_text(
        json.dumps({"raw_runs": raw_records, "aggregated": aggregated}, indent=2),
        encoding="utf-8",
    )
    write_csv(args.output_dir / RESULTS_CSV, aggregated)
    write_report(args.output_dir / REPORT_MD, aggregated, len({row["run_id"] for row in raw_records}))


if __name__ == "__main__":
    main()
