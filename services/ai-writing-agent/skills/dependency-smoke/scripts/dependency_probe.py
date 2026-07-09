#!/usr/bin/env python3
from __future__ import annotations

from pathlib import Path
from typing_extensions import TypedDict


class Probe(TypedDict):
    marker: str


def main() -> int:
    probe: Probe = {"marker": "dependency-smoke-ok"}
    Path("dependency-smoke-output.txt").write_text(
        f"{probe['marker']}\n",
        encoding="utf-8",
    )
    print(probe["marker"])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
