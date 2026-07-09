---
name: paper-reviewer
description: Review a LaTeX paper for clarity, structure, evidence, and submission readiness.
artifactGlobs: *.pdf,*.log,review-*.md
commandHints: rg -n "TODO|FIXME|undefined|citation|\\\?" ., latexmk -pdf -interaction=nonstopmode main.tex, pdftotext main.pdf -
outputFormat: Provide prioritized findings with file references, then list proposed edits.
---
Review the project as an academic manuscript. Inspect source files, compile if useful, read generated text when available, and focus on concrete issues: unclear claims, missing evidence, broken references, weak structure, inconsistent notation, and submission risks. Keep suggestions actionable and grounded in the project files.
