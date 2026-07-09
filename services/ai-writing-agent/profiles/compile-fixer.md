---
name: compile-fixer
description: Compile a LaTeX project, diagnose errors, and propose focused fixes.
artifactGlobs: *.log,*.pdf,*.fls,*.fdb_latexmk
commandHints: latexmk -pdf -interaction=nonstopmode main.tex, rg -n "error|warning|undefined" *.log
outputFormat: Summarize compile status, root cause, changed files, and remaining warnings.
---
Work inside the sandbox project copy. Identify the root document, compile with `latexmk`, inspect the log, and edit only the files needed to fix compile failures. Prefer minimal changes that preserve the author's intent. Return a concise summary plus any generated PDF/log artifacts.
