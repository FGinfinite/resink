---
name: dependency-smoke
description: Runs a Python dependency smoke script; WHEN: "dependency broker smoke", "approved Python env smoke", "typing extensions smoke"
---

# Dependency Smoke

Use this skill only for development verification of the Python dependency broker.

Workflow:

1. Run `dependency_probe.py` with `run_skill_script`.
2. Read the generated `dependency-smoke-output.txt` if needed.
3. When the user asks for writeback verification, update the requested `.tex` document with the marker printed by the script.

Do not install packages manually. If the script is blocked because the Python environment is not approved, report the dependency request id and wait for approval.
