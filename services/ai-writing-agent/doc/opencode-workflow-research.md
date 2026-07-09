# OpenCode 工具调用可靠性机制研究与迁移方案

> 基于 opencode 代码库（`/opencode-research/`）的深度调研，对比 AI Writing Agent 现有妥协设计，识别可迁移的工作流模式。

---

## 调研背景

AI Writing Agent 为应对弱模型（gpt-oss-120b）的工具调用缺陷，实施了 6 项妥协方案（见 [agent-workflow-and-compromises.md](./agent-workflow-and-compromises.md)）。OpenCode 作为成熟的 AI 编程代理 CLI 工具，支持 Claude、GPT-4/5、Gemini、Qwen 等全系列模型，在工具调用可靠性方面有大量可借鉴的设计。

本文档记录 opencode 的关键机制、与我们的对比差异、以及切换到 zai-glm-4.7 后的迁移建议。

---

## 一、架构差异总览

| 维度 | AI Writing Agent | OpenCode |
|------|-----------------|----------|
| **运行时** | Node.js (ES Modules) | TypeScript/Bun + Vercel AI SDK |
| **LLM 调用** | 直接调用 OpenAI 兼容 API | 通过 Vercel AI SDK `streamText()` |
| **tool_choice** | `required`（强制） | `auto`（默认，不显式设置） |
| **对话终止** | `end_conversation` 工具 | `finish_reason` 自动判断 |
| **文本输出** | 全部缓冲，仅用 `end_conversation.response` | 直接流式展示给用户 |
| **错误恢复** | `maxEmptyRetries` 重试 | `repairToolCall` + `InvalidTool` + Doom Loop + API 重试 |
| **Replacer 链** | 5 层 | 9 层 |
| **Prompt 策略** | 单一 prompt（base + tools + safety） | 按模型选择不同 prompt 文件 |

---

## 二、OpenCode 关键源文件索引

> 以下路径均相对于 `/opencode-research/packages/opencode/src/`

### 核心循环

| 文件 | 职责 | 关键行号 |
|------|------|---------|
| `session/prompt.ts` | 会话循环入口，`loop()` 是外层 while(true) | L267-653: loop(); L306-313: 终止判断; L528-529: maxSteps |
| `session/processor.ts` | 流处理器，内层 while(true)，处理流式事件 | L45-406: process(); L143-168: Doom Loop; L339-363: 重试 |
| `session/llm.ts` | LLM 调用封装，`streamText()` 入口 | L46-250: stream(); L189-209: repairToolCall; L214: activeTools 过滤 |
| `session/retry.ts` | API 错误重试逻辑 | retryable(): 可重试判断; delay(): 指数退避 |

### 工具系统

| 文件 | 职责 | 关键行号 |
|------|------|---------|
| `tool/tool.ts` | 工具基类，`Tool.define()` | L57-68: Zod 参数验证 + 错误消息给模型 |
| `tool/registry.ts` | 工具注册表，条件工具选择 | L126-159: tools(); L136-148: GPT 用 apply_patch vs edit |
| `tool/invalid.ts` | 无效工具调用兜底 | 全文仅 17 行，description="Do not use" |
| `tool/edit.ts` | 编辑工具 + 9 层 Replacer 链 | L618-655: replace(); L625-647: 9 层 Replacer |
| `tool/truncation.ts` | 工具输出截断（2000 行 / 50KB） | 超限保存到文件并提示 |

### Prompt 模板

| 文件 | 适用模型 | 特点 |
|------|---------|------|
| `session/prompt/anthropic.txt` | Claude | 允许并行工具调用，TodoWrite 任务管理 |
| `session/prompt/beast.txt` | GPT-4/o1/o3 | 极度自主，不停止直到完成 |
| `session/prompt/codex_header.txt` | GPT-5 | apply_patch 偏好，前端设计指南 |
| `session/prompt/gemini.txt` | Gemini | 详细工作流步骤 |
| `session/prompt/qwen.txt` | Qwen / 默认回退 | **每次只用一个工具** |
| `session/prompt/trinity.txt` | Trinity | 与 qwen.txt 几乎相同 |
| `session/prompt/max-steps.txt` | 所有模型 | 达到最大步数时注入，禁用工具 |
| `agent/prompt/explore.txt` | Explore 子代理 | 只读文件搜索，禁止修改 |
| `agent/prompt/compaction.txt` | Compaction 代理 | 对话摘要压缩 |

