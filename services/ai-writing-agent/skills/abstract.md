---
name: abstract
description: Draft or rewrite paper abstracts using structured formulas and venue-specific conventions
triggerHint: When the user asks to write, rewrite, or improve an abstract
---

# Abstract Writing

You are now in **abstract writing** mode.

## When to Use

- Write a new abstract for a paper
- Rewrite or improve an existing abstract
- Adapt an abstract for a different venue or word limit

## The 5-Sentence Abstract Formula

Every abstract should follow this structure (adapted from Sebastian Farquhar / Orchestra):

1. **Background & motivation** -- What is the core challenge or gap? (1 sentence)
2. **Problem statement** -- What specific shortcomings exist in current approaches? (1 sentence)
3. **Method overview** -- What does this paper do? (1 sentence, concrete and specific)
4. **Key results** -- What are the main findings? (1-2 sentences, with specific numbers)
5. **Impact** -- Why does this matter? What does it enable? (1 sentence)

### Example (annotated):

> [1-Background] Training large language models requires massive compute budgets that limit accessibility.
> [2-Problem] Existing efficiency methods sacrifice model quality for speed, creating an unacceptable trade-off.
> [3-Method] We propose AdaptScale, a dynamic precision allocation method that adjusts numerical precision per-layer during training based on gradient statistics.
> [4-Results] AdaptScale reduces training FLOPs by 38% on LLaMA-7B while matching full-precision perplexity (5.12 vs 5.14) and downstream accuracy (avg 72.1% on MMLU).
> [5-Impact] This enables researchers with limited compute to train competitive models, democratizing LLM development.

## Venue Style Differences

| Venue type   | Style tendency                                           | Word limit |
|--------------|----------------------------------------------------------|------------|
| NeurIPS      | Theoretical grounding, emphasize novelty and analysis    | ~250       |
| ICLR         | Explicit contributions list, clear empirical validation  | ~250       |
| ACL/EMNLP    | Applied focus, task-oriented framing                     | 150--250   |
| CVPR/ECCV    | Visual results emphasis, mention datasets explicitly     | ~250       |
| Journals     | More comprehensive, can include broader context          | 150--300   |

When the user does not specify a venue, write for general ML/AI conference conventions (~200 words).

## Abstract Anti-Patterns

DELETE or rewrite these on sight:

**Generic openings** (provide zero information):
- "Recent advances in X have achieved remarkable success..."
- "Large language models have shown great promise..."
- "Deep learning has revolutionized the field of..."
- "In recent years, X has attracted increasing attention..."

Replace with a specific statement about the problem or gap.

**Other anti-patterns:**
- Overly broad background that could apply to any paper in the field
- Method details that belong in Section 3 (abstract should say *what*, not *how*)
- No specific result numbers ("our method significantly outperforms..." -- by how much?)
- Vague contribution claims ("we make several contributions" -- name them)
- Restating the title as the first sentence

## Workflow

### Phase 1: Read the Paper

Call `read_document` on the main .tex file(s). Extract:
- Core contributions (usually in Introduction)
- Key result numbers (from Results/Experiments tables and text)
- Method name and one-line description
- Target venue if mentioned

If the paper is split across multiple files, use `list_files` first, then read the relevant sections.

### Phase 2: Draft

Write the abstract following the 5-sentence formula. Rules:
- Include at least one specific number from the results
- Name the method/approach explicitly
- Keep within the target word count (default: 200 words)
- Match the language of the paper (English or Chinese)

### Phase 3: Verify Checklist

Before finalizing, check every item:
- [ ] Every contribution from the Introduction is mentioned or implied
- [ ] At least one specific quantitative result is included
- [ ] Word count is within venue limits
- [ ] Numbers in abstract match the Results section exactly
- [ ] No generic opening sentence
- [ ] Method name appears explicitly
- [ ] A reader unfamiliar with the field can understand the problem statement

### Phase 4: Write

Use `edit_document` to write or replace the abstract in the .tex file. The abstract is typically inside `\begin{abstract}...\end{abstract}`.

## Tools

- `read_document` -- read paper content to extract contributions and results
- `edit_document` -- write or replace the abstract
- `list_files` -- find project files when structure is unclear
- `search_project` -- search for specific numbers, method names, or contribution statements

## Common Issues

| Issue                        | Cause                                        | Fix                                                   |
|------------------------------|----------------------------------------------|-------------------------------------------------------|
| Abstract too long            | Too much method detail or background         | Cut background to 1 sentence; move method details out |
| Abstract too short           | Missing results or impact sentence           | Add specific numbers and significance statement       |
| Contribution mismatch        | Abstract claims don't match paper body       | Re-read Introduction contributions list               |
| No quantitative results      | Wrote "significant improvement" without data | Pull exact numbers from Results tables                |
| Generic first sentence       | Copied common AI paper openings              | Replace with specific problem statement               |
| Inconsistent with Results    | Numbers in abstract differ from tables       | Cross-check every number against source table         |

{{userInstructions}}
