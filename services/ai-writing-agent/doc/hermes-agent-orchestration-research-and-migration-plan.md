# Hermes Agent 编排调研与 ResInk 迁移方案

> 目的：把 Hermes Agent 的成熟编排设计转化为本项目可落地的架构方案，修正当前“一次性 sandbox + OpenCode run”的弱链路，形成真正持久、可编排、可审计的 Overleaf/ResInk Agent 能力。
>
> 调研来源：本地参考仓库 `/home/cjc/reference-repos/hermes-agent`，浅克隆自 `NousResearch/hermes-agent`，当前参考提交 `7eb9678 test(desktop): cover link-title window audio muting`。参考仓库位于本项目外部，不应复制进本仓库或提交。

## 1. 背景与结论

当前 `ai-writing-agent` 的 sandbox 路径已经能完成项目导出、运行 OpenCode、收集 diff、生成 pending changes、由用户确认后写回 Overleaf。但它本质上仍是 request-scoped 任务执行器：

```text
Overleaf frontend
  -> /api/ai proxy
  -> ai-writing-agent
  -> create temporary sandbox
  -> export project snapshot
  -> opencode run once
  -> collect diff
  -> destroy sandbox
```

这个设计最大的问题是没有真实的 agent session：

- 每轮消息都会重新导出项目和创建临时 sandbox。
- OpenCode 只是一次性命令，不持久保存上下文。
- 前端只能展示底层事件流，无法表达“工作区状态、任务状态、文件变更、子任务进度”。
- 用户刷新页面后，除了 Mongo 中的 pending changes 和 artifacts，没有可继续工作的 agent workspace。

Hermes 的价值不在于“可以直接替换为一个 Python runtime”，而在于它把 agent 能力拆成了几个稳定的系统层：

- 持久 session store。
- 主循环 conversation loop。
- tool registry 和 toolset policy。
- 子 agent delegation。
- gateway/session 多入口映射。
- ephemeral prompt injection 和 memory/context 管理。

本项目应采用的迁移方向是：**借鉴 Hermes 的编排架构，重构现有 Node `ai-writing-agent`**。不要把 Hermes 源码直接嵌入项目，也不要让 Hermes 的个人本机权限模型进入 Overleaf 多用户环境。

## 2. Hermes Agent 编排设计解读

### 2.1 AIAgent 是状态化编排单元

Hermes 的核心类是 `AIAgent`。它不是简单的 LLM wrapper，而是一个携带模型配置、session id、tool callbacks、platform 信息、user/chat/thread 信息、session DB、parent session、iteration budget 等状态的编排对象。

关键来源：

- `/home/cjc/reference-repos/hermes-agent/run_agent.py:333` 定义 `class AIAgent`。
- `/home/cjc/reference-repos/hermes-agent/run_agent.py:356` 开始的构造参数包含 `enabled_toolsets`、`session_id`、大量 stream/tool callbacks、`platform`、`user_id`、`gateway_session_key`、`session_db`、`parent_session_id`、`iteration_budget`。
- `/home/cjc/reference-repos/hermes-agent/run_agent.py:5272` 的 `run_conversation()` 是 thin forwarder，真正逻辑在 `agent/conversation_loop.py`。

可学习点：

- Agent session 应该是一等对象，而不是一次请求的局部变量。
- Web、CLI、gateway、subagent 这些入口应共享同一个核心 session/orchestration 抽象。
- session id、parent session、tool callbacks、runtime profile 不应散落在前端状态和临时 manager map 中。

### 2.2 Conversation loop 是单轮 turn 的完整状态机

Hermes 把 `run_conversation` 拆到 `agent/conversation_loop.py`。文件开头说明它负责把一个 user turn 推过模型调用、工具调度、retry、fallback、compression、post-turn hooks、background memory/skill review。

关键来源：

- `/home/cjc/reference-repos/hermes-agent/agent/conversation_loop.py:1` 说明该文件是 agent conversation loop。
- `/home/cjc/reference-repos/hermes-agent/agent/conversation_loop.py:4` 说明该 loop 驱动一个 user turn。
- `/home/cjc/reference-repos/hermes-agent/agent/conversation_loop.py:254` 附近开始处理 system prompt restore/build。

可学习点：

- 当前项目不应该把“运行 runtime、收集 diff、返回 SSE”写成一个线性脚本。
- 应引入 `AgentTurnRunner`，把每轮消息拆成明确阶段：
  - restore session。
  - sync workspace。
  - build prompt/context。
  - execute runtime/tool loop。
  - persist messages/tool calls。
  - collect workspace changes。
  - emit normalized events。

