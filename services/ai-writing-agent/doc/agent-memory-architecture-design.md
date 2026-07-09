# Agent Memory 架构设计稿

> 目的：为 ResInk AI 设计一套接近 Claude Code / Codex 的轻量记忆与项目指令体系，替换当前零散的 `Project Rules` / `MemoryManager` 形态，并覆盖前端、后端、权限、安全、多 Agent 和 Live Agent Workspace 的完整产品边界。
>
> 本文是架构设计稿，不是开发计划。它用于确认产品形态、系统边界和主要抽象；方向确认后，再另写 `/goal` 风格开发计划。
>
> 重要前提：产品仍处于封闭开发阶段，没有外部用户和历史 API 需要兼容。因此本文采用 clean replacement 设计，不要求兼容现有 `/projects/:projectId/rules` API、`aiProjectRules` collection、右上角 Project Rules 下拉框或当前 `MemoryManager` 实现。

## 1. 结论先行

ResInk 不应该建设一个复杂的 memory taxonomy，也不应该把 sandbox 文件、pending changes、compile artifacts、agent events 都包装成 memory。

推荐目标是 **instruction-first**：

```text
Project Instructions  项目共享指令，类似 AGENTS.md / CLAUDE.md
Memories              用户私有记忆，类似 Codex memories / Hermes USER.md
Session Summary       会话续跑摘要，属于运行状态
Context Recall        内部检索服务，不作为产品概念暴露
```

其中只有前两个需要明显用户交互：

- **Project Instructions**：用户在项目内编辑、审阅、提交、回滚。它是项目文件和项目历史的一部分。
- **Memories**：用户查看、删除、禁用、确认自动提议。它是个人设置，不进入项目历史。

Session Summary 和 Context Recall 是后端能力：

- Session Summary 服务于刷新恢复、compaction、多 Agent context pack。
- Context Recall 只负责在构建 prompt 时召回少量相关 memories / summaries，避免把所有历史信息常驻注入。

设计原则：

1. **项目长期规则以文件为真相源。**
   默认使用项目根目录 `AGENTS.md`。前端提供专用编辑体验，但最终写入仍经过 Overleaf 文件、draft change、CAS 和 history。
2. **用户长期偏好默认私有。**
   `Memories` 按 `userId` 存储，可选 project scope，但不能被协作者读取，也不能自动进入项目文件。
3. **自动记忆必须克制。**
   Agent 可以提出“记住此偏好”的提议，但默认不把论文事实、协作者意见、pending change 内容或一次性实现细节写入长期记忆。
4. **强约束不靠 memory 执行。**
   权限、写回、工具访问、网络、Python 依赖、安全策略由 Overleaf permission、ToolsetPolicy、sandbox、CAS、hook/test gate 执行。
5. **子 Agent 默认不可写长期记忆。**
   子 Agent 只能读必要的 context pack；长期记忆写入由 root session 或用户确认动作完成。

## 2. 当前实现的问题

当前实现有几块可作为参考，但不应作为长期结构保留：

```text
Frontend ProjectRulesEditor
  -> GET/PUT /api/ai/projects/:projectId/rules
  -> ai-writing-agent AgentController
  -> aiProjectRules Mongo collection
  -> ProjectRulesProvider
  -> MemoryManager.getMemoryContent(projectId)
  -> system prompt
```

主要问题：

1. **项目规则不在项目文件中。**
   用户在 Overleaf 项目文件树、历史记录、协作者 review 中看不到规则来源；这不像 Claude Code / Codex 的文件化指令。
2. **“rules”和“memory”混在一起。**
   `aiProjectRules` 被注释为 memory，但产品语义其实是项目指令。
3. **编辑体验过轻。**
   当前下拉框适合少量 Markdown，但不适合版本化 review、创建文件、diff、冲突、协作编辑。
4. **没有用户私有 memories。**
   跨项目偏好、用户工作习惯、反复纠正记录没有单独存储。
5. **没有记忆提议和审计。**
   Agent 无法提出“是否记住这条偏好”，用户也不能查看、删除、拒绝来源。
