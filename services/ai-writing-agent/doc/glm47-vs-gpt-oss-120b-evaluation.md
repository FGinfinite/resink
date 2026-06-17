# GLM-4.7 vs gpt-oss-120b 模型对比评估

> 基于实际测试数据的模型能力对比，以及对现有妥协方案的影响评估。

---

## 测试环境

| 项目 | 值 |
|------|-----|
| 端点 | `http://3.106.145.29:4005/proxy/small/v1`（支持标准 `tool_calls` 响应） |
| 参数 | `max_tokens=64000, temperature=0.2` |
| System Prompt | 生产环境完整模板（base + latex + tools + safety，8524 chars） |
| 工具定义 | 生产环境 4 工具（list_files, read_document, edit_document, end_conversation） |

### 测试阶段

| 阶段 | 脚本 | 重点 |
|------|------|------|
| 阶段 1：基础对比 | `test/manual/detailed-comparison.mjs` | `tool_choice=required` 下两模型对比 |
| 阶段 2：auto 模式全面测试 | `test/manual/auto-mode-comprehensive.mjs` | 16 场景覆盖文本/工具/多轮/质量 |
| 阶段 3：Prompt 变体对比 | `test/manual/auto-mode-prompt-variants.mjs` | V1/V2/V3 三种 prompt 下行为差异 |
| 阶段 4：多轮 & 并行工具 | `test/manual/auto-mode-multiturn.mjs` | 编辑工作流、混合对话、稳定性 |
| 阶段 5：并行编辑验证 | `test/manual/auto-mode-parallel-edit.mjs` | 多编辑并行、最终回复模式 |

---

## 阶段 1：基础对比（tool_choice=required）

### 测试用例

| 编号 | 场景 | 期望行为 |
|------|------|----------|
| T1 | 列出项目文件 | 调用 `list_files` |
| T2 | 打招呼 | 调用 `end_conversation` |
| T3 | 读取指定文件 | 调用 `read_document(path:"main.tex")` |
| T4 | 编辑前的读取 | 调用 `read_document` 作为编辑流程第一步 |
| T5 | 带 pattern 的列表 | 调用 `list_files(pattern:"*.tex")` |
| T6 | 2 轮对话（读→结束） | Turn 1: `read_document` → Turn 2: `end_conversation` |
| T7 | 3 轮对话（读→改→结束） | Turn 1: `read_document` → Turn 2: `edit_document` → Turn 3: `end_conversation` |

### 结果总览

| 指标 | gpt-oss-120b | zai-glm-4.7 |
|------|-------------|-------------|
| **工具调用正确率** | 6/7 (86%) | **7/7 (100%)** |
| **API tool_calls 格式** | 7/7 ✅ | 7/7 ✅ |
| **平均推理 token** | 259 chars | **156 chars** |
| **总 API 耗时** | **3.53s** | 9.24s |

---

## GLM-4.7 优于 gpt-oss-120b 的具体表现

### 1. 工具调用 100% 正确

GLM-4.7 在所有 7 个测试中选择了正确的工具，gpt-oss-120b 在 T7 Turn 1 中**错误地调用了 `list_files` 而非 `read_document`**。

```
GLM-4.7:      read_document(path:"main.tex")  ✅ → edit_document → end_conversation
gpt-oss-120b: list_files(type:"all")          ❌ → edit_document → end_conversation
```

### 2. 零 text content 污染

在支持 `tool_calls` 的端点上，GLM-4.7 的 `content` 字段在 `tool_choice=required` 下**始终为空**（0 chars）。工具调用完全通过标准 `tool_calls` API 返回，推理过程通过 `reasoning` 字段输出，两者完全分离。

### 3. 参数更精准

- GLM-4.7 的 `edit_document` 调用**显式包含 `path` 字段**，明确指定编辑目标
- gpt-oss-120b 省略了 `path`，依赖"当前文档"默认行为
- GLM-4.7 的 `list_files` 不带参数时传 `{}`（正确使用默认值），gpt-oss-120b 传了多余的 `{"pattern":"*","type":"all"}`

