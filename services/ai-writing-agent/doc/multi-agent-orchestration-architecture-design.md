# 多 Agent 编排架构设计稿

> 目的：重新审视 ResInk AI 当前的多 Agent 设计，明确它与成熟 Agent 产品之间的差距，并提出一个适合 Overleaf/论文写作场景的可控多 Agent 架构。
>
> 本文是架构审阅稿，不是开发计划。它用于讨论产品形态、系统边界和关键抽象；后续确认方向后，再另写 `/goal` 风格的开发计划。
>
> 重要前提：本产品仍处于封闭开发阶段，没有外部用户和历史 API 需要兼容。因此本文采用 clean replacement 设计，不要求兼容旧 `delegate_task({ task, agent })` 产品形态，也不建议保留旧的静态 Agent 类型系统作为长期主路径。

## 1. 结论先行

当前的多 Agent 设计已经解决了第一阶段最重要的问题：父 Agent 可以把任务委派给受限工具集的子 Agent，并且子 Agent 的变更能保留 provenance，最终进入 Live Agent Workspace 的 draft/change-set 体系。

但它仍然偏死板。现在的模型更接近：

```text
父 Agent
  -> 调用 delegate_task({ task, agent })
  -> 选择一个静态 .md Agent 类型
  -> 创建一个 leaf child session
  -> 子 Agent 顺序执行
  -> 返回一段文本 summary
  -> 父 Agent 继续
```

这适合 Deep Review 早期版本，例如固定调度 `content-reviewer` 和 `experiment-reviewer`。但它还不是一个成熟的 Agent Team Runtime，因为缺少：

- 动态任务图。
- 并行 fan-out / join。
- Handoff。
- 后台 explorer。
- 结构化 task/result。
- 可恢复 task store。
- 基于 context pack 的上下文隔离。
- reducer / critic / evaluator loop。
- Skill 自带 agent team。
- UI 层的 team trace 和可观测性。
- 更细的权限、预算、文件范围、网络、Python env 策略。

推荐目标不是做一个完全开放的 swarm，也不是继续堆静态 reviewer，更不是在当前 `delegate_task` 上继续补丁式扩张，而是：

**构建一个受控的 Agent Team Runtime：在 AgentLoopV2 和 Live Agent Workspace 之上，支持 subagent-as-tool、handoff、parallel workflow graph、background explorer 和 structured reducer。**

## 2. 当前设计的价值与边界

### 2.1 已经做对的部分

当前设计有几个正确基础，应当作为新架构的设计约束保留，而不是保留现有实现形态：

- 子 Agent 是真实 child session，不只是 prompt 里的角色扮演。
- 子 Agent 有独立消息、tool call 和 session 状态。
- 子 Agent 的工具集是父 Agent 工具集的子集，不能越权拿到父 Agent 没有的能力。
- `RunBudget` 已经覆盖 delegation depth、并发槽、token、tool call、wall time 等基本预算。
- 子 Agent 修改能进入父 change set，并保留 `parentSessionId`、`childSessionId`、`agentName`、`profile`、`toolName` 等 provenance。
- 普通产品路径仍然经过 Overleaf 权限、Live Agent Workspace draft、CAS writeback，而不是让子 Agent 直接写 canonical 文档。

这些能力说明当前实现已经越过了“假多 Agent”的阶段。

### 2.2 主要问题

#### 1. Agent 类型过于静态

`AgentTypeRegistry` 从 `agents/*.md` 读取固定 Agent 类型。每个 Agent 类型用 frontmatter 定义：

```yaml
name: content-reviewer
description: ...
tools: read_document, list_files, search_project
maxTurns: 5
```

这使得扩展新 Agent 很直接，但也导致：

- Skill 无法自然声明自己的 agent team。
- Agent 类型缺少版本、触发条件、输入 schema、输出 schema、适用场景、风险等级。
- 所有 task 都只能选一个全局 agent name。
- 无法表达“这个 workflow 临时创建三个相同类型 reviewer，但上下文不同”。

#### 2. `delegate_task` 的任务模型太薄

当前 schema 只有：

```json
{
  "task": "string",
  "agent": "string"
}
```

它无法表达：