6. **Context 注入过于粗糙。**
   Provider 字符串拼接进 prompt，没有 scope、来源、预算、可解释性和子 Agent 切片。

Clean replacement 后，应删除或重命名这些概念：

| 旧概念 | 目标概念 | 处理 |
| --- | --- | --- |
| `Project Rules` UI | `Agent Instructions` 面板 | 重做为文件编辑与 review 体验 |
| `/projects/:projectId/rules` | Project Instructions API | 新 API 以项目文件为真相源 |
| `aiProjectRules` | 迁移缓存或废弃 collection | 不作为长期真相源 |
| `MemoryManager.getMemoryContent()` | `AgentContextBuilder` + `InstructionResolver` + `ContextRecallService` | 拆分职责 |
| `ProjectRulesProvider` | `ProjectInstructionSource` | 从项目文件读取 |

## 3. 产品模型

### 3.1 Project Instructions

Project Instructions 是项目共享的长期指令。默认文件：

```text
/AGENTS.md
```

使用 `AGENTS.md` 的理由：

- 与 Codex 生态一致。
- 文件名语义直接，不绑定某个供应商。
- 进入 Overleaf 文件树和项目历史，协作者可见、可 diff、可恢复。
- 未来可被本地 coding agent 或导出的项目复用。

不推荐默认使用隐藏 SaaS-only 配置或只存在 Mongo 的规则。Overleaf 项目是协作编辑器，项目级规则应属于项目资产。

Project Instructions 应放：

- 写作目标和论文/项目约束。
- 编译命令、测试命令、验证要求。
- 术语、命名、引用和格式约定。
- AI 修改边界，例如哪些文件不能改。
- 多 Agent workflow 偏好，例如 Deep Review 的默认 reviewer。
- 提交流程，例如阶段性提交规范。

不应放：

- 用户私有偏好。
- API key、token、账号信息。
- 一次性聊天摘要。
- 未经确认的论文事实。
- 子 Agent 中间输出全文。

### 3.2 Memories

Memories 是用户私有的长期偏好和工作习惯。这里采用 Codex 风格的命名，不再引入额外产品概念。

示例：

```text
- 用户偏好中文沟通。
- 用户不希望 memory taxonomy 过度复杂。
- 用户要求架构任务尽量做 clean replacement，不做过度兼容。
- 用户认为只跑单元测试不足以验收 AI runtime，需要真实部署和浏览器 E2E。
```

Memories 的 scope：

```text
global memory       跨项目生效
project memory      仅当前 projectId 生效，但仍然只对该 user 可见
```

默认写入策略：

- 用户明确说“记住”时，可直接创建提议并等待确认。
- 用户反复纠正时，Agent 可提出记忆建议。
- 系统不得自动把项目内容或协作者意见提升为 Memories。

### 3.3 Session Summary

Session Summary 是运行状态，不是产品层长期记忆。

用途：

- 长会话 compaction 后继续对话。
- 页面刷新后恢复当前工作。
- 多 Agent 子任务构造 context pack。
- 失败后 resume / retry。

生命周期：

```text
agent session / team run scoped
archive 后仍可读
删除 session 时一起删除或脱敏归档
```

Session Summary 不进入用户设置页，也不作为“记忆”直接管理。

### 3.4 Context Recall

Context Recall 是内部服务，不是前端主概念。

作用：

- 不把所有 Memories 和历史 summaries 常驻 prompt。
- 在需要时召回少量相关内容。
- 给子 Agent 生成 scoped context pack。

第一版不需要 embedding。优先用：

- Mongo text index。
- 项目文件名 / section title / tag keyword。
- recency + scope ranking。

只有当 memories 和 session 数量明显增大后，再增加 embedding / hybrid search。

## 4. 前端设计

### 4.1 信息架构

AI Assistant 面板不再用一个小下拉框承载项目规则，也不新增多个并列面板按钮。目标 UI 应收敛为一个入口：