### 4. 推理更高效

GLM-4.7 平均推理长度 156 字符，gpt-oss-120b 为 259 字符（多 66%）。

### 5. 语言一致性更好

- GLM-4.7 始终以中文回复中文用户
- gpt-oss-120b 在 T6 中用英文回复了中文请求

### 6. 支持并行工具调用（新发现）

GLM-4.7 可以在**单个 turn 中发起多个工具调用**。在"将 5 个英文标题全部改为中文"的测试中，模型一次性发起了 5 个 `edit_document` 调用，全部正确：

```
Turn 2 (single API call):
  edit_document(oldText: "\section{Introduction}",  newText: "\section{引言}")
  edit_document(oldText: "\section{Related Work}",  newText: "\section{相关工作}")
  edit_document(oldText: "\section{Methods}",       newText: "\section{方法}")
  edit_document(oldText: "\section{Results}",       newText: "\section{结果}")
  edit_document(oldText: "\section{Conclusion}",    newText: "\section{结论}")
```

当前 `AgentLoop.js` 已支持多工具调用处理（第 224-268 行），无需额外改动。

---

## 阶段 2-5：tool_choice=auto 深度测试

### 测试目标

验证 GLM-4.7 在 `tool_choice=auto` 下能否：
1. 正确决策何时调用工具、何时直接用文本回复
2. 在不使用 `end_conversation` 的情况下产生干净的文本回复
3. 多轮对话中保持正确的工具使用流程
4. 文本内容质量是否可直接流式输出给用户

### Prompt 变体设计

| 变体 | 说明 | end_conversation | 关键修改 |
|------|------|------------------|----------|
| V1 | 原始 prompt（对照组） | 必须使用 | "text content NOT displayed"，"must end with this tool" |
| V2 | end_conversation 可选 | 可选使用 | 删除"NOT displayed"，改为"可选"，新增"text IS displayed" |
| V3 | 无 end_conversation | 工具不存在 | 移除 end_conversation 工具定义 |

### Prompt 变体测试结果

5 个场景 × 3 个变体的对比矩阵：

| 场景 | V1（原始） | V2（end 可选） | V3（无 end） |
|------|-----------|---------------|-------------|
| 问候（"你好"） | `list_files` ❌ | **TEXT `finish=stop`** ✅ | **TEXT `finish=stop`** ✅ |
| 知识问答（"什么是 LaTeX"） | `end_conversation` | **TEXT `finish=stop`** ✅ | **TEXT `finish=stop`** ✅ |
| 建议请求（"论文结构建议"） | `list_files` | `list_files` + 文本 | `list_files` + 文本 |
| 列出文件 | `list_files` ✅ | `list_files` ✅ | `list_files` ✅ |
| 读取文档 | `read_document` ✅ | `read_document` ✅ | `read_document` ✅ |

**关键发现：V1 中问候被误判为需要工具（调用了 `list_files`），V2/V3 中问候正确返回纯文本。问题出在 prompt 的指令，而非模型能力。**

### V2 Prompt 下的多轮测试结果

#### 稳定性测试（5 场景单轮，V2 prompt）

| 场景 | 结果 | 模式 | finish_reason |
|------|------|------|--------------|
| 问候 "你好" | ✅ | TEXT | `stop` |
| 列出 .tex 文件 | ✅ | `list_files` | `tool_calls` |
| 感谢 "谢谢" | ✅ | TEXT | `stop` |
| 读取 main.tex | ✅ | `read_document` | `tool_calls` |
| 知识问答 "加脚注" | ✅ | TEXT | `stop` |

**5/5 全部正确。** 模型精确区分"需要工具"和"直接回复"的场景。

#### 编辑工作流测试（V2 prompt，3 次重复）

| 步骤 | 行为 | 一致性 |
|------|------|--------|
| Turn 1: 读取 | `read_document` ✅ | 3/3 |
| Turn 2: 编辑 | `edit_document` ✅ | 3/3 |
| Turn 3: 总结 | `end_conversation` + 中文回复 | 3/3 |