### 2.3 SessionDB 是持久会话的中心

Hermes 使用 SQLite `state.db` 存 session 和 messages。schema 包括 session metadata、parent session、message/tool count、token/cost、cwd、title、handoff state、archived 等字段；messages 表保存 role、content、tool_call_id、tool_calls、tool_name、reasoning、provider-specific items，并通过 FTS 做全文搜索。

关键来源：

- `/home/cjc/reference-repos/hermes-agent/hermes_state.py:514` 定义 `sessions` 表。
- `/home/cjc/reference-repos/hermes-agent/hermes_state.py:551` 定义 `messages` 表。
- `/home/cjc/reference-repos/hermes-agent/hermes_state.py:601` 定义 FTS 表和触发器。
- `/home/cjc/reference-repos/hermes-agent/hermes_state.py:657` 定义 `SessionDB`。
- `/home/cjc/reference-repos/hermes-agent/run_agent.py:524` 的 `_ensure_db_session()` 在首次使用时创建 session row。
- `/home/cjc/reference-repos/hermes-agent/run_agent.py:1512` 的 `_persist_session()` 确保任何退出路径都会保存会话。
- `/home/cjc/reference-repos/hermes-agent/run_agent.py:1581` 的 `_flush_messages_to_session_db()` 按消息 identity 去重写入，避免重复 flush。

可学习点：

- 本项目应建立自己的 Mongo-backed `aiAgentSessions` / `aiAgentMessages` / `aiAgentToolCalls` / `aiAgentArtifacts`，而不是只保存 sandbox run metadata。
- session store 必须支持：
  - 页面刷新后恢复对话。
  - 查询历史 turn。
  - 保存 tool calls 和 tool results。
  - 保存 parent/child session 关系。
  - 记录 workspace 状态、dirty files、pending changes。

不应照搬点：

- Hermes 使用用户目录 `~/.hermes/state.db`，这是单用户 CLI/Gateway 模型。本项目必须改成 Overleaf 的 `userId + projectId` scoped Mongo 数据模型。

### 2.4 Tool registry 与 toolset policy 是权限边界

Hermes 的工具系统采用自注册模式：每个 tool 文件在 import 时调用 `registry.register()` 声明 schema、handler、toolset、availability check。`model_tools.py` 做发现和对模型暴露 tool definitions。

关键来源：

- `/home/cjc/reference-repos/hermes-agent/tools/registry.py:1` 说明 central registry 的设计。
- `/home/cjc/reference-repos/hermes-agent/tools/registry.py:57` 的 `discover_builtin_tools()` 扫描并导入自注册工具。
- `/home/cjc/reference-repos/hermes-agent/tools/registry.py:77` 的 `ToolEntry` 保存 tool metadata。
- `/home/cjc/reference-repos/hermes-agent/tools/registry.py:151` 的 `ToolRegistry` 管理工具和 toolset。
- `/home/cjc/reference-repos/hermes-agent/model_tools.py:5` 说明它是 registry 之上的薄编排层。

可学习点：

- 当前项目不应该继续把 legacy tools、sandbox runtime、OpenCode/Codex adapter、review profiles 各自散落。
- 应引入 `ToolRegistry` 和 `ToolsetPolicy`：
  - `file-read`、`file-write`、`compile`、`citation`、`web-research`、`review`、`subagent` 等 toolset。
  - 每个 profile 选择可用 toolsets。
  - 每个 subagent 继承父 agent 的 toolset 子集。
  - tool availability 可由配置、服务健康、项目权限决定。

Overleaf 特殊约束：

- tool policy 不是最终安全边界。最终安全边界仍是 sandbox/container、Overleaf 权限、pending change review 和 CAS 写回。
- 子 agent 不允许直接写 canonical Overleaf docs，只能写 workspace。

### 2.5 delegate_task 是可控子 agent 编排模型

Hermes 的 `delegate_task` 支持单任务和 batch 任务，创建 child `AIAgent`，给它独立上下文、独立 task id、受限 toolsets、focused system prompt。父 agent 只看到 delegation call 和汇总结果，不暴露子 agent 的全部中间推理。

关键来源：