```text
AI Assistant panel
  Header actions
    Agent Context button

Agent Context drawer / modal
  Instructions tab
    File-backed editor for /AGENTS.md
    Preview
    Diff against saved version
    Save as draft change
    Apply if Auto Accept is enabled

  Memories tab
    Recall On/Off
    Global memories
    Project-scoped private memories
    Pending memory suggestions
    Delete memory

  Trace tab
    Context used by current turn
    Current session summary
    Compact now
```

这样前端只新增一个稳定入口。`Project Instructions` 和 `Memories` 是用户能理解的两个概念，但不需要分别占用 AI 面板 header 的两个按钮；`Session Summary` 更不应成为常驻一级 panel。

### 4.2 Agent Instructions 编辑体验

Agent Instructions 应更像一个项目文件编辑器，而不是 textarea 下拉框。

核心交互：

1. 打开面板。
2. 如果 `AGENTS.md` 不存在，显示创建状态。
3. 用户编辑 Markdown。
4. 保存时生成 Live Agent Workspace draft change。
5. Review 模式下，用户看到 `AGENTS.md` 的新增/修改 diff。
6. 用户接受后，Overleaf CAS 写入 canonical project。
7. Auto Accept 开启时，保存后立即走 CAS writeback。

为什么不直接 PUT Mongo：

- 项目指令应进入项目历史。
- 协作者应能看到项目级 AI 规则变化。
- 冲突应按 Overleaf 文件版本处理。
- 用户可以用普通项目文件能力恢复或导出。

### 4.3 Memories 交互

Memories 应独立于项目文件，并放在 `Agent Context` 入口内，不单独提供常驻 panel。

面板内容：

```text
Memories
  Recall: On/Off
  Global memories
  Memories for this project
  Pending suggestions
```

每条 memory 展示：

- 内容。
- scope：global / this project。
- 来源：manual / suggested from session。
- 创建时间。
- 最近使用时间。
- 操作：edit、delete、disable、promote to Project Instructions。

Pending suggestions 的确认文案要克制：

```text
记住这个偏好？
"以后设计 memory 功能时保持接近 Codex/Claude Code，不做复杂分类体系。"

[记住为全局偏好] [仅此项目] [忽略]
```

### 4.4 Context 使用可解释性

用户不需要每次都看到 recall 细节，但需要可检查。

每个 assistant turn 可在 debug/trace 区域展示：

```text
Context used
  Project Instructions: AGENTS.md @ version 17
  Memories: 2 entries
  Session Summary: current session summary seq 42
  Recalled summaries: 1
```

默认折叠。只有在 verbose/debug 或用户点开时显示。

### 4.5 多用户协作语义

Project Instructions：

- 项目成员按 Overleaf 项目权限读取。
- 只有有写权限的用户能修改。
- 修改是项目文件变更，进入 history。
- 多人同时修改走文件冲突/CAS。

Memories：

- 永远只属于当前 user。
- 协作者不可见。
- 不进入 project export。
- 不影响其他协作者的 AI 行为。

Session Summary：

- 默认属于发起该 AI session 的 user。
- 如果未来支持共享 AI session，再单独设计共享策略。

## 5. 后端架构

### 5.1 目标组件

```text
AgentController
  -> AgentSessionService
  -> AgentContextBuilder
       -> ProjectInstructionService
       -> MemoryService
       -> SessionSummaryService
       -> ContextRecallService
  -> AgentLoopV2 / AgentTeamRuntime

ProjectInstructionService
  -> ProjectFileAdapter / DocumentAdapter
  -> LiveDraftChangeBridge
  -> CanonicalWritebackService

MemoryService
  -> aiMemories
  -> aiMemorySuggestions

SessionSummaryService
  -> aiMessages / aiSessionSummaries

ContextRecallService
  -> aiMemories text index
  -> aiSessionSummaries text index
  -> project AGENTS.md snapshot
```

### 5.2 ProjectInstructionService

职责：

