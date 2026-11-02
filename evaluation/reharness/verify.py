#!/usr/bin/env python3
"""External synthetic-pilot oracle. Never copy into the agent's Git archive."""

import argparse
from decimal import Decimal, ROUND_HALF_EVEN, ROUND_HALF_UP
import importlib.util
import json
from pathlib import Path

PROFILES = {
    "legacy": ("acme", ROUND_HALF_UP),
    "current": ("nova", ROUND_HALF_EVEN),
}
CASES = [
    {
        "id": "  inv-1 ",
        "amount": "1.005",
        "currency": "usd",
        "tags": [" VIP ", "vip", "", "web"],
    },
    {
        "id": "refund-2",
        "amount": "-1.005",
        "currency": "eur",
        "tags": [" B ", "a", "b", "  "],
    },
    {"id": "zero", "amount": "0", "currency": "jpy", "tags": []},
    {
        "id": "large",
        "amount": "90071992547409.93",
        "currency": "gbp",
        "tags": ["z", "A"],
    },
    {"id": "tie", "amount": "1.015", "currency": "USD", "tags": ["x"]},
]


def expected(event, profile, kind):
    prefix, rounding = PROFILES[profile]
    return {
        "key": prefix + ":" + event["id"].strip(),
        "kind": kind,
        "minor": int(
            (Decimal(event["amount"]) * 100).quantize(Decimal("1"), rounding=rounding)
        ),
        "currency": event["currency"].upper(),
        "tags": sorted({tag.strip().lower() for tag in event["tags"] if tag.strip()}),
    }


def check(encode, profile, kind):
    failures = []
    for index, event in enumerate(CASES):
        want = expected(event, profile, kind)
        try:
            got = encode(json.loads(json.dumps(event)))
            # bool is a Python int subclass but invalid on this wire protocol.
            if (
                got != want
                or not isinstance(got, dict)
                or type(got.get("minor")) is not int
            ):
                failures.append({"case": index, "expected": want, "actual": got})
        except Exception as error:
            failures.append({"case": index, "expected": want, "error": str(error)})
    return failures


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profile", choices=PROFILES, required=True)
    parser.add_argument("--kind", required=True)
    args = parser.parse_args()
    try:
        spec = importlib.util.spec_from_file_location(
            "pilot_adapter", Path.cwd() / "adapter.py"
        )
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        failures = check(module.encode, args.profile, args.kind)
    except Exception as error:
        failures = [{"error": str(error)}]
    if failures:
        prefix, rounding = PROFILES[args.profile]
        print(
            "PROFILE_RULES "
            + json.dumps(
                {
                    "profile": args.profile,
                    "key": f"{prefix}: followed by stripped id",
                    "minor": f"decimal amount times 100 rounded to an integer using {rounding}; never binary float",
                    "currency": "uppercase",
                    "tags": "strip, lowercase, drop empty, deduplicate, sort",
                    "kind": args.kind,
                    "fields": ["key", "kind", "minor", "currency", "tags"],
                }
            )
        )
        print(json.dumps({"passed": False, "failures": failures}, default=repr))
        return 1
    print(json.dumps({"passed": True, "cases": len(CASES), "profile": args.profile}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