- 任务目标和验收标准。
- 结构化输出格式。
- 需要读取的文件范围。
- 是否允许写入、编译、联网、运行 Python。
- 任务优先级。
- deadline/timeout。
- 是否允许后台运行。
- 父任务/依赖任务。
- task cancel/retry/resume。
- 多个子任务之间的 join/reducer 关系。

这会迫使所有复杂行为都写进自然语言 task 字符串，难以审计和恢复。

#### 3. 并行能力不足

当前多次 `delegate_task` 在同一 turn 中偏顺序执行。对于论文审阅、引用审计、格式检查、实验检查等任务，这会浪费时间，也削弱了“多 Agent 独立判断”的价值。

成熟多 Agent 系统通常会支持：

```text
fan-out:
  content-reviewer
  experiment-reviewer
  quality-checker
  citation-assistant

join:
  reducer 汇总、去重、排序

critic:
  检查 findings 是否有证据、是否重复、是否越界
```

#### 4. 没有 handoff

当前都是父 Agent 调子 Agent，子 Agent 返回 summary 后父 Agent 继续掌控对话。很多场景更适合 handoff：

- 编译失败时，直接交给 `compile-fixer` 接管一小段工作。
- 引用问题时，交给 `citation-assistant` 连续处理搜索、BibTeX、dedupe。
- Rebuttal 写作时，交给 `rebuttal-writer` 管理一段用户交互。

Handoff 与 subagent-as-tool 的区别：

```text
subagent-as-tool:
  父 Agent 仍是主控，子 Agent 是 bounded worker。

handoff:
  specialist 临时成为当前对话主控，直到完成或交回。
```

#### 5. 缺少 context pack

子 Agent 现在主要拿到一段 task 文本和可用工具。它可以自己读文件，但父 Agent 无法精确控制“给它什么上下文、不给什么上下文”。

成熟 Agent 产品中，多 Agent 的核心往往不是“有几个 Agent”，而是 context engineering：

- 子 Agent 是否看到父对话历史？
- 是否只看到压缩后的 task brief？
- 是否携带当前 active change set？
- 是否携带用户规则、项目规则、已读文件摘要？
- 是否只能看某些文件片段？
- 是否能看到其他子 Agent 的 findings？
- 是否能看到隐藏诊断信息？

这些都应成为显式的 `ContextPack`，而不是散落在 prompt 字符串里。

#### 6. 结果不可结构化聚合

许多子 Agent 输出是一段 Markdown 文本。对人阅读够用，但对系统聚合不够：

- 不能稳定去重。
- 不能按严重程度排序。
- 不能追踪 evidence refs。
- 不能把 finding 直接变成 draft change。
- 不能可靠判断任务是否完成。
- 不能被 reducer/critic 稳定检查。

应该要求子 Agent 输出结构化结果，再由 reducer 生成用户可读 summary。

#### 7. UI 可观测性不足

用户应该看到的是一个 team 工作流，而不是聊天流里混杂几条 child session 事件。

理想 UI 应能回答：

- 哪些 Agent 正在运行？
- 每个 Agent 负责什么任务？
- 读了哪些文件？
- 生成了哪些 finding、artifact、draft change？
- 哪些任务失败、超时、被取消？
- 哪些任务是只读，哪些任务会写入？
- 哪些结果被 reducer 接纳或丢弃？
- 成本、耗时、token、工具调用量是多少？

## 3. 成熟产品参考

### 3.1 OpenAI Agents SDK

OpenAI Agents SDK 明确区分两种多 Agent 模式：

- **Agents as tools**：manager Agent 把 specialist 当工具调用，适合中心化控制和 bounded task。
- **Handoffs**：当前任务移交给另一个 Agent，适合 specialist 接管一段交互。

它也建议把 LLM 编排和 code 编排混用，例如：

- LLM 判断任务类型。
- 代码决定执行顺序。
- 多个 Agent 并行运行。
- reducer 汇总。
- critic loop 复核。

对 ResInk 的启发：

- 当前 `delegate_task` 属于 agents-as-tools。
- 应新增 handoff。
- Deep Review 这类任务应由 workflow graph 管理，而不是完全靠父 Agent 临场决定。

参考：