- 查找项目根目录 `AGENTS.md`。
- 读取当前 canonical 内容。
- 创建文件。
- 生成 draft change。
- 在 Auto Accept 下应用 CAS writeback。
- 提供 prompt 注入用的 frozen snapshot。
- 记录使用的 project version / doc version。

建议 API：

```http
GET /projects/:projectId/agent-instructions
PUT /projects/:projectId/agent-instructions/draft
POST /projects/:projectId/agent-instructions/apply
POST /projects/:projectId/agent-instructions/create
```

响应示例：

```json
{
  "path": "AGENTS.md",
  "exists": true,
  "content": "...",
  "docId": "...",
  "version": 17,
  "lastModified": "...",
  "source": "project-file"
}
```

写入语义：

- Review 模式：返回 draft change id。
- Auto Accept：创建 draft change 后立即 apply，返回 applied version。
- 所有写入都需要 userId 和项目写权限。
- 不允许 AI service 绕过 Overleaf canonical write path。

### 5.3 MemoryService

职责：

- 管理用户私有 memories。
- 管理 Agent 提出的记忆建议。
- 控制 global / project scope。
- 支持关闭 recall。
- 记录使用来源。

Mongo collection：

```js
aiMemories {
  _id,
  userId,
  projectId: null | ObjectId,
  scope: "global" | "project",
  content,
  status: "active" | "disabled" | "deleted",
  source: "manual" | "suggestion",
  sourceSessionId: null | ObjectId,
  createdAt,
  updatedAt,
  lastUsedAt: null | Date
}

aiMemorySuggestions {
  _id,
  userId,
  projectId,
  sessionId,
  content,
  suggestedScope: "global" | "project",
  reason,
  status: "pending" | "accepted" | "dismissed" | "expired",
  createdAt,
  expiresAt
}
```

建议 API：

```http
GET    /memories?projectId=:projectId
POST   /memories
PATCH  /memories/:memoryId
DELETE /memories/:memoryId

GET    /memory-suggestions?projectId=:projectId
POST   /memory-suggestions/:suggestionId/accept
POST   /memory-suggestions/:suggestionId/dismiss
```

### 5.4 SessionSummaryService

当前 `ContextManager.compactHistory()` 可以作为迁移参考，但目标应拆成独立服务。

职责：

- 生成 session summary。
- 保存 summary seq / token usage / source message range。
- 在 compaction 前触发 optional memory suggestion pass。
- 为 AgentContextBuilder 提供当前 session summary。
- 为 ContextRecallService 提供可检索历史 summary。

Mongo collection：

```js
aiSessionSummaries {
  _id,
  sessionId,
  projectId,
  userId,
  summary,
  sourceMessageSeqStart,
  sourceMessageSeqEnd,
  createdAt,
  model,
  tokenUsage
}
```

注意：

- Summary 是会话运行状态。
- 不进入 Memories，除非用户确认某条稳定偏好。
- 不进入 Project Instructions。

### 5.5 ContextRecallService

职责：

- 根据当前 user message、session、project、task spec 检索少量相关内容。
- 限制 scope。
- 返回带来源的 context fragments。
- 为 root Agent 和 child Agent 分别生成 recall slice。

第一版 ranking：

```text
scope match
keyword match
recency
manual memory > suggestion memory > session summary
project-scoped > global when project task is active
```

返回结构：

```js
ContextFragment {
  type: "memory" | "session_summary" | "project_instruction",
  sourceId,
  scope,
  content,
  reason,
  tokenEstimate
}
```

默认预算：

```text
Project Instructions: always included, capped by config
Session Summary: always included for current session
Memories: recall up to 3
Past Session Summaries: recall up to 2
```

## 6. Prompt 与上下文构建

目标 prompt 结构：

```text
System prompt
  Product/developer rules
  Tool policy
  Safety boundaries

Project Instructions
  Source: AGENTS.md, project version/doc version
  Treated as project guidance, not higher than system/developer rules

Memories
  Current user's private preferences
  Treated as preferences, not project facts

Session Summary
  Current session continuity summary
  Treated as historical context, not instructions

Recalled Context
  Small number of relevant memories or summaries
  Explicitly marked as background context

Current user message
```