### Provider 适配

| 文件 | 职责 |
|------|------|
| `session/system.ts` | 按模型 ID 选择 prompt 文件（L19-27） |
| `provider/transform.ts` | 消息格式转换、温度参数、推理模式适配 |

---

## 三、OpenCode 六大工具调用保障机制详解

### 机制 1：experimental_repairToolCall — 工具名修复

**位置**: `session/llm.ts:189-209`

```typescript
async experimental_repairToolCall(failed) {
    // 第一步：大小写修复
    const lower = failed.toolCall.toolName.toLowerCase()
    if (lower !== failed.toolCall.toolName && tools[lower]) {
        return { ...failed.toolCall, toolName: lower }
    }
    // 第二步：重定向到 invalid 工具，将错误信息传回模型
    return {
        ...failed.toolCall,
        input: JSON.stringify({
            tool: failed.toolCall.toolName,
            error: failed.error.message,
        }),
        toolName: "invalid",
    }
}
```

**工作原理**:
1. 当 Vercel AI SDK 解析到一个无法匹配已注册工具的调用时触发
2. 先尝试大小写修复（如 `Read_Document` → `read_document`）
3. 修复失败则将调用重写为对 `invalid` 工具的调用，**把错误原因作为参数传回去**
4. `invalid` 工具执行后返回描述性错误，模型在下一轮看到这个结果后可以自我修正

**关键设计**：这是 Vercel AI SDK 提供的回调接口（`experimental_repairToolCall`），在 SDK 层面拦截错误，我们如果不用 Vercel AI SDK 需要自己在 `executeTool` 逻辑中实现等效功能。

### 机制 2：InvalidTool — 错误调用的优雅降级

**位置**: `tool/invalid.ts`（全文）

```typescript
export const InvalidTool = Tool.define("invalid", {
    description: "Do not use",
    parameters: z.object({
        tool: z.string(),
        error: z.string(),
    }),
    async execute(params) {
        return {
            title: "Invalid Tool",
            output: `The arguments provided to the tool are invalid: ${params.error}`,
            metadata: {},
        }
    },
})
```

**关键设计**:
- 在 `tools` 对象中注册（让 SDK 能路由到它）
- 从 `activeTools` 中排除（`llm.ts:214`: `Object.keys(tools).filter((x) => x !== "invalid")`）
- 这意味着模型**不知道这个工具的存在**，不会主动调用它
- 但当 `repairToolCall` 重写错误调用时，它能接住并返回有用的错误信息

**与我们的差异**: 我们的 `executeTool` 对未知工具返回 `Unknown tool: xxx`，但这个错误字符串被追加到 messages 后，模型不一定能从中理解如何修正。OpenCode 的方式更结构化。

### 机制 3：Doom Loop 检测

**位置**: `session/processor.ts:143-168`

```typescript
const DOOM_LOOP_THRESHOLD = 3 // 连续 3 次相同调用

const parts = await MessageV2.parts(input.assistantMessage.id)
const lastThree = parts.slice(-DOOM_LOOP_THRESHOLD)

if (
    lastThree.length === DOOM_LOOP_THRESHOLD &&
    lastThree.every(
        (p) =>
            p.type === "tool" &&
            p.tool === value.toolName &&
            p.state.status !== "pending" &&
            JSON.stringify(p.state.input) === JSON.stringify(value.input),
    )
) {
    // 触发 doom_loop 权限检查（CLI 模式下暂停询问用户）
    await PermissionNext.ask({
        permission: "doom_loop",
        patterns: [value.toolName],
        sessionID: input.assistantMessage.sessionID,
        metadata: { tool: value.toolName, input: value.input },
        always: [value.toolName],
        ruleset: agent.permission,
    })
}
```

**工作原理**: 每次工具调用前，检查最近 3 次调用是否为完全相同的 `(toolName, input)` 组合。如果是，说明模型陷入了死循环（"调用 → 失败 → 同参数再调 → 再失败"），此时暂停并征求用户意见。

