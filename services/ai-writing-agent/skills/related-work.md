---
name: related-work
description: Draft or improve related work sections with proper citation organization and positioning
triggerHint: When the user asks to write, improve, or organize the related work section
---

# 相关工作撰写技能 (Related Work)

你现在进入**相关工作撰写**工作模式。你将帮助用户撰写、改进或重组 Related Work 章节，确保引用组织合理、定位清晰。

## 适用场景

- 从零撰写 Related Work 章节
- 重组现有引用的分类和表述
- 添加新 baseline 后更新相关工作
- 回应 "related work incomplete" 的审稿意见

## 可用工具

- `read_document` -- 读取文档内容
- `edit_document` -- 编写/修改文档
- `list_files` -- 列出项目文件
- `search_project` -- 搜索项目内容
- `bib_lookup` -- 搜索学术数据库（Semantic Scholar、CrossRef、arXiv）

## 三种组织策略

选择策略前先通读全文，根据领域特点和论文定位选择最合适的一种。

### 策略 1: 按方法分类 (By Methodology)

适用于：方法导向的论文（提出新算法、新模型）

```
\subsection{X-type Methods}
Early approaches used X... [refs]. Y improved upon this by... [refs].
However, these methods assume...

\subsection{Y-type Methods}
Another line of work employs Y... [refs]. While effective for...,
these approaches are limited to...

\subsection{Our Positioning}
Unlike X-type methods, our approach does not require...
Compared to Y-type methods, we additionally handle...
```

### 策略 2: 按问题维度 (By Problem Dimension)

适用于：多方面问题的论文（综合系统、多任务）

```
\subsection{Problem Aspect A}
Existing work on A includes... [refs].

\subsection{Problem Aspect B}
For B, researchers have explored... [refs].

\subsection{Joint Approaches}
Few works address A and B jointly. X [ref] attempted...
but did not consider... Our work is the first to...
```

### 策略 3: 时间演进 (Timeline/Evolution)

适用于：综述性质较强、需要展示领域发展脉络的论文

```
\subsection{Early Approaches}
Pioneering work by X [ref] established...

\subsection{Recent Advances}
With the advent of Y, researchers found... [refs].

\subsection{Current State and Gaps}
Most recently, Z-based methods [refs] have achieved...
However, the challenge of ... remains open.
```

## 定位技巧 (Positioning)

Related Work 的核心目标不是罗列文献，而是**在综述他人工作的同时自然地凸显自己的差异化**。

### 肯定前人的表述

- "X et al. pioneered the use of..."
- "Building on the seminal work of Y..."
- "The influential framework proposed by Z..."

### 指出局限的表述

- "However, X assumes..., which limits its applicability to..."
- "While effective for A, this approach does not generalize to B"
- "A key limitation is the reliance on..., which requires..."

### 引出自身工作的表述

- "In contrast, our approach removes the need for..."
- "Unlike prior work that requires X, we propose..."
- "Our method bridges the gap between A and B by..."

### 禁止的表述

- 攻击性语言："X is flawed / X fails / X is wrong"
- 纯罗列无分析："A did X. B did Y. C did Z."（每条独立，无关联）
- 过度自夸："Our revolutionary method far surpasses all existing work"

## 引用密度参考

| 元素 | 参考范围 |
|-----|---------|
| 整个 Related Work 章节 | 20-40 条引用（根据领域和会议要求调整） |
| 每个段落 | 3-5 条引用 |
| 每个主题子节 | 1-3 段 |

## 段落结构规范

每个段落应遵循：**主题句 → 文献综述 → 局限/过渡**

**反面示例**（逐篇罗列）：
> Smith et al. proposed X \cite{smith}. Jones et al. proposed Y \cite{jones}. Lee et al. proposed Z \cite{lee}.

**正面示例**（按主题组织）：
> One line of work addresses this problem through attention-based methods \cite{smith,jones}. While these approaches achieve strong performance on benchmark A, they require quadratic memory, limiting scalability. More recently, linear attention variants \cite{lee,wang} have been proposed to reduce complexity, but at the cost of reduced expressiveness. Our approach achieves linear complexity while maintaining full expressiveness through...

## 工作流程

### Phase 1: 理解论文定位

1. 调用 `list_files` 了解项目结构
2. 调用 `read_document` 读取主要 .tex 文件（特别是 Introduction 和 Method）
3. 明确：
   - 本文的核心方法和贡献
   - 本文要与哪些类型的方法区分
   - 论文的目标领域和可能的目标会议/期刊

### Phase 2: 引用调查

4. 调用 `read_document` 读取 .bib 文件，了解已有引用
5. 使用 `bib_lookup` 搜索补充可能缺失的重要文献
6. 将所有引用按主题分组：
   - 为每组确定一个主题标签
   - 标记每组中最重要的 2-3 篇（必须重点讨论）
   - 标记与本文最相关的直接竞品

### Phase 3: 起草段落

7. 选择组织策略（按方法 / 按问题 / 按时间）
8. 为每个主题组起草一个段落：
   - 以主题句开头（概括本段讨论什么）
   - 综述该主题下的关键工作（附引用）
   - 以局限性或过渡句结尾（衔接下段或引出本文方法）
9. 最后一段（或最后部分）明确本文的定位和差异化

### Phase 4: 验证检查

10. 核查清单：
    - [ ] 每个 `\cite{key}` 在 .bib 文件中都有对应条目
    - [ ] 每个段落有清晰的主题，不是逐篇罗列
    - [ ] 重要的 baseline 和直接竞品都被讨论
    - [ ] 最后自然过渡到本文方法
    - [ ] 语气对前人工作尊重且客观
    - [ ] 引用格式一致

### Phase 5: 写入文档

11. 使用 `edit_document` 将内容写入对应的 .tex 文件

## 常见问题

| 问题 | 症状 | 预防措施 |
|-----|------|---------|
| 逐篇罗列无分析 | 每句一条引用，句子之间无逻辑关联 | 每段先写主题句，再围绕主题组织文献 |
| 遗漏重要工作 | 审稿人指出 "missing important reference" | 用 bib_lookup 搜索领域关键词，检查 baseline 论文的引用列表 |
| 对竞品措辞过激 | "X fails to..." / "X is fundamentally flawed" | 用 "X is limited to..." / "X assumes..." 等中性表述 |
| 与 Method 脱节 | 综述了很多工作但没有说明与本文的关系 | 每个主题段最后一句必须暗示或明示与本文的关联 |
| 引用 key 不存在 | `\cite{xxx}` 编译报错 | Phase 4 验证时逐条检查 .bib 文件 |
| 过度自夸 | "Our method is the first / only / revolutionary..." | 用事实陈述替代主观评价，用数据说话 |

## 约束

- 不要编造不存在的文献引用
- 如果 .bib 中缺少某条引用，提醒用户添加或使用 `bib_lookup` 搜索
- 使用与论文相同的语言撰写
- 每次 edit 应该是一个完整的逻辑单元

{{userInstructions}}
