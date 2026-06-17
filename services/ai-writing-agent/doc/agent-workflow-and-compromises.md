# AI Agent 工作流程与 zai-glm-4.7 适配方案

> 记录 AI Writing Agent 从 gpt-oss-120b 迁移到 zai-glm-4.7 后的核心工作流程，以及围绕新模型能力所做的架构调整。
>
> 前一版本基于 gpt-oss-120b 的妥协做法已在本次迁移中全面回退。本文档既是当前设计的技术参考，也是下次模型切换的基线对照。

---

## 一、Agent 核心工作流程（当前状态）

### 整体架构

```
用户消息
   ↓
AgentLoop.run()  ← AsyncGenerator，yield 事件流
   ↓
while (true) {
   1. Doom loop 检测 → 连续 3 次相同工具调用签名则终止
   2. 调用 LLM（streaming，tool_choice=auto）
   3. 流式转发 text content → 前端实时显示
   4. 收集 tool_calls + finish_reason
   5. 若无 tool_calls 且 finish_reason=stop → yield done → 结束
   6. yield tool_call 事件 → 前端展示"AI 正在调用 xxx"
   7. 逐个执行工具，yield tool_result 事件
   8. 如果工具返回 endConversation=true → yield text + done → 结束
   9. Doom loop digest 入队
  10. 将 assistant message + tool results 追加到 messages → 下一轮
}
   ↓
AgentController (SSE) → 前端
```

### 关键设计

| 设计点 | 说明 |
|--------|------|
| **tool_choice=auto** | 模型自行决定是否调用工具或直接输出文本。对话终止由 `finish_reason` 驱动 |
| **流式文本** | LLM 的 text content 实时 yield 给前端，用户可逐字看到回复 |
| **end_conversation 可选** | 编辑完成后推荐使用，提供结构化摘要；简单 Q&A 直接文本回复即可 |
| **Doom loop 检测** | 连续 3 轮 tool_calls 签名相同 → 自动终止并提示用户 |
| **Max turns 优雅降级** | 达到上限时不抛异常，而是注入系统提示并禁用工具，让模型输出最终文本 |
| **先读后写** | `edit_document` 强制要求先调用 `read_document`，通过 `sessionState.readDocuments`（Map）追踪 |
| **Pending Change** | 所有编辑生成待确认的 Pending Change，用户确认后才实际应用到文档 |
| **Replacer 链** | `edit_document` 使用 5 层渐进式匹配（精确 → 行 trim → 首尾锚点 → 空白归一化 → 缩进灵活）+ 唯一性校验 |

### 工具列表

| 工具 | 用途 | 调用时机 |
|------|------|----------|
| `list_files` | 列出项目文件 | 需要发现项目结构时 |
| `read_document` | 读取文档内容（带行号输出） | 编辑前必读；用户要求查看内容时 |
| `edit_document` | 提出文档编辑（支持 replaceAll） | 用户要求修改文档时 |
| `end_conversation` | 提供结构化摘要 | 编辑完成后推荐；简单对话可省略 |

---

## 二、迁移变更详述

以下按修改的文件和模块逐项说明 gpt-oss-120b → zai-glm-4.7 迁移中的每一处变更，包括**改了什么**、**为什么改**、**旧行为**对照。

### 变更 1：tool_choice 从 `required` 改为 `auto`

| 项目 | 内容 |
|------|------|
| **涉及文件** | `AgentLoop.js:131` |
| **旧行为** | `const toolChoice = 'required'` — 强制 LLM 每轮必须调用至少一个工具 |
| **新行为** | `const toolChoice = 'auto'` — 模型自行决定是否调用工具 |
| **为什么改** | gpt-oss-120b 在 `auto` 模式下行为不稳定（有时不调用工具直接生成文本，有时在不该结束时结束），所以被迫用 `required` 强制工具调用。zai-glm-4.7 在 `auto` 模式下表现稳定，压力测试 15/15 次正确选择工具或文本回复，无需强制。使用 `auto` 让模型能在不需要工具时直接输出文本（如回应简单问候），是更自然的交互模式 |
| **连带变更** | 对话终止逻辑从"必须调用 end_conversation"改为"finish_reason 驱动"（见变更 2） |

### 变更 2：对话终止机制——finish_reason 驱动

