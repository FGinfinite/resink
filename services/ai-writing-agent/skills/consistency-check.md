---
name: consistency-check
description: Check formatting consistency (notation, tense, style, numbering) across the document
triggerHint: When the user asks to check formatting consistency, notation uniformity, or style uniformity
---

# 格式一致性检查技能 (Consistency Check)

你现在进入**格式一致性检查**工作模式。这是一个**只读技能**，你不会修改任何文档，只生成检查报告。

## 何时使用

- 投稿前最终检查
- 大幅修改（major revision）后的一致性确认
- 合并多位作者贡献后的风格统一检查

## 与 logic-check 的区别

| | consistency-check (本技能) | logic-check |
|--|--------------------------|-------------|
| 关注点 | **格式一致性** | **逻辑正确性** |
| 检查内容 | 符号统一、时态统一、排版风格统一 | 数据矛盾、因果错误、术语含义混淆 |
| 示例 | "有时用 Fig. 有时用 Figure" | "Abstract 说 15% 但表格显示 8%" |
| 示例 | "有时用 $\mathbf{x}$ 有时用 $\vec{x}$" | "方法说用 Dataset A，实验用了 Dataset B" |

## 可用工具

- `read_document` -- 读取指定文档内容
- `list_files` -- 列出项目文件结构
- `search_project` -- 在项目中搜索关键词

**禁止使用** `edit_document`、`create_file`、`delete_file` 等写操作工具。

## 专家知识：一致性检查维度

### 1. 数学符号一致性

论文中同类数学对象应使用统一的符号风格：

| 对象 | 常见选项 | 规则 |
|------|----------|------|
| 向量 | `\mathbf{x}`, `\bm{x}`, `\vec{x}` | 选一种，全文统一 |
| 矩阵 | `\mathbf{A}`, `\bm{A}` | 大写加粗，与向量区分 |
| 集合 | `\mathcal{S}`, `\mathbb{S}` | 选一种，全文统一 |
| 损失函数 | `\mathcal{L}`, `L` | 选一种，全文统一 |
| 标量 | 小写斜体 $x$ | 不加粗，与向量区分 |
| 随机变量 | 大写 $X$ 或 $\mathcal{X}$ | 与确定性变量区分 |

### 2. 时态使用约定

不同章节有约定俗成的时态使用规范：

| 章节 | 推荐时态 | 示例 |
|------|----------|------|
| Abstract | 过去时（所做工作）+ 现在时（结果含义） | "We proposed... Results show that..." |
| Introduction | 现在时（背景）+ 过去时（先前工作） | "NLP is... Smith et al. proposed..." |
| Method | 现在时 | "We propose...", "We define..." |
| Experiments | 过去时 | "We conducted...", "We evaluated..." |
| Results | 现在时 | "Table 1 shows...", "Figure 2 illustrates..." |
| Conclusion | 过去时（总结）+ 现在时（意义） | "We presented... This approach enables..." |

### 3. 排版一致性检查项

| 检查项 | 常见不一致 | 应统一为 |
|--------|-----------|----------|
| 图表引用 | "Figure 1" vs "Fig. 1" vs "figure 1" | 选一种，全文统一（注意句首必须全拼） |
| 数字格式 | 1000 vs 1,000 vs 1K | 选一种，全文统一 |
| 百分号 | 50% vs 50\% | LaTeX 中应用 50\% |
| 缩写 | 首次使用是否定义，后续是否统一使用缩写 | 首次 "Natural Language Processing (NLP)"，后续统一 "NLP" |
| 连字符 | "state-of-the-art" (形容词) vs "state of the art" (名词) | 按词性区分 |
| 列表格式 | "(1) ... (2) ..." vs "(a) ... (b) ..." vs "1) ... 2) ..." | 选一种，全文统一 |
| 省略号 | "..." vs "\ldots" | LaTeX 中应用 `\ldots` |
| 引号 | "quote" vs ``quote'' | LaTeX 中应用 `` ``quote'' `` |

## 工作流程

### Phase 1: 读取所有内容

1. 调用 `list_files` 了解项目结构
2. 依次调用 `read_document` 读取所有 .tex 文件
3. 如果文件较多，优先读取主文件和各主要章节文件

### Phase 2: 构建一致性映射表

扫描全文，为每个维度构建映射：

- **符号表**：记录每个数学概念的符号写法及出现位置
- **时态表**：记录每个章节使用的主要时态
- **格式表**：记录图表引用、数字格式、缩写等排版风格及出现位置

### Phase 3: 交叉验证

对每个映射表进行检查：
- 同一概念是否在不同位置使用了不同符号？
- 同一章节内时态是否混用？
- 排版格式是否前后不一？

### Phase 4: 输出报告

## 报告格式

```
# Consistency Check Report

**Files checked**: [列出检查的文件]
**Result**: [N inconsistencies found / All consistent]

---

## Issue #1: [简短问题标题]
- **Type**: Notation / Tense / Typography
- **Location**: [文件名, Section]
- **Problem**: [描述不一致之处]
- **Evidence**: [引用不同位置的原文]
- **Suggestion**: [建议统一为哪种形式]

## Issue #2: ...
```

## 常见问题

| 问题 | 表现 | 预防措施 |
|------|------|----------|
| 多作者风格冲突 | A 作者用 Fig.，B 作者用 Figure | 在 Phase 2 中按文件分组统计，识别风格分裂点 |
| 修改后残留旧格式 | 大部分已改为 $\mathbf{x}$，但个别地方还是 $\vec{x}$ | 用 `search_project` 搜索每种变体，确保无遗漏 |
| 复制粘贴引入不一致 | 从其他论文复制的段落使用不同符号体系 | 重点检查 Related Work 和新增段落 |

## 约束

- 使用与论文相同的语言撰写报告，保持节标题为英文以保持结构一致性
- 只报告确实存在的不一致，不要臆测
- 不要评价论文内容或逻辑（那是 logic-check 和 review 的职责）
- 对于有意为之的格式差异（如引用不同作者的符号体系进行对比），不要报告为问题

{{userInstructions}}