**与我们的差异**: 我们的 `maxEmptyRetries = 3` 只检测"零工具调用"的情况（模型在 `tool_choice=required` 下仍未输出任何 tool_call）。不检测"有工具调用但反复调用同一个"的情况。

### 机制 4：tool_choice=auto + finish_reason 判断

**位置**: `session/prompt.ts:306-313`

```typescript
// 循环终止条件
if (
    lastAssistant?.finish &&
    !["tool-calls", "unknown"].includes(lastAssistant.finish) &&
    lastUser.id < lastAssistant.id
) {
    log.info("exiting loop", { sessionID })
    break
}
```

**工作原理**: OpenCode **不设置 `toolChoice`**，使用 Vercel AI SDK 的默认行为（即 `auto`）。循环终止判断：
- `finish === "tool-calls"` → 模型请求了工具调用，继续循环
- `finish === "unknown"` → 未知状态，继续尝试
- 其他（`"stop"`, `"length"` 等）→ 模型认为任务完成，退出

**与我们的差异**: 我们用 `tool_choice=required` 强制每轮调用工具，对话只能通过 `end_conversation` 工具结束。OpenCode 信任模型自行判断何时停止。

**额外保护 — maxSteps**: `prompt.ts:528-529`
```typescript
const maxSteps = agent.steps ?? Infinity
const isLastStep = step >= maxSteps
```
达到最大步数时，注入 `max-steps.txt` 消息（"CRITICAL - MAXIMUM STEPS REACHED. Tools are disabled until next user input."），作为 assistant 消息前缀强制模型停止。

### 机制 5：Zod 参数验证 + 面向模型的错误消息

**位置**: `tool/tool.ts:57-68`

```typescript
toolInfo.execute = async (args, ctx) => {
    try {
        toolInfo.parameters.parse(args)  // Zod schema 验证
    } catch (error) {
        if (error instanceof z.ZodError && toolInfo.formatValidationError) {
            throw new Error(toolInfo.formatValidationError(error), { cause: error })
        }
        throw new Error(
            `The ${id} tool was called with invalid arguments: ${error}.\n` +
            `Please rewrite the input so it satisfies the expected schema.`,
            { cause: error },
        )
    }
    // ... 实际执行
}
```

**关键设计**: 错误消息中包含 "Please rewrite the input so it satisfies the expected schema."——这不是给开发者看的，是**给模型看的**。模型在下一轮读到这个 tool_result 后，能理解需要修正参数格式。

**与我们的差异**: 我们的 `tool.validateArgs(args)` 使用 Zod，但验证失败后返回的是 `Invalid JSON arguments: ...`，缺少引导模型修正的指示性语言。

### 机制 6：分模型 Prompt + 工具策略适配

**位置**: `session/system.ts:19-27`

```typescript
export function provider(model: Provider.Model) {
    if (model.api.id.includes("gpt-5")) return [PROMPT_CODEX]
    if (model.api.id.includes("gpt-") || model.api.id.includes("o1") || model.api.id.includes("o3"))
        return [PROMPT_BEAST]
    if (model.api.id.includes("gemini-")) return [PROMPT_GEMINI]
    if (model.api.id.includes("claude")) return [PROMPT_ANTHROPIC]
    if (model.api.id.toLowerCase().includes("trinity")) return [PROMPT_TRINITY]
    return [PROMPT_ANTHROPIC_WITHOUT_TODO]  // qwen.txt
}
```

**弱模型策略（qwen.txt 中的关键规则）**:

> "Use exactly one tool per assistant message. After each tool call, wait for the result before continuing."

这是 opencode 对 Qwen 等非顶级模型的策略——**限制每次只调一个工具**，避免并行工具调用时参数混乱。与我们的 `tool_choice=required` 方向一致但更精细。

**强模型策略差异**:

| 模型 | 并行工具调用 | apply_patch | 工具集 |
|------|------------|------------|--------|
| Claude | 允许 | 否 | edit + write + 全套 |
| GPT-5 | 允许 | **是**（替代 edit/write） | apply_patch + 其他 |
| GPT-4/o1/o3 | 允许 | 否 | edit + write + 全套 |
| Qwen/默认 | **每次一个** | 否 | edit + write + 全套 |