- <https://openai.github.io/openai-agents-python/multi_agent/>

### 3.2 Claude Code Subagents

Claude Code 的 subagents 更像可配置工作者：

- 每个 subagent 有独立上下文。
- 每个 subagent 有描述、系统提示和工具权限。
- 主 Agent 可以根据描述自动选择合适 subagent。
- Subagent 用于探索、计划、实现、审查等不同工作。

对 ResInk 的启发：

- 子 Agent 最重要的价值之一是保护主上下文。
- 应允许 background explorer 把大量阅读、搜索、定位工作放到子上下文里。
- Subagent 的可用工具、文件范围、预算要显式配置。

参考：

- <https://code.claude.com/docs/en/sub-agents>

### 3.3 LangChain / LangGraph

LangGraph 的多 Agent 重点不是固定专家列表，而是图式编排：

- Supervisor。
- Network。
- Hierarchical。
- Handoffs。
- Custom workflow。
- Context engineering。

对 ResInk 的启发：

- 论文任务天然适合 workflow graph。
- Graph 节点可以是 Agent，也可以是确定性代码。
- Reducer/critic 应该是图的一部分。

参考：

- <https://docs.langchain.com/oss/python/langchain/multi-agent>

### 3.4 AutoGen

AutoGen AgentChat 提供多种 team：

- `RoundRobinGroupChat`：轮流发言。
- `SelectorGroupChat`：模型选择下一个 speaker。
- `Swarm`：Agent 之间通过 handoff 转移控制权。
- `GraphFlow`：有向图定义顺序、并行、条件和循环。
- `Magentic-One`：orchestrator 规划、委派、跟踪进度并动态修订计划。

对 ResInk 的启发：

- 不应该默认采用开放 group chat，因为论文写作需要审计和写回控制。
- 但应该借鉴 `GraphFlow` 和 `Magentic-One` 的 orchestrator/task tracking。
- `SelectorGroupChat` 适合研究型探索，但要受预算和权限约束。

参考：

- <https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/tutorial/teams.html>
- <https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/graph-flow.html>
- <https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/magentic-one.html>

### 3.5 CrewAI

CrewAI 的关键抽象是 process：

- Sequential process。
- Hierarchical process。
- Manager Agent 分配、审查、判断完成。

对 ResInk 的启发：

- 多 Agent 的产品表达可以是“流程”，不一定是“群聊”。
- 对用户来说，“预投稿检查流程”“深度审稿流程”“编译修复流程”比“开几个 Agent 聊天”更自然。

参考：

- <https://docs.crewai.com/en/concepts/processes>

### 3.6 Google ADK

Google ADK 强调 workflow agents：

- sequence。
- parallel。
- loop。
- collaborative workflow。
- template workflow。

对 ResInk 的启发：

- 多 Agent 编排应支持确定性节点和 Agent 节点混合。
- 不要把所有事情都交给 LLM 自由讨论。

参考：

- <https://adk.dev/workflows/>

### 3.7 OpenHands / Skills

OpenHands 更偏 generalist coding agent + microagents/skills，而不是把所有能力都拆成多个显式 Agent。

对 ResInk 的启发：

- 不要滥用多 Agent。
- 很多能力应该先作为 skill、script、tool、workflow node 存在。
- 只有当需要上下文隔离、并行判断、独立权限或长期任务状态时，才升级为 Agent。

参考：

- <https://docs.openhands.dev/overview/skills>

## 4. ResInk 的目标模型

### 4.1 设计原则

1. **单 Agent 是默认，多 Agent 是有代价的能力。**
   普通问答、简单编辑、局部润色不应启动 team。

2. **多 Agent 优先表现为 workflow，而不是群聊。**
   用户触发的是“深度审阅”“预投稿检查”“编译修复”，而不是“让几个 Agent 聊聊”。

3. **Agent 可以并行，但写入必须汇聚到 Live Agent Workspace。**
   所有子 Agent 的修改都进入统一 change set，经过 draft review / Auto Accept / CAS writeback。

4. **子 Agent 默认是受限 worker。**
   只有明确配置的 coordinator 可以再 spawn child；普通 child 不允许递归委派。

