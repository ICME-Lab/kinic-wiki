"""Where: plugins/hermes/kinic_hermes/evolve.py
What: Compatibility shim for the shared Kinic agent evolution runner.
Why: Existing kinic-skill-evolve entrypoints should keep working after runtime extraction.
"""

from __future__ import annotations

import sys
from pathlib import Path

PLUGIN_ROOT = Path(__file__).resolve().parents[1]
LOCAL_RUNTIME_ROOT = PLUGIN_ROOT
REPO_RUNTIME_ROOT = Path(__file__).resolve().parents[2] / "runtime"
for runtime_root in (LOCAL_RUNTIME_ROOT, REPO_RUNTIME_ROOT):
    if runtime_root.joinpath("kinic_agent_runtime").is_dir() and str(runtime_root) not in sys.path:
        sys.path.insert(0, str(runtime_root))

from kinic_agent_runtime.evolve import *  # noqa: F403
from kinic_agent_runtime.evolve import main


if __name__ == "__main__":
    raise SystemExit(main())