关键规则：

- Project Instructions 不能覆盖系统安全策略。
- Memories 不能覆盖 Project Instructions 中的团队共享约定，除非只是个人展示偏好。
- Session Summary 不能作为事实权威；当前项目文件优先。
- Recalled Context 必须带来源边界，避免被当作新用户输入。
- Prompt 中不得注入 deleted / disabled memories。

建议采用 Hermes 的 frozen snapshot 思路：

- 每个 turn 构造一次 context snapshot。
- 该 turn 内新增/修改的 memories 不改变当前模型调用上下文。
- 下一个 turn 才能使用新 memories。
- 这样可以避免同一 turn 中 prefix/cache/context 不稳定。

## 7. 自动记忆提议

自动记忆不应默认写入长期 memories。目标是 **suggestion-first**。

触发时机：

- 用户显式说“记住”。
- 用户纠正 Agent 的长期行为偏好。
- 用户多次强调稳定工作流约束。
- compaction 前发现对未来有用但不应塞进 summary 的偏好。

不触发：

- 普通论文内容。
- 用户上传或项目文件中的学术事实。
- 临时任务状态。
- 环境变量和密钥。
- 协作者私有聊天或未确认意见。
- 子 Agent findings。

流程：

```text
Agent detects candidate
  -> MemorySuggestionService creates pending suggestion
  -> Frontend shows compact prompt
  -> User accepts as global/project memory or dismisses
  -> MemoryService writes active memory
```

Agent 可见工具：

```text
propose_memory
```

不提供默认可见工具：

```text
write_memory
delete_memory
write_project_instructions
```

这些动作由用户 UI 或受控 API 完成。

## 8. 多 Agent 集成

多 Agent runtime 应默认只读 memory slice。

Root Agent：

- 可读取 Project Instructions。
- 可读取当前用户 Memories。
- 可提出 Memory suggestion。
- 可编辑 Project Instructions，但必须走 draft change。

Child Agent：

- 只接收 `AgentContextPack` 中明确包含的 instructions / memories。
- 默认不能调用 `propose_memory`。
- 默认不能读取全部 Memories。
- 默认不能编辑 Project Instructions。
- findings 可被 root Agent 汇总后提出 suggestion，但不能直接写长期记忆。

Context pack 扩展：

```js
AgentContextPack {
  projectInstructions: {
    path,
    excerpt,
    version
  },
  memories: [
    { id, content, scope, reason }
  ],
  sessionSummary: {
    id,
    summary
  },
  recalledContext: [
    { type, content, sourceId, reason }
  ]
}
```

这能避免子 Agent 继承父 Agent 全部历史，降低上下文污染。

## 9. Live Agent Workspace 集成

Project Instructions 修改必须走 Live Agent Workspace。

Review 模式：

```text
User edits the Instructions tab in Agent Context
  -> ProjectInstructionService builds file diff
  -> AgentChangeSetService creates draft change
  -> Frontend shows AGENTS.md diff
  -> User accepts
  -> CanonicalWritebackService CAS applies
```

Auto Accept：

```text
User saves Agent Instructions
  -> Draft change created
  -> CanonicalWritebackService applies immediately
  -> Editor/project tree updates
```

Agent 自动修改 Project Instructions 时也必须如此：

- 不允许直接 update Mongo。
- 不允许直接写 document-updater。
- 不允许 sandbox 直接 mutate canonical docs。

Memories 不走 Live Workspace，因为它们不是项目文件。

## 10. 安全与权限

### 10.1 权限边界

| 数据 | 读取 | 写入 | 真相源 |
| --- | --- | --- | --- |
| Project Instructions | 项目成员 | 项目写权限用户 | Overleaf project file `AGENTS.md` |
| Memories | 当前 user | 当前 user | `aiMemories` |
| Session Summary | session owner | AI service | `aiSessionSummaries` |
| Context Recall Index | AI service scoped query | 后台派生 | 派生索引 |

### 10.2 注入防护

