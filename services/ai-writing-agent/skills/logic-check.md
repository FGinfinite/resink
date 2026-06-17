---
name: logic-check
description: Check document for logical contradictions, terminology inconsistency, and critical grammar ambiguity
triggerHint: When the user asks to check logic, find contradictions, or verify consistency
---

# 逻辑一致性检查技能 (Logic Check)

你现在进入**轻量级逻辑一致性检查**工作模式。这是一个**只读技能**，你不会修改任何文档，只生成检查报告。

## 何时使用 / 与 consistency-check 的区别

两个检查技能的职责边界：

| | logic-check (本技能) | consistency-check |
|--|---------------------|-------------------|
| 关注点 | **逻辑正确性** | **格式一致性** |
| 检查内容 | 数据矛盾、因果错误、术语含义混淆 | 符号统一、时态统一、排版风格统一 |
| 示例 | "Abstract 说 15% 但表格显示 8%" | "有时用 Fig. 有时用 Figure" |
| 示例 | "方法章节说用 Dataset A，实验用了 Dataset B" | "有时用 $\mathbf{x}$ 有时用 $\vec{x}$ 表示向量" |

## 可用工具

- `list_files` -- 列出项目文件结构
- `read_document` -- 读取指定文档内容
- `search_project` -- 在项目中搜索关键词

**禁止使用** `edit_document`、`create_file`、`delete_file` 等写操作工具。

## 检查范围

仅检查以下三类**实质性问题**：

### 1. 致命矛盾
前后数据或结论冲突。例如：
- Abstract 称 "提升了 15%"，Results 表格显示仅 8%
- 方法章节声称使用 Dataset A，实验章节却报告 Dataset B 的结果
- 两处对同一指标给出不同数值

### 2. 术语混乱
同一概念在不同位置使用不同名称，导致读者困惑。例如：
- 有时称 "attention mechanism"，有时称 "attention module"，有时称 "self-attention layer"，且未说明区别
- 缩写定义不一致或首次使用未定义

### 3. 严重语病导致歧义
语法问题严重到改变了句子含义或使含义无法确定。例如：
- 代词指代不清（"it" 可能指代两个不同事物）
- 否定词位置导致句意反转

## 工作流程

### Phase 1: 读取内容
1. 调用 `list_files` 了解项目结构
2. 依次调用 `read_document` 读取所有 .tex 文件（主文件优先）
3. 如文件较多，优先读取：abstract、introduction、method、experiment/results、conclusion

### Phase 2: 逐节分析
对每个章节构建：
- **术语映射**：记录每个概念的所有称谓
- **数据点**：记录所有出现的数值、百分比、指标
- **因果链**：记录关键的因果声明（X 导致 Y）

### Phase 3: 交叉验证
重点对比以下章节对：
- Abstract <-> Results（数据一致性）
- Method <-> Experiment（方法描述与实际实验一致性）
- Introduction claims <-> Conclusion claims（前后呼应）
- 各处引用的同一数据（数值一致性）

### Phase 4: 输出报告

## 高容忍阈值

**宁漏勿错**。只报告你有充分证据确认的问题：
- 如果不确定是否为问题，**不要报告**
- 表述上的微小差异（如同义词替换）不算术语混乱
- 普通语法瑕疵不报告，只报告导致歧义的严重语病
- 如果没有发现任何实质性问题，直接输出「检测通过，无实质性问题」

## 报告格式

```
# Logic Consistency Report

**检查范围**: [列出检查的文件]
**检查结果**: [发现 N 个问题 / 检测通过，无实质性问题]

---

## Issue #1: [简短问题标题]
- **类型**: 致命矛盾 / 术语混乱 / 歧义语病
- **位置**: [文件名, Section/行号]
- **问题**: [具体描述]
- **证据**: [引用原文相关片段]
- **建议**: [修正方向]

## Issue #2: ...
```

## 约束

- 使用与论文相同的语言撰写报告
- 保持节标题为英文以保持结构一致性
- 不要为了凑数量而报告不确定的问题
- 不要评价论文质量或给出写作建议，这不是审阅技能

{{userInstructions}}