- `/home/cjc/reference-repos/hermes-agent/tools/delegate_tool.py:5` 说明子 agent 具备 isolated context、restricted toolsets、own terminal sessions。
- `/home/cjc/reference-repos/hermes-agent/tools/delegate_tool.py:44` 定义 child 禁用工具，包括 `delegate_task`、`clarify`、`memory`、`send_message`、`execute_code`。
- `/home/cjc/reference-repos/hermes-agent/tools/delegate_tool.py:656` 的 `_build_child_system_prompt()` 构造 focused child prompt。
- `/home/cjc/reference-repos/hermes-agent/tools/delegate_tool.py:990` 的 `_build_child_agent()` 决定 child role、depth、toolsets、workspace hint、provider/model 继承。
- `/home/cjc/reference-repos/hermes-agent/tools/delegate_tool.py:1047` 将 child requested toolsets 与 parent toolsets 求交集，避免越权。
- `/home/cjc/reference-repos/hermes-agent/tools/delegate_tool.py:2065` 的 `delegate_task()` 支持 single/batch、leaf/orchestrator role、background 限制和 depth limit。
- `/home/cjc/reference-repos/hermes-agent/run_agent.py:5193` 的 `_dispatch_delegate_task()` 是父 agent 调用 delegation 的统一入口。

可学习点：

- ResInk 的 Deep Review 不应只是 prompt 里说“多专家评审”，而应该变成真实 child sessions：
  - `paper-reviewer` 主 agent 作为 coordinator。
  - `citation-auditor`、`experiment-reviewer`、`logic-reviewer`、`compile-fixer` 作为 child agents。
  - child agents 默认 leaf，不允许继续递归，除非 profile 明确授权。
  - child agents 只能返回 summary、findings、workspace changes，不直接改 canonical docs。

### 2.6 Gateway/ACP 提供多入口 session 映射

Hermes 通过 Gateway 和 ACP adapter 把不同入口映射到同一个 agent/session 机制。ACP session manager 明确说明 session 同时保存在内存和 shared SessionDB，支持进程重启后恢复。

关键来源：

- `/home/cjc/reference-repos/hermes-agent/acp_adapter/session.py:1` 说明 ACP session manager 将 ACP sessions 映射到 Hermes AIAgent instances。
- `/home/cjc/reference-repos/hermes-agent/acp_adapter/session.py:187` 说明 sessions held in-memory and persisted to SessionDB。
- `/home/cjc/reference-repos/hermes-agent/gateway/session.py` 提供 gateway session store、context prompts 和 reset policies。

可学习点：

- Overleaf 前端、CLI/manual smoke test、未来 API/server-side automation 应共享同一个 `AgentSessionService`。
- 前端不应直接决定“legacy chat vs sandbox session”的底层实现细节，而是发消息到一个统一 agent session。

## 3. 可迁移设计与边界

### 3.1 应迁移的架构设计

1. **持久 AgentSession**
   - 每个 `(userId, projectId)` 可以创建多个 agent sessions。
   - session 保存 model/profile/runtime/workspace/status/title/parentSessionId。
   - 支持 resume、archive、search、list recent。

2. **消息与工具调用持久化**
   - 保存 user/assistant/tool messages。
   - 保存 tool call name、arguments、result summary、status、duration、error。
   - 保存 reasoning summary 或 redacted reasoning metadata，但不要保存敏感 chain-of-thought。

3. **Workspace-first 运行模型**
   - agent 在 workspace 中读写文件。
   - Overleaf canonical docs 只通过 pending changes/CAS accept 写回。
   - workspace 具备 TTL、dirty state、sync state、lastExportVersion。

4. **Toolset policy**
   - profile 决定可用 toolsets。
   - project/user/admin policy 可以进一步收窄 toolsets。
   - subagent 只能继承父 agent 的 toolset 子集。

5. **Subagent coordinator**
   - 支持 coordinator/leaf role。
   - 限制 depth、并发、budget、runtime。
   - 子 agent 独立 session，parent/child lineage 可查询。

6. **Normalized event stream**
   - 前端只消费产品级事件：
     - `session.ready`
     - `workspace.syncing`
     - `turn.started`
     - `model.delta`
     - `tool.started`
     - `tool.completed`
     - `subagent.started`
     - `subagent.completed`
     - `changes.ready`
     - `turn.completed`
   - 不再直接把 Docker/OpenCode stdout 当聊天文本展示。

### 3.2 不应迁移或必须改造的部分

1. **不要迁移 Hermes 用户目录模型**
   - Hermes 的 `~/.hermes` 适合个人 CLI。
   - 本项目必须使用 Mongo + sandbox volume，并以 Overleaf user/project 权限为准。