Project Instructions 和 Memories 都会进入 prompt，因此必须扫描：

- `ignore previous instructions`
- exfiltration attempts
- credential-looking strings
- tool override instructions
- hidden role/system prompt markers
- HTML/script payload
- oversized content

命中后不应静默删除。应：

- 阻止保存，提示用户。
- 或保存但不注入，并显示 blocked 状态。

第一版推荐：保存前阻止明显 prompt injection 和 secret-looking 内容。

### 10.3 密钥和敏感信息

禁止写入长期上下文：

- API key / token / password。
- cookie / session id。
- OAuth refresh token。
- 私人联系方式，除非用户明确作为项目公开内容写入文件。
- 未公开投稿系统凭证。

### 10.4 数据删除

Memories：

- 用户可删除。
- 删除后不再 recall。
- 派生索引异步删除或标记 tombstone。

Project Instructions：

- 通过项目文件删除或修改。
- 删除进入项目历史。

Session Summary：

- 跟 session archive/delete 策略走。

## 11. API 设计

### 11.1 Project Instructions

```http
GET /projects/:projectId/agent-instructions
```

返回 canonical 文件内容和版本。

```http
POST /projects/:projectId/agent-instructions/create
```

创建 `AGENTS.md` draft change。

```http
PUT /projects/:projectId/agent-instructions/draft
```

根据 base version 创建修改 draft。

```http
POST /projects/:projectId/agent-instructions/:changeId/accept
POST /projects/:projectId/agent-instructions/:changeId/reject
```

可复用通用 pending change accept/reject API，避免创建特殊路径。

### 11.2 Memories

```http
GET /memories?projectId=:projectId
POST /memories
PATCH /memories/:memoryId
DELETE /memories/:memoryId
```

### 11.3 Memory Suggestions

```http
GET /memory-suggestions?projectId=:projectId
POST /memory-suggestions/:suggestionId/accept
POST /memory-suggestions/:suggestionId/dismiss
```

### 11.4 Context Trace

```http
GET /sessions/:sessionId/context-snapshot/:turnId
```

只返回来源摘要和 token 预算，不返回隐藏 system prompt。

## 12. 数据模型

### 12.1 `aiMemories`

```js
{
  _id,
  userId,
  projectId,
  scope,
  content,
  status,
  source,
  sourceSessionId,
  createdAt,
  updatedAt,
  lastUsedAt
}
```

Indexes：

```js
{ userId: 1, status: 1, updatedAt: -1 }
{ userId: 1, projectId: 1, status: 1, updatedAt: -1 }
text(content)
```

### 12.2 `aiMemorySuggestions`

```js
{
  _id,
  userId,
  projectId,
  sessionId,
  content,
  suggestedScope,
  reason,
  status,
  createdAt,
  expiresAt
}
```

Indexes：

```js
{ userId: 1, projectId: 1, status: 1, createdAt: -1 }
{ expiresAt: 1 }
```

### 12.3 `aiSessionSummaries`

```js
{
  _id,
  sessionId,
  projectId,
  userId,
  summary,
  sourceMessageSeqStart,
  sourceMessageSeqEnd,
  createdAt,
  model,
  tokenUsage
}
```

Indexes：

```js
{ sessionId: 1, createdAt: -1 }
{ userId: 1, projectId: 1, createdAt: -1 }
text(summary)
```

### 12.4 `aiContextSnapshots`

可选，但推荐用于 debug 和可解释性。

```js
{
  _id,
  sessionId,
  turnId,
  projectId,
  userId,
  projectInstructionRef,
  memoryRefs,
  sessionSummaryRef,
  recalledRefs,
  tokenEstimate,
  createdAt
}
```

不保存完整 system prompt。

## 13. 与现有代码的替换关系

