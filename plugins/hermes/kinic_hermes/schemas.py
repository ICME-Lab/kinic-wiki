"""Where: plugins/hermes/kinic_hermes/schemas.py
What: Small JSON shapes used by the Hermes Kinic plugin.
Why: The plugin must pass stable run evidence to kinic-vfs-cli without owning DB logic.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass
class ToolTrace:
    name: str
    args: Any
    result_excerpt: str
    duration_ms: int | None = None


@dataclass
class RunBuffer:
    tool_trace: list[ToolTrace] = field(default_factory=list)
    skill_candidates: set[str] = field(default_factory=set)
    final_response: str = ""

    def to_json(self, skill_id: str, usage_delta: dict[str, Any], agent_outcome: str = "unknown") -> dict[str, Any]:
        return {
            "schema_version": 1,
            "skill_id": skill_id,
            "task": "",
            "task_outcome": "",
            "agent_outcome": agent_outcome,
            "agent": "hermes",
            "recorded_by": "hermes-plugin",
            "summary": self._summary(),
            "raw_evidence_excerpt": self._excerpt(),
            "usage_delta": usage_delta,
            "tool_trace": [trace.__dict__ for trace in self.tool_trace],
            "final_response": self.final_response,
        }

    def _summary(self) -> str:
        if self.final_response:
            return self.final_response[:500]
        if self.tool_trace:
            return f"{len(self.tool_trace)} tool calls captured."
        return "Skill usage detected from Hermes usage sidecar."

    def _excerpt(self) -> str:
        parts = [trace.result_excerpt for trace in self.tool_trace if trace.result_excerpt]
        if self.final_response:
            parts.append(self.final_response)
        return "\n\n".join(parts)[:4000]
