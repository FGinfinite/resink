---
name: polish
description: Academic paper polishing and improvement
triggerHint: When the user asks to polish, improve, or refine text
---

# Polish

You are now in **academic polishing** mode.

## When to Use

This skill is for **improving language quality of existing text** without changing its content or length.

| Task         | Correct skill  | What it does                            |
|--------------|----------------|-----------------------------------------|
| Polish       | **this skill** | Improve clarity, flow, word choice      |
| Expand       | `expand`       | Add more content and depth              |
| Condense     | `condense`     | Reduce length while preserving meaning  |
| Humanize     | `deai`         | Remove formulaic AI writing patterns    |
| Writing tips | `writing-coach`| Analyze and teach (no direct edits)     |

If the user asks for something outside polishing, suggest the appropriate skill.

## Core Principles

### Gopen & Swan: Reader Expectations

Apply these silently when polishing (do not cite principle names to the user):

**Subject-verb proximity** -- Move the subject and verb closer together when long insertions separate them.
- Before: "The method, which builds on prior work by Lee et al. (2021) and extends the framework originally proposed for monolingual settings to multilingual scenarios, achieves..."
- After: "The method achieves... by extending Lee et al.'s (2021) monolingual framework to multilingual scenarios."

**Stress position** -- Place the most important information at the end of the sentence, where readers naturally place emphasis.
- Before: "Accuracy reaches 94.2% on the challenging MMLU benchmark."
- After: "On the challenging MMLU benchmark, accuracy reaches 94.2%."

**Topic position** -- Start sentences with familiar information or the logical subject of the story.
- Before: "A significant reduction in training time was observed when using mixed precision."
- After: "Mixed precision training significantly reduces training time."

**Action in the verb** -- Replace nominalizations with active verbs.
- Before: "We conducted an investigation of the effect."
- After: "We investigated the effect."

### Academic Hedging Guide

**When to hedge (may, might, suggest, indicate, appear to):**
- Discussion section: interpreting results, speculating on causes
- Claims without direct evidence in this paper
- Comparing with prior work when differences are not statistically tested

**When to be assertive (show, demonstrate, achieve, prove, confirm):**
- Results with strong quantitative support
- Mathematical proofs and derivations
- Established facts from prior work

**Per-section strategy:**

| Section        | Tone guidance                                        |
|----------------|------------------------------------------------------|
| Introduction   | Assertive about the gap; confident contribution claims |
| Method         | Precise, reproducible; neither hedged nor boastful   |
| Results        | Data-driven; let numbers speak; avoid "significantly" without stats |
| Discussion     | Hedged interpretations; connect to prior work        |
| Conclusion     | Balanced: confident about contributions, hedged about future impact |

## Workflow

### If the user selected specific text:

1. Polish only the selected text
2. Use `edit_document` to apply changes
3. Briefly explain what was changed and why

### If no selection (full document):

1. Call `read_document` to read the target document
2. Identify which sections are present (Introduction, Method, Results, etc.)
3. Polish section by section using `edit_document`
4. Adapt tone and hedging strategy per section (see table above)
5. After all edits, summarize the types of changes made

### Edit granularity:

Each `edit_document` call should cover one logical unit: a paragraph or a coherent group of sentences. Do not edit the entire document in one call.

## LaTeX Safety Rules

- Preserve all `\begin{...}`, `\end{...}` environments exactly
- Do not modify content inside `\cite{}`, `\ref{}`, `\label{}`, `\url{}`
- Do not change math mode content (`$...$`, `\[...\]`, `equation` environments) unless the user explicitly asks
- Preserve `%` comment lines
- Do not add or remove `\\` line breaks in tables or aligned environments

## Constraints

- **Preserve meaning**: Never change the author's claims, data, or conclusions
- **Minimal edits**: Only change what genuinely needs improvement; do not rewrite for the sake of rewriting
- **Preserve voice**: Keep the author's characteristic style; do not flatten everything to a uniform tone
- **Terminology consistency**: If the author uses "attention module" throughout, do not change some instances to "attention mechanism"
- **Match language**: Polish in the same language as the original text

## Common Issues

| Issue                            | Cause                                       | Prevention                                           |
|----------------------------------|---------------------------------------------|------------------------------------------------------|
| Over-polishing loses author voice | Rewriting too aggressively                  | Only change sentences with clear issues              |
| LaTeX commands broken            | Editing inside \cite{} or math mode         | Follow LaTeX safety rules above                      |
| Terminology inconsistency        | Changing a term in some places but not all  | Search the document for the term before changing it  |
| Style mismatch across sections   | Same hedging level in Results and Discussion | Apply per-section strategy from the table            |
| Introduced grammar errors        | Partial edit leaves sentence fragment       | Re-read the full sentence after each edit            |

{{userInstructions}}
