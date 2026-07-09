#!/usr/bin/env python3
"""Report lightweight LaTeX prose signals for a workspace file.

This script is intentionally read-only. It helps the polish skill decide whether
there are obvious prose issues before editing through the normal draft pipeline.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print("usage: latex_sanity_report.py <tex-file>", file=sys.stderr)
        return 2

    target = Path(argv[1])
    if target.is_absolute() or ".." in target.parts:
        print("path must be workspace-relative", file=sys.stderr)
        return 2
    if target.suffix != ".tex":
        print("target should be a .tex file", file=sys.stderr)
        return 2
    if not target.exists():
        print(f"file not found: {target}", file=sys.stderr)
        return 1

    text = target.read_text(encoding="utf-8", errors="replace")
    prose = strip_latex_commands(text)
    words = re.findall(r"[A-Za-z][A-Za-z'-]*", prose)
    long_sentences = [s.strip() for s in re.split(r"(?<=[.!?])\s+", prose) if len(s.split()) > 35]
    passive_hints = re.findall(r"\b(?:is|are|was|were|be|been|being)\s+\w+ed\b", prose, flags=re.I)

    print(f"file: {target.as_posix()}")
    print(f"word_count: {len(words)}")
    print(f"long_sentence_count: {len(long_sentences)}")
    print(f"passive_hint_count: {len(passive_hints)}")
    if long_sentences:
        print("first_long_sentence:", long_sentences[0][:240])
    return 0


def strip_latex_commands(text: str) -> str:
    text = re.sub(r"%.*", " ", text)
    text = re.sub(r"\\(?:cite|ref|label|url)\{[^{}]*\}", " ", text)
    text = re.sub(r"\\[a-zA-Z]+(?:\[[^\]]*\])?(?:\{[^{}]*\})?", " ", text)
    text = re.sub(r"\$[^$]*\$", " ", text)
    return text


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