5. **内置通用 Agent 是分发兜底。**
   专家 Agent 适合边界清晰的任务，但 runtime 必须提供 `general-agent` capability，用于探索、归纳、跨域小任务和难以稳定分类的任务。Planner/selector 无法高置信匹配专家时，应退回通用 Agent，而不是强行选择某个预设专家。

6. **Handoff 是显式产品行为。**
   Specialist 接管对话时，UI 应显示当前控制权归属和可随时返回主 Agent。

7. **ContextPack 是核心安全与质量边界。**
   子 Agent 不应默认继承全部父上下文。

8. **结果先结构化，再总结给用户。**
   子 Agent 返回 machine-readable results，reducer 再生成 Markdown summary。

9. **权限不是工具列表那么简单。**
   Policy 必须覆盖工具、文件范围、写入范围、网络、Python env、模型等级、预算、并发和 handoff 权限。

10. **用户看 workflow trace，不看内部混乱。**
   UI 默认展示 task cards 和结果摘要，详细 tool/event 进入 diagnostics。

### 4.2 推荐系统形态

```text
Browser AI panel
  -> AgentLoopV2
  -> AgentTeamOrchestrator
      -> AgentTaskPlanner
      -> AgentGraphRunner
      -> AgentTaskStore
      -> AgentContextPackBuilder
      -> AgentPolicyEngine
      -> child AgentLoopV2 sessions
      -> AgentResultReducer
      -> AgentHandoffManager
  -> Live Agent Workspace draft/change-set pipeline
  -> Overleaf CAS writeback
```

### 4.3 三种基础编排模式

#### 模式 A：Subagent-as-tool

适合：

- 有明确边界的小任务。
- 父 Agent 需要保持主控。
- 子 Agent 输出给父 Agent 进一步处理。

示例：

```text
父 Agent:
  请 citation-assistant 检查 main.bib 是否有重复条目。

citation-assistant:
  返回结构化 finding list。

父 Agent:
  结合用户问题决定是否创建 draft change。
```

#### 模式 B：Handoff

适合：

- Specialist 需要连续多步处理。
- 用户接下来几轮都在同一专业任务里。
- 父 Agent 转述会降低效率。

示例：

```text
用户: 编译报错，帮我修一下。

主 Agent:
  handoff -> compile-fixer

compile-fixer:
  compile -> inspect log -> edit draft -> compile -> report

完成后:
  handoff back -> main agent
```

#### 模式 C：Workflow graph

适合：

- 可预定义的复杂流程。
- 需要并行。
- 需要 reducer/critic。
- 需要强验收。

示例：

```text
Deep Review Graph:

prepare_context
  -> parallel:
      content-reviewer
      experiment-reviewer
      quality-checker
      citation-assistant
      document-auditor
  -> reducer
  -> critic
  -> user-facing review report
```

## 5. 核心抽象

### 5.1 AgentCapability

替代单薄的 `.md agent type`。

```ts
type AgentCapability = {
  name: string
  version: string
  description: string
  triggerHints: string[]
  role: 'general' | 'worker' | 'coordinator' | 'critic' | 'handoff-specialist'
  inputSchema?: JsonSchema
  outputSchema?: JsonSchema
  defaultModelTier: 'fast' | 'standard' | 'strong'
  defaultToolsets: string[]
  defaultPolicy: AgentPolicyCapsule
  contextPolicy: ContextPolicy
  systemPromptRef: string
  examples?: AgentExample[]
}
```

变化：

- Agent 不再只是 Markdown prompt。
- Agent 有 role、schema、policy、context policy、版本。
- Skill 可以声明自己的 AgentCapability。
- Registry 必须内置 `general-agent` capability。它不是兜底 prompt 注入，而是一个普通受控 capability：有 schema、policy、context policy、预算和 provenance。
- Planner/selector 必须支持 `selectionConfidence`。当任务难以界定、跨多个领域或没有专家 capability 命中时，选择 `general-agent`；当任务有明确领域和高置信命中时，才选择专家 Agent。

### 5.2 AgentTaskSpec

每个子任务都应是结构化对象。