| 当前文件/概念 | 目标处理 |
| --- | --- |
| `ProjectRulesEditor` | 替换为单一 `AgentContextPanel`，内部包含 Instructions / Memories / Trace |
| `aiApi.getProjectRules/updateProjectRules` | 删除，替换为 agent instructions + memories APIs |
| `AgentController.getProjectRules/updateProjectRules` | 删除 |
| `Router` 中 `/projects/:projectId/rules` | 删除 |
| `aiProjectRules` collection | 迁移后废弃 |
| `MemoryManager` | 删除或改造成 `AgentContextBuilder` 的内部依赖 |
| `ProjectRulesProvider` | 删除，替换为 `ProjectInstructionService` |
| `ContextManager.compactHistory` | 拆出 `SessionSummaryService` |
| `AgentContextPackBuilder.projectRules` | 改名为 `projectInstructions` |

## 14. 不做的事情

明确不做：

- 不做 semantic / episodic / procedural 等复杂分类。
- 不做 memory wiki。
- 不做 DREAMS.md。
- 不默认启用 Active Memory 子 Agent。
- 不做多 provider memory backend。
- 不做 graph memory。
- 不把 vector DB 作为真相源。
- 不把 sandbox workspace 状态称为 memory。
- 不允许 memory 绕过 Overleaf 权限、draft review 或 CAS。

## 15. 验收标准

### 15.1 产品验收

- 用户能在 AI 面板中创建和编辑 `AGENTS.md`。
- `AGENTS.md` 修改进入项目文件树和项目历史。
- Review 模式下，保存 Project Instructions 产生可见 draft diff。
- Auto Accept 模式下，保存 Project Instructions 立即写回 canonical project。
- 用户能查看、创建、编辑、删除 Memories。
- Agent 提出的记忆建议必须用户确认后才进入 Memories。
- 用户能关闭 Memories recall。
- Context trace 能显示当前 turn 使用了哪些 instructions / memories / summaries。

### 15.2 后端验收

- Project Instructions 读取来自项目文件，不来自 Mongo-only rules。
- Memories 严格按 userId 隔离。
- Session Summary 不自动提升为 Memories。
- 子 Agent 默认不能写 Memories 或 Project Instructions。
- ContextRecallService 不返回其他用户的 memories。
- Prompt 中不包含 disabled/deleted memories。
- Prompt injection 和 secret-looking content 被阻止或标记为 blocked。

### 15.3 E2E 验收

- 真实 develop stack 部署。
- 浏览器创建 `AGENTS.md`，保存后在文件树可见。
- Review 模式下，`AGENTS.md` draft change 可接受/拒绝。
- Auto Accept 模式下，`AGENTS.md` 修改即时写回。
- 新一轮 AI 对话确实使用 `AGENTS.md` 中的规则。
- 创建 Memory 后，新一轮对话可召回；删除后不再召回。
- 协作者无法读取另一个用户的 Memories。
- 子 Agent context pack 只包含被允许的 memories slice。

## 16. 推荐实施顺序

本文不是开发计划，但推荐后续开发文档按以下顺序拆：

1. Project Instructions 文件化：`AGENTS.md` 读取、创建、draft、apply、UI。
2. Memories：私有 memory CRUD、suggestions、recall toggle、UI。
3. SessionSummaryService：从 `ContextManager` 中拆出 summary 责任。
4. AgentContextBuilder：统一 Project Instructions、Memories、Session Summary、Recall。
5. Context trace：记录每轮上下文来源。
6. 多 Agent context pack 改名和权限收紧。
7. 删除旧 `/rules` API、`aiProjectRules`、`MemoryManager` 旧路径。

## 17. 最终目标

最终产品应让用户感知到两个清晰概念：

```text
Project Instructions
  这是项目共享的 AI 工作说明，保存在 AGENTS.md。

Memories
  这是 AI 对我的私有偏好记录，我可以确认、删除或关闭。
```

其他内容都保持内部化：

```text
Session Summary 用于续跑。
Context Recall 用于少量召回。
Context Snapshot 用于解释和调试。
```

这条路线保留 Claude Code / Codex 的成熟思想，也吸收 OpenClaw 的文件可读性和 Hermes 的 frozen snapshot / toolset 克制，但不会把 ResInk 做成复杂记忆平台。