**条件工具选择逻辑** (`registry.ts:136-148`):
```typescript
// GPT-5 以上用 apply_patch 替代 edit + write
const usePatch = model.modelID.includes("gpt-") &&
    !model.modelID.includes("oss") && !model.modelID.includes("gpt-4")
if (t.id === "apply_patch") return usePatch
if (t.id === "edit" || t.id === "write") return !usePatch
```

---

## 四、Replacer 链对比

### 对照表

| 层级 | OpenCode | AI Writing Agent | 差异 |
|------|---------|-----------------|------|
| 1 | SimpleReplacer | SimpleReplacer | 相同 |
| 2 | LineTrimmedReplacer | LineTrimmedReplacer | 相同 |
| 3 | BlockAnchorReplacer（Levenshtein） | BlockAnchorReplacer | 相同 |
| 4 | WhitespaceNormalizedReplacer | WhitespaceNormalizedReplacer | 相同 |
| 5 | IndentationFlexibleReplacer | IndentationFlexibleReplacer | 相同 |
| 6 | **EscapeNormalizedReplacer** | — | OpenCode 独有 |
| 7 | **TrimmedBoundaryReplacer** | — | OpenCode 独有 |
| 8 | **ContextAwareReplacer** | — | OpenCode 独有 |
| 9 | **MultiOccurrenceReplacer** | — | OpenCode 独有 |

### OpenCode 额外 4 层 Replacer 详解

