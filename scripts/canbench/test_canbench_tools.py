"""Where: scripts/canbench/test_canbench_tools.py
What: Unit tests for canbench aggregation and comparison helpers.
Why: Reporting scripts should fail loudly when canbench inputs or benchmark shapes are inconsistent.
"""

import json
import tempfile
import unittest
from pathlib import Path

from scripts.canbench.aggregate import parse_canbench_results, parse_metadata_log
from scripts.canbench.compare import compare_rows


class CanbenchToolTests(unittest.TestCase):
    def test_parse_fixed_canbench_yaml_shape(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "canbench_results.yml"
            path.write_text(
                "\n".join(
                    [
                        "benches:",
                        "  write_node_scale_n100:",
                        "    total:",
                        "      calls: 1",
                        "      instructions: 42",
                        "      heap_increase: 2",
                        "      stable_memory_increase: 3",
                        "    scopes: {}",
                        "version: 0.4.1",
                    ]
                ),
                encoding="utf-8",
            )
            parsed = parse_canbench_results(path)
            self.assertEqual(parsed["write_node_scale_n100"]["instructions"], 42)
            self.assertEqual(parsed["write_node_scale_n100"]["stable_memory_increase"], 3)

    def test_parse_canister_metadata_log(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "canbench.log"
            payload = {"bench_name": "write_node_scale_n100", "n": 100, "operation": "write"}
            path.write_text(f"INFO CANBENCH_META {json.dumps(payload)}\n", encoding="utf-8")
            parsed = parse_metadata_log(path)
            self.assertEqual(parsed["write_node_scale_n100"]["n"], 100)

    def test_compare_rows_rejects_shape_mismatch(self) -> None:
        baseline = {
            "operation": "write",
            "n": 100,
            "shape": "shape-a",
            "node_count": 100,
            "depth": 4,
            "content_size": 256,
            "updated_count": 1,
            "instructions": {"mean": 1000.0},
            "heap_increase": {"mean": 1.0},
            "stable_memory_increase": {"mean": 2.0},
        }
        candidate = {**baseline, "content_size": 512}
        with self.assertRaises(ValueError):
            compare_rows(baseline, candidate)


if __name__ == "__main__":
    unittest.main()