2. **不要迁移 Hermes 的本机权限假设**
   - Hermes 的 terminal/file tools 默认面向用户自己的机器。
   - Overleaf 是多用户协作系统，必须默认 sandbox/container/VM 隔离。

3. **不要复制 Hermes 源码**
   - Hermes 是参考实现。
   - 本项目只迁移设计，不复制 Python 文件、schema 大段文本或私有实现。

4. **不要绕过 pending changes**
   - 即使 agent 能编辑 workspace，也不能直接写 Overleaf canonical docs。
   - 当前 `DocumentAdapter` 的 CAS apply 和 pending change UI 是必须保留的资产。

## 4. ResInk 目标架构

### 4.1 分层职责

```text
Overleaf Web
  - auth/session/project permissions
  - editor UI
  - agent panel
  - pending change review

AI Agent Service
  - AgentSessionService
  - AgentTurnRunner
  - ToolRegistry / ToolsetPolicy
  - SubagentCoordinator
  - EventNormalizer

Sandbox Workspace
  - persistent per-session project checkout
  - LaTeX compile, shell, file operations
  - artifacts, logs, generated files

Runtime Adapter
  - OpenCode / Codex / future runtime
  - model provider credentials scoped to runtime
  - stream normalized model/tool events

Overleaf Apply Bridge
  - diff -> pending changes
  - accept/reject
  - CAS writeback
  - conflict reporting
```

### 4.2 新服务概念

#### AgentSessionService

负责创建、恢复、归档、列出 session。

Mongo collections 建议：

- `aiAgentSessions`
- `aiAgentMessages`
- `aiAgentToolCalls`
- `aiAgentArtifacts`
- `aiAgentWorkspaceChanges`

Session 关键字段：

- `_id`
- `projectId`
- `userId`
- `profile`
- `runtimeAdapter`
- `model`
- `status`
- `parentSessionId`
- `workspaceId`
- `workspacePath`
- `syncState`
- `dirtyState`
- `createdAt`
- `updatedAt`
- `lastTurnAt`
- `expiresAt`

#### AgentWorkspaceManager

负责 workspace 生命周期：

- create workspace。
- export Overleaf project。
- resume existing workspace。
- detect Overleaf version drift。
- sync/rebase workspace。
- collect diff。
- cleanup expired workspaces。

该层替代当前 `SandboxSessionManager` 中“一次请求创建和销毁 sandbox”的行为。

#### AgentTurnRunner

负责单轮 turn：

```text
load session
  -> verify permission
  -> ensure/resume workspace
  -> sync if needed
  -> append user message
  -> build runtime prompt/context
  -> run runtime/tool loop
  -> persist assistant/tool messages
  -> collect workspace changes
  -> emit changes.ready
```

#### ToolRegistry / ToolsetPolicy

初始 toolsets：

- `project-read`: list/read Overleaf workspace files。
- `project-write`: write workspace files only。
- `compile`: run latexmk, parse logs, collect PDF artifacts。
- `review`: structural review, paper review tools。
- `citation`: bibliography search/check tools。
- `web`: optional web research, disabled by default in strict deployments。
- `subagent`: coordinator-only delegation。

#### SubagentCoordinator

第一版只支持同步 child sessions：

- parent 调用 `delegate_task`。
- child session 持久化到 `aiAgentSessions`，带 `parentSessionId`。
- child 默认 leaf。
- child toolsets = parent toolsets intersection requested toolsets。
- child 输出 summary 和 optional workspace patch。
- parent 看到 child summary，不直接注入所有 child tool logs。

### 4.3 API 草案

统一新接口使用 `/api/ai/agent/*`，由现有 Web proxy 继续注入 `x-user-id`。

```http
POST /api/ai/agent/sessions
GET  /api/ai/agent/sessions
GET  /api/ai/agent/sessions/:sessionId
POST /api/ai/agent/sessions/:sessionId/messages
POST /api/ai/agent/sessions/:sessionId/stop
POST /api/ai/agent/sessions/:sessionId/sync
GET  /api/ai/agent/sessions/:sessionId/changes
POST /api/ai/agent/sessions/:sessionId/changes/:changeId/accept
POST /api/ai/agent/sessions/:sessionId/changes/:changeId/reject
GET  /api/ai/agent/sessions/:sessionId/artifacts/:artifactId
```

`POST /messages` 返回 SSE，事件必须是产品级 normalized events，不直接泄露 runtime 原始 stdout 作为聊天正文。