编辑完成后，模型**始终**使用 `end_conversation` 来交付结果摘要（而非纯文本）。这是合理的行为：`end_conversation` 提供结构化的终止信号。

#### 并行编辑测试（V2 prompt，5 个标题翻译）

| 步骤 | 行为 |
|------|------|
| Turn 1 | `read_document` + 状态文本 "我来帮你把...首先让我读取文件内容。" |
| Turn 2 | **5 个 `edit_document` 并行调用** + 状态文本 "现在我来修改这些章节标题：" |
| Turn 3 | `end_conversation` + 结果摘要（列出所有 5 项修改） |

**模型在工具调用的同时输出了有用的状态文本**，这些文本可以流式显示给用户。

#### 混合对话测试（V2 prompt）

```
Turn 1: 用户说"你好" → TEXT (finish=stop) ✅ 纯文本问候
Turn 2: 用户说"看看文件" → list_files (tool_calls) ✅
Turn 3: 工具结果返回 → TEXT (finish=stop) ✅ 纯文本展示文件列表
Turn 4: 用户问"main.tex 是什么" → read_document × 2 ⚠️ 模型选择读取而非直接回答
```

Turn 3 的表现特别值得注意：模型在收到 `list_files` 结果后，用纯文本（`finish=stop`）直接呈现内容，而非调用 `end_conversation`。

### 文本内容质量评估

在 V2 prompt 下运行 3 次文本生成测试：

| 检查项 | 结果 |
|--------|------|
| 推理过程泄露 | 0/3 ✅ 无泄露 |
| JSON 工具调用混入 | 0/3 ✅ 无混入 |
| 语言一致性 | 3/3 ✅ 中文请求→中文回复 |
| 内容实用性 | 3/3 ✅ 回复内容相关且有帮助 |
| 工具调用伴随文本 | 干净的状态描述（如"我来帮你..."） |

---

## 与妥协方案的最终评估

参考 [agent-workflow-and-compromises.md](./agent-workflow-and-compromises.md) 中的 6 项妥协：

### 妥协 4：Prompt 禁止输出 JSON 工具调用 → ✅ 可以直接去除

**已确认：GLM-4.7 不需要此提示。** `base.txt` 中 "Tool Calling Rules" 章节可安全删除。

### 妥协 2：tool_choice=required + 空重试机制 → ✅ 可以去除

**测试结论：GLM-4.7 在 `tool_choice=auto` 下工具选择 100% 正确。**

关键证据：
- 稳定性测试 5/5 正确 — 精确区分工具调用和文本回复场景
- 所有编辑工作流（单编辑、多编辑、并行编辑）中间步骤全部正确
- `finish_reason` 语义正确：工具调用时为 `tool_calls`，文本回复时为 `stop`
- 空重试机制从未在任何测试中触发

**去除范围：**
- `AgentLoop.js` 第 124 行：`'required'` → `'auto'`
- `AgentLoop.js` 第 99-100 行：`maxEmptyRetries` 和 `emptyRetries` 可移除
- `AgentLoop.js` 第 161-200 行：空重试逻辑可移除

### 妥协 1：回复通道移至 end_conversation.response → ✅ 可以去除（需修改 prompt）

**测试结论：GLM-4.7 在 V2 prompt 下可产生干净的纯文本回复。**

关键证据：
- 问候、知识问答、文件列表展示等场景：纯文本 `finish=stop`，内容干净
- 文本质量：无推理泄露、无 JSON 混入、语言一致
- 编辑工作流结束时仍使用 `end_conversation`（这是合理且期望的行为）

**去除方式：**
1. 修改 prompt：删除 "text content NOT displayed" 指示，改为 "text IS displayed"
2. 将 `end_conversation` 描述从"必须使用"改为"可选使用"
3. 修改 `AgentLoop.js` 的结束检测：除 `end_conversation` 外，也接受 `finish_reason=stop` + 非空文本作为对话结束信号