| 项目 | 内容 |
|------|------|
| **涉及文件** | `AgentLoop.js:168-224` |
| **旧行为** | 由于 `tool_choice=required`，对话只能通过 `end_conversation` 工具结束。当模型未调用工具时（违反 required 约束），进入 `emptyRetries` 重试逻辑（最多 3 次），超限后强制终止并使用 `cleanLLMText()` 清理输出 |
| **新行为** | 当 `toolCallsInTurn.length === 0` 时，检查 `finishReason`：`stop` 或 `length` 表示模型正常选择以纯文本结束 → yield done；其他情况视为异常 → 记录警告并终止 |
| **为什么改** | zai-glm-4.7 正确使用 `finish_reason=stop` 表示文本回复结束、`finish_reason=tool_calls` 表示需要执行工具调用。不再需要 "空工具重试" 这一 gpt-oss-120b 的容错机制。新机制更简洁、可预测 |

### 变更 3：LLM 文本内容从缓冲改为实时流式转发

| 项目 | 内容 |
|------|------|
| **涉及文件** | `AgentLoop.js:174-176` |
| **旧行为** | 流式处理时只缓冲 text content（`assistantContent += chunk.content`），不 yield。用户只能在 `end_conversation.response` 中看到最终回复 |
| **新行为** | 收到 text chunk 立即 yield：`yield { type: 'text', content: chunk.content }` |
| **为什么改** | gpt-oss-120b 的 text content 混杂假工具调用 JSON（如 `{"tool":"read_document","params":{"path":"main.tex"}}`）和推理过程文本，直接转发会在前端显示乱码。zai-glm-4.7 严格通过 function calling 接口调用工具，text content 输出干净，可以直接流式展示。这使用户体验从"等待 end_conversation 一次性出结果"变为"逐字看到 AI 思考和回复" |

### 变更 4：移除 `cleanLLMText()` 函数

| 项目 | 内容 |
|------|------|
| **涉及文件** | `AgentLoop.js`（删除约 23 行） |
| **旧行为** | `cleanLLMText(text)` 函数通过正则清理假工具调用 JSON（`{"tool":"...","params":{...}}`）、省略号分隔符（`...`）和多余空行 |
| **新行为** | 整个函数删除 |
| **为什么改** | 该函数完全是为了应对 gpt-oss-120b 在 text content 中输出假工具调用的行为。zai-glm-4.7 从未在 text content 中产生此类垃圾输出，函数不再有存在必要 |

### 变更 5：end_conversation 从"必须调用"降级为"推荐调用"

| 项目 | 内容 |
|------|------|
| **涉及文件** | `end.js`, `base.txt`, `tools.txt` |
| **旧行为** | Prompt 明确声明 "Every conversation MUST end with a call to `end_conversation`"；工具描述强调 `response` 参数是 "ONLY text the user will see" |
| **新行为** | Prompt 改为 "After edits, call `end_conversation` with a summary. For simple questions, respond in text directly."；工具描述增加 "For simple questions or greetings, respond directly in text without calling this tool." |
| **为什么改** | gpt-oss-120b 的 text content 不可控，所以必须把 `end_conversation.response` 作为**唯一**的用户回复通道。zai-glm-4.7 的 text content 可以直接展示给用户，`end_conversation` 退化为编辑流程的结构化摘要工具。对于简单问答（如"你好"、"LaTeX 怎么加表格？"），模型可以直接用文本回复，无需走工具调用 |

### 变更 6：Prompt 移除"Tool Calling Rules"警告章节

| 项目 | 内容 |
|------|------|
| **涉及文件** | `base.txt`（删除约 10 行） |
| **旧行为** | System prompt 中有 "Tool Calling Rules" 章节，包含 BAD/GOOD 示例，明确告知模型"DO NOT output tool calls as JSON text in your response"、"Do NOT write out your planning or reasoning about which tools to call" |
| **新行为** | 简化为三条规则："Your text content IS displayed to the user in real-time"、"For simple questions or greetings, respond directly in text"、"After completing edits, call end_conversation to provide a structured summary" |
| **为什么改** | gpt-oss-120b 经常在 text content 中输出 `{"tool":"xxx","params":{}}` 格式的假工具调用。这段 BAD/GOOD 示例专为压制该行为。zai-glm-4.7 完全通过标准 function calling 机制调用工具，无需此警告。保留反而浪费 prompt token 并增加模型的认知负荷 |

### 变更 7：温度上限从 0.2 提升到 0.5

