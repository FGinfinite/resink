# AI 工具调用交叉渲染 — 问题分析与方案

> 状态：待实施
> 创建时间：2026-02-09
> 前置提交：`fd17dec` feat(ai-assistant): add tool call display system in chat panel

---

## 问题描述

### 当前行为

当前实现将工具调用状态统一显示在流式消息顶部，文本内容拼接在下方：

```
[folder_open] 已列出 4 个文件
[description] 已读取 /main.tex (197 行)
[edit_note]   已生成编辑方案: main.tex

让我先列出项目文件...好的，现在读取主文档...已读取内容，让我添加注释总结...已完成任务！以下是工作总结：...
```

### 实际的事件流

AgentLoop 产生的 SSE 事件是**交替**的：

```
text_chunk:  "让我先列出项目文件..."
tool_call:   list_files
tool_result: list_files → 4 个文件
text_chunk:  "好的，现在读取主文档..."
tool_call:   read_document
tool_result: read_document → 197 行
text_chunk:  "已读取内容，让我添加注释总结..."
tool_call:   edit_document
tool_result: edit_document → 生成编辑方案
text_chunk:  "已完成任务！以下是工作总结：..."
message_complete
```

### 核心问题

1. **文本丢失分段结构**：多轮 LLM 输出被拼成一整段，AI 的思考过程不可见
2. **工具调用脱离上下文**：用户无法看出工具调用与文本之间的时序关系
3. **透明度不足**：当 AI 中途改变策略（如读错文件后重新读取），用户完全感知不到

---

## 期望行为

文本和工具调用按时序交叉展示：

```
让我先列出项目文件...
  [folder_open] 已列出 4 个文件
好的，现在读取主文档...
  [description] 已读取 /main.tex (197 行)
已读取内容，让我添加注释总结...
  [edit_note] 已生成编辑方案: main.tex
已完成任务！以下是工作总结：...（后续文本）
```

这也是 Claude.ai、ChatGPT 等主流 AI 产品采用的展示模式。

---

## 调研结论

### 第三方库评估

| 方案 | 交叉工具调用 | 流式支持 | 可只用渲染层 | 侵入性 | 结论 |
|------|------------|---------|------------|--------|------|
| **Vercel AI SDK** (`ai`) | `message.parts` 模型 | 原生 | 可借鉴数据模型 | 低 | 数据模型值得参考，但整体 SDK 过重 |
| **@assistant-ui/react** | `makeAssistantToolUI` | 原生 | 需写 custom runtime adapter | 中 | 功能完整但抽象层过厚 |
| **CopilotKit** | AG-UI 协议 | 支持 | 需用它的 context | 高 | 接管状态管理，不适合 |
| **Streamdown** | 不涉及 | 专为流式设计 | 纯渲染 | 低 | 解决流式 Markdown，不解决 content blocks |

### 结论

**没有现成库能直接拿来用**，原因：
- 功能匹配的（Vercel AI SDK、assistant-ui）绑定了自己的状态管理，与我们已有的 context + reducer + SSE 协议冲突
- 纯渲染层的（Streamdown）只解决 Markdown 渲染，不解决 content blocks 编排
- 嵌入在 Overleaf 编辑器面板中的特殊场景，集成外部 UI 框架成本高

### 推荐路线

**借鉴 Vercel AI SDK 的 `message.parts` 数据模型，自行实现 content blocks 渲染。**

---

## 实施方案概要

### 核心数据模型变更

```typescript
// 内容块类型（参考 Vercel AI SDK 的 message.parts）
type ContentBlock =
  | { type: 'text'; content: string }
  | { type: 'tool_call'; entry: ToolCallEntry }

// 消息结构
interface AIMessage {
  id: string
  role: MessageRole
  contentBlocks: ContentBlock[]   // 替代 content + toolCalls
  timestamp: number
  pending?: boolean
}

// State 变更
interface AIAssistantState {
  // ...其他字段不变
  activeBlocks: ContentBlock[]    // 替代 streamingContent + activeToolCalls
}
```

### 改动范围

| 层级 | 文件 | 改动 |
|------|------|------|
| 类型 | `types/ai-types.ts` | 新增 `ContentBlock`，修改 `AIMessage`/`AIAssistantState` |
| Reducer | `context/ai-assistant-context.tsx` | `text_chunk` → 追加到最近的 text block 或创建新 block；`tool_call/tool_result` → 追加/更新 tool block；`MESSAGE_COMPLETE` → 持久化 `activeBlocks` 为 `contentBlocks` |
| 渲染 | `components/message-list.tsx` | 遍历 `contentBlocks`，按 type 分发渲染（文本 → `MessageContent`，工具 → `ToolCallItem`） |
| 后端 | `AgentController.js` | 保存 `contentBlocks` 替代 `content` + `toolCalls`（或做兼容映射） |
| 兼容 | `getSession` | 旧消息（只有 `content` 字段）需要兼容转换为 `contentBlocks` |

### Reducer 逻辑要点

```
SEND_MESSAGE_START → activeBlocks: []
RECEIVE_TEXT_CHUNK  →
  if 最后一个 block 是 text → 追加 content
  else → push 新 text block
RECEIVE_TOOL_CALL   → push 新 tool_call block (status: running)
RECEIVE_TOOL_RESULT → 找到对应 tool_call block，更新 status/result
MESSAGE_COMPLETE    → 将 activeBlocks 存入消息的 contentBlocks，清空
```

### 后端持久化策略

两种选择：

1. **直接保存 contentBlocks**：结构清晰，但破坏向后兼容
2. **保存 content + toolCalls，前端重建 contentBlocks**：兼容但无法还原确切的交叉顺序

推荐选择 1，同时在 `getSession` 中做兼容处理：如果旧消息只有 `content` 字段，自动包装为 `[{ type: 'text', content }]`。

### 可选增强：Streamdown 集成

当前手写的 Markdown 渲染器（`message-content.tsx`，约 130 行）不支持：
- 流式不完整 Markdown（如只收到 `` ``` `` 但未闭合）
- 列表、表格、标题等 GFM 扩展

可在本次改动中或后续单独引入 Streamdown 替换手写渲染器，提升流式 Markdown 渲染质量。

---

## 注意事项

- `ToolCallList` 组件和渲染器注册表可以复用，只需从"列表渲染"改为"单项内联渲染"
- 需要处理边界情况：AI 在同一轮中先输出文本再调用工具，或不输出文本直接调用工具
- 历史消息的兼容性：旧格式 `{ content, toolCalls? }` 需要能正确降级为 `contentBlocks`