```ts
type AgentTaskSpec = {
  id: string
  teamId: string
  parentTaskId?: string
  agent: string
  mode: 'tool' | 'handoff' | 'background' | 'workflow-node'
  objective: string
  acceptanceCriteria: string[]
  input: unknown
  outputSchema?: JsonSchema
  contextPackId: string
  policy: AgentPolicyCapsule
  dependencies: string[]
  priority: 'low' | 'normal' | 'high'
  timeoutMs: number
  retryPolicy: RetryPolicy
}
```

这让 task 可以排队、并行、恢复、取消、重试、审计。

### 5.3 AgentContextPack

子 Agent 不应直接继承父 Agent 全部上下文，而应拿到受控 context pack。

```ts
type AgentContextPack = {
  id: string
  projectId: string
  sessionId: string
  taskId: string
  userRequestSummary: string
  projectRules: string[]
  activeChangeSetId?: string
  files: Array<{
    path: string
    mode: 'full' | 'excerpt' | 'summary' | 'metadata'
    contentRef?: string
    reason: string
  }>
  artifacts: ArtifactRef[]
  priorFindings: FindingRef[]
  hiddenDiagnostics?: DiagnosticRef[]
  tokenBudget: number
}
```

原则：

- 默认不给父 Agent 全部聊天历史。
- 默认不给其他子 Agent 的完整过程。
- 给足完成任务需要的信息。
- 记录每个上下文片段为什么被提供。

### 5.4 AgentPolicyCapsule

权限不能只用 toolset 表达。

```ts
type AgentPolicyCapsule = {
  toolsets: string[]
  allowedTools: string[]
  deniedTools: string[]
  fileReadGlobs: string[]
  fileWriteGlobs: string[]
  canCreateDraftChanges: boolean
  canAutoAccept: boolean
  canHandoff: boolean
  canSpawn: boolean
  maxDepth: number
  maxParallelChildren: number
  maxTurns: number
  maxToolCalls: number
  maxTokens: number
  maxWallTimeMs: number
  modelTier: 'fast' | 'standard' | 'strong'
  networkPolicy: 'none' | 'declared-only' | 'admin-approved'
  pythonEnvironmentPolicy: 'none' | 'approved-snapshots-only'
}
```

### 5.5 AgentTaskResult

子 Agent 输出应结构化。

```ts
type AgentTaskResult = {
  taskId: string
  status: 'completed' | 'failed' | 'cancelled' | 'timeout'
  summary: string
  findings?: Finding[]
  proposedEdits?: ProposedEditRef[]
  artifacts?: ArtifactRef[]
  evidenceRefs?: EvidenceRef[]
  unresolvedQuestions?: string[]
  confidence: 'low' | 'medium' | 'high'
  nextActions?: NextAction[]
}
```

Finding 示例：

```ts
type Finding = {
  id: string
  severity: 'critical' | 'major' | 'minor' | 'info'
  category: string
  title: string
  description: string
  evidence: Array<{
    filePath: string
    lineStart?: number
    lineEnd?: number
    quote?: string
  }>
  suggestedFix?: string
  duplicateOf?: string
}
```

### 5.6 AgentResultReducer

Reducer 负责把多个 child result 合成稳定输出。

职责：

- 去重 findings。
- 合并同类问题。
- 按 severity 和 evidence 排序。
- 检查是否缺少证据。
- 标记冲突意见。
- 决定哪些 finding 进入用户报告。
- 决定哪些 proposed edit 进入 draft changes。

Reducer 可以是：

- 确定性代码。
- LLM reducer。
- 代码 + LLM 混合。

## 6. 关键产品工作流

### 6.1 Deep Review

目标：生成严谨、可定位、有证据的论文审阅报告。

```text
prepare_review_context
  -> parallel:
      content-reviewer
      experiment-reviewer
      quality-checker
      citation-assistant
      document-auditor
  -> reducer
  -> critic
  -> final_report
```

特点：

- Reviewer 并行。
- 每个 reviewer 拿不同 ContextPack。
- 输出结构化 findings。
- Reducer 去重并排序。
- Critic 检查 evidence 和过度推断。

### 6.2 Compile Fix

目标：修复 LaTeX 编译错误。

```text
handoff compile-fixer
  -> compile_latex
  -> inspect log
  -> edit draft
  -> compile again
  -> return summary
```

特点：