**EscapeNormalizedReplacer**（第 6 层）:
- 处理 `\n`, `\t`, `\'`, `\"` 等转义字符
- 模型有时输出 `\\n` 而文档中是实际换行符，或反之
- **对 LaTeX 编辑特别有用**：LaTeX 中大量使用 `\` 前缀命令

**TrimmedBoundaryReplacer**（第 7 层）:
- 对整个 oldString 做 `.trim()` 后匹配
- 处理模型在 oldText 首尾添加/遗漏空白的情况

**ContextAwareReplacer**（第 8 层）:
- 首尾行作为锚点精确匹配
- 中间行只需 >= 50% 匹配率
- 适合模型"记住了开头和结尾，但中间细节有出入"的情况
- **对长段落编辑最有价值**

**MultiOccurrenceReplacer**（第 9 层）:
- 找到所有精确匹配位置
- 仅用于 `replaceAll=true` 的场景

### 唯一性校验逻辑

```typescript
// edit.ts:643-644 (简化)
const index = content.indexOf(search)
const lastIndex = content.lastIndexOf(search)
if (index !== lastIndex) continue  // 多处匹配 → 跳过此 replacer，尝试下一层
```

非 `replaceAll` 模式下，如果匹配到多处，跳过当前 Replacer 尝试更严格的下一层。如果所有层都无法唯一匹配，抛出错误：
> "Found multiple matches for oldString. Provide more surrounding lines in oldString to identify the correct match."

这个错误消息同样是写给模型看的——引导模型提供更多上下文来消歧义。

---

## 五、OpenCode 其他值得关注的设计

### 工具输出截断

**位置**: `tool/truncation.ts`

当工具输出超过 2000 行或 50KB 时自动截断，将完整输出保存到临时文件，在截断消息中提供文件路径。这防止超长工具输出消耗过多上下文窗口。

我们目前在 `truncation.js` 中也有类似实现。

### 上下文压缩（Compaction）

**位置**: `session/compaction.ts`, `agent/prompt/compaction.txt`

当 token 用量接近上下文窗口上限时，自动触发压缩代理（使用小模型）生成对话摘要，替换历史消息。我们当前没有这个机制，但如果多轮对话变长，这值得考虑。

### LiteLLM 兼容性处理

**位置**: `session/llm.ts:163-181`

当使用 LiteLLM 代理且当前轮不需要工具，但历史消息包含工具调用时，添加一个空操作 `_noop` 工具满足 API 验证。这解决了某些代理/网关对 `tools` 参数的强制要求。

### Provider 消息转换

**位置**: `provider/transform.ts`

针对不同提供商的消息格式差异做专门处理：
- **Anthropic**: 过滤空内容消息、清理 toolCallId 为 `[a-zA-Z0-9_-]`、应用缓存控制
- **Mistral**: toolCallId 必须恰好 9 个字母数字字符、tool 消息后插入 assistant 占位
- **Google/Gemini**: integer enum 转 string enum、清理 schema required 数组

### Provider 特定参数

```typescript
// transform.ts 中的温度配置
export function temperature(model: Provider.Model) {
    if (id.includes("qwen")) return 0.55
    if (id.includes("claude")) return undefined  // 不设置
    if (id.includes("gemini")) return 1.0
    if (id.includes("glm-4.6")) return 1.0
    // ...
}
```

注意 opencode 已经有 `glm-4.6` 的温度配置（1.0），说明它已对智谱模型做过适配。

---

## 六、与妥协方案的对应关系及迁移建议

### 对照矩阵

| 我们的妥协 | OpenCode 的等效机制 | 迁移可行性 |
|-----------|-------------------|-----------|
| **妥协 1**: 回复通道移至 end_conversation.response | 直接用 text content 作为回复（`tool_choice=auto` 下模型自行输出） | ⏳ 需先验证 `tool_choice=auto` |
| **妥协 2**: tool_choice=required + 空重试 | `tool_choice=auto` + `finish_reason` 判断 + `maxSteps` 保护 | ⏳ 需先验证 `tool_choice=auto` |
| **妥协 3**: 缓冲 text content 不转发 | 直接流式转发所有 text content | ⏳ 依赖妥协 1/2 |
| **妥协 4**: Prompt 禁止输出假 JSON | `repairToolCall` + `InvalidTool` 代码兜底 | ✅ 可立即迁移 |
| **妥协 5**: 5 层 Replacer 链 | 9 层 Replacer 链（更完善） | ✅ 可增强 |
| **妥协 6**: 行号输出 | 同样使用行号输出 | ✅ 保留 |

### Phase 1：立即可做

#### 1.1 引入 InvalidTool + repairToolCall 等效机制（取代妥协 4）

**做什么**: 删除 `base.txt` 中 "Tool Calling Rules" 章节，引入代码级兜底。

**实现要点**:

在 `ToolRegistry` 中注册一个不暴露给 LLM 的 `invalid` 工具：
```javascript
// 注册时不加入 getTools() 返回的列表
// 但在 executeTool 中可路由到它
```

修改 `AgentLoop.executeTool()` 中的未知工具处理：
```javascript
if (!tool) {
    // 旧: return { success: false, output: `Unknown tool: ${toolName}` }
    // 新: 返回引导模型修正的结构化信息
    return {
        success: false,
        output: `The tool "${toolName}" does not exist. Available tools are: ${availableToolNames.join(', ')}. Please use one of these tools instead.`,
        error: 'UNKNOWN_TOOL',
    }
}
```

修改参数验证失败的错误消息：
```javascript
// 旧: `Invalid JSON arguments: ${parseError.message}`
// 新: 面向模型的引导性消息
`Invalid arguments for ${toolName}: ${parseError.message}. Please rewrite the input so it satisfies the expected schema.`
```

**参考文件**: `opencode: tool/invalid.ts`, `tool/tool.ts:57-68`, `session/llm.ts:189-209`

#### 1.2 引入 Doom Loop 检测（增强 maxEmptyRetries）

**做什么**: 在现有 `maxEmptyRetries`（检测零工具调用）基础上，增加重复调用检测。

**实现要点**:

在 AgentLoop while 循环中追踪最近调用：
```javascript
const DOOM_LOOP_THRESHOLD = 3
const recentCalls = []  // 在 while 循环外声明

