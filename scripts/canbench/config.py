"""Where: scripts/canbench/config.py
What: Shared constants for canbench scale aggregation and reporting.
Why: The reporting scripts should use one source of truth for artifact names and labels.
"""

from pathlib import Path

ARTIFACT_ROOT = Path("artifacts/canbench")
RUNS_DIRNAME = "runs"
RESULTS_JSON = "scale_results.json"
RESULTS_CSV = "scale_results.csv"
REPORT_MD = "scale_report.md"
COMPARE_JSON = "scale_compare.json"
COMPARE_CSV = "scale_compare.csv"
COMPARE_MD = "scale_compare.md"
CERTIFICATION_NOTE = "未実装・計測対象外"
SNAPSHOT_SIZE_NOTE = "snapshot_bytes は export_snapshot 応答を JSON UTF-8 に直列化した実測サイズです。"
STABLE_TOUCH_NOTE = "stable memory touch 量は未計測です。stable_memory_increase のみ掲載します。"