- 更适合 handoff，而不是父 Agent 反复委派。
- 写入必须进入 draft changes。
- Auto Accept 只在用户启用时走 CAS writeback。

### 6.3 Pre-submit Check

目标：投稿前检查格式、引用、结构、TODO、匿名性。

```text
document-auditor
  -> citation-assistant
  -> quality-checker
  -> reducer
  -> checklist report
```

特点：

- 更像 deterministic workflow。
- 结果可直接映射成 checklist。
- 不一定需要强 LLM coordinator。

### 6.4 Writing Edit With Background Explorer

目标：在不污染主上下文的情况下完成高质量编辑。

```text
background explorer:
  搜索相关段落、术语、前后文、项目规则

writing-editor:
  基于 ContextPack 做局部编辑

critic:
  检查是否改变技术含义、破坏引用/LaTeX
```

特点：

- Explorer 只读。
- Writer 有有限写权限。
- Critic 只读。
- 所有修改进入同一 change set。

### 6.5 Rebuttal Workflow

目标：生成逐点回复。

```text
parse_reviews
  -> split reviewer comments
  -> parallel response-drafters
  -> evidence-checker
  -> tone-checker
  -> reducer
  -> response-to-reviewers.tex draft
```

特点：

- 子任务可按 reviewer comment 分片。
- Reducer 保证口吻一致。
- Evidence checker 防止无证据承诺。

## 7. 数据模型草案

### 7.1 `aiAgentTeams`

```js
{
  _id,
  projectId,
  rootSessionId,
  rootChangeSetId,
  workflowType: 'deep-review' | 'compile-fix' | 'pre-submit' | 'custom',
  status: 'running' | 'completed' | 'failed' | 'cancelled',
  startedBy,
  startedAt,
  completedAt,
  policySummary,
  budgetSummary
}
```

### 7.2 `aiAgentTasks`

```js
{
  _id,
  teamId,
  parentTaskId,
  sessionId,
  agentName,
  mode: 'tool' | 'handoff' | 'background' | 'workflow-node',
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'timeout',
  objective,
  acceptanceCriteria,
  contextPackId,
  policy,
  dependencies,
  startedAt,
  completedAt,
  resultId,
  error
}
```

### 7.3 `aiAgentContextPacks`

```js
{
  _id,
  teamId,
  taskId,
  projectId,
  files,
  artifacts,
  priorFindings,
  projectRules,
  tokenBudget,
  createdAt
}
```

### 7.4 `aiAgentTaskResults`

```js
{
  _id,
  taskId,
  teamId,
  status,
  summary,
  findings,
  proposedEdits,
  artifacts,
  evidenceRefs,
  confidence,
  nextActions,
  createdAt
}
```

### 7.5 `aiAgentTeamEvents`

```js
{
  _id,
  teamId,
  taskId,
  sessionId,
  type,
  payload,
  createdAt
}
```

## 8. API 与事件

### 8.1 API 草案

```text
POST /api/ai/sessions/:sessionId/team-runs
GET  /api/ai/sessions/:sessionId/team-runs/:teamId
POST /api/ai/sessions/:sessionId/team-runs/:teamId/cancel
POST /api/ai/sessions/:sessionId/team-runs/:teamId/tasks/:taskId/retry
GET  /api/ai/sessions/:sessionId/team-runs/:teamId/results
```

### 8.2 SSE 事件

```text
agent_team.started
agent_team.completed
agent_team.failed
agent_task.queued
agent_task.started
agent_task.progress
agent_task.completed
agent_task.failed
agent_task.cancelled
agent_handoff.requested
agent_handoff.accepted
agent_handoff.completed
agent_graph.node_started
agent_graph.node_completed
agent_reducer.started
agent_reducer.completed
agent_critic.started
agent_critic.completed
```

事件原则：

- 用户默认看到产品级事件。
- diagnostics 才显示底层 tool call。
- 不暴露隐藏 prompt、完整 child reasoning、secret、private env。

## 9. UI 设计方向

AI 面板应支持一个 team trace 区域：

```text
Deep Review
  running
  5 tasks
  3 completed, 2 running

  content-reviewer       completed   7 findings
  experiment-reviewer    running     reading results.tex
  citation-assistant     completed   2 citation issues
  document-auditor       completed   4 structural warnings
  reducer                queued
```