旧接口 `/api/ai/sandbox/sessions` 保留为 v0 compatibility，但文档标记为 deprecated path。

## 5. 迁移路线

### Phase 1: 文档与审计

- 完成本文档。
- 记录当前 sandbox v0 链路的问题和保留资产。
- 确认 Hermes 参考仓库不会进入 git。

### Phase 2: 持久 session schema

- 新增 `AgentSessionService`。
- 新增 Mongo collections 访问层。
- 保存 messages/tool calls/artifacts/workspace changes。
- 单元测试覆盖 create/list/get/permission/session restore。

### Phase 3: 持久 workspace

- 将 `SandboxSessionManager` 拆分为：
  - workspace create/resume/destroy。
  - project export/sync。
  - runtime turn execution。
  - diff collection。
- 去掉每轮 `finally destroySession` 的默认行为。
- 引入 TTL cleanup，而不是 turn 结束立即清理。

### Phase 4: 统一 Agent API

- 新增 `/agent/sessions` 和 `/agent/sessions/:id/messages`。
- 前端切到 project agent session。
- sandbox runtime 状态显示改为 session/workspace 状态。

### Phase 5: Tool registry 和 toolsets

- 将 profile 中的能力声明改为 toolset policy。
- OpenCode/Codex runtime adapters 只获得被授权的 workspace、env、command policy。
- 工具调用和 runtime events 持久化。

### Phase 6: 子 agent 编排

- 实现 `delegate_task` 的项目内版本。
- first-class child sessions。
- 默认只允许 review/citation/compile-fix 等 leaf agent。
- 增加 depth、并发、budget 限制。

### Phase 7: 前端体验重做

- 面板展示 agent session，而不是临时 run。
- 增加 workspace 状态、任务状态、子 agent 进度、changes panel、artifact panel。
- 聊天正文只展示模型答复和总结，底层 logs 放入可展开诊断区。

### Phase 8: 真实验收

- 使用 DeepSeek flash 进行真实模型端到端测试。
- 浏览器中真实创建/恢复 session、发送消息、查看 diff、accept 写回。
- 刷新页面后验证 session history、pending changes、artifacts 仍可恢复。
- LaTeX 编译、PDF artifact、compile-fix 都必须走真实 sandbox。

## 6. 测试策略

### 单元测试

- AgentSessionService CRUD 和 permission。
- message/tool call persistence 去重。
- workspace resume/sync/TTL cleanup。
- toolset intersection 和 denied tool 行为。
- subagent depth/concurrency/budget。
- diff -> pending changes。

### 集成测试

- `POST /agent/sessions` 创建 session。
- `POST /messages` 发送 turn 并返回 SSE。
- turn 中写 workspace 文件，收集 changes。
- accept change 后通过 CAS 写回 Overleaf。
- stop running turn。
- restore session after service restart。

### 真实验收测试

- 使用 `deepseek-v4-flash` 做真实模型 smoke test。
- 在网页端完成：
  - 登录。
  - 打开项目。
  - 创建/恢复 agent session。
  - 发送写作或 compile-fix 请求。
  - 查看变更。
  - accept 写回。
  - 刷新页面确认历史还在。

明确禁止只做 mock test 后交付。

## 7. 风险与约束

- **多用户安全**：Hermes 的个人本机模型不能直接进入 Overleaf。所有文件和命令执行必须在 sandbox/workspace 中。
- **数据一致性**：workspace 与 Overleaf canonical docs 存在版本漂移，必须依赖 CAS 和 rebase/conflict flow。
- **前端复杂度**：从 chat 面板升级为 agent workspace UI 是必要改动，不能只靠美化事件流解决。
- **成本控制**：subagent 会放大 tokens 和并发，需要预算、深度、并发限制。
- **密钥边界**：模型 key 只放 gitignored env 或 admin config，不进入 tracked docs、fixtures、logs。

## 8. 最终建议

当前 sandbox/OpenCode v0 链路不要继续作为主产品形态扩展。它可以保留为底层 runtime smoke path，但下一步主线应转向 Hermes-style persistent agent architecture：

```text
Persistent AgentSession
  + Persistent Sandbox Workspace
  + Toolset Policy
  + Turn Runner
  + Subagent Coordinator
  + Overleaf Pending Change Apply Bridge
```

这条路线保留了当前实现中正确的部分：Overleaf 权限、project export、sandbox workspace、diff、pending changes、CAS 写回；同时补上真正 agent 产品必须具备的 session、history、workspace、tool orchestration 和 subagent 能力。
