# AI Writing Agent — 新功能工作流设计

> 基于现有深度审稿 (Deep Review) 多 agent 架构，规划更多学术写作场景的 agent 功能。
> 本文档是后续深度调研和实现的基础参考。

## 变更记录

| 日期 | 版本 | 说明 |
|------|------|------|
| 2026-02-10 | 1.0.0 | 初稿：8 个 agent 功能的完整工作流设计 |

---

## 目录

- [一、总体架构：三种执行模式](#一总体架构三种执行模式)
- [二、Quick Action 类功能](#二quick-action-类功能)
  - [2.1 学术润色 Agent](#21-学术润色-agent-academic-polish)
  - [2.2 中英互译 Agent](#22-中英互译-agent-academic-translation)
  - [2.3 Caption 生成 Agent](#23-caption-生成-agent-caption-generator)
- [三、Agent Loop 类功能](#三agent-loop-类功能)
  - [3.1 实验分析 Agent](#31-实验分析-agent-experiment-analyst)
  - [3.2 Related Work 助手](#32-related-work-助手)
  - [3.3 Rebuttal 草稿 Agent](#33-rebuttal-草稿-agent)
- [四、Coordinator + Sub-agents 类功能](#四coordinator--sub-agents-类功能)
  - [4.1 投稿前检查 Agent](#41-投稿前检查-agent-pre-submission-checklist)
  - [4.2 一致性检查 Agent](#42-一致性检查-agent-consistency-checker)
- [五、后端组件变更汇总](#五后端组件变更汇总)
- [六、API 端点汇总](#六api-端点汇总)
- [七、前端组件变更汇总](#七前端组件变更汇总)
- [八、QuickActionRunner 核心设计](#八quickactionrunner-核心设计)
- [九、实现路径建议](#九实现路径建议)
- [附录 A：参考资料来源](#附录-a参考资料来源)

---

## 一、总体架构：三种执行模式

### 1.1 现有架构回顾

当前系统有两种已实现的执行模式：

| 组件 | 文件位置 | 用途 |
|------|----------|------|
| **AgentLoop** | `app/js/agent/AgentLoop.js` | 多轮对话循环：LLM 响应 → 工具调用 → 再次 LLM → ... 直到完成 |
| **SubAgentRunner** | `app/js/review/SubAgentRunner.js` | 单次 LLM 调用，无工具循环，用于深度审稿的子 agent |

AgentLoop 的关键特征：
- AsyncGenerator 模式，yield 事件流（text / tool_call / tool_result / done）
- 支持 `maxTurns` 和 `maxToolCalls` 限制
- Doom loop 检测（最近 3 个 turn 的工具调用摘要完全重复时停止）
- `dispatch_reviewer` 类工具在 AgentLoop 中被特殊处理为并行执行（`Promise.all`），其他工具顺序执行

SubAgentRunner 的关键特征：
- 接收 paperContent + customInstructions
- 单次 `llmAdapter.chat()` 调用，tools 为空数组
- 低温度 (0.3)，返回纯文本 findings

### 1.2 新增执行模式

新功能需要引入第三种模式：**Quick Action**。

| 执行模式 | 描述 | 适用场景 | 已有范例 |
|----------|------|----------|----------|
| **Quick Action** | 选中文本 → 单次 LLM → 直接返回 pending change | 润色、翻译、Caption | 无（需新建 `QuickActionRunner`） |
| **Agent Loop** | 多轮对话，需要读写文档工具 | 实验分析、Related Work、Rebuttal | 现有 chat（`sendMessage`） |
| **Coordinator + Sub-agents** | 协调器派发多个子 agent，汇总结果 | 投稿检查、一致性检查 | 现有深度审稿（`startReview`） |

三种模式的后端映射：

```
Quick Action
  → QuickActionRunner（类似 SubAgentRunner）
  → 不经过 AgentLoop，不需要工具
  → 直接返回 { oldText, newText } 或纯文本
  → 非 SSE 响应，普通 JSON

Agent Loop
  → 复用现有 AgentLoop
  → 使用不同的 ToolRegistry 组合和 system prompt
  → 多轮 SSE 流式输出

Coordinator + Sub-agents
  → 复用 AgentLoop + dispatch_xxx 工具模式
  → 协调器读取文档 → 派发子 agent → 汇总
  → SSE 流式输出
```

### 1.3 功能与执行模式对应关系

| 功能 | 执行模式 | 优先级 | 需要新 API | 需要新前端组件 |
|------|----------|--------|-----------|--------------|
| 学术润色 | Quick Action | P0 | 是 | 是（选中工具栏） |
| 中英互译 | Quick Action | P0 | 是（同上） | 是（同上 + 翻译弹窗） |
| Caption 生成 | Quick Action | P2 | 是（同上） | 是（gutter 按钮） |
| 实验分析 | Agent Loop | P1 | 否（走 chat） | 轻微（数据输入组件） |
| Related Work | Agent Loop | P3 | 否（走 chat） | 否 |
| Rebuttal 草稿 | Agent Loop | P3 | 是 | 是（独立面板） |
| 投稿前检查 | Coordinator | P1 | 是 | 是（检查结果面板） |
| 一致性检查 | Coordinator | P2 | 否（走 chat） | 否 |

---

## 二、Quick Action 类功能

### 2.1 学术润色 Agent (Academic Polish)

#### 2.1.1 功能定义

将用户选中的 LaTeX 文本进行学术化处理。支持四种子模式：

| 子模式 | 说明 | 改动幅度 |
|--------|------|----------|
| **polish**（润色） | 提升学术表达质量，修正语法、句式、用词 | 中等 |
| **condense**（缩写） | 在不丢信息的前提下压缩文本 | 减少 5-15 词 |
| **expand**（扩写） | 补充隐含逻辑、增强连接 | 增加 5-15 词 |
| **deai**（去 AI 味） | 消除 AI 写作特征词和机械连接词 | 最小化 |

#### 2.1.2 用户交互流程

```
1. 用户在 CodeMirror 编辑器中选中一段文本
2. 选中区域上方出现浮动工具栏（Selection Tooltip）：
   [润色] [缩写] [扩写] [去AI味] [中→英] [英→中]
3. 用户点击某个按钮
4. 按钮变为 loading 状态，工具栏保持显示
5. LLM 返回结果后：
   - 选中区域变为 inline diff 视图（删除线 + 高亮新文本）
   - 工具栏变为 [Accept ✓] [Reject ✗] + 修改说明小字
6. 用户点击 Accept：
   - 调用 POST /sessions/:id/changes/:changeId/accept
   - diff 视图消失，新文本替换旧文本
7. 用户点击 Reject：
   - 调用 POST /sessions/:id/changes/:changeId/reject
   - diff 视图消失，恢复原文
```

示意图：

```
┌─────────────────────────────────────────────────┐
│  ... LaTeX content ...                          │
│                                                 │
│  ┌─ selected ────────────────────────────────┐  │
│  │ We leverage a novel approach to delve     │  │
│  │ into the intricate problem of ...         │  │
│  └───────────────────────────────────────────┘  │
│     [润色] [缩写] [扩写] [去AI味] [中→英] [英→中] │
│                                                 │
│  ↓ 用户点击 [去AI味] 后                          │
│                                                 │
│  ┌─ diff view ───────────────────────────────┐  │
│  │ We ̶l̶e̶v̶e̶r̶a̶g̶e̶ [use] a ̶n̶o̶v̶e̶l̶ [new]      │  │
│  │ approach to ̶d̶e̶l̶v̶e̶ ̶i̶n̶t̶o̶ [examine]       │  │
│  │ the ̶i̶n̶t̶r̶i̶c̶a̶t̶e̶ problem of ...            │  │
│  └───────────────────────────────────────────┘  │
│     [Accept ✓] [Reject ✗]                       │
│     修改说明：替换了 leverage→use, novel→new,     │
│     delve into→examine, 删除了 intricate         │
└─────────────────────────────────────────────────┘
```

#### 2.1.3 后端数据流

**请求：**

```
POST /api/ai/sessions/:sessionId/quick-action
Content-Type: application/json

{
  "projectId": "abc123",
  "docId": "doc456",
  "selectedText": "We leverage a novel approach to delve into...",
  "action": "deai",
  "context": {
    "surroundingText": "...前后各 ~500 字符...",
    "docPath": "/main.tex",
    "sectionTitle": "Introduction",
    "selectionRange": {
      "startLine": 42,
      "startCol": 0,
      "endLine": 45,
      "endCol": 38
    }
  }
}
```

**后端处理流程：**

```
AgentController.quickAction(req, res):
  1. 验证参数（sessionId, docId, selectedText, action）
  2. 查找 session
  3. 实例化 QuickActionRunner
  4. runner.run({
       action: "deai",
       selectedText: req.body.selectedText,
       context: req.body.context
     })
  5. 构建 Pending Change 并存入 session
  6. 返回 JSON 响应（非 SSE）
```

**响应：**

```json
{
  "success": true,
  "result": {
    "revisedText": "We use a new approach to examine the problem of...",
    "log": "替换了 leverage→use, novel→new, delve into→examine, 删除了 intricate",
    "translation": null
  },
  "pendingChange": {
    "id": "change-abc123",
    "projectId": "abc123",
    "docId": "doc456",
    "oldText": "We leverage a novel approach to delve into the intricate problem of...",
    "newText": "We use a new approach to examine the problem of...",
    "status": "pending",
    "metadata": {
      "action": "deai",
      "log": "替换了 leverage→use, novel→new, delve into→examine, 删除了 intricate"
    }
  }
}
```

#### 2.1.4 Prompt 模板设计

**文件位置：** `app/js/prompt/templates/quick-action/polish.txt`

```markdown
# Role

你是嵌入 Overleaf 编辑器的学术润色助手。你的水准对标 ICML/NeurIPS/ACL 等顶级会议的语言质量要求。

# Task

对用户选中的 LaTeX 代码片段进行深度表达润色。

# Constraints

1. 学术规范与句式优化：
   - 调整句式结构以适配顶级会议写作规范
   - 优化长难句表达，消除非母语写作导致的生硬表达
   - 彻底修正所有拼写、语法、标点及冠词使用错误

2. 词汇与语体控制：
   - 使用标准学术书面语，严禁缩写形式（it's → it is）
   - 拒绝堆砌华丽辞藻，使用科研领域通用、易理解的词汇
   - 避免名词所有格形式（METHOD's performance → the performance of METHOD）

3. LaTeX 完整性：
   - 严格保留 \cite{}, \ref{}, \label{} 等命令
   - 保留原文已有格式（\textbf{} 等），但不添加新格式
   - 正确转义特殊字符（%, _, &, #）
   - 保持数学公式原样

4. 修改阈值：
   - 如果原文已经足够好，直接原样返回
   - 不要为了修改而修改

# Output Format

严格输出以下 JSON（不要输出任何其他内容）：

```json
{
  "revisedText": "润色后的 LaTeX 文本（如无需修改则与原文相同）",
  "log": "简要说明修改了什么，用中文（如无修改则输出'原文表达规范，无需修改'）"
}
```

# Context

所在 section: {{sectionTitle}}
前后文参考（仅供理解上下文，不要包含在输出中）:
{{surroundingText}}
```

**文件位置：** `app/js/prompt/templates/quick-action/condense.txt`

```markdown
# Role

你是专注于简洁性的学术编辑。特长是在不损失信息量的前提下压缩文本长度。

# Task

对选中的 LaTeX 代码片段进行微幅缩减（减少约 5-15 个单词）。

# Constraints

1. 调整幅度：
   - 严禁大删大改，必须保留所有核心信息、技术细节及实验参数
   - 目标是少量减少字数，不要把一段话变成一句话

2. 缩减手段：
   - 句法压缩：将从句转化为短语，被动变主动（如果更简练）
   - 剔除冗余：删除无意义填充词（in order to → to）

3. LaTeX 完整性：
   - 保留所有 LaTeX 命令和数学公式
   - 正确转义特殊字符

# Output Format

```json
{
  "revisedText": "缩减后的 LaTeX 文本",
  "log": "简要说明调整了哪些地方（中文）"
}
```

# Context

所在 section: {{sectionTitle}}
前后文参考:
{{surroundingText}}
```

**文件位置：** `app/js/prompt/templates/quick-action/expand.txt`

```markdown
# Role

你是专注于逻辑流畅度的学术编辑。特长是通过深挖内容深度和增强逻辑连接，使文本更加饱满。

# Task

对选中的 LaTeX 代码片段进行微幅扩写（增加约 5-15 个单词）。

# Constraints

1. 调整幅度：
   - 严禁恶意注水，不添加无意义的形容词或重复废话

2. 扩写手段：
   - 深度挖掘：显式化原文中隐含的结论、前提或因果关系
   - 逻辑增强：增加必要的连接词以明确句间关系
   - 表达升级：将简单描述替换为更精准的学术表达

3. LaTeX 完整性：
   - 保留所有 LaTeX 命令和数学公式
   - 正确转义特殊字符

# Output Format

```json
{
  "revisedText": "扩写后的 LaTeX 文本",
  "log": "简要说明调整了哪些地方（中文）"
}
```

# Context

所在 section: {{sectionTitle}}
前后文参考:
{{surroundingText}}
```

**文件位置：** `app/js/prompt/templates/quick-action/deai.txt`

```markdown
# Role

你是学术编辑，专注于提升论文的自然度。任务是将 AI 生成的机械化文本重写为人类母语研究者的自然表达。

# Task

对选中的 LaTeX 代码片段进行"去 AI 化"重写。

# Constraints

1. 词汇规范化：
   - 避免被过度滥用的词汇：leverage → use, delve into → examine,
     tapestry → (删除), utilize → use, facilitate → enable,
     comprehensive → thorough, innovative → novel, crucial/pivotal → important,
     landscape → field, paradigm → approach, underscores → shows,
     multifaceted → (具体描述), It is worth noting that → (直接陈述)
   - 只有在必须表达特定技术含义时才使用术语

2. 结构自然化：
   - 严禁列表格式，转化为连贯段落
   - 移除机械连接词（First and foremost 等），依靠逻辑递进自然连接
   - 减少破折号（—），用逗号、括号或从句替代

3. 修改阈值：
   - 如果输入已经自然地道且无明显 AI 特征，保留原文
   - 宁缺毋滥

4. LaTeX 完整性：同其他模式

# Output Format

```json
{
  "revisedText": "重写后的 LaTeX 文本（如原文已足够好则原样返回）",
  "log": "调整了哪些机械化表达（中文），或 '原文表达地道自然，无明显 AI 味，建议保留'"
}
```

# Context

所在 section: {{sectionTitle}}
前后文参考:
{{surroundingText}}
```

#### 2.1.5 错误处理

| 场景 | 处理方式 |
|------|----------|
| 选中文本为空 | 前端禁用按钮（不发请求） |
| 选中文本过长（> 5000 字符） | 前端提示"选中文本过长，建议分段处理" |
| LLM 返回非 JSON | QuickActionRunner 捕获解析错误，返回 error 响应 |
| LLM 返回的 revisedText 与原文完全相同 | 前端显示"原文无需修改"提示，不创建 pending change |
| Session 不存在 | 复用现有 SessionNotFoundError |
| LLM 超时/限流 | 复用 LLMAdapter 的重试机制 |

---

### 2.2 中英互译 Agent (Academic Translation)

#### 2.2.1 功能定义

| 子模式 | 输入 | 输出 | 是否产生 Pending Change |
|--------|------|------|----------------------|
| **zh2en**（中→英） | 中文 LaTeX 草稿 | 英文 LaTeX + 中文直译对照 | **是**（替换为英文） |
| **en2zh**（英→中） | 英文 LaTeX 代码 | 纯中文文本（清洗后） | **否**（仅展示） |

两种模式的核心差异：
- 中→英 是一个**编辑操作**：用户的中文草稿需要被替换为英文正式文本
- 英→中 是一个**阅读辅助**：用户想理解某段英文的意思，不需要修改文档

#### 2.2.2 用户交互流程

**中→英 流程：** 与润色完全一致——选中 → 点击 [中→英] → inline diff → Accept/Reject

**英→中 流程：** 不同于润色，翻译结果以弹出面板展示：

```
1. 用户选中英文文本
2. 点击工具栏 [英→中]
3. 选中区域右侧弹出 Popover 面板：
   ┌──────────────────────────────────┐
   │  中文翻译                    [×] │
   │──────────────────────────────────│
   │  我们提出了一种新的方法来         │
   │  解决该问题。通过引入注意力       │
   │  机制，模型能够有效捕获长距       │
   │  离依赖关系。实验结果表明...      │
   │──────────────────────────────────│
   │  [复制到剪贴板]                  │
   └──────────────────────────────────┘
4. 用户阅读后关闭 popover，文档不做任何修改
```

#### 2.2.3 后端数据流

**请求（两种模式共用同一端点）：**

```
POST /api/ai/sessions/:sessionId/quick-action
{
  "action": "zh2en",  // 或 "en2zh"
  "selectedText": "...",
  "context": { ... }
}
```

**响应差异：**

```jsonc
// zh2en 响应（产生 pending change）
{
  "success": true,
  "result": {
    "revisedText": "English LaTeX text...",
    "translation": "中文直译（用于核对原意）",
    "log": "翻译说明"
  },
  "pendingChange": {
    "id": "...",
    "oldText": "中文原文",
    "newText": "English LaTeX text...",
    "status": "pending"
  }
}

// en2zh 响应（不产生 pending change）
{
  "success": true,
  "result": {
    "translatedText": "翻译后的纯中文文本...",
    "displayOnly": true
  },
  "pendingChange": null
}
```

#### 2.2.4 Prompt 模板设计

**文件位置：** `app/js/prompt/templates/quick-action/zh2en.txt`

```markdown
# Role

你是兼具顶尖科研写作专家与资深会议审稿人双重身份的翻译助手。

# Task

将用户选中的中文 LaTeX 草稿翻译并润色为英文学术论文片段。

# Constraints

1. 视觉与排版：
   - 不使用加粗、斜体或引号
   - 保持 LaTeX 源码纯净

2. 风格与逻辑：
   - 逻辑严谨，用词准确，表达凝练连贯
   - 使用常见单词，避免生僻词
   - 不使用破折号（—），用从句或同位语替代
   - 拒绝 \item 列表，使用连贯段落
   - 去除 AI 味

3. 时态规范：
   - 一般现在时描述方法、架构和实验结论
   - 仅明确提及历史事件时用过去时

4. LaTeX 规范：
   - 特殊字符转义（95% → 95\%, model_v1 → model\_v1, R&D → R\&D）
   - 保持数学公式原样

# Output Format

```json
{
  "revisedText": "翻译后的英文 LaTeX 文本",
  "translation": "对应的中文直译（用于核对是否忠于原意）",
  "log": "翻译要点说明（中文）"
}
```

# Context

所在 section: {{sectionTitle}}
前后文参考:
{{surroundingText}}
```

**文件位置：** `app/js/prompt/templates/quick-action/en2zh.txt`

```markdown
# Role

你是资深的计算机科学领域学术翻译官。帮助科研人员快速理解英文论文段落。

# Task

将用户选中的英文 LaTeX 代码片段翻译为流畅、易读的中文文本。

# Constraints

1. 语法清洗：
   - 删除所有 \cite{...}, \ref{...}, \label{...} 等索引命令
   - 提取 \textbf{text}, \emph{text} 等修饰命令中的文本内容
   - 将 LaTeX 数学公式转化为自然语言描述（$\alpha$ → alpha, \frac{a}{b} → a/b）

2. 翻译原则：
   - 严格直译，不进行润色、重写或逻辑优化
   - 中文语序尽量与英文原句保持一致
   - 不随意增减词汇，原文有语法错误也如实反映

# Output Format

```json
{
  "translatedText": "翻译后的纯中文文本段落（不含任何 LaTeX 代码）",
  "displayOnly": true
}
```
```

#### 2.2.5 前端组件需求

| 组件 | 用途 | 复用情况 |
|------|------|----------|
| `selection-toolbar.tsx` | 选中文本浮动工具栏 | 新建，润色/翻译共用 |
| `quick-action-diff.tsx` | Inline diff 视图 | 新建，润色/翻译(zh2en)共用 |
| `translation-popover.tsx` | 英→中翻译弹窗 | 新建，仅翻译(en2zh)使用 |
| `use-selection-action.ts` | 编辑器选中文本 hook | 新建 |
| `selection-tooltip.ts` | CM6 选中工具栏扩展 | 新建 |

---

### 2.3 Caption 生成 Agent (Caption Generator)

#### 2.3.1 功能定义

为 LaTeX 图表环境（`\begin{figure}` / `\begin{table}`）生成专业的 caption 文本。

#### 2.3.2 用户交互流程

**方式 A — 自动检测（编辑器 gutter 触发）：**

```
1. 系统检测到用户光标位于 \begin{figure}...\end{figure} 内
   且 \caption{} 为空（或只有 TODO 占位符）
2. 编辑器 gutter 区域显示图标按钮 [✨ 生成 Caption]
3. 用户点击按钮
4. Quick Action 执行，结果以 inline diff 形式显示在 \caption{} 位置
5. Accept/Reject
```

**方式 B — Chat 触发：**

```
用户在 chat 中说："帮我写 Figure 1 的 caption"
→ 走现有 chat 流程
→ agent 调用 read_document 读取 figure 环境
→ 调用 edit_document 填写 caption
→ 产生 pending change
```

本节仅详细设计方式 A，方式 B 无需额外设计（已有能力覆盖）。

#### 2.3.3 后端数据流

**请求：**

```
POST /api/ai/sessions/:sessionId/quick-action
{
  "action": "generate_caption",
  "selectedText": "\\begin{figure}[t]\n  \\centering\n  \\includegraphics[width=\\linewidth]{fig/architecture.pdf}\n  \\caption{}\n  \\label{fig:architecture}\n\\end{figure}",
  "context": {
    "captionType": "figure",
    "surroundingText": "...figure 所在 section 的上下文...",
    "existingCaptions": [
      "Comparison of different methods on CIFAR-10 dataset.",
      "Ablation study results across three configurations."
    ],
    "docPath": "/main.tex"
  }
}
```

**LLM 输出：**

```json
{
  "caption": "Overview of the proposed architecture. The model consists of three stages: feature extraction, attention-based fusion, and task-specific prediction heads.",
  "log": "根据 includegraphics 路径推断为架构图，参考已有 caption 风格生成"
}
```

**后端将输出转化为 Pending Change：**

```json
{
  "oldText": "\\caption{}",
  "newText": "\\caption{Overview of the proposed architecture. The model consists of three stages: feature extraction, attention-based fusion, and task-specific prediction heads.}"
}
```

#### 2.3.4 Prompt 模板设计

**文件位置：** `app/js/prompt/templates/quick-action/caption.txt`

```markdown
# Role

你是学术编辑，擅长撰写精准、规范的论文 figure/table caption。

# Task

为用户的 LaTeX 图表环境生成专业的 caption。

# Constraints

1. 格式规范：
   - 名词短语：Title Case，末尾不加句号
   - 完整句子：Sentence case，末尾加句号
   - 不要以 "The figure shows" 或 "This table presents" 开头
   - 直接描述内容（Architecture of ..., Comparison of ...）

2. 风格一致性：
   - 参考用户项目中已有的 caption 风格
   - 去 AI 味：避免 showcase, depict 等词

3. LaTeX 规范：
   - 转义特殊字符
   - 保持数学公式原样

4. 内容推断：
   - 从 \includegraphics 的路径名推断图的大致内容
   - 从 \label{} 推断标签语义
   - 从上下文 section 内容推断图表用途

# Input Context

Caption 类型: {{captionType}}
已有 caption 风格参考:
{{existingCaptions}}

所在 section 上下文:
{{surroundingText}}

# Output Format

```json
{
  "caption": "生成的 caption 文本（不含 \\caption{} 命令，只有内容）",
  "log": "生成思路（中文）"
}
```
```

#### 2.3.5 前端组件需求

| 组件 | 用途 |
|------|------|
| `caption-gutter-button.ts` | CM6 gutter decoration，检测空 `\caption{}` 并显示生成按钮 |
| 复用 `quick-action-diff.tsx` | inline diff 展示生成结果 |

检测逻辑（在 CM6 扩展中）：
- 用正则扫描当前 viewport 中的 `\caption{}` 或 `\caption{ }` 或 `\caption{TODO}`
- 匹配到时在对应行的 gutter 区域显示按钮
- 按钮点击触发 quick-action API 调用

---

## 三、Agent Loop 类功能

这类功能复用现有的 `sendMessage` 端点和 `AgentLoop`，通过 prompt 层面引导行为。核心设计原则：**不需要新 API 端点，但需要增强 prompt 和可选的前端输入组件。**

### 3.1 实验分析 Agent (Experiment Analyst)

#### 3.1.1 功能定义

用户提供实验数据，agent 分析数据并生成 LaTeX 分析段落和/或表格代码。

#### 3.1.2 用户交互流程

**方式 A — 直接在 chat 中粘贴数据：**

```
用户在 chat 输入：
  "分析一下这组实验数据：
   Method A: Acc 85.2, F1 83.1
   Method B: Acc 92.1, F1 90.5
   Ours: Acc 94.3, F1 93.8
   帮我写分析段落插入 experiments.tex"

Agent 执行（多轮）：
  Turn 1: read_document("experiments.tex") → 了解现有写作风格和结构
  Turn 2: 生成分析段落 + edit_document 插入 → pending change
  Turn 3: （可选）生成 booktabs 表格代码 + edit_document → pending change
  Turn 4: 文字总结
```

**方式 B — 结构化数据输入（推荐，需前端增强）：**

```
1. 用户点击 chat input 区域的 [📊 实验分析] 按钮
2. 弹出结构化输入面板：
   ┌──────────────────────────────────────┐
   │  实验数据分析                         │
   │──────────────────────────────────────│
   │  数据（粘贴 CSV 或表格）：            │
   │  ┌────────────────────────────────┐  │
   │  │ Method, Acc, F1, Params       │  │
   │  │ MethodA, 85.2, 83.1, 12M     │  │
   │  │ MethodB, 92.1, 90.5, 45M     │  │
   │  │ Ours, 94.3, 93.8, 15M        │  │
   │  └────────────────────────────────┘  │
   │                                      │
   │  想强调的结论（可选）：               │
   │  [我们方法在参数量更少的情况下表现最好] │
   │                                      │
   │  目标文件：[@experiments.tex ▼]      │
   │                                      │
   │  输出类型：                           │
   │  [✓] 分析段落  [✓] LaTeX 表格        │
   │                                      │
   │  [取消] [提交分析]                    │
   └──────────────────────────────────────┘
3. 提交后，结构化数据被组装为消息发送给 agent
4. Agent 流式执行，在 chat 面板中显示过程和结果
5. 生成的 pending changes 在 Pending Changes List 中展示
```

#### 3.1.3 Agent 工作流

```
[用户提交实验数据]
       ↓
[AgentLoop Turn 1]
  LLM 分析数据结构，决定需要读取哪些文件
  → tool_call: list_files()
       ↓
[AgentLoop Turn 2]
  → tool_call: read_document("experiments.tex")
  了解现有风格：\paragraph{} 格式？自由段落？已有表格风格？
       ↓
[AgentLoop Turn 3]
  LLM 生成分析段落
  → tool_call: edit_document({
       path: "experiments.tex",
       oldText: "% TODO: add analysis here",
       newText: "\\paragraph{Superior Performance with Fewer Parameters}\nOur method achieves..."
     })
       ↓
[AgentLoop Turn 4]（如果用户要求表格）
  → tool_call: edit_document({
       path: "experiments.tex",
       oldText: "% TODO: add results table",
       newText: "\\begin{table}[t]\\centering\\caption{...}\\begin{tabular}{lcc}..."
     })
       ↓
[AgentLoop Turn 5]
  文字总结：已生成 2 个修改，请在 Pending Changes 中确认
```

#### 3.1.4 Prompt 增强

不创建独立 prompt 文件。在现有 `academic.txt` 中追加实验分析指导段落：

```markdown
## Experiment Analysis Mode

When the user provides experimental data (CSV, tables, numerical comparisons),
follow this workflow:

1. Read the target document to understand existing writing style and structure
2. Analyze the data to identify:
   - SOTA comparison: which method performs best on which metric
   - Trade-offs: performance vs efficiency, accuracy vs speed
   - Key takeaways that support the paper's narrative
3. Generate LaTeX paragraphs using the \paragraph{Conclusion} + analysis pattern
4. Use edit_document to propose insertion at the appropriate location
5. If requested, also generate a booktabs-style LaTeX table

Critical rules:
- All conclusions must be strictly based on the provided data
- Do NOT fabricate data or exaggerate improvements
- If no clear advantage exists, describe the results honestly
- Use \paragraph{} with Title Case headings for each finding
- Do NOT use \textbf{} or \emph{} in the analysis text
- Different findings should be separated by blank lines
```

#### 3.1.5 前端组件需求

| 组件 | 用途 | 复杂度 |
|------|------|--------|
| `experiment-data-input.tsx` | 结构化数据输入弹窗 | 中等 |
| chat input 区域新增 [📊] 按钮 | 触发数据输入弹窗 | 低 |

---

### 3.2 Related Work 助手

#### 3.2.1 功能定义

辅助用户撰写 Related Work 章节：读取 .bib 文件和论文方向，按主题分组组织引用并生成段落。

#### 3.2.2 用户交互流程

```
用户在 chat 中触发：
  "帮我写 Related Work，方向是 RLHF alignment 和 reward hacking"
  或
  "@main.tex 帮我组织 Related Work 段落"
  或
  "@references.bib 里的引用帮我分组写 Related Work"
```

无需特殊前端组件，走标准 chat 流程。

#### 3.2.3 Agent 工作流

```
[用户请求写 Related Work]
       ↓
[AgentLoop Turn 1]
  → tool_call: list_files()
  发现项目文件结构，定位 .bib 文件和主文档
       ↓
[AgentLoop Turn 2]
  → tool_call: read_document("references.bib")
  解析 .bib 条目：提取 key, title, author, year
       ↓
[AgentLoop Turn 3]
  → tool_call: read_document("main.tex")
  读取 Introduction 和 Method，理解论文定位和贡献
       ↓
[AgentLoop Turn 4]
  LLM 根据论文方向和可用引用，规划 Related Work 结构：
  - 输出文字说明分组方案（供用户确认）
  - 例："我计划按以下主题组织：
    1. RLHF 基础方法 (引用 A, B, C)
    2. Reward Hacking 问题 (引用 D, E)
    3. 替代对齐方法 (引用 F, G)
    确认后我开始写。"
       ↓
[用户确认]
       ↓
[AgentLoop Turn 5-7]
  逐段生成 Related Work 内容
  → tool_call: edit_document({
       path: "related_work.tex" 或 "main.tex",
       oldText: "% Related Work content here",
       newText: "生成的段落（含 \cite{} 引用）"
     })
       ↓
[AgentLoop Final]
  汇总说明 + 标记 [CITATION NEEDED] 的位置
```

#### 3.2.4 Prompt 增强

在 `academic.txt` 中追加：

```markdown
## Related Work Writing Mode

When the user asks for help with Related Work:

1. Always read the .bib file first to discover available citations
2. Read Introduction and Method sections to understand positioning
3. Before writing, present a grouping plan and ask for user confirmation
4. Write cohesive paragraphs per topic group — NOT item lists
5. Citation rules:
   - Only use \cite{key} where key exists in the .bib file
   - For key topics without available citations, insert: \cite{NEEDED:topic-name}
   - Use \citet{} for "Author (Year) showed..." patterns
   - Use \citep{} for parenthetical citations
6. Structure: broad context → specific methods → identified gap → this work's approach
7. Never fabricate BibTeX entries or citation keys
```

#### 3.2.5 前端组件需求

无需新组件。完全走现有 chat 面板。

---

### 3.3 Rebuttal 草稿 Agent

#### 3.3.1 功能定义

用户粘贴审稿意见，agent 对照论文内容逐条生成 point-by-point 回复草稿。

#### 3.3.2 用户交互流程

**方式 A — Chat 触发（简单场景）：**

```
用户在 chat 中输入：
  "审稿人意见如下：
   W1: The paper lacks comparison with XYZ method.
   W2: The motivation in Section 1 is unclear.

   帮我写 rebuttal"
```

**方式 B — 独立面板（完整场景，P3 优先级）：**

```
1. 用户在 rail 中打开 "Rebuttal" tab
2. 面板分为上下两部分：
   ┌──────────────────────────────────┐
   │  Rebuttal Drafter                │
   │──────────────────────────────────│
   │  审稿意见：                       │
   │  ┌────────────────────────────┐  │
   │  │ [粘贴审稿意见全文]          │  │
   │  │                            │  │
   │  └────────────────────────────┘  │
   │                                  │
   │  目标会议：[ICML 2026      ]     │
   │  补充说明：[我们已补做了...  ]     │
   │                                  │
   │  [Start Drafting]                │
   │──────────────────────────────────│
   │  ↓ 执行后流式显示                 │
   │                                  │
   │  ## Reviewer 1                   │
   │                                  │
   │  **[W1] Lacks comparison with    │
   │  XYZ method**                    │
   │                                  │
   │  We thank the reviewer for this  │
   │  suggestion. We have added...    │
   │  (see Table 3 in the revised     │
   │  manuscript)                     │
   │                                  │
   │  **[W2] Motivation unclear**     │
   │  ...                             │
   └──────────────────────────────────┘
```

#### 3.3.3 后端执行流程

**新增端点（方式 B）：**

```
POST /api/ai/sessions/:sessionId/rebuttal
Content-Type: application/json

{
  "reviewerComments": "审稿意见全文",
  "targetVenue": "ICML 2026",
  "userNotes": "我们已经补做了 ImageNet 实验，结果在 supplementary 里"
}
```

**Agent 工作流：**

```
[接收审稿意见]
       ↓
[AgentLoop Turn 1]
  → tool_call: list_files()
  → tool_call: read_document("main.tex")
  理解论文全貌
       ↓
[AgentLoop Turn 2]
  解析审稿意见，拆分为逐条 comment
  输出解析结果（text，不是工具调用）
       ↓
[AgentLoop Turn 3-N]
  对每条 comment：
  1. 定位论文中相关段落（如需要会 read_document 其他文件）
  2. 生成回复
  以 SSE text_chunk 流式输出
       ↓
[AgentLoop Final]
  完整的 point-by-point rebuttal
  格式：Markdown（不是 LaTeX，因为 rebuttal 通常单独提交）
```

#### 3.3.4 Prompt 模板设计

**文件位置：** `app/js/prompt/templates/rebuttal/coordinator.txt`

```markdown
# Role

你是一位经验丰富的学术论文 rebuttal 撰写顾问。你熟悉顶级会议的 rebuttal 流程和策略。

# Task

根据审稿意见和论文内容，生成 point-by-point 的 rebuttal 草稿。

# Available Tools

- `list_files` — 列出项目文件
- `read_document` — 读取文档内容

# Workflow

1. 读取论文主要内容（至少 main.tex）
2. 解析审稿意见，拆分为独立 comment
3. 对每条 comment：
   - 定位论文中的相关段落
   - 判断 comment 是否合理
   - 生成回复

# Rebuttal Format

对每位 Reviewer 的每条意见，使用以下格式：

---
**[W/Q编号] 审稿人原文摘要（英文）**

回复内容...

---

# Response Strategy

- **审稿人正确时**：坦然承认，描述已做或计划做的修改，引用具体位置
- **审稿人误解时**：礼貌澄清，引用论文中的具体证据
- **需要补充实验时**：说明实验方案和预期结论，或引用用户补充说明中已完成的工作
- **观点分歧时**：用数据和逻辑论证，不要带感情色彩

# Tone

- 尊重但自信
- 每条都正面回应，不要回避尖锐问题
- 尽量量化（"we added X experiment, achieving Y% improvement, see Table Z"）
- 不要防御性或带攻击性

# Constraints

- 不要编造实验结果或数据
- 不要承诺做不到的修改
- 如果用户提供了补充说明（已做的修改），将其自然融入回复

{{userNotes}}
```

#### 3.3.5 前端组件需求

| 优先级 | 组件 | 说明 |
|--------|------|------|
| P3 | `rebuttal-pane.tsx` | 独立面板，上半部分输入审稿意见，下半部分流式展示 rebuttal |
| P3 | `rebuttal-context.tsx` | 状态管理 |
| P3 | rail-context.tsx 修改 | 新增 `'rebuttal'` tab |

方式 A（chat 触发）无需新组件，可立即使用。

---

## 四、Coordinator + Sub-agents 类功能

### 4.1 投稿前检查 Agent (Pre-submission Checklist)

#### 4.1.1 功能定义

按目标会议的投稿要求，自动化检查论文是否满足各项投稿条件。与深度审稿的区别：

| 维度 | 深度审稿 (Deep Review) | 投稿前检查 (Checklist) |
|------|----------------------|----------------------|
| 目的 | 评判论文学术质量 | 确认投稿格式/规范合规 |
| 输出 | 自由文本评审报告 | 结构化检查清单（pass/fail/warn） |
| 子 agent | content / experiment / quality | format / reference / completeness |
| 检查项 | 主观判断为主 | 客观可量化为主 |
| 可操作性 | 需要作者深入修改 | 多数问题可机械修复 |

#### 4.1.2 用户交互流程

**在 Deep Review 面板中增加模式切换：**

```
┌──────────────────────────────────────────┐
│  [Deep Review] [Pre-sub Checklist]  ← 切换│
│──────────────────────────────────────────│
│  目标会议：[ICML 2026           ▼]       │
│  [Start Check]                           │
│                                          │
│  ↓ 执行中 ...                            │
│                                          │
│  ═══ Format Check ═══                    │
│  ✓ Page Limit           9/9 pages  PASS  │
│  ✓ Font Size            10pt       PASS  │
│  ✗ Anonymization        FAIL             │
│    → Line 23: "our previous work [1]"    │
│      contains self-citation              │
│  ⚠ PDF Metadata         WARN             │
│    → Cannot verify (no compiled PDF)     │
│                                          │
│  ═══ Reference Check ═══                 │
│  ✓ All \ref{} resolved                   │
│  ✗ Dangling \label{fig:old}     FAIL     │
│    → Defined in line 142 but never       │
│      referenced                          │
│  ✓ BibTeX keys all exist                 │
│                                          │
│  ═══ Content Check ═══                   │
│  ✓ Abstract              238/250 words   │
│  ✗ Limitations section   FAIL            │
│    → Required by ICML but not found      │
│  ⚠ Broader Impact        WARN            │
│    → Recommended but not required        │
│  ✓ Ethics Statement      Found           │
│                                          │
│──────────────────────────────────────────│
│  Summary: 8 passed, 2 failed, 2 warnings │
│  [导出报告] [一键修复可自动修复的问题]      │
│──────────────────────────────────────────│
└──────────────────────────────────────────┘
```

#### 4.1.3 后端数据流

**请求：**

```
POST /api/ai/sessions/:sessionId/checklist
Content-Type: application/json

{
  "targetVenue": "ICML 2026",
  "customRules": []
}
```

**SSE 事件流：**

```jsonc
// Phase 事件
{ "type": "checklist_phase", "phase": "scanning" }

// 读取文件事件
{ "type": "tool_call", "toolCall": { "function": { "name": "read_document" } } }

// Checker 派发事件
{ "type": "checker_dispatched", "checker": "format_checker", "scope": "全文" }
{ "type": "checker_dispatched", "checker": "reference_checker", "scope": "全文" }
{ "type": "checker_dispatched", "checker": "content_checker", "scope": "全文" }

// Checker 完成事件
{
  "type": "checker_complete",
  "checker": "format_checker",
  "results": [
    { "item": "Page Limit", "status": "pass", "detail": "9/9 pages" },
    { "item": "Anonymization", "status": "fail", "detail": "Line 23: self-citation detected", "location": "main.tex:23" }
  ]
}

// 最终汇总
{ "type": "checklist_report", "report": { "passed": 8, "failed": 2, "warnings": 2, "items": [...] } }
{ "type": "done" }
```

#### 4.1.4 Coordinator Prompt 设计

**文件位置：** `app/js/prompt/templates/checklist/coordinator.txt`

```markdown
# Role

你是投稿前检查协调器。根据目标会议的投稿要求，派发专门的检查子 agent 并汇总结果。

# Available Tools

- `list_files` — 列出项目文件
- `read_document` — 读取文档内容
- `dispatch_checker` — 派发检查子 agent

# Available Checkers

- `format_checker` — 检查页数、匿名化、格式规范
- `reference_checker` — 检查引用完整性、\ref/\label 一致性、BibTeX 完整性
- `content_checker` — 检查 abstract 长度、必要章节存在性、checklist 填写

# Venue-Specific Requirements

根据 targetVenue 确定检查标准。常见会议要求：

## ICML / NeurIPS / ICLR
- 页数限制：正文 9 页（不含 references）
- 匿名审稿：正文不可含作者身份信息
- Abstract 字数：通常 250 词以内
- 必须包含：Limitations section
- 推荐包含：Broader Impact / Ethics Statement

## ACL / EMNLP
- 页数限制：长文 8 页，短文 4 页
- 匿名审稿
- 必须包含：Limitations section
- 必须包含：Ethics Statement

## CVPR / ICCV / ECCV
- 页数限制：正文 8 页
- 匿名审稿
- 推荐包含：Supplementary material

# Workflow

1. `list_files()` + `read_document()` 扫描项目结构
2. 确定目标会议要求
3. 并行 `dispatch_checker()` 派发所有 checker
4. 汇总结果为结构化清单

# Report Format

每个检查项的结果格式：

{
  "item": "检查项名称",
  "status": "pass" | "fail" | "warn",
  "detail": "具体说明",
  "location": "文件:行号（如果适用）",
  "autoFixable": true | false
}

汇总格式：

# Pre-submission Checklist Report

**Target Venue**: ICML 2026
**Check Date**: YYYY-MM-DD

## Results

| # | Item | Status | Detail |
|---|------|--------|--------|
| 1 | ... | PASS | ... |

## Summary
- Passed: N
- Failed: N
- Warnings: N

## Required Actions
（列出所有 FAIL 项的修复建议）
```

#### 4.1.5 Sub-agent 设计

**Sub-agent 注册** — 在 `app/js/review/agents.js` 中追加（或新建 `app/js/checklist/agents.js`）：

```javascript
export const CHECKLIST_AGENTS = {
  format_checker: {
    name: 'format_checker',
    description: '检查页数、匿名化、字体、边距等格式规范',
    promptTemplate: 'checklist/format',
    defaultFocus: ['全文'],
  },
  reference_checker: {
    name: 'reference_checker',
    description: '检查 \\ref/\\label 配对、\\cite 对应 BibTeX 条目、引用格式一致性',
    promptTemplate: 'checklist/reference',
    defaultFocus: ['全文', '.bib 文件'],
  },
  content_checker: {
    name: 'content_checker',
    description: '检查 abstract 长度、必要 section 存在性（Limitations/Ethics/Checklist）',
    promptTemplate: 'checklist/content',
    defaultFocus: ['全文'],
  },
}
```

**Sub-agent prompt 示例 — `checklist/format.txt`：**

```markdown
# Role

你是格式合规检查专家。你的任务是机械化、精确地检查论文的格式是否符合目标会议的要求。

# Check Items

1. **Page Limit**: 计算正文页数（从 \begin{document} 到 \bibliography 之前）
   - 估算方法：按每页约 3500 字符（含空格和命令）粗算
   - 如果文档包含 \newpage 或 \clearpage，据此分页

2. **Anonymization**: 检查正文中是否泄露作者信息
   - 搜索 "our previous work", "our earlier", "we previously" 等自引表述
   - 搜索 \author{} 命令是否被注释掉或替换为 Anonymous
   - 搜索 acknowledgments 中是否包含具名致谢
   - 搜索 URL 中是否包含个人 GitHub/主页

3. **Font and Margin**: 检查 documentclass 和 usepackage 是否使用正确的模板

# Output Format

严格输出 JSON：

{
  "checks": [
    {
      "item": "Page Limit",
      "status": "pass",
      "detail": "Estimated 8.5 pages, limit is 9",
      "location": null,
      "autoFixable": false
    },
    {
      "item": "Anonymization",
      "status": "fail",
      "detail": "Self-citation detected: 'our previous work [1]'",
      "location": "main.tex:23",
      "autoFixable": false
    }
  ]
}
```

#### 4.1.6 dispatch_checker 工具

**方案选择：**

**方案 A — 复用 dispatch_reviewer：** 在 `REVIEW_AGENTS` 中追加 checklist agent 定义，复用同一个 `dispatch_reviewer` 工具。优点是改动最小，缺点是两类 agent 混在一起。

**方案 B — 新建 dispatch_checker（推荐）：** 创建独立的 `DispatchCheckerTool`，结构与 `DispatchReviewerTool` 平行。优点是职责清晰，且 checklist sub-agent 的输出格式是结构化 JSON（而非 review 的自由文本），处理逻辑不同。

选择方案 B 时，需要在 `AgentLoop.js` 中将 `dispatch_checker` 也加入并行执行分支：

```javascript
// AgentLoop.js 中修改并行判断逻辑
const PARALLEL_TOOLS = new Set(['dispatch_reviewer', 'dispatch_checker'])

const parallelCalls = toolCallsInTurn.filter(
  tc => PARALLEL_TOOLS.has(tc.function.name)
)
```

#### 4.1.7 前端组件需求

| 组件 | 说明 |
|------|------|
| `deep-review-pane.tsx` 修改 | 增加 [Deep Review] / [Pre-sub Check] 模式切换 |
| `checklist-results.tsx` | 结构化检查结果列表（pass/fail/warn 图标 + 详情） |
| `check-item.tsx` | 单项检查结果展示组件 |
| `deep-review-context.tsx` 修改 | 增加 checklist 模式的状态管理 |

或者，更干净的方式是新建独立的 checklist context 和 pane：

| 组件 | 说明 |
|------|------|
| `checklist-pane.tsx` | 独立面板 |
| `checklist-context.tsx` | 独立状态管理 |
| `check-item.tsx` | 单项检查结果 |
| `rail-context.tsx` 修改 | 新增 `'checklist'` tab |

---

### 4.2 一致性检查 Agent (Consistency Checker)

#### 4.2.1 功能定义

轻量级的多维度一致性检查。与深度审稿 quality_checker 的区别：

| 维度 | quality_checker（深度审稿） | consistency_checker（一致性检查） |
|------|--------------------------|-------------------------------|
| 触发方式 | 深度审稿面板，一键全文 | Chat 指令，可指定范围 |
| 重量级 | 作为 3 个 sub-agent 之一 | 独立轻量检查 |
| 输出 | 自由文本发现 | 结构化错误列表 + 可选 auto-fix |
| 后续 | 用户自行修改 | Agent 可提出 pending change |

#### 4.2.2 用户交互流程

```
用户在 chat 中输入：
  "检查一下全文的一致性"
  或 "检查 @main.tex 的术语和数字一致性"
  或 "帮我看看 Introduction 和 Experiments 里的数字对不对得上"
```

走标准 chat 流程，无需独立面板。

#### 4.2.3 Agent 工作流

```
[用户请求一致性检查]
       ↓
[AgentLoop Turn 1]
  → tool_call: list_files()
  → tool_call: read_document("main.tex")
  全文扫描
       ↓
[AgentLoop Turn 2]
  → tool_call: dispatch_reviewer({
       agent: "consistency_checker",
       instructions: "重点检查术语一致性和数字一致性",
       focus_sections: ["Introduction", "Experiments"]
     })
  调用一致性检查子 agent
       ↓
[AgentLoop Turn 3]
  收到检查结果，对可自动修复的问题：
  → tool_call: edit_document({
       path: "main.tex",
       oldText: "the proposed framework",
       newText: "the proposed model",
       replaceAll: true
     })
  生成 pending change
       ↓
[AgentLoop Turn 4]
  输出总结报告：
  "检查完成。发现 3 个一致性问题：
   1. 术语不一致：'framework' 和 'model' 交替使用，已生成统一修改（pending change）
   2. 数字不匹配：Abstract 写 '94.3%' 但 Table 1 显示 '94.1%'（需手动确认）
   3. 悬空引用：\ref{fig:overview} 对应的 \label 不存在"
```

#### 4.2.4 Sub-agent 定义

在 `app/js/review/agents.js` 的 `REVIEW_AGENTS` 中追加：

```javascript
consistency_checker: {
  name: 'consistency_checker',
  description: '检查术语一致性、数字一致性（正文 vs 表格 vs 摘要）、引用一致性（\\ref 和 \\label 配对）',
  promptTemplate: 'review/consistency',
  defaultFocus: ['全文'],
},
```

**Prompt 模板 — `app/js/prompt/templates/review/consistency.txt`：**

```markdown
# Role

你是论文一致性检查专家。你的任务是精确定位论文中的机械性不一致问题。

# Check Dimensions

## 1. 术语一致性 (Terminology Consistency)
- 同一概念是否在不同位置使用了不同名称？
  例：Introduction 中叫 "framework"，Method 中叫 "model"，Experiments 中叫 "system"
- 方法名是否全文统一？
- 缩写是否在首次使用时定义，之后一致使用？

## 2. 数字一致性 (Numerical Consistency)
- Abstract 中提到的数字是否与表格/正文中一致？
- 不同表格间相同实验的数字是否一致？
- 百分比符号使用是否一致（95% vs 95\% vs 0.95）？

## 3. 引用一致性 (Reference Consistency)
- 每个 \ref{label} 是否有对应的 \label{label}？
- 每个 \label{} 是否被至少一个 \ref{} 引用？
- \cite{key} 对应的 BibTeX 条目是否存在？

## 4. 符号一致性 (Notation Consistency)
- 数学符号是否全文统一？
  例：某处用 $\mathbf{x}$，另一处用 $\boldsymbol{x}$
- 上下标使用是否一致？

# Output Format

对每个发现的问题，输出：

**[类型] 简要描述**
- 位置 A: [文件:行号] "原文片段"
- 位置 B: [文件:行号] "原文片段"
- 建议: 统一为 "xxx" / 需要作者确认正确值
- 可自动修复: 是/否

# Self-Check

- 只报告确实不一致的问题，不要报告合理的措辞变化
- 数字差异只在明确指代同一实验/指标时才报告
- 引用检查必须精确匹配 label 和 ref 的字符串
```

---

## 五、后端组件变更汇总

### 新增文件

```
services/ai-writing-agent/
├── app/js/
│   ├── quick-action/
│   │   └── QuickActionRunner.js         # Quick Action 执行器
│   ├── checklist/
│   │   └── agents.js                    # Checklist sub-agent 注册
│   ├── tool/
│   │   └── dispatch_checker.js          # Checklist 派发工具
│   └── prompt/templates/
│       ├── quick-action/
│       │   ├── polish.txt               # 润色 prompt
│       │   ├── condense.txt             # 缩写 prompt
│       │   ├── expand.txt               # 扩写 prompt
│       │   ├── deai.txt                 # 去 AI 味 prompt
│       │   ├── zh2en.txt                # 中→英 prompt
│       │   ├── en2zh.txt                # 英→中 prompt
│       │   └── caption.txt              # Caption 生成 prompt
│       ├── checklist/
│       │   ├── coordinator.txt          # 投稿检查协调器 prompt
│       │   ├── base-checker.txt         # Checker 基础 prompt
│       │   ├── format.txt               # 格式检查 prompt
│       │   ├── reference.txt            # 引用检查 prompt
│       │   └── content.txt              # 内容完整性检查 prompt
│       ├── rebuttal/
│       │   └── coordinator.txt          # Rebuttal 协调器 prompt
│       └── review/
│           └── consistency.txt          # 一致性检查 prompt（新增）
```

### 修改文件

| 文件 | 改动说明 |
|------|----------|
| `app/js/AgentController.js` | 新增 `quickAction`, `startChecklist`, `startRebuttal` 处理函数 |
| `app/js/Router.js` | 新增 3 个路由 |
| `app/js/review/agents.js` | 追加 `consistency_checker` 定义 |
| `app/js/agent/AgentLoop.js` | 并行执行判断改为 `PARALLEL_TOOLS` Set，包含 `dispatch_checker` |
| `app/js/prompt/templates/academic.txt` | 追加实验分析和 Related Work 写作指导 |
| `app/js/prompt/system.js` | 新增 `buildChecklistPrompt`, `buildRebuttalPrompt` 构建函数 |
| `config/settings.defaults.cjs` | 新增 checklist 和 rebuttal 的配置项 |

---

## 六、API 端点汇总

### 新增端点

| 方法 | 路径 | 功能 | 响应格式 | 执行模式 |
|------|------|------|----------|----------|
| POST | `/sessions/:id/quick-action` | 选中文本快捷操作 | JSON | QuickActionRunner |
| POST | `/sessions/:id/checklist` | 投稿前检查 | SSE | Coordinator + Sub-agents |
| POST | `/sessions/:id/rebuttal` | Rebuttal 草稿 | SSE | AgentLoop |

### 现有端点（无需修改，通过 prompt 增强功能）

| 端点 | 新增覆盖的功能 |
|------|--------------|
| `POST /sessions/:id/messages` | 实验分析、Related Work 写作、一致性检查 |

---

## 七、前端组件变更汇总

### 新增文件

```
services/web/frontend/js/features/ai-assistant/
├── components/
│   ├── quick-action/
│   │   ├── selection-toolbar.tsx         # 选中文本浮动工具栏
│   │   ├── quick-action-diff.tsx         # Inline diff 展示
│   │   └── translation-popover.tsx       # 英→中翻译弹窗
│   ├── checklist/
│   │   ├── checklist-pane.tsx            # 检查结果面板
│   │   └── check-item.tsx               # 单项检查结果
│   ├── rebuttal/
│   │   └── rebuttal-pane.tsx             # Rebuttal 面板（P3）
│   └── chat-input/
│       └── experiment-data-input.tsx     # 实验数据输入组件
├── context/
│   ├── quick-action-context.tsx          # Quick Action 状态管理
│   └── checklist-context.tsx             # Checklist 状态管理
├── hooks/
│   └── use-selection-action.ts           # 编辑器选中文本 hook
├── extensions/
│   ├── selection-tooltip.ts              # CM6 选中工具栏扩展
│   └── caption-gutter-button.ts          # CM6 空 caption 检测 + 生成按钮
├── api/
│   └── ai-api.ts                         # 追加 quickAction, startChecklist, startRebuttal
└── types/
    └── checklist-types.ts                # Checklist 相关类型定义
```

### 修改文件

| 文件 | 改动说明 |
|------|----------|
| `context/deep-review-context.tsx` | 增加 checklist 模式支持（或独立为 checklist-context） |
| `components/deep-review/deep-review-pane.tsx` | 增加模式切换 UI |
| `api/ai-api.ts` | 新增 `quickAction()`, `startChecklist()`, `startRebuttal()` |
| `index.ts` | 导出新组件 |
| `extensions/index.ts` | 注册 selection-tooltip 和 caption-gutter-button |
| IDE rail 相关 | 新增 checklist / rebuttal tab |

### CM6 扩展设计

**selection-tooltip.ts（选中工具栏）核心逻辑：**

```
1. 监听 EditorView 的 selection 变化
2. 当 selection 非空且长度 > 10 字符时：
   - 计算选中区域的视觉位置
   - 在选区上方渲染浮动工具栏 DOM
   - 工具栏包含 [润色] [缩写] [扩写] [去AI味] [中→英] [英→中] 按钮
3. 按钮点击时：
   - 提取 selectedText
   - 提取 surroundingText（选区前后各 500 字符）
   - 检测所在 section（向上搜索最近的 \section{} / \subsection{}）
   - 调用 quick-action API
4. 收到响应后：
   - 如果有 pendingChange：切换为 diff 视图 + Accept/Reject
   - 如果 displayOnly（英→中）：弹出 popover
5. Accept 后：通过现有 pendingChange 机制应用修改
```

---

## 八、QuickActionRunner 核心设计

### 8.1 类结构

```javascript
/**
 * QuickActionRunner — 单次 LLM 调用，用于选中文本的快捷操作
 *
 * 与 SubAgentRunner 的区别：
 * - SubAgentRunner 接收完整论文内容，用于审稿
 * - QuickActionRunner 接收选中的片段文本，用于编辑/翻译
 *
 * 与 AgentLoop 的区别：
 * - AgentLoop 是多轮工具循环
 * - QuickActionRunner 是单次调用，不使用工具
 */
export class QuickActionRunner {
  constructor({ llmAdapter }) {
    this.llmAdapter = llmAdapter
    this.maxTokens = 4096       // 输出 token 限制
    this.temperature = 0.3      // 低温度保证稳定输出
  }

  /**
   * @param {object} options
   * @param {string} options.action - 操作类型
   * @param {string} options.selectedText - 选中的原文
   * @param {object} options.context - 上下文信息
   * @returns {Promise<QuickActionResult>}
   */
  async run({ action, selectedText, context }) {
    // 1. 加载对应的 prompt 模板
    const template = await loadTemplate(`quick-action/${action}`)

    // 2. 注入上下文变量
    const systemPrompt = injectVariables(template, {
      sectionTitle: context.sectionTitle || '',
      surroundingText: context.surroundingText || '',
      captionType: context.captionType || '',
      existingCaptions: (context.existingCaptions || []).join('\n'),
    })

    // 3. 单次 LLM 调用
    const result = await this.llmAdapter.chat({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: selectedText },
      ],
      tools: [],
      stream: false,
      maxTokens: this.maxTokens,
      temperature: this.temperature,
    })

    // 4. 解析 JSON 输出（带容错）
    const parsed = this._parseResponse(result.content)

    // 5. 根据 action 类型决定返回格式
    if (action === 'en2zh') {
      return {
        type: 'display',
        content: parsed.translatedText,
        displayOnly: true,
      }
    }

    if (action === 'generate_caption') {
      return {
        type: 'pending_change',
        change: {
          oldText: this._extractEmptyCaption(selectedText),
          newText: `\\caption{${parsed.caption}}`,
        },
        metadata: { action, log: parsed.log },
      }
    }

    // polish / condense / expand / deai / zh2en
    const revisedText = parsed.revisedText
    const isUnchanged = revisedText.trim() === selectedText.trim()

    if (isUnchanged) {
      return {
        type: 'no_change',
        message: parsed.log || '原文无需修改',
      }
    }

    return {
      type: 'pending_change',
      change: {
        oldText: selectedText,
        newText: revisedText,
      },
      metadata: {
        action,
        log: parsed.log,
        translation: parsed.translation || null,
      },
    }
  }

  _parseResponse(content) {
    // 尝试从 LLM 输出中提取 JSON
    // 支持 ```json ... ``` 包裹和纯 JSON 两种格式
    // 解析失败时抛出 QuickActionParseError
  }

  _extractEmptyCaption(text) {
    // 从 figure/table 环境中提取 \caption{} 或 \caption{ }
    // 返回匹配到的空 caption 字符串
  }
}
```

### 8.2 AgentController 中的路由处理

```javascript
/**
 * Handle quick-action request
 * Non-streaming, returns JSON directly
 */
async function quickAction(req, res) {
  const { sessionId } = req.params
  const { action, selectedText, context } = req.body

  // 验证
  if (!action || !selectedText) {
    throw new ValidationError('action and selectedText are required')
  }

  const VALID_ACTIONS = ['polish', 'condense', 'expand', 'deai', 'zh2en', 'en2zh', 'generate_caption']
  if (!VALID_ACTIONS.includes(action)) {
    throw new ValidationError(`Invalid action: ${action}`)
  }

  const session = await findSession(sessionId)

  // 执行
  const runner = new QuickActionRunner({ llmAdapter })
  const result = await runner.run({ action, selectedText, context: context || {} })

  // 如果产生 pending change，存入 session
  if (result.type === 'pending_change') {
    const changeId = crypto.randomBytes(12).toString('hex')
    const pendingChange = {
      id: changeId,
      projectId: session.projectId,
      docId: context?.docId || session.currentDocId,
      ...result.change,
      status: 'pending',
      metadata: result.metadata,
      createdAt: Date.now(),
      path: context?.docPath,
    }

    await db.aiSessions.updateOne(
      { _id: session._id },
      {
        $push: { pendingChanges: pendingChange },
        $set: { updatedAt: new Date() },
      }
    )

    return res.json({
      success: true,
      result: {
        revisedText: result.change.newText,
        log: result.metadata?.log,
        translation: result.metadata?.translation,
      },
      pendingChange,
    })
  }

  if (result.type === 'display') {
    return res.json({
      success: true,
      result: {
        translatedText: result.content,
        displayOnly: true,
      },
      pendingChange: null,
    })
  }

  if (result.type === 'no_change') {
    return res.json({
      success: true,
      result: {
        message: result.message,
        noChange: true,
      },
      pendingChange: null,
    })
  }
}
```

---

## 九、实现路径建议

### Phase 1 — Quick Action 基础设施 + 润色/翻译

**范围：**
- 后端：`QuickActionRunner` + `quickAction` 端点 + 6 个 prompt 模板（polish/condense/expand/deai/zh2en/en2zh）
- 前端：`selection-toolbar` CM6 扩展 + `quick-action-diff` + `translation-popover`

**依赖关系：**
- 无外部依赖，可独立实现
- 复用现有 LLMAdapter 和 PendingChange 机制

**用户价值：** 润色和翻译是科研工作者使用频率最高的 AI 功能。完成后 Overleaf 的日常写作体验有显著提升。

### Phase 2 — 投稿前检查

**范围：**
- 后端：`dispatch_checker` 工具 + `checklist/` prompt 模板 + `startChecklist` 端点
- 前端：`checklist-pane` + `check-item` 组件
- AgentLoop 修改：并行工具集合扩展

**依赖关系：**
- 复用深度审稿的 Coordinator + SubAgentRunner 架构
- 改动量小

**用户价值：** 投稿前的机械化检查是刚需，且竞品中尚无完善的集成方案。

### Phase 3 — Chat 能力增强（实验分析 + 一致性检查）

**范围：**
- 后端：`academic.txt` prompt 增强 + `consistency_checker` sub-agent 追加
- 前端：`experiment-data-input` 组件（可选）

**依赖关系：**
- 仅修改 prompt 和 agent 注册，不需要新端点
- 风险最低

**用户价值：** 实验分析是差异化功能，一致性检查填补了深度审稿和日常使用之间的空白。

### Phase 4 — Caption + Related Work + Rebuttal

**范围：**
- Caption：`caption.txt` prompt + `caption-gutter-button` CM6 扩展
- Related Work：仅 prompt 增强
- Rebuttal：完整的新面板 + 端点 + prompt

**依赖关系：**
- Caption 依赖 Phase 1 的 Quick Action 基础设施
- Related Work 无新依赖
- Rebuttal 独立但工作量较大

**用户价值：** Caption 和 Related Work 是高频但非紧急的功能。Rebuttal 是低频但高价值的功能（投稿后才用）。

---

## 附录 A：参考资料来源

### 现有代码架构

| 组件 | 文件位置 | 说明 |
|------|----------|------|
| AgentLoop | `app/js/agent/AgentLoop.js` | 核心多轮对话循环 |
| SubAgentRunner | `app/js/review/SubAgentRunner.js` | 单次 LLM 子 agent |
| Tool 基类 | `app/js/tool/Tool.js` | 工具抽象和 Zod 校验 |
| ToolRegistry | `app/js/tool/ToolRegistry.js` | 工具注册和 OpenAI 格式转换 |
| DispatchReviewerTool | `app/js/tool/dispatch_reviewer.js` | 审稿子 agent 派发 |
| EditDocumentTool | `app/js/tool/edit.js` | Pending Change 生成 |
| Prompt 系统 | `app/js/prompt/system.js` | 模板加载和变量注入 |
| AgentController | `app/js/AgentController.js` | 路由处理（session/message/review） |
| LLMAdapter | `app/js/adapter/LLMAdapter.js` | LLM API 封装（流式/重试） |
| 前端 Context | `frontend/.../ai-assistant-context.tsx` | Reducer 状态管理 |
| Deep Review | `frontend/.../deep-review-context.tsx` | 审稿面板状态管理 |
| Rail 面板 | `frontend/.../rail-context.tsx` | IDE 侧边栏 tab 管理 |

### 外部参考

- [awesome-ai-research-writing](https://github.com/Leey21/awesome-ai-research-writing)：科研工作者高频使用的写作 prompt 集合，覆盖翻译、润色、缩写、扩写、去 AI 味、逻辑检查、实验分析、图表 caption、审稿视角检查等场景
- [AI-research-SKILLs](https://github.com/zechenzhangAGI/AI-research-SKILLs)：面向 NeurIPS/ICML/ICLR 的完整论文写作 skill，含模板管理、引用验证、投稿 checklist
- [humanizer](https://github.com/blader/humanizer)：去 AI 写作痕迹的 skill

---

*文档生成时间: 2026-02-10*
