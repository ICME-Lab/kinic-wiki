"""Where: scripts/bench/test_wrapper_contract.py
What: Guard benchmark wrapper flags against the current vfs_bench CLI contract.
Why: workload-setup and workload-measure share required args; wrapper drift breaks runs before measurement.
"""

from pathlib import Path
import re
import unittest


REPO_ROOT = Path(__file__).resolve().parents[2]
WORKLOAD_WRAPPER = REPO_ROOT / "scripts" / "bench" / "run_canister_vfs_workload.sh"


def extract_call_block(script_text: str, subcommand: str) -> str:
    pattern = re.compile(
        rf'if "\$\{{BENCH_BIN\}}" {re.escape(subcommand)} \\\n(?P<body>.*?)\n\s*--operation "\$\{{cli_operation\}}" 2> "\$\{{stderr_file\}}"; then',
        re.DOTALL,
    )
    match = pattern.search(script_text)
    if match is None:
        raise AssertionError(f"missing wrapper block for {subcommand}")
    return match.group("body")


class WrapperContractTest(unittest.TestCase):
    maxDiff = None

    def test_workload_setup_passes_preview_mode(self) -> None:
        script_text = WORKLOAD_WRAPPER.read_text(encoding="utf-8")
        setup_block = extract_call_block(script_text, "workload-setup")

        self.assertIn('--preview-mode "${preview_mode}"', setup_block)

    def test_workload_setup_and_measure_share_required_shape_args(self) -> None:
        script_text = WORKLOAD_WRAPPER.read_text(encoding="utf-8")
        setup_block = extract_call_block(script_text, "workload-setup")
        measure_block = extract_call_block(script_text, "workload-measure")
        required_args = [
            '--file-count "${file_count}"',
            '--directory-shape "${directory_shape}"',
            '--concurrent-clients "${concurrent_clients}"',
            '--preview-mode "${preview_mode}"',
        ]

        for arg in required_args:
            self.assertIn(arg, setup_block)
            self.assertIn(arg, measure_block)


if __name__ == "__main__":
    unittest.main()