| 项目 | 内容 |
|------|------|
| **涉及文件** | `LLMAdapter.js:59` |
| **旧行为** | `body.temperature = Math.min(body.temperature, 0.2)` |
| **新行为** | `body.temperature = Math.min(body.temperature, 0.5)` |
| **为什么改** | gpt-oss-120b 的工具调用在较高温度下不稳定，需要 0.2 的极低温度才能确保可靠的 function calling。zai-glm-4.7 在 0.5 温度下的工具选择一致性经压力测试验证（15/15 次正确，3/3 次编辑输出一致），同时 0.5 允许模型在写作建议、文本润色等场景中保留更多创造力 |

### 变更 8：Doom loop 检测（替代 emptyRetries 机制）

| 项目 | 内容 |
|------|------|
| **涉及文件** | `AgentLoop.js:99-101, 134-149, 270-277` |
| **旧行为** | `emptyRetries` 计数器：当模型未调用工具（违反 `required`）时累加，达到 3 次后强制终止 |
| **新行为** | 每轮工具调用后计算 digest（`toolName:arguments` 排序拼接），保留最近 3 条。如果 3 条完全相同，判定为 doom loop 并终止，向用户提示"检测到重复操作" |
| **为什么改** | 旧的 `emptyRetries` 是为了处理 gpt-oss-120b 在 `required` 模式下仍然不调用工具的 bug。zai-glm-4.7 使用 `auto` 模式，不调用工具是正常行为（表示文本回复），所以该机制不再适用。Doom loop 检测则解决了一个**不同的问题**：模型在遇到持续性工具错误（如文件锁定、oldText 反复匹配不上）时可能陷入无限重试。压力测试验证该机制在 H2 测试场景（文档锁定）中正确触发 |

### 变更 9：Max turns 从抛异常改为优雅降级

| 项目 | 内容 |
|------|------|
| **涉及文件** | `AgentLoop.js:107-131` |
| **旧行为** | `throw new AgentMaxTurnsError('Maximum number of turns reached')` — 直接抛异常，SSE 连接中断 |
| **新行为** | 注入系统提示 `[系统提示] 已达到最大对话轮数，工具已禁用。请直接用文本提供最终回复。`，再以 `tools: []` 调用 LLM 一次，让模型生成最终摘要后正常结束 |
| **为什么改** | 抛异常会导致前端 SSE 连接突然中断，用户看到错误提示而非有用信息。优雅降级让模型在受限条件下仍能输出有意义的回复。zai-glm-4.7 在 `tools: []` 条件下能正确生成纯文本摘要（因其 auto 模式本身就支持纯文本回复） |

### 变更 10：工具错误消息增强

| 项目 | 内容 |
|------|------|
| **涉及文件** | `AgentLoop.js:317-352`（`executeTool` 方法） |
| **旧行为** | `Unknown tool: ${toolName}`、`Invalid JSON arguments: ${parseError.message}`；参数校验错误不 try-catch（直接抛出到外层） |
| **新行为** | `Unknown tool "${toolName}". Available tools: ${available}. Please use one of these.`；`Invalid JSON in arguments for "${toolName}". Please rewrite with valid JSON.\nError: ...`；参数校验异常被 catch 并生成结构化错误消息 `Tool "${toolName}" arguments invalid. Please rewrite to satisfy the schema.\n${details}` |
| **为什么改** | gpt-oss-120b 在 `required` 模式下不太需要错误恢复——因为其行为本身就不可靠，错误消息写得再好也不影响重试成功率。zai-glm-4.7 具备**错误自适应能力**——压力测试 F 系列验证模型能根据错误消息调整策略（如扩大 oldText 上下文、使用 replaceAll）。提供更详细的错误消息使模型的自纠正更高效 |

### 变更 11：done 事件 content 包含 assistantContent

| 项目 | 内容 |
|------|------|
| **涉及文件** | `AgentLoop.js:279-289` |
| **旧行为** | `end_conversation` 触发的 done 事件 `content` 仅包含 `endResponse`（即 response 参数的值） |
| **新行为** | `content: assistantContent + (endResponse ? '\n\n' + endResponse : '')` — 同时包含模型在调用工具前输出的文本和 end_conversation 的 response |
| **为什么改** | 旧设计中 assistantContent 被视为垃圾（可能含假 JSON），不纳入最终输出。迁移后 assistantContent 是干净的、有价值的用户通信内容，应当保留 |

---

## 三、变更前后对照表

