#!/usr/bin/env python3
"""Repository entrypoint for the isolation implementation shipped inside the CLI."""
from pathlib import Path
import runpy

_source = Path(__file__).resolve().parents[2] / "crates/vfs_cli_app/assets/agent_isolation/dsh_isolated_runner.py"
if __name__ == "__main__":
    runpy.run_path(str(_source), run_name="__main__")
else:
    globals().update(runpy.run_path(str(_source)))