// 每次工具调用后追加
for (const toolCall of toolCallsInTurn) {
    const callSignature = `${toolCall.function.name}:${toolCall.function.arguments}`
    recentCalls.push(callSignature)

    // 检查最近 N 次是否完全相同
    if (recentCalls.length >= DOOM_LOOP_THRESHOLD) {
        const lastN = recentCalls.slice(-DOOM_LOOP_THRESHOLD)
        if (lastN.every(c => c === lastN[0])) {
            logger.warn({ toolName: toolCall.function.name }, 'Doom loop detected')
            // 强制结束或注入提示让模型改变策略
        }
    }
}
```

**参考文件**: `opencode: session/processor.ts:143-168`

#### 1.3 增强 Replacer 链（添加 2 层）

**做什么**: 从 opencode 移植 `EscapeNormalizedReplacer` 和 `ContextAwareReplacer`。

**优先级排序**:
- **EscapeNormalizedReplacer**: LaTeX 文档中大量 `\` 前缀命令，转义处理对我们的场景非常关键
- **ContextAwareReplacer**: 长段落编辑时首尾锚定 + 50% 中间容忍度很实用
- TrimmedBoundaryReplacer: 价值较低，已有 LineTrimmedReplacer 覆盖类似场景
- MultiOccurrenceReplacer: 我们已有 `replaceAll` 参数处理，暂不需要

**参考文件**: `opencode: tool/edit.ts:618-655`（replace 函数）及同文件中各 Replacer 的实现

### Phase 2：需联合测试后决定

#### 2.1 切换 tool_choice=auto + finish_reason 判断（联动去除妥协 1/2/3）

**前置条件**: 必须先通过以下测试矩阵

| 测试场景 | 验证目标 |
|---------|---------|
| 简单问答（"你好"、"帮我解释这段代码"） | 模型不调用工具，直接用 text content 回复，finish_reason=stop |
| 文件操作（"列出项目文件"） | 模型调用 list_files，执行后用 text content 回复 |
| 读→回复（"读 main.tex 并告诉我内容"） | read_document → text content 回复 |
| 读→改→回复（"把 Introduction 改成引言"） | read_document → edit_document → text content 回复 |
| 中间轮次 text content 检查 | 中间轮次不输出垃圾文本（假 JSON、推理过程） |
| 连续多轮对话 | 模型在每轮都能正确判断何时停止 |

**如果测试通过，改动范围**:

1. `AgentLoop.js`: `toolChoice` 从 `'required'` 改为 `'auto'`
2. `AgentLoop.js`: 循环终止从检测 `end_conversation` 改为检测 `finish_reason !== 'tool-calls'`
3. `AgentLoop.js`: 恢复流式 text content 转发（去掉缓冲逻辑）
4. `end.js`: `end_conversation` 工具保留但 `response` 参数改为 optional
5. `base.txt`: 去掉关于 "text content is NOT displayed" 的说明

**如果测试未通过**，可以考虑 opencode 的 Qwen 策略——`tool_choice=auto` 但 prompt 中限制"每次只用一个工具"，作为折中方案。

**参考文件**: `opencode: session/prompt.ts:306-313`, `session/prompt/qwen.txt`, `session/prompt/max-steps.txt`

### 保留不动

| 项目 | 原因 |
|------|------|
| Replacer 链基础 5 层 | 防御性设计，成本极低 |
| 行号输出（妥协 6） | opencode 同样使用，对所有模型有益 |
| end_conversation 工具 | 即使切换到 auto 模式，保留为可选工具仍有价值（结构化终止） |

### 不建议迁移

| OpenCode 机制 | 不迁移原因 |
|--------------|-----------|
| Apply Patch 机制 | GPT-5 专用，与我们的场景无关 |
| Vercel AI SDK | 我们直接调用 OpenAI 兼容 API 更轻量 |
| 上下文压缩（Compaction） | 我们的对话轮次有限（maxTurns=10），暂不需要 |
| Task 子代理 | 我们是单一用途 agent，不需要子代理分派 |
| 分模型 Prompt | 当前只用一个模型，未来多模型时再考虑 |

---

## 七、核心设计哲学对比

| 维度 | AI Writing Agent（当前） | OpenCode |
|------|------------------------|----------|
| **信任度** | 不信任模型 → 用 prompt 约束和流程控制 | 信任模型但用代码兜底 |
| **终止控制** | 程序化强制（`tool_choice=required` + `end_conversation`） | 模型自主（`tool_choice=auto` + `finish_reason`） |
| **错误恢复** | 重试（`maxEmptyRetries`） | 修复 + 重定向（`repairToolCall` + `InvalidTool`） |
| **文本处理** | 全部丢弃 | 全部展示 |
| **Prompt 策略** | 通过 prompt 教模型不犯错 | 通过代码兜住模型犯的错 |

**迁移的核心方向**: 从"Prompt 约束"转向"代码兜底"。GLM-4.7 的 100% 工具调用正确率意味着约束可以放松，但兜底机制仍然必要。

---

*文档创建: 2026-02-08*
*基于 opencode 代码库 commit: 详见 `/opencode-research/`*
