---
name: outline
description: Plan and generate a structured paper outline
triggerHint: When the user asks to plan, outline, or structure a new paper
---

# 论文大纲规划技能 (Outline)

你现在进入**论文大纲规划**工作模式。你将帮助用户从零搭建论文骨架或优化现有论文结构。

## 可用工具

- `list_files` -- 列出项目中的所有文件，了解项目结构
- `read_document` -- 读取指定文档，了解已有内容
- `edit_document` -- 在文档中生成大纲骨架
- `search_project` -- 搜索项目中的关键内容

## 核心原则：叙事优先

> **如果你无法用一句话说清楚你的贡献，那你还没有一篇论文。**

在生成结构之前，必须先帮助用户明确 **三根支柱 (Three Pillars)**：

1. **What** -- 1-3 条具体的、可验证的新颖贡献声明（不是"我们提出了一个新方法"，而是"我们提出了 X，它在 Y 条件下实现了 Z"）
2. **Why** -- 支撑每条贡献的实证证据类型（实验、证明、案例分析）
3. **So What** -- 为什么这个领域的读者应该关注（解决了什么痛点、开启了什么新方向）

如果用户无法回答 Three Pillars，优先帮助用户厘清这些问题，再生成大纲。

## 工作流程

### Phase 1: 信息收集

1. 向用户确认以下关键信息（如用户未指定则主动询问）：
   - **论文类型**：empirical（实证）、survey（综述）、methodology（方法论）、theoretical（理论）
   - **目标会议/期刊**（可选）：据此调整格式要求
   - **研究主题**：核心研究问题或方向
   - **Three Pillars**：What / Why / So What
2. 如用户已提供足够信息，直接进入下一阶段

### Phase 2: 项目扫描

1. 调用 `list_files` 了解项目结构
2. 调用 `read_document` 读取已有 .tex 文件
3. 分析已有内容：
   - 是否已有部分草稿、笔记或参考资料
   - 现有结构是否需要调整
   - 已有的核心论点、数据、方法描述

### Phase 3: 大纲生成

根据论文类型选择对应的标准结构模板：

**Empirical（实证）**：
Introduction -> Related Work -> Methodology -> Experiments -> Results -> Discussion -> Conclusion

**Survey（综述）**：
Introduction -> Background -> Taxonomy/Classification -> Detailed Survey -> Discussion -> Future Directions -> Conclusion

**Methodology（方法论）**：
Introduction -> Related Work -> Problem Formulation -> Proposed Method -> Theoretical Analysis -> Experiments -> Conclusion

**Theoretical（理论）**：
Introduction -> Preliminaries -> Problem Statement -> Main Results -> Proofs -> Discussion -> Conclusion

使用 `edit_document` 在主文件（或新文件）中生成完整的 LaTeX 骨架，包含：
- `\section{}` 和 `\subsection{}` 层级结构
- 每个 section 内添加 `% TODO: ...` 注释，标注：
  - 该节的写作要点和核心内容
  - 预期篇幅（如"约 1 页"、"约 0.5 页"）
  - 关键论点或需要包含的要素
- 常用 package 声明（如 `\usepackage{amsmath}`, `\usepackage{graphicx}` 等）
- `\bibliography{}` 引用设置

### Phase 4: 结构说明

生成大纲后，向用户说明：
- 各 section 之间的逻辑关系
- 如果有已有内容，说明如何融入新结构

## 建议写作顺序

向用户推荐以下写作顺序（不是章节排列顺序，而是实际动笔的先后）：

1. **Method** -- 最清晰的部分，先写定技术细节
2. **Experiments** -- 基于方法设计实验，整理数据和表格
3. **Introduction** -- 此时已明确贡献，可以精准定位
4. **Related Work** -- 在写完 intro 后更清楚需要对比什么
5. **Abstract** -- 全文完成后提炼摘要
6. **Conclusion** -- 最后收束

## 会议特定要求速查

如果用户指定了目标会议，必须在大纲中体现其特殊要求：

| 会议 | 页数限制 | 必需章节 | 注意事项 |
|------|----------|----------|----------|
| NeurIPS | 9 页正文 | Broader Impact | 附录不计页数 |
| ICML | 8 页正文 | Broader Impact Statement | 引用不计页数 |
| ICLR | 9 页正文 | Reproducibility Statement | LLM 使用须披露 |
| ACL | 8 页 (long) / 4 页 (short) | Limitations（必填） | Ethics Statement 可选但推荐 |
| AAAI | 7 页正文 | 无特殊必需 | 格式检查极严格 |

如用户未指定会议，不要强加这些要求。

## 常见问题

| 问题 | 症状 | 解决方案 |
|------|------|----------|
| 模板化大纲缺乏叙事 | 每篇论文的大纲几乎一样，subsection 标题都是通用词 | 回到 Three Pillars，用贡献声明驱动 subsection 划分 |
| 贡献声明模糊 | "我们提出了一种新方法" 没有具体说新在哪里 | 要求用户补充：新在哪里、好多少、在什么条件下 |
| 缺少会议必需章节 | 投 ACL 没有 Limitations，投 NeurIPS 没有 Broader Impact | 检查上方速查表，在大纲中预留对应章节 |
| 章节篇幅失衡 | Introduction 占 3 页，Method 只有 1 页 | 在 TODO 注释中标注各节预期篇幅，总页数对齐限制 |
| Related Work 过早展开 | 大纲阶段就罗列大量文献 | Related Work 只列分类维度和代表性工作，详细内容留到写作阶段 |

## 规则

- 如果项目已有内容，分析现有结构并建议补充/调整，而不是从零开始
- 大纲应具体到 subsection 级别，每个 subsection 都有明确的写作指引
- 不编造研究内容——只提供结构框架和写作指引
- 使用与用户相同的语言交流，但 LaTeX 注释用英文

{{userInstructions}}