交互原则：

- 默认折叠细节，避免聊天流噪音。
- 每个 Agent/task 是一张可展开 task card。
- Finding 可以跳转到文件位置。
- Draft change 显示来源 Agent。
- 用户可以取消整个 team run。
- 用户可以重试失败 task。
- Handoff 时明确显示“当前由 compile-fixer 接管”。
- Reload 后 team trace 可恢复。

## 10. 权限、安全与预算

### 10.1 权限继承

子 Agent 权限必须满足：

```text
childPolicy <= parentPolicy <= user/project/admin policy
```

不可出现：

- 父 Agent 只读，子 Agent 可写。
- 父 Agent 无网络，子 Agent 可联网。
- 父 Agent 无 Python env，子 Agent 可运行未审批环境。
- 父 Agent 不能 spawn，子 Agent 可以 spawn。

### 10.2 递归与并发

默认：

- 普通 worker 不能 spawn。
- Coordinator 可 spawn，但必须有 `maxDepth`。
- 每个 team 有 `maxParallelTasks`。
- 每个 session 有 global budget。
- 每个 project 有并发 team 限制。

### 10.3 写入边界

子 Agent 写入必须：

- 只写 sandbox workspace。
- 生成 draft changes。
- 附带 task/agent provenance。
- 不能绕过 Live Agent Workspace。
- 不能直接写 canonical Overleaf docs。
- Auto Accept 也必须走 CAS writeback。

### 10.4 网络与 Python

多 Agent 与 Python Dependency Broker 必须联动：

- 子 Agent 不能通过 `run_command` 自由安装包。
- Skill script 只能使用 approved environment snapshot。
- Project Python env 必须经过 dependency request/approval。
- 子 Agent 的 network policy 默认继承父 Agent，不能提升。

## 11. 何时不该用多 Agent

不要因为“成熟产品支持多 Agent”就把所有能力都拆成 Agent。

不适合多 Agent：

- 简单问答。
- 单文件小改。
- 局部润色。
- 明确的单工具任务。
- 用户希望快速答复。
- 任务上下文很小，拆分反而增加成本。

更适合：

- 多维度审阅。
- 大项目上下文探索。
- 编译/引用/格式多个系统交叉的问题。
- 需要独立批判或复核。
- 需要并行处理多个文件或 reviewer comments。
- 需要长期后台任务状态。

## 12. 与现有实现的关系

由于产品仍在封闭开发阶段，这次不需要设计兼容层。现有实现的价值是提供经验和验收样例，而不是作为必须继续承载产品 API 的基础。

新架构应直接替换以下旧形态：

| 旧形态 | 问题 | 新形态 |
|---|---|---|
| `delegate_task({ task, agent })` | schema 太薄，无法表达验收、上下文、权限、依赖、并发、恢复 | `AgentTaskSpec` |
| `agents/*.md` 静态 Agent 类型 | 缺少版本、schema、role、policy、context policy，无法由 skill 声明 team | `AgentCapabilityRegistry` |
| 多个 `delegate_task` 顺序执行 | 无法表达 fan-out/join，效率低 | `AgentGraphRunner` 并行 task graph |
| 子 Agent 返回 Markdown summary | 难以去重、聚合、复核、映射到 draft change | `AgentTaskResult` + `AgentResultReducer` |
| 父 Agent 自然语言拼接 task context | 上下文不可审计，容易过载或泄漏 | `AgentContextPackBuilder` |
| 只有 toolset 级权限 | 无法约束文件范围、网络、Python env、模型等级、预算 | `AgentPolicyCapsule` |
| child session 事件混在聊天流 | 用户难理解 workflow 状态 | Team trace UI |

### 12.1 替换原则

1. **不保留旧 `delegate_task` 作为产品 API。**
   可以在开发过程里临时保留内部 shim 方便测试，但最终用户路径和模型可见工具应切换到新的 team/task/handoff 工具。

2. **不要求旧 Agent frontmatter 格式兼容。**
   旧 `agents/*.md` 可以批量迁移为 `AgentCapability`，迁移后删除旧 registry。

