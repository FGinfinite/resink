---
name: pre-submit
description: Pre-submission quality checklist (structure, references, formatting audit)
triggerHint: When the user asks to check paper before submission, run pre-submission checklist, or audit document quality
---

# 投稿前检查技能 (Pre-Submission Check)

你现在进入**投稿前检查**工作模式。你将对论文进行全面的质量审计，涵盖文档结构、交叉引用、引用完整性、匿名化及会议特定要求。

## 可用工具

- `list_files` -- 列出项目文件
- `read_document` -- 读取文档内容
- `search_project` -- 搜索项目内容
- `doc_structure_map` -- 分析文档结构和指标
- `delegate_task` -- 委派审计任务给 document-auditor

## 会议特定要求速查

如果用户指定了目标会议，对照以下要求重点检查：

| 会议 | 正文页数限制 | 特殊必需项 |
|------|-------------|-----------|
| NeurIPS | 9 页 | 16 项 mandatory checklist + Broader Impact section + 录用后需 lay summary |
| ICML | 8 页 | Broader Impact Statement + Reproducibility checklist |
| ICLR | 9 页 | LLM disclosure policy + Reproducibility Statement + reciprocal reviewing |
| ACL | 8 页 (long) / 4 页 (short) | Limitations section mandatory + Ethics Statement |
| AAAI | 7 页 | 严格 style file adherence |

注意：页数限制通常不含 references 和 appendix。需确认使用了正确年份的模板。

## 匿名化检查清单

投稿双盲审的会议时，逐项确认：
- [ ] 作者姓名和机构信息已移除（`\author{}` 中无真实信息）
- [ ] 自引用使用第三人称（"Smith et al. [1] showed..." 而非 "In our previous work [1]..."）
- [ ] 无可识别的代码仓库 URL（GitHub/GitLab 链接中无用户名）
- [ ] 无致谢信息（Acknowledgments section 已移除或注释）
- [ ] 无基金号（Grant numbers 已移除）
- [ ] 文件元数据中无作者信息（PDF metadata）

## 通用投稿前检查项

以下项目不论会议都应检查：
- [ ] 所有 Figure 有自包含的 caption（不看正文也能理解图意）
- [ ] 所有 `\cite{}` 引用的 key 在 .bib 中存在（无 broken references）
- [ ] 所有 `\ref{}` 引用的 label 已定义（无 undefined references）
- [ ] 页数符合限制（references 通常不计入）
- [ ] 使用了正确的模板（对应会议 + 正确年份）
- [ ] 无残留的 TODO / FIXME / XXX 注释
- [ ] 无残留的 `\textcolor{red}{}` 等审阅标记
- [ ] Abstract 字数符合限制（如有）
- [ ] 参考文献格式一致且完整（有年份、期刊/会议名、页码）

## 工作流程

严格按照以下三个阶段执行：

### Phase 1: 文档结构分析

使用 `doc_structure_map` 对文档进行全面分析：
- `follow_inputs: true`（包含所有子文件）
- `metrics: ["word_count", "equation_count", "figure_count", "table_count", "citation_count", "todo_count"]`（所有指标）

分析结果，关注：
- 各章节字数是否均衡
- 是否存在 TODO/FIXME 未清理
- 图表分布是否合理

### Phase 2: 交叉引用审计

使用 `delegate_task` 委派给 `document-auditor`，指令：
- 执行完整的交叉引用审计（labels、refs、cites）
- 重点检查未定义的引用和缺失的 citation key

### Phase 3: 综合报告

汇总 Phase 1 和 Phase 2 的结果，结合会议特定要求和匿名化检查，生成投稿前检查报告。

## 报告格式

---

# Pre-Submission Quality Report

**Document**: [文件名]
**Total Word Count**: [字数]
**Files Analyzed**: [文件数]
**Target Venue**: [会议/期刊名，如用户指定]

## 1. Structure Overview
[结构树 + 各章节字数]

## 2. Critical Issues (必须修复)
编译错误级别的问题：
- 未定义的引用
- 缺失的 citation key
- ...

## 3. Warnings (建议修复)
不影响编译但影响质量的问题：
- 重复标签
- 未使用的标签
- 章节严重不平衡
- 残留的 TODO/FIXME
- 匿名化遗漏
- ...

## 4. Statistics
| Metric | Count |
|--------|-------|
| Words | ... |
| Equations | ... |
| Figures | ... |
| Tables | ... |
| Citations | ... |
| TODOs | ... |

## 5. Checklist
- [ ] 所有引用已定义
- [ ] 所有 citation key 存在于 .bib
- [ ] 无重复标签
- [ ] 无残留 TODO/FIXME
- [ ] 章节字数基本均衡
- [ ] 匿名化完整（双盲审时）
- [ ] 页数符合限制
- [ ] 使用正确模板

---

## 常见问题

| 问题 | 表现 | 预防措施 |
|------|------|----------|
| 匿名化遗漏 | 致谢未删、自引用 "our work" | 使用匿名化检查清单逐项核对 |
| 超页数限制 | 正文 10 页投 9 页限制的会议 | Phase 1 中检查字数，提前预警 |
| 忘记 checklist | NeurIPS/ICML 要求的 checklist 未填写 | 检查会议特定要求表，确认必需项 |
| 模板版本错误 | 用去年的模板投今年的会议 | 检查模板文件中的年份标识 |

{{userInstructions}}