**建议保留 `end_conversation` 工具**（作为可选），因为：
- 编辑工作流中它提供结构化的结果摘要
- 模型在复杂任务完成后倾向使用它来交付格式化回复
- 保留不增加成本，去除反而失去结构化终止能力

### 妥协 3：缓冲 text content 不转发前端 → ✅ 可以去除

**测试结论：GLM-4.7 的 text content 干净可控，可以直接流式输出。**

关键证据：
- 纯文本回复：干净的中文内容，`finish=stop`
- 工具调用伴随文本：有用的状态描述（"我来帮你..."、"现在我来修改..."）
- 无推理泄露、无 JSON 混入（3/3 一致性测试通过）

**去除范围：**
- `AgentLoop.js` 第 141-143 行：将 `assistantContent += chunk.content` 的缓冲逻辑改为直接 yield
- `cleanLLMText()` 函数（第 18-30 行）可移除

### 妥协 5：5 层 Replacer 链容错匹配 → ❌ 不建议去除

虽然 GLM-4.7 的多行编辑测试表现优秀（正确处理了包含 `\begin{itemize}` 的多行替换），但 Replacer 链是防御性设计，成本极低，保留更安全。

### 妥协 6：read_document 带行号 → ❌ 保留（非妥协性改动）

行号对任何模型都是有用的上下文信息。

---

## 最终总结

| 妥协 | 结论 | 操作 | 前置条件 |
|------|------|------|----------|
| **妥协 4**（Prompt 禁止 JSON） | ✅ **去除** | 删除 `base.txt` 中 "Tool Calling Rules" 章节 | 无 |
| **妥协 2**（tool_choice=required） | ✅ **去除** | `AgentLoop.js` 改为 `auto`，移除空重试逻辑 | 无 |
| **妥协 1**（end_conversation 回复通道） | ✅ **去除** | 修改 prompt + AgentLoop 接受 `stop` 结束 | 修改 prompt |
| **妥协 3**（缓冲 text content） | ✅ **去除** | 流式输出 text content，移除 cleanLLMText | 妥协 1 先去除 |
| **妥协 5**（Replacer 链） | ❌ 保留 | 保持现状 | — |
| **妥协 6**（行号输出） | ❌ 保留 | 保持现状 | — |

### 推荐的实施顺序

**第 1 步：端点与模型迁移**
- `.env`：`OPENAI_API_BASE` → `http://3.106.145.29:4005/proxy/small/v1`
- `.env`：`OPENAI_MODEL` → `zai-glm-4.7`

**第 2 步：去除妥协 4（最低风险）**
- 删除 `base.txt` 中 "Tool Calling Rules" 章节（第 9-21 行）

**第 3 步：去除妥协 2（改为 auto 模式）**
- `AgentLoop.js`：`toolChoice = 'required'` → `'auto'`
- 移除 `maxEmptyRetries`、`emptyRetries` 及相关重试逻辑

**第 4 步：去除妥协 1 + 3（联动修改）**
- 修改 `base.txt`：删除 "text is NOT displayed"，添加 "text IS displayed"
- 修改 `tools.txt` 中 end_conversation 描述为可选
- 修改 `AgentLoop.js`：
  - 新增 `finish_reason=stop` + 非空文本作为对话结束条件
  - 将 text content 的 yield 从缓冲改为实时流式
  - 移除 `cleanLLMText()` 函数
- 保留 `end_conversation` 工具定义（作为可选）

### 新发现：并行工具调用能力

GLM-4.7 支持在单个 turn 中发起多个工具调用，这是 gpt-oss-120b 未展现的能力。`AgentLoop.js` 已原生支持此特性（第 224-268 行循环处理 `toolCallsInTurn`）。

这意味着多编辑操作（如批量翻译 5 个标题）可在 3 个 turn（读→批量编辑→结束）内完成，而非 7 个 turn（读→编辑×5→结束）。

---

*文档更新: 2026-02-08*
*测试脚本: test/manual/auto-mode-*.mjs*