3. **不保留顺序多 `delegate_task` 的 Deep Review 编排。**
   Deep Review 应直接改成 workflow graph，明确 fan-out、join、reducer、critic。

4. **不保留 Markdown-only 子 Agent 输出作为系统内部契约。**
   子 Agent 可生成用户可读摘要，但内部结果必须结构化。

5. **不保留“父 Agent 字符串转述上下文”的模式。**
   所有子任务上下文都应由 `ContextPackBuilder` 构建并记录。

6. **旧实现只提供验收基线。**
   例如：子 Agent provenance、工具子集继承、budget 限制、Live Agent Workspace 写回路径必须在新架构里重新实现并通过 E2E 验证。

### 12.2 推荐替换顺序

这不是对外渐进发布顺序，而是降低工程风险的实现顺序。每一步完成后都可以删除对应旧路径。

1. 建立 `AgentCapabilityRegistry`，把旧 `agents/*.md` 迁移为 capability 定义，然后删除旧 `AgentTypeRegistry` 产品路径。
2. 建立 `AgentTaskStore`、`AgentTaskSpec`、`AgentTaskResult`，让 team task 成为一等对象。
3. 建立 `AgentContextPackBuilder`，禁止新子任务直接继承父上下文全文。
4. 建立 `AgentPolicyCapsule`，替换单纯 toolset 权限。
5. 建立 `general-agent` 内置 capability，并在 planner/selector 中实现低置信兜底选择。
6. 建立 `AgentTeamOrchestrator`，统一创建 child sessions、预算、状态、事件。
7. 建立 `AgentGraphRunner`，将 Deep Review 改为并行 workflow graph。
8. 建立 `AgentResultReducer` 和 critic 节点，替换父 Agent 手写汇总。
9. 建立 `AgentHandoffManager`，让 compile/citation/rebuttal 等 specialist 可以临时接管。
10. 更新前端 team trace UI，删除聊天流里临时拼接 child event 的产品表达。
11. 删除旧 `delegate_task({ task, agent })` 模型可见工具、旧静态 registry、旧 Deep Review prompt 编排和旧 child event UI 假设。

## 13. 需要决策的问题

在写开发计划前，建议先确认这些产品决策：

1. 是否允许普通用户显式选择某个专家 Agent，还是只暴露 workflow 和系统自动分发？
2. Handoff 是否需要用户确认，还是由系统自动切换？
3. Skill 是否可以声明自己的 AgentCapability？如果可以，是否需要管理员审核？
4. Deep Review 是否默认并行跑所有 reviewer，还是由 planner 根据论文内容选择？
5. 子 Agent 的完整 transcript 是否对用户可见，还是只在 diagnostics/admin 可见？
6. Writing editor 子 Agent 是否允许直接产生 draft changes？
7. Critic/reducer 应优先用确定性代码、LLM，还是混合？
8. 多 Agent 的成本预算如何在 UI 上展示？
9. 是否需要后台长任务队列，允许用户离开页面后继续运行？
10. 多 Agent workflow 是否应支持跨 turn resume，还是每次 team run 都绑定单个 user turn？

## 14. 推荐方向

推荐把下一阶段目标定义为：

**Agent Team Runtime：一个面向论文写作工作流的受控多 Agent 编排层。**

它不是开放 swarm，不是 reviewer prompt 列表，也不是把所有工具都变成 Agent。它应该提供：

- `subagent-as-tool`：短任务、父 Agent 主控。
- `handoff`：specialist 临时接管。
- `workflow graph`：Deep Review / Pre-submit / Rebuttal 等确定性流程。
- `background explorer`：上下文收集不污染主会话。
- `structured results`：findings、edits、artifacts、evidence refs。
- `policy capsule`：工具、文件、网络、Python env、预算、模型等级统一约束。
- `team trace UI`：用户能理解发生了什么，也能取消/重试/审阅结果。

如果这个设计方向确认，后续应另写：

```text
services/ai-writing-agent/doc/agent-team-runtime-development-plan.md
```

该开发计划应按既有风格拆成 M0-Mx，并要求真实部署、浏览器 E2E、live model、多 Agent 并行、handoff、writeback、reload、预算和安全负向测试。
