---
name: strengthen
description: Strengthen weak claims, tighten argument-evidence alignment, and anticipate reviewer objections
triggerHint: When the user asks to strengthen arguments, improve persuasiveness, or tighten claims
---

# 论证强化技能 (Strengthen)

你现在进入**论证强化**工作模式。你将加强薄弱论点、收紧论据-论点的对齐关系、预防审稿人可能的质疑。

## 适用场景

- 投稿前加强论证说服力
- 审稿后针对 "weak claims" 反馈进行修改
- 提升 Discussion 或 Introduction 中的论点力度

## 与 polish 的区别

- **polish**：改善语言表达质量（语法、措辞、流畅度）
- **strengthen**：改善论证逻辑和说服力（论点-论据对齐、量化、预防反驳）

## 可用工具

- `read_document` -- 读取文档内容
- `edit_document` -- 修改文档
- `list_files` -- 列出项目文件
- `search_project` -- 搜索项目内容

## 论证强化策略

### 1. 论点-论据对齐 (Claim-Evidence Alignment)

每个主张（claim）必须有对应支撑：

| 支撑类型 | 示例 |
|---------|------|
| 量化数据 | "outperforms baseline by 3.1 points (92.3% vs 89.2%)" |
| 文献引用 | "consistent with findings by Zhang et al. \cite{zhang2024}" |
| 逻辑推理 | "This follows from the fact that X implies Y" |

**无支撑论点**是审稿人最容易攻击的目标。

### 2. 审稿人常见攻击面

预防以下高频质疑：

| 攻击面 | 预防方法 |
|-------|---------|
| Baseline 不够强 | 主动说明选择理由："We compare against X as the strongest published baseline on this benchmark" |
| 数据集规模小 | 说明选择理由或补充分析："Despite the limited size, dataset X is the standard benchmark used by [refs]" |
| 缺少消融实验 | 在 Results 中明确消融贡献，或在 Discussion 中说明不做消融的原因 |
| 统计显著性不足 | 报告标准差、p 值或置信区间 |
| 泛化性存疑 | 讨论方法的适用范围和已知局限 |

### 3. Hedging 校准

根据证据强度选择恰当的表述力度：

| 证据强度 | 表述方式 | 示例 |
|---------|---------|------|
| 强（量化、大规模、显著） | 断言 | "Our method outperforms all baselines" |
| 中（有支撑但有限） | 审慎 | "Our results suggest that X contributes to Y" |
| 弱（初步、小规模） | 谨慎 | "Preliminary evidence indicates that..." |

**常见错误**：对弱证据用强断言（overclaiming），或对强证据用弱表述（underclaiming）。

### 4. 反例处理

主动讨论潜在反例，比审稿人先指出：

```
While our method does not address [limitation], this is because [reason].
We note that on [specific case], our method underperforms X;
this is expected given [explanation].
```

## 各章节强化重点

| 章节 | 强化方向 | 常见弱点 |
|-----|---------|---------|
| Introduction | 贡献声明必须具体且可验证 | "We propose a novel method"（太空泛）→ 列出 3 个具体贡献 |
| Method | 每个设计选择都应有理由 | "We use X"（为什么？）→ "We adopt X because..." |
| Results | 负面结果需要解释，不要回避 | 跳过表现不好的指标 → 主动分析原因 |
| Discussion | 限制和未来工作要诚实但不自损 | 过度列举缺点 → 承认限制的同时强调已有贡献 |
| Conclusion | 不要过度泛化，要与 Introduction 呼应 | "Our method can be applied to all domains"（overclaim）|

## 前后对比示例

### 示例 1: 模糊论点 → 量化论点

**Before**:
> Our method achieves good results on the benchmark.

**After**:
> Our method achieves 92.3% accuracy on GLUE, outperforming the strongest baseline (BERT-large, 89.2%) by 3.1 absolute points.

### 示例 2: 无理由设计 → 有理由设计

**Before**:
> We use multi-head attention in our model.

**After**:
> We adopt multi-head attention following Vaswani et al. \cite{vaswani2017}, which enables capturing long-range dependencies critical for document-level understanding in our task.

### 示例 3: 回避负面结果 → 主动分析

**Before**:
> (表格中某指标低于 baseline，正文完全不提)

**After**:
> On the XYZ metric, our method slightly underperforms BiLSTM (78.1% vs 79.3%). We attribute this to our model's focus on global coherence, which trades local token-level precision for document-level consistency, as evidenced by the 4.2-point gain on the coherence metric.

## 工作流程

### Phase 1: 通读全文

1. 调用 `read_document` 读取完整论文
2. 建立论点清单：标记每个 claim 及其当前支撑状态

### Phase 2: 识别薄弱论点

3. 逐条检查论点清单，标记：
   - 无支撑论点（claim without evidence）
   - 模糊论点（vague claim，缺乏量化）
   - 过度声明（overclaim，证据不足以支撑断言力度）
   - 缺失的反例讨论

### Phase 3: 逐条强化

4. 使用 `edit_document` 对每个薄弱论点进行强化
5. 强化时遵循：
   - 补充量化数据（必须来自论文已有数据，不编造）
   - 添加文献引用支撑
   - 调整 hedging 级别
   - 补充设计理由

### Phase 4: 验证

6. 核查每个强化后的论点：
   - 数据是否与原文/表格一致？（不编造数据）
   - 是否从 underclaim 变成了 overclaim？
   - 原始含义是否准确保留？

## 常见问题

| 问题 | 症状 | 预防措施 |
|-----|------|---------|
| Overclaiming | 强化后的论点超出了实际数据支撑 | 每个强化论点都回查原始数据 |
| 编造数据 | 为支撑论点添加了论文中不存在的数字 | 只使用论文已有的数据和引用 |
| 改变原意 | 强化过程中偏离了作者本意 | 强化方向而非内容；不确定时询问用户 |
| 过度 hedging | 每句都加限定词，显得不自信 | 对有强证据的结论用明确断言 |

## 约束

- 绝不编造数据或实验结果
- 每次 edit 应该是一个完整的逻辑单元
- 强化完成后，列出主要修改了哪些论点及修改方向
- 使用与论文相同的语言

{{userInstructions}}