| 维度 | gpt-oss-120b（旧） | zai-glm-4.7（当前） |
|------|---------------------|---------------------|
| tool_choice | `required` | `auto` |
| 对话终止 | 只能通过 `end_conversation` | `finish_reason=stop` 或 `end_conversation` |
| LLM text content | 缓冲不展示（含垃圾输出） | 实时流式转发（输出干净） |
| 用户回复通道 | 仅 `end_conversation.response` | text content + `end_conversation.response` |
| 温度上限 | 0.2 | 0.5 |
| 空工具容错 | `emptyRetries` 重试（最多 3 次） | 不需要（auto 模式下不调用工具是正常行为） |
| 循环检测 | 无 | Doom loop 检测（连续 3 次相同 digest） |
| Max turns 超限 | 抛 `AgentMaxTurnsError` 异常 | 优雅降级（禁用工具，让模型输出文本摘要） |
| Prompt 中工具调用规则 | BAD/GOOD 示例，禁止输出 JSON | 已移除（不需要） |
| `cleanLLMText()` | 存在，清理假工具调用 JSON | 已删除 |
| 工具错误消息 | 简短，无可用工具列表 | 详细，含可用工具列表和 schema 校验细节 |

---

## 四、保留不变的设计

以下设计在迁移中**未改动**，与模型无关：

| 设计 | 说明 | 文件 |
|------|------|------|
| Replacer 链 | 5 层渐进式匹配 + 唯一性校验 | `util/replacer.js`, `adapter/DocumentAdapter.js` |
| 行号输出 | `read_document` 输出 `00001\| content` 格式 | `tool/read.js` |
| 先读后写 | `edit_document` 要求先 `read_document` | `tool/edit.js` |
| Pending Change | 编辑不立即应用，用户确认后才写入 | `tool/edit.js`, `AgentLoop.js` |
| replaceAll 参数 | edit_document 支持全局替换 | `tool/edit.js` |
| readDocuments Map | 追踪读取时的版本号和时间 | `AgentLoop.js` |
| LLM 重试机制 | 指数退避，最多 3 次重试 | `LLMAdapter.js` |
| SSE 事件格式 | tool_call、tool_result、pending_change 事件类型 | `AgentController.js` |

---

## 五、压力测试验证

迁移完成后通过 `test/manual/model-stress-test.mjs` 进行了 15 项复杂场景测试：

| 类别 | 测试数 | 结果 | 验证内容 |
|------|--------|------|----------|
| E: 复杂编辑 | 4 | 4 PASS | 嵌套 LaTeX 表格、数学公式替换、跨文件编辑、多要求复合编辑 |
| F: 错误恢复 | 3 | 3 PASS | oldText 匹配失败重试、文件不存在处理、multiple matches 后扩展上下文 |
| G: 模糊请求 | 3 | 3 PASS | 审阅 vs 编辑判断、隐含 vs 显式请求、追问建议不做未授权编辑 |
| H: 长对话 | 3 | 2 PASS / 1 WARN | 5 轮交替对话、doom loop 抵抗（文档锁定场景）、上下文保持 |
| I: 温度稳定性 | 2 | 2 PASS | 0.5 温度下 15 次工具选择一致、3 次编辑输出一致 |

**总计：14 PASS / 1 WARN / 0 FAIL**

测试脚本已改造为模型无关的可复用版本，支持通过 CLI 参数 / 环境变量 / .env 文件配置模型和参数，便于未来换模型时复用。

---

## 六、未来模型切换指引

当需要切换到新模型时：

1. **修改 `.env`**：更新 `OPENAI_MODEL` 和 `OPENAI_API_BASE`
2. **运行压力测试**：`node test/manual/model-stress-test.mjs`，观察 15 项测试结果
3. **评估是否需要调整**：
   - 如果 I 类（温度稳定性）失败 → 考虑降低 `LLMAdapter.js` 中的温度上限
   - 如果 E 类（复杂编辑）失败 → 检查模型的 function calling 是否规范
   - 如果 G 类（模糊请求）失败 → 可能需要调回 `tool_choice=required` 并恢复 end_conversation 强制调用
   - 如果模型在 text content 中输出假工具调用 JSON → 需恢复缓冲机制和 `cleanLLMText()`，参考 git 历史中 gpt-oss-120b 时期的实现
4. **参照本文档的变更对照表**，判断哪些当前设计需要回退

---

*文档更新时间: 2026-02-08*
*对应模型: zai-glm-4.7*
*对应提交: feat(ai-writing-agent): add model-compromise workarounds 之后的迁移提交*
