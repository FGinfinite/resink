# Agent Team Runtime Development Plan

> Goal: replace the current static `delegate_task` / `.md agent type` subagent model with a clean Agent Team Runtime for ResInk AI.
>
> This migration assumes the product is still in closed development. There are no external users, public API consumers, or historical multi-agent workflows that require compatibility. Do not build a long-term compatibility layer for `delegate_task({ task, agent })`, old `AgentTypeRegistry`, static `agents/*.md` products, sequential Deep Review dispatch, or Markdown-only child-agent result contracts.
>
> This document is written for one long-running autonomous `/goal` execution. The agent should drive the whole migration to completion, use implementation subagents for separable workstreams, require independent verification subagents for browser/live-model/writeback/security/reload checks, and commit after every completed milestone.

## 1. Product Positioning

ResInk AI should not expose multi-agent behavior as a loose group chat or a list of hard-coded reviewers. The target product is:

**A controlled Agent Team Runtime for LaTeX research workflows, embedded in Overleaf and backed by AgentLoopV2, Live Agent Workspace, sandbox command/skill runtime, and the UV Python Dependency Broker.**

The user-facing product should feel like workflows:

- Deep Review
- Compile Fix
- Pre-submit Check
- Citation Audit
- Rebuttal Drafting
- Focused Writing Edit
- Background Project Exploration

The system-facing runtime should support:

- `subagent-as-tool` for bounded worker tasks.
- `handoff` for specialists that temporarily take over a conversation.
- `workflow graph` for deterministic fan-out/join/reducer/critic flows.
- `background explorer` agents for context gathering without polluting the main conversation.
- Structured task specs, context packs, results, findings, artifacts, and draft-change provenance.
- Fine-grained policy capsules for tools, files, write scope, network, Python environments, model tier, budget, depth, and concurrency.

## 2. Design Inputs

Primary design source:

- `services/ai-writing-agent/doc/multi-agent-orchestration-architecture-design.md`

Required existing architecture boundaries:

- `services/ai-writing-agent/doc/live-agent-workspace-development-plan.md`
- `services/ai-writing-agent/doc/sandbox-command-skill-runtime-development-plan.md`
- `services/ai-writing-agent/doc/uv-python-dependency-broker-development-plan.md`
- `services/ai-writing-agent/doc/hermes-style-agent-loop-development-plan.md`

The new runtime must preserve these product facts:

- Overleaf owns auth, project permissions, canonical documents, editor state, collaboration, and CAS writeback.
- AgentLoopV2 owns model/tool orchestration, persistent sessions, message/tool persistence, and SSE events.
- Live Agent Workspace owns draft changes, change sets, Review mode, Auto Accept mode, and canonical writeback orchestration.
- Sandbox runtime owns workspace commands, skill scripts, artifacts, TeX/Python execution, and isolation.
- UV Python Dependency Broker owns package trust, locked environments, approved snapshots, and dependency request approval.

## 3. Non-Goals

- Do not build an open-ended swarm/group chat as the default product model.
- Do not keep expanding static `agents/*.md` files as the primary agent registry.
- Do not keep `delegate_task({ task, agent })` as the long-term model-visible product API.
- Do not let child agents bypass parent policy, Live Agent Workspace, Overleaf permission checks, or Python dependency policy.
- Do not expose hidden prompts, full child reasoning, index credentials, model secrets, or raw diagnostic logs to ordinary users.
- Do not mark runtime milestones complete with only unit/lint/type checks.
- Do not create compatibility shims unless they are short-lived implementation scaffolding removed before final acceptance.

## 4. Architecture Principles

1. **Clean replacement over gradual compatibility.**
   Reuse proven concepts from the old implementation, not its public shape. The final product path should use team/task/handoff/workflow APIs directly.

2. **Workflow first, group chat last.**
   Most user-facing multi-agent features should be deterministic workflows with Agent nodes, reducer nodes, and critic nodes.

3. **Single Agent remains the default.**
   Multi-agent execution is reserved for tasks that need context isolation, parallel review, independent critique, specialist handoff, or long-running background work.

4. **Every child task has a structured spec.**
   Natural language task strings are not enough. Each task records objective, acceptance criteria, input, expected output schema, context pack, policy capsule, dependencies, priority, timeout, and retry policy.

5. **Every child task receives a context pack.**
   Child agents do not inherit full parent conversation history by default. Context is deliberately selected, budgeted, recorded, and justified.

6. **Every child result is structured.**
   Child agents may include human-readable summaries, but the system contract is `AgentTaskResult` with findings, evidence, artifacts, proposed edits, confidence, unresolved questions, and next actions.

7. **Parallelism is explicit and bounded.**
   Fan-out is useful for review, audit, and exploration, but all concurrency is controlled by team budget, project budget, user/admin policy, and sandbox capacity.

8. **Handoff is a first-class state transition.**
   When a specialist takes over, session state, UI state, tool policy, and return conditions are explicit.

9. **All writes flow through Live Agent Workspace.**
   Child agents can edit only sandbox workspace files. Draft changes carry team/task/agent provenance and canonical writeback remains CAS-gated.

10. **Policy inheritance is monotonic.**
    `childPolicy <= parentPolicy <= user/project/admin policy`. Child agents cannot gain tools, file access, network, Python envs, model tier, write scope, or spawn rights that the parent did not have.

11. **Team trace is product UI, low-level logs are diagnostics.**
    Users should see task cards, state, findings, artifacts, and draft changes. Raw tool logs stay behind diagnostics/admin views.

12. **Subagents are also part of development verification.**
    Implementation subagents own disjoint workstreams. Verification subagents independently test browser, live model, writeback, policy, reload, conflict, and cleanup behavior.

## 5. Target Runtime Shape

```text
Browser AI panel
  -> Web /api/ai proxy
  -> AgentLoopV2 root session
  -> AgentTeamOrchestrator
      -> AgentCapabilityRegistry
      -> AgentTaskPlanner
      -> AgentTaskStore
      -> AgentContextPackBuilder
      -> AgentPolicyEngine
      -> AgentGraphRunner
      -> AgentHandoffManager
      -> child AgentLoopV2 sessions
      -> AgentResultReducer
      -> AgentTeamEventNormalizer
  -> Live Agent Workspace change sets and draft changes
  -> Overleaf CAS writeback
```

### Runtime Modes

| Mode | Purpose | Control Owner | Example |
|---|---|---|---|
| single-agent | Default chat/edit flow. | Root AgentLoopV2 | Local prose edit |
| subagent-as-tool | Bounded worker task. | Parent/root agent | Citation check |
| handoff | Specialist temporarily owns conversation. | Handoff manager | Compile fixer |
| workflow graph | Deterministic multi-step team workflow. | Graph runner | Deep Review |
| background explorer | Read-only context gathering. | Team orchestrator | Locate related sections |

## 6. Core Components

### AgentCapabilityRegistry

Replaces static product dependence on `AgentTypeRegistry` and `agents/*.md`.

Responsibilities:

- Load built-in agent capabilities from structured definitions.
- Load skill-provided agent capabilities after skill package validation.
- Validate name, version, role, prompt reference, input schema, output schema, default policy, context policy, trigger hints, examples, and safety classification.
- Expose capability metadata to planner, graph runner, handoff manager, and UI.
- Skip invalid capabilities with safe diagnostics.

Capability roles:

- `worker`
- `coordinator`
- `critic`
- `reducer`
- `handoff-specialist`
- `background-explorer`

### AgentTaskStore

Persists task lifecycle and allows reload/resume/retry/cancel.

Responsibilities:

- Create task specs.
- Track `queued`, `running`, `completed`, `failed`, `cancelled`, `timeout`.
- Store dependencies and graph position.
- Link child session ids, tool call ids, context pack ids, result ids, and draft change ids.
- Summarize budget and runtime evidence.

### AgentContextPackBuilder

Builds scoped context for each task.

Responsibilities:

- Build task briefs from parent/root session state.
- Select files, excerpts, summaries, artifacts, findings, project rules, active change set, and diagnostics according to context policy.
- Keep context under token budget.
- Record why each context item was included.
- Prevent hidden prompt, secret, raw credential, or unrelated project leakage.

### AgentPolicyEngine

Computes and enforces policy capsules.

Responsibilities:

- Intersect parent, capability, workflow, user, project, and admin policies.
- Enforce monotonic inheritance.
- Gate tools, file globs, write scope, handoff, spawn, model tier, network, Python env, wall time, token budget, tool calls, depth, and concurrency.
- Integrate with sandbox command policy and UV Python Dependency Broker.
- Produce audit-friendly denial reasons.

### AgentTeamOrchestrator

Top-level runtime service for teams.

Responsibilities:

- Start team runs.
- Dispatch tasks.
- Create child AgentLoopV2 sessions.
- Attach context packs and active change sets.
- Stream normalized team events.
- Track budget and cancellation.
- Route results to reducers and handoff manager.
- Mark teams completed/failed/cancelled.

### AgentGraphRunner

Runs deterministic workflow graphs.

Responsibilities:

- Execute sequence, parallel, conditional, reducer, critic, and loop nodes.
- Support fan-out/fan-in.
- Respect dependencies and concurrency caps.
- Retry failed nodes according to policy.
- Persist graph state for reload/resume.

### AgentHandoffManager

Handles specialist control transfer.

Responsibilities:

- Create handoff state.
- Decide whether user confirmation is required.
- Switch active session owner/profile/tool policy.
- Show UI state for current specialist.
- Return control to root agent on completion, cancellation, or timeout.
- Preserve transcript, task result, draft changes, and provenance.

### AgentResultReducer

Combines child task outputs into product results.

Responsibilities:

- Validate child output schemas.
- Deduplicate findings.
- Merge related issues.
- Rank by severity and evidence.
- Detect conflicts between reviewers.
- Convert accepted findings/proposed edits into draft changes when appropriate.
- Generate final user-facing report.

### AgentTeamEventNormalizer

Turns internal team/task/graph/handoff events into frontend-safe SSE events.

Responsibilities:

- Redact prompts, secrets, raw logs, credentials, and hidden diagnostics.
- Preserve task ids, status, summaries, findings, artifact refs, draft change refs, cost/budget summaries, and provenance.
- Separate product events from diagnostics events.

## 7. Data Model

### `aiAgentTeams`

```js
{
  _id,
  projectId,
  userId,
  rootSessionId,
  rootChangeSetId,
  workflowType: 'deep-review' | 'compile-fix' | 'pre-submit' | 'citation-audit' | 'rebuttal' | 'custom',
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled',
  mode: 'workflow-graph' | 'handoff' | 'subagent-tool' | 'background',
  startedBy,
  policySummary,
  budgetSummary,
  startedAt,
  updatedAt,
  completedAt
}
```

### `aiAgentTasks`

```js
{
  _id,
  teamId,
  parentTaskId,
  rootSessionId,
  childSessionId,
  agentName,
  agentVersion,
  mode: 'tool' | 'handoff' | 'background' | 'workflow-node' | 'reducer' | 'critic',
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'timeout',
  objective,
  acceptanceCriteria,
  input,
  outputSchema,
  contextPackId,
  policy,
  dependencies,
  priority,
  timeoutMs,
  retryPolicy,
  resultId,
  error,
  startedAt,
  completedAt
}
```

### `aiAgentContextPacks`

```js
{
  _id,
  teamId,
  taskId,
  projectId,
  sessionId,
  activeChangeSetId,
  userRequestSummary,
  projectRules,
  files: [
    { path, mode, contentRef, reason, tokenEstimate }
  ],
  artifacts,
  priorFindings,
  diagnostics,
  tokenBudget,
  createdAt
}
```

### `aiAgentTaskResults`

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
  unresolvedQuestions,
  confidence,
  nextActions,
  usage,
  createdAt
}
```

### `aiAgentTeamEvents`

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

## 8. API And Event Surface

### APIs

```text
POST /api/ai/sessions/:sessionId/team-runs
GET  /api/ai/sessions/:sessionId/team-runs
GET  /api/ai/sessions/:sessionId/team-runs/:teamId
POST /api/ai/sessions/:sessionId/team-runs/:teamId/cancel
POST /api/ai/sessions/:sessionId/team-runs/:teamId/tasks/:taskId/retry
GET  /api/ai/sessions/:sessionId/team-runs/:teamId/results
GET  /api/ai/sessions/:sessionId/team-runs/:teamId/events
```

### Model-Visible Tools

Final product tools should replace the old thin delegation shape:

```text
start_agent_team
start_agent_task
handoff_to_agent
return_from_handoff
cancel_agent_task
inspect_agent_team
```

Rules:

- `delegate_task({ task, agent })` is not a final product tool.
- Any temporary shim must be removed by final acceptance.
- Tool schemas must include structured task spec fields and policy constraints.

### SSE Events

```text
agent_team.started
agent_team.completed
agent_team.failed
agent_team.cancelled
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

## 9. Replacement Map

| Replace | With | Final state |
|---|---|---|
| `AgentTypeRegistry` product path | `AgentCapabilityRegistry` | Old registry removed from normal product startup. |
| `agents/*.md` as product source | structured capability packages | Old files migrated or deleted. |
| `delegate_task({ task, agent })` | `start_agent_task` / workflow graph / handoff tools | Old tool removed from normal model-visible toolsets. |
| Sequential Deep Review prompt dispatch | `deep-review` workflow graph | Parallel reviewers, reducer, critic. |
| Child Markdown summary as internal contract | `AgentTaskResult` | Markdown summary becomes display field only. |
| Parent string-built context | `AgentContextPack` | Child context is recorded and budgeted. |
| Toolset-only child policy | `AgentPolicyCapsule` | Policy covers files/network/Python/model/budget. |
| Chat-stream child events | Team trace UI | Product UI shows workflow state. |

## 10. Milestone Board

Status format:

```text
- [ ] Mx: pending
- [~] Mx: in progress - owner/evidence
- [x] Mx: done - key files, verification, E2E/security evidence, commit
```

Initial status:

- [x] M0: Baseline audit and deletion map - 2026-06-24 old `delegate_task`/`AgentTypeRegistry`/frontend child-session/Deep Review prompt paths mapped; baseline unit/lint/manual smoke passed; committed in `37b4fe6f17`.
- [x] M1: Capability registry and policy capsule foundation - 2026-06-24 structured built-in capability registry, monotonic policy engine, prompt-safe runtime status service, unit/lint/syntax/container diagnostics complete; committed in `916a5366e4`.
- [x] M2: Task store, structured specs, and context packs - 2026-06-24 structured `AgentTaskSpec`, Mongo-backed `AgentTaskStore`, scoped `AgentContextPackBuilder`, team collections/indexes, reload smoke, and prompt/secret redaction tests complete; committed in `9e6b7ae768` and `adce014de6`.
- [x] M3: Team orchestrator and subagent-as-tool replacement - 2026-06-24 `AgentTeamOrchestrator`, `start_agent_task`, child AgentLoop runner, promptRef loader, default toolset replacement, persisted task/result/event redaction, tool schema repair, policy inheritance repair, and child draft provenance implemented; unit/lint/container Mongo smoke, live-model API smoke, and durable writeback smoke passed; committed in `c8327541af`.
- [x] M4: Graph runner and Deep Review workflow - 2026-06-24 `AgentGraphRunner`, `deep-review` graph, `start_agent_team`, reducer/critic capabilities, review skill migration, reloadable graph events/results, targeted unit/lint, Mongo smoke, and live AgentLoop tool smoke complete; committed in `a471d0c589`.
- [x] M5: Structured results, reducer, critic, and finding model - 2026-06-24 `AgentTaskResult` validator, finding schema, reducer dedupe, critic downgrade/report rendering, graph reducer/critic synthetic tasks, unit/lint, and Mongo structured-result smoke complete; committed in `1d2e1e2684`.
- [x] M6: Handoff manager and specialist takeover - 2026-06-24 `AgentHandoffManager`, `handoff_to_agent`, `return_from_handoff`, activeHandoff session state, compile-fixer handoff policy denial/return, unit/lint, and Mongo smoke complete; committed in `93cfb46393`.
- [x] M7: Team trace UI and reload/resume - backend team run API, live/reload trace hydration, cancel semantics, browser reload smoke, and M9-backed retry execution completed.
- [x] M8: Skill-provided agent capabilities and dependency policy integration - skill.json agent capability schema, activation-scoped registration, prompt loading, and dependency-policy guard tests completed.
- [x] M9: Security, budgets, cancellation, conflict, and cleanup - 2026-06-25 code-level hardening, browser Team Trace retry/cancel/reload, live root Auto Accept writeback, live child/team Auto Accept writeback, forced stale writeback conflict, real local Docker sandbox cleanup, targeted unit/lint, and post-run Docker/Mongo residue audits passed.
- [x] M10: Remove legacy multi-agent paths and final acceptance - 2026-06-25 legacy `delegate_task`, `AgentTypeRegistry`, `agents/*.md`, and old child-session UI product paths deleted; built-in capability prompts migrated into structured capability definitions; full AI unit/eslint, web type-check/targeted eslint, deployed dev-stack health, browser team-trace reload smoke, live-model structured team-tool smoke, final M9 E2E sweep, sandbox cleanup smoke, and cleanup audit passed.

## 11. M0: Baseline Audit And Deletion Map

### Objective

Establish the exact current multi-agent implementation and mark what will be replaced instead of extended.

### Implementation Tasks

- Audit:
  - `delegate_task.js`
  - `AgentTypeRegistry.js`
  - `agents/*.md`
  - `ToolsetPolicy.js`
  - `ToolPool.js`
  - `AgentController` child session handling
  - `AgentLoop` child event streaming
  - Live Agent Workspace subagent provenance integration
  - frontend child session event handling
  - Deep Review skills/prompts
- Write an implementation deletion map in this document or a linked implementation note.
- Identify all model-visible references to `delegate_task`.
- Identify all UI assumptions around child sessions.
- Identify tests that prove old behavior and decide which become replacement acceptance tests.

### Acceptance Criteria

- Every old multi-agent product path has a replacement target.
- No runtime code is modified before the audit map is complete.
- Existing unrelated worktree changes are preserved.

### Verification

```bash
cd services/ai-writing-agent
npm run test:unit -- test/unit/js/tool/DelegateTaskToolTests.test.js test/unit/js/skill/AgentTypeRegistryTests.test.js
npx eslint app/js/tool app/js/skill test/unit/js/tool test/unit/js/skill
```

### E2E Evidence

- Browser/live model can still run the current subagent flow before replacement.
- Evidence captures current limitations: sequential dispatch, Markdown-only result, and child event UI behavior.

### 2026-06-24 M0 Baseline Audit Checkpoint

Current old-product path:

- `AgentController.initialize()` loads `SkillRegistry`, then `AgentTypeRegistry`, then registers `DelegateTaskTool` into the root `toolRegistry`.
- `ToolsetPolicy` exposes `delegate_task` through the `subagent` toolset, and the `default` / `paper-reviewer` profiles include that toolset.
- `DelegateTaskTool` exposes the model-visible schema `{ task, agent }`; this is too thin for target team runtime requirements because it has no structured acceptance criteria, context pack, output schema, task dependencies, retry policy, or complete policy capsule.
- `DelegateTaskTool` looks up `agent` in `AgentTypeRegistry`, creates a child session through `AgentController.createChildSession()`, builds a child `AgentLoopV2` from the markdown body, streams child events back to the parent, persists child messages/tool calls, and returns the final child text as the parent tool result.
- Child tool names currently come from the static agent markdown `tools` frontmatter and are filtered against parent `allowedToolNames`; this prevents simple tool escalation but does not cover the target policy dimensions for file globs, write scope, network, Python envs, model tier, task budget, graph depth, and concurrency.
- Child draft changes currently inherit the parent active change set through existing Live Agent Workspace integration, but provenance is attached to a child session/tool call rather than a structured team/task/result graph.

Static agent inventory:

| Agent file | Current role | Current tools | Replacement capability |
|---|---|---|---|
| `agents/content-reviewer.md` | Content peer reviewer | `read_document`, `list_files`, `search_project` | Built-in `content-reviewer` worker capability with structured finding output. |
| `agents/experiment-reviewer.md` | Experiment peer reviewer | `read_document`, `list_files`, `search_project` | Built-in `experiment-reviewer` worker capability with experiment finding schema. |
| `agents/quality-checker.md` | Typesetting/reference quality checker | `read_document`, `list_files`, `search_project` | Built-in `quality-checker` worker capability or `deep-review` graph node. |
| `agents/document-auditor.md` | Structure/cross-reference auditor | `read_document`, `list_files`, `search_project`, `label_ref_audit`, `doc_structure_map` | Built-in `document-auditor` background/worker capability. |
| `agents/citation-assistant.md` | Citation specialist | `read_document`, `list_files`, `search_project`, `bib_lookup`, `bib_manage` | Built-in `citation-assistant` worker/handoff capability. |
| `agents/compile-fixer.md` | Compile repair specialist | `list_files`, `read_document`, `compile_latex`, `edit_document`, `sync_workspace_changes`, `read_skill_reference`, `run_skill_script`, `write_workspace_file` | Built-in `compile-fixer` handoff-specialist capability. |
| `agents/writing-editor.md` | Focused writing editor | `read_document`, `list_files`, `search_project`, `edit_document`, `sync_workspace_changes`, `read_skill_reference`, `run_skill_script`, `write_workspace_file` | Built-in `writing-editor` worker/handoff capability. |

Deep Review baseline:

- Active Deep Review is prompt/skill driven through `skills/review/SKILL.md`.
- The skill lists `delegate_task` as the coordination tool and names the static reviewers `content-reviewer`, `experiment-reviewer`, and `quality-checker`.
- The skill explicitly tells the model to call multiple `delegate_task` calls in a single response and notes they execute sequentially.
- There is no persisted `deep-review` workflow graph, no graph node state, no structural fan-out/fan-in, no reducer node, no critic node, and no structured reviewer finding contract.
- Legacy `dispatch_reviewer` appears to be stale residue rather than the active product path.

Frontend baseline:

- `ai-types.ts` models `ToolCallEntry.childSessionId`, `AIMessage.childSessionParts`, and SSE `child_session_init`.
- `ai-assistant-context.tsx` routes child events by session id into `childActiveBlocks`, associates `child_session_init` with the last running `delegate_task`, and persists child blocks into `childSessionParts` on message completion.
- `message-list.tsx` passes child blocks to the tool-call renderer by `childSessionId`.
- `tool-call-list.tsx` special-cases `entry.tool === 'delegate_task'` and renders `SubAgentTaskBlock`.
- This UI shape is fragile for true parallel team workflows because child trace state is nested under chat tool-call blocks instead of being a reloadable team/task graph.

Deletion map:

| Old product path | Replacement target | Delete timing and acceptance evidence |
|---|---|---|
| Model-visible `delegate_task({ task, agent })` | `start_agent_task`, workflow graph APIs, and handoff tools backed by `AgentTeamOrchestrator` | Remove from normal product toolsets after live model evidence shows structured task creation through new tools and `delegate_task` absent from model-visible `body.tools`. |
| `AgentTypeRegistry.js` and `agents/*.md` product registry | `AgentCapabilityRegistry` with structured built-in and skill-provided capability definitions | Remove after built-in reviewers/editors/fixers load through capability registry and child sessions are created from `AgentTaskSpec`. |
| Static markdown agent body as child system prompt contract | Capability prompt/reference refs plus context packs | Remove after child contexts are built by `AgentContextPackBuilder` and hidden prompts are not exposed in public events. |
| Deep Review prompt dispatch in `skills/review/SKILL.md` | `deep-review` `AgentGraphRunner` workflow with parallel reviewers, reducer, and critic | Remove after browser/live Deep Review creates persisted parallel reviewer tasks and reducer/critic results. |
| Sequential multiple `delegate_task` execution in `AgentLoop` | Orchestrator/graph-managed bounded parallel execution | Remove after unit and live evidence show bounded parallel reviewers, budget enforcement, cancellation, and cleanup. |
| Markdown-only child final text as internal result contract | `AgentTaskResult` validator, finding schema, artifacts, evidence refs, and reducer input | Remove after reducer consumes structured findings and rejects malformed child results. |
| Frontend `childSessionParts` as product trace | Team trace UI with task cards, findings, artifacts, handoff banner, reload, cancel, retry | Remove after reloadable UI reconstructs team runs from `aiAgentTeams` / task/event APIs. |
| `dispatch_reviewer` styling/comment residue | New Deep Review team trace styling | Delete when graph UI lands; acceptance is no active `dispatch_reviewer` hits in app/test/frontend code. |

Baseline verification:

```bash
cd services/ai-writing-agent
npm run test:unit -- test/unit/js/tool/DelegateTaskToolTests.test.js test/unit/js/skill/AgentTypeRegistryTests.test.js
npx eslint app/js/tool app/js/skill test/unit/js/tool test/unit/js/skill
node test/manual/delegate-task-coordinator-smoke-test.mjs
```

Results:

- `DelegateTaskToolTests` and `AgentTypeRegistryTests`: 2 files / 29 tests passed.
- Focused ESLint for old tool/skill paths: passed.
- Manual coordinator smoke passed and emitted:
  - `delegate_task coordinator smoke: ok`
  - child session `6a3beec3e40b7971a75e225f`
  - filtered `allowedTools: read_document`
  - `childMessages: 2`
  - `childToolCalls: 1`
- Dev stack status during audit: `develop-ai-writing-agent-1` healthy at `http://127.0.0.1:43060/status`; web/webpack dev stack running at `127.0.0.1:18080`.
- Independent read-only audit subagent `019efa1b-936b-7ec0-a8a9-c384f0f84541` confirmed the same old product paths and frontend assumptions without modifying files.

M0 scope note:

- This milestone intentionally changed only this plan document. Runtime code remains old-path until M1+ replacement slices introduce the new capability/policy foundation and later remove old product paths.
- Unrelated dirty worktree entries observed and preserved: `CLAUDE.md`, `.helloagents/`, and `services/ai-writing-agent/doc/multi-agent-orchestration-architecture-design.md`.

## 12. M1: Capability Registry And Policy Capsule Foundation

### Objective

Create the new structured registry and policy model that will replace static Agent types.

### Implementation Tasks

- Add `AgentCapabilityRegistry`.
- Add capability schema:
  - name
  - version
  - description
  - role
  - trigger hints
  - input schema
  - output schema
  - default model tier
  - default toolsets
  - default policy capsule
  - context policy
  - prompt/reference refs
- Add `AgentPolicyCapsule`.
- Add `AgentPolicyEngine`.
- Migrate built-in agents into structured capability fixtures.
- Keep old registry only if needed for tests during implementation, not as final product path.
- Add policy inheritance tests.
- Add invalid capability tests.

### Acceptance Criteria

- Built-in reviewer/editor/fixer capabilities load through the new registry.
- Policy engine computes monotonic child policies.
- Invalid capabilities are skipped safely.
- Capability metadata can be listed without loading all prompt bodies.

### Verification

```bash
cd services/ai-writing-agent
npm run test:unit -- test/unit/js/agent-team test/unit/js/tool test/unit/js/skill
npx eslint app/js/agent-team app/js/tool app/js/skill test/unit/js
```

### E2E Evidence

- Runtime status or diagnostics can show available team capabilities without exposing hidden prompts.

### 2026-06-24 M1 Capability And Policy Foundation Checkpoint

Implemented:

- Added `app/js/agent-team/AgentCapabilityRegistry.js`.
  - Loads structured capability definitions.
  - Validates name, version, role, prompt reference, input schema, and output schema.
  - Skips invalid capabilities with safe diagnostics.
  - Lists metadata without loading or exposing prompt bodies.
- Added `app/js/agent-team/capabilities/builtInCapabilities.js`.
  - Migrates the current built-in agent inventory into structured capability definitions:
    `content-reviewer`, `experiment-reviewer`, `quality-checker`, `document-auditor`,
    `citation-assistant`, `compile-fixer`, and `writing-editor`.
  - Uses prompt references such as `agents/compile-fixer.md` instead of embedding hidden prompt text.
- Added `app/js/agent-team/AgentPolicyEngine.js`.
  - Computes child policy by intersecting parent, capability, workflow, and task policy layers.
  - Enforces monotonic permission inheritance for tools, file globs, write globs, network, Python environments, model tiers, depth, parallelism, tool-call budget, spawn, and handoff.
  - Fails closed with `AGENT_POLICY_DENIED` when the resulting child policy has no usable permission set.
- Added `app/js/agent-team/AgentTeamRuntimeStatus.js`.
  - Provides a prompt-safe diagnostics/status payload listing available team capabilities and registry diagnostics.

Verification:

```bash
cd services/ai-writing-agent
npm run test:unit -- test/unit/js/agent-team
node --check app/js/agent-team/AgentCapabilityRegistry.js app/js/agent-team/AgentPolicyEngine.js app/js/agent-team/AgentTeamRuntimeStatus.js app/js/agent-team/capabilities/builtInCapabilities.js
npx eslint app/js/agent-team test/unit/js/agent-team
```

Results:

- Agent-team Vitest: 3 files / 5 tests passed.
- Node syntax checks: passed.
- ESLint for `app/js/agent-team` and `test/unit/js/agent-team`: passed.

Diagnostics smoke:

```bash
docker compose -f develop/docker-compose.yml -f develop/docker-compose.dev.yml exec -T ai-writing-agent sh -lc 'env -u NODE_OPTIONS node --input-type=module <agent-team-runtime-status-smoke>'
```

Result:

```json
{"loaded":7,"skipped":0,"names":["citation-assistant","compile-fixer","content-reviewer","document-auditor","experiment-reviewer","quality-checker","writing-editor"]}
```

The smoke explicitly failed if the serialized status contained `You are a LaTeX compile repair specialist` or `# Role`; neither appeared.

Scope note:

- The old `AgentTypeRegistry` and `delegate_task` product path remain in place until M3/M10 replacement milestones. M1 only introduces the new structured foundation and diagnostics surface.

## 13. M2: Task Store, Structured Specs, And Context Packs

### Objective

Make team tasks and task context first-class persistent objects.

### Implementation Tasks

- Add `AgentTaskStore`.
- Add Mongo collections:
  - `aiAgentTeams`
  - `aiAgentTasks`
  - `aiAgentContextPacks`
  - `aiAgentTaskResults`
  - `aiAgentTeamEvents`
- Add `AgentContextPackBuilder`.
- Add context pack policies:
  - parent history summary
  - project rules
  - active change set
  - file full/excerpt/summary/metadata
  - prior findings
  - artifacts
  - diagnostics
- Add context budget enforcement.
- Add secret/raw prompt redaction.
- Add API/service methods for creating, listing, loading, and archiving tasks.

### Acceptance Criteria

- A team run can create structured tasks and context packs.
- Reload can reconstruct task state from Mongo.
- Child tasks do not receive full parent history by default.
- Context packs record why each item was included.

### Verification

```bash
cd services/ai-writing-agent
npm run test:unit -- test/unit/js/agent-team test/unit/js/agent
npx eslint app/js/agent-team app/js/agent test/unit/js
```

### E2E Evidence

- Browser diagnostics show a task with context pack metadata after reload.
- Secret-pattern probe confirms hidden prompts and credentials do not appear in public events.

### 2026-06-24 M2 Task Store And Context Pack Checkpoint

Implemented:

- Added `AgentTaskSpec`.
  - Normalizes structured task specs with capability name/version, mode, objective, acceptance criteria, input, output schema, context policy, policy, dependencies, priority, timeout, and retry policy.
  - Rejects unsafe capability names, unsupported modes, invalid output schemas, unsafe dependency ids, invalid scheduling fields, and any prompt/secret-bearing fields such as `systemPrompt`, `apiKey`, `token`, `raw_secret`, and password variants.
- Added `AgentTaskStore`.
  - Creates `aiAgentTeams`, `aiAgentTasks`, `aiAgentContextPacks`, `aiAgentTaskResults`, and `aiAgentTeamEvents` records.
  - Supports structured task creation from `AgentTaskSpec`.
  - Tracks queued/running/completed lifecycle, child session/tool-call links, context pack ids, result ids, events, list, load/reload, and archive/cancel state.
- Added `AgentContextPackBuilder`.
  - Builds scoped context packs without copying full parent messages.
  - Records inclusion reasons, modes, token estimates, active change set id, project rules, prior findings, artifacts, and safe diagnostics.
  - Enforces relative project paths, context file truncation, and prompt/secret redaction.
- Extended `mongodb.js`.
  - Declared team runtime collections.
  - Added indexes for team reload, task scheduling/status, context pack lookup, result lookup, and ordered team/task events.

Verification:

```bash
cd services/ai-writing-agent
npm run test:unit -- test/unit/js/agent-team
node --check app/js/agent-team/AgentTaskStore.js app/js/agent-team/AgentContextPackBuilder.js app/js/agent-team/AgentTaskSpec.js app/js/mongodb.js
npx eslint app/js/agent-team app/js/mongodb.js test/unit/js/agent-team
```

Results:

- Agent-team Vitest: 7 files / 16 tests passed.
- Node syntax checks: passed.
- ESLint for `app/js/agent-team`, `app/js/mongodb.js`, and `test/unit/js/agent-team`: passed.

Runtime diagnostics smoke:

```bash
docker compose -f develop/docker-compose.yml -f develop/docker-compose.dev.yml exec -T ai-writing-agent sh -lc 'env -u NODE_OPTIONS node --input-type=module <agent-team-m2-store-context-smoke>'
```

Result:

```json
{"marker":"m2-smoke-1782313744456","teamId":"6a3bf3108f80fa4838e26053","taskCount":1,"contextPackCount":1,"eventCount":1,"request":"Review [REDACTED]"}
```

The smoke created a real Mongo team run, task, context pack, and event through the AI service container, reloaded the team run, verified that the sensitive `apiKey=secret-value` probe was redacted, and deleted the temporary records. The script body completed successfully; the interactive exec session was stopped with Ctrl-C afterward because the Node process kept the Mongo client open.

Scope note:

- M2 does not expose new product tools or frontend UI. Browser diagnostics and team trace UI land in M3/M7 after orchestrator and API surfaces exist.

## 14. M3: Team Orchestrator And Subagent-As-Tool Replacement

### Objective

Replace thin `delegate_task` execution with structured task execution through `AgentTeamOrchestrator`.

### Implementation Tasks

- Add `AgentTeamOrchestrator`.
- Add `start_agent_task` tool with structured schema.
- Create child AgentLoopV2 sessions from `AgentTaskSpec`.
- Attach context pack, policy capsule, active change set, parent/root session ids, and task id.
- Stream normalized team/task events.
- Record task result and usage.
- Ensure child writes enter Live Agent Workspace with task/agent provenance.
- Prevent old `delegate_task` from being exposed in normal product toolsets.

### Acceptance Criteria

- Root agent can start a structured child task.
- Child tools are a strict subset of computed policy.
- Child draft changes are stored under the root change set with team/task provenance.
- Old `delegate_task` is not available in normal model-visible product tools.

### Verification

```bash
cd services/ai-writing-agent
npm run test:unit -- test/unit/js/agent-team test/unit/js/tool test/unit/js/agent
npx eslint app/js/agent-team app/js/tool app/js/agent test/unit/js
```

### E2E Evidence

- Deployed dev stack live model starts a structured child task that reads a document and returns a structured result.
- A child writing task creates a Review-mode draft change under the root change set with team/task/capability provenance.
- Browser-visible team trace/editor card evidence remains part of M7/M10, where the frontend surface is implemented.

### Implementation Progress - 2026-06-24

Implemented:

- Added `AgentTeamOrchestrator` for single structured child task execution through persisted team/task/context/result/event records.
- Added model-visible `start_agent_task` with structured schema and policy-aware parent context.
- Added `AgentTeamChildRunner` that creates child AgentLoopV2 sessions from computed policy, filters recursive tools, loads capability prompt references through a safe prompt loader, and persists child turns.
- Registered `start_agent_task` in the normal product tool registry and replaced the default `subagent` toolset entry; retained `delegate_task` only as registered legacy scaffolding, not in normal model-visible profiles.
- Added persisted task/result/event redaction so task specs, team events, and child results do not store raw token-like values or sensitive keyed fields.
- Added unit coverage for orchestrator, tool execution, child runner tool filtering, context/task/result/event redaction, and default tool visibility.
- Repaired `start_agent_task` OpenAI tool schema so nested `input`, `outputSchema`, `contextPolicy`, and `policy` fields are exposed as JSON objects rather than string-like records.
- Repaired task policy inheritance so omitted task policy fields inherit parent/capability constraints instead of collapsing limits to zero or network to deny.
- Threaded `agentTeam` provenance through child `AgentLoop`, workspace draft creation, and draft-change serialization.
- Repaired child draft aggregation so the first child edit creates/reuses a root-session review change set instead of opening a child-owned change set.

Verification:

```bash
cd services/ai-writing-agent
npm run test:unit -- test/unit/js/agent-team test/unit/js/tool test/unit/js/agent
npx eslint app/js/agent-team app/js/tool app/js/agent test/unit/js
```

Results:

- Unit tests after final M3 repairs: 21 files / 164 tests passed for targeted `agent-team`, `StartAgentTaskTool`, `ToolRegistry`, and `agent` coverage.
- ESLint: passed.
- Note: earlier full `test/unit/js/tool` parallel runs can hit the known 5s boundary on `BibLookupToolTests` timeout handling; the file passed on immediate isolated reruns.

Container smoke:

```bash
docker compose -f develop/docker-compose.yml -f develop/docker-compose.dev.yml exec -T ai-writing-agent sh -lc 'env -u NODE_OPTIONS node --input-type=module <m3-orchestrator-mongo-smoke>'
```

Result:

```json
{"policyHasStart":true,"policyHasDelegate":false,"allowedToolNames":["read_document"],"events":["agent_team.started","agent_task.queued","agent_task.started","agent_task.progress","agent_task.completed","agent_team.completed"],"redacted":true}
```

The smoke inserted a real parent session, started a structured `content-reviewer` task through `AgentTeamOrchestrator`, created a child session, persisted team/task/context/result/event records, verified `run_command` was removed by child policy, verified `delegate_task` was absent from the default model-visible policy, verified `secret-value` did not appear in persisted team data, and cleaned up the temporary Mongo records.

Live-model smoke:

- Deployed services were running through `develop/docker-compose.yml` + `develop/docker-compose.dev.yml`; `ai-writing-agent` was healthy on `127.0.0.1:43060`, `web` on `127.0.0.1:13000`, and Mongo on `127.0.0.1:37017`.
- Real model request used the configured `balanced` slot and root session `6a3bfae7b4321c7663a69219`.
- The root model called `start_agent_task` once successfully after the tool schema repair.
- Persisted team/task evidence:
  - team `6a3bfae9b4321c7663a6921b`, mode `subagent-tool`, completed.
  - task `6a3bfae9b4321c7663a6921d`, agent `content-reviewer`, child session `6a3bfae9b4321c7663a69220`, completed.
  - computed child policy allowed only `read_document`; attempted unavailable tools were denied by policy.
  - events included `agent_team.started`, `agent_task.queued`, `agent_task.started`, `agent_task.progress`, `agent_task.completed`, and `agent_team.completed`.

Durable writeback smoke:

```bash
cd services/ai-writing-agent
MONGO_CONNECTION_STRING='mongodb://127.0.0.1:37017/sharelatex?directConnection=true&serverSelectionTimeoutMS=3000' \
  node --input-type=module <m3-child-draft-writeback-smoke>
```

Result:

```json
{"ok":true,"rootSessionId":"6a3bfd5821460a10765e7502","childSessionId":"6a3bfd5821460a10765e7503","teamId":"6a3bfd5821460a10765e7504","taskId":"6a3bfd5821460a10765e7505","changeSetId":"6a3bfd5821460a10765e7506","changeId":"6a3bfd5821460a10765e7507","changeSet":{"sessionId":"6a3bfd5821460a10765e7502","mode":"review","status":"review","changeIds":["6a3bfd5821460a10765e7507"]},"draft":{"sessionId":"6a3bfd5821460a10765e7502","parentSessionId":"6a3bfd5821460a10765e7502","childSessionId":"6a3bfd5821460a10765e7503","status":"pending","type":"edit","source":"agent-loop-v2","path":"/main.tex","provenance":{"agentName":"writing-editor","toolName":"edit_document","model":"deterministic-smoke","profile":"writing-editor","teamId":"6a3bfd5821460a10765e7504","taskId":"6a3bfd5821460a10765e7505","capabilityName":"writing-editor"}},"rootPendingCount":1,"childPendingCount":0,"workspaceContainsMarker":true,"eventTypes":["draft_change.created"]}
```

The writeback smoke inserted temporary root/child sessions plus team/task records, executed `read_document` and `edit_document` against an in-memory sandbox session through the real `LiveDraftChangeBridge` and real Mongo-backed `AgentChangeSetService`, verified the draft is Review-mode pending under the root session, verified team/task/capability provenance, verified the root session pending-change mirror and absence of child pending-change pollution, and cleaned up the temporary Mongo records.

M3 is complete for backend runtime replacement. Browser-visible team trace, editor review-card polish, reload UI, and final browser acceptance remain in M7/M10.

## 15. M4: Graph Runner And Deep Review Workflow

### Objective

Turn Deep Review into a deterministic workflow graph with parallel reviewers, reducer, and critic.

### Implementation Tasks

- Add `AgentGraphRunner`.
- Add graph node types:
  - sequence
  - parallel
  - agent task
  - reducer
  - critic
  - condition
  - loop with hard cap
- Define `deep-review` graph:
  - prepare context
  - parallel reviewer fan-out
  - reducer
  - critic
  - final report
- Migrate current review skill/prompt behavior into the graph.
- Add graph state persistence.
- Add partial failure behavior:
  - one reviewer fails
  - reducer still runs with degraded evidence
  - user sees failure details

### Acceptance Criteria

- Deep Review no longer depends on sequential `delegate_task`.
- At least three reviewers can run in parallel under budget.
- Reducer and critic are graph nodes with persisted results.
- Reload restores graph progress.

### Verification

```bash
cd services/ai-writing-agent
npm run test:unit -- test/unit/js/agent-team test/unit/js/skill test/unit/js/tool
npx eslint app/js/agent-team app/js/skill app/js/tool test/unit/js
```

### E2E Evidence

- Browser/live model starts Deep Review.
- Mongo/team trace shows parallel reviewer tasks.
- Final review report includes reducer output and critic validation.

### Implementation Progress - 2026-06-24

Implemented:

- Added `AgentGraphRunner` with sequence, parallel, agent-task, reducer, critic, condition, and bounded loop node support.
- Added `deep-review` workflow graph: parallel `content-reviewer`, `experiment-reviewer`, and `quality-checker` fan-out, followed by `deep-review-reducer` and `deep-review-critic`.
- Added built-in reducer and critic capabilities so reducer/critic are persisted task nodes rather than prompt-only summaries.
- Added `AgentTeamOrchestrator.startAgentTeam()` and `runWorkflowGraph()` for `workflowType: deep-review`, `mode: workflow-graph` team runs.
- Added model-visible `start_agent_team` and exposed it through the normal `subagent` toolset beside `start_agent_task`; child tool pools blacklist it to prevent recursive team spawning.
- Migrated `skills/review/SKILL.md` from old sequential delegation instructions to `start_agent_team`.
- Added reload coverage proving graph events plus reviewer/reducer/critic task results can be restored through `AgentTaskStore.loadTeamRun()`.

Verification:

```bash
cd services/ai-writing-agent
npm run test:unit -- test/unit/js/agent-team test/unit/js/tool/ToolRegistryTests.test.js test/unit/js/tool/StartAgentTeamToolTests.test.js test/unit/js/tool/StartAgentTaskToolTests.test.js test/unit/js/tool/BibLookupToolTests.test.js test/unit/js/skill
npx eslint app/js/agent-team app/js/skill app/js/tool test/unit/js
```

Results:

- Unit tests: 18 files / 112 tests passed.
- ESLint: passed.
- Full broader `test/unit/js/agent-team test/unit/js/skill test/unit/js/tool` run still has the known `BibLookupToolTests` 5s timeout boundary under parallel load; isolated `BibLookupToolTests` passed immediately afterward and in the targeted command above.

Mongo workflow smoke:

```bash
cd services/ai-writing-agent
MONGO_CONNECTION_STRING='mongodb://127.0.0.1:37017/sharelatex?directConnection=true&serverSelectionTimeoutMS=3000' \
  node --input-type=module <m4-deep-review-graph-smoke>
```

Result:

```json
{"ok":true,"teamId":"6a3c0018b36b1360a98e2118","workflowType":"deep-review","mode":"workflow-graph","taskAgents":["content-reviewer","experiment-reviewer","quality-checker","deep-review-reducer","deep-review-critic"],"resultCount":5,"graphEvents":["agent_graph.node_started:reviewers","agent_graph.node_started:content-reviewer","agent_graph.node_started:experiment-reviewer","agent_graph.node_started:quality-checker","agent_graph.node_completed:content-reviewer","agent_graph.node_completed:experiment-reviewer","agent_graph.node_completed:quality-checker","agent_graph.node_completed:reviewers","agent_graph.node_started:reducer","agent_graph.node_completed:reducer","agent_graph.node_started:critic","agent_graph.node_completed:critic"]}
```

Live AgentLoop smoke:

```json
{"ok":true,"slot":"balanced","model":"deepseek-v4-flash","sessionId":"6a3c01f94c7919f0e7c2e661","teamId":"6a3c01fa4c7919f0e7c2e662","taskAgents":["content-reviewer","quality-checker","experiment-reviewer","deep-review-reducer","deep-review-critic"],"graphEvents":["agent_graph.node_started:reviewers","agent_graph.node_started:content-reviewer","agent_graph.node_started:quality-checker","agent_graph.node_started:experiment-reviewer","agent_graph.node_completed:quality-checker","agent_graph.node_completed:experiment-reviewer","agent_graph.node_completed:content-reviewer","agent_graph.node_completed:reviewers","agent_graph.node_started:reducer","agent_graph.node_completed:reducer","agent_graph.node_started:critic","agent_graph.node_completed:critic"]}
```

The live smoke used the deployed model slot through `AgentLoop`, verified the model called `start_agent_team`, created a `workflow-graph` Deep Review team with three reviewer tasks plus reducer and critic tasks, observed persisted graph events, and cleaned up temporary Mongo records.

Browser UI trace is not implemented in M4; it remains in M7/M10. A browser-authenticated `/review` smoke was not run because the local manual API helper requires Overleaf session cookie and CSRF credentials.

## 16. M5: Structured Results, Reducer, Critic, And Finding Model

### Objective

Replace Markdown-only child summaries with structured findings and reducer output.

### Implementation Tasks

- Add `AgentTaskResult` validator.
- Add finding schema:
  - severity
  - category
  - title
  - description
  - evidence refs
  - suggested fix
  - confidence
  - duplicate link
- Add `AgentResultReducer`.
- Add critic checks:
  - evidence required
  - no praise-only findings
  - no unsupported claim
  - duplicate detection
  - severity sanity
  - file/path reference validity
- Add final report renderer.
- Add tests for malformed child outputs.

### Acceptance Criteria

- Child results are validated before reducer consumes them.
- Reducer can deduplicate findings.
- Critic can reject or downgrade weak findings.
- Final user report remains readable but backed by structured data.

### Verification

```bash
cd services/ai-writing-agent
npm run test:unit -- test/unit/js/agent-team
npx eslint app/js/agent-team test/unit/js/agent-team
```

### E2E Evidence

- Browser Deep Review result shows grouped findings with evidence refs.
- Diagnostics can trace a finding back to source task and file evidence.

### Implementation Progress - 2026-06-24

Implemented:

- Added `AgentTaskResult` validator with structured finding schema:
  - severity: `critical | major | minor | question`
  - category, title, description, evidence refs, suggested fix, confidence, duplicate/source links
  - high-severity findings require at least one evidence ref
  - unsupported/sensitive fields are dropped before persistence
- Integrated result validation into `AgentTeamOrchestrator.runTaskInTeam()` before `aiAgentTaskResults` persistence.
- Added `AgentResultReducer` to validate reviewer outputs, ignore malformed child results with degraded evidence notes, deduplicate findings, merge evidence refs, preserve source task/agent links, produce next actions, run critic checks, downgrade weak high-severity findings, and render a final Deep Review report.
- Wired graph `reducer` and `critic` nodes to synthetic persisted tasks instead of ordinary child LLM tasks; reducer consumes parallel reviewer outputs, critic emits a report artifact.

Verification:

```bash
cd services/ai-writing-agent
npm run test:unit -- test/unit/js/agent-team test/unit/js/tool/StartAgentTeamToolTests.test.js test/unit/js/tool/StartAgentTaskToolTests.test.js
npx eslint app/js/agent-team app/js/tool/start_agent_team.js test/unit/js/agent-team test/unit/js/tool/StartAgentTeamToolTests.test.js test/unit/js/tool/StartAgentTaskToolTests.test.js
```

Results:

- Unit tests: 15 files / 35 tests passed.
- ESLint: passed.

Structured-result Mongo smoke:

```json
{"ok":true,"teamId":"6a3c0449916f0e0daf8ad266","reducerFindingCount":2,"unsupportedSourceTaskIds":["6a3c0449916f0e0daf8ad26c","6a3c0449916f0e0daf8ad26e"],"reducerFindings":[{"title":"Citation mismatch","sourceTaskIds":["6a3c0449916f0e0daf8ad26d"],"evidenceRefs":1},{"title":"Unsupported central claim","sourceTaskIds":["6a3c0449916f0e0daf8ad26c","6a3c0449916f0e0daf8ad26e"],"evidenceRefs":2}],"criticHasReportArtifact":true}
```

The smoke created temporary root/child sessions and a Deep Review team, returned structured reviewer findings, verified reducer deduplication and evidence merging, verified source task links for duplicate findings, verified critic report artifact creation, and cleaned up temporary Mongo records.

Browser grouped-finding UI remains part of M7. M5 completes the backend structured data contract that the UI will consume.

## 17. M6: Handoff Manager And Specialist Takeover

### Objective

Add explicit specialist handoff for workflows such as compile fix, citation audit, and rebuttal drafting.

### Implementation Tasks

- Add `AgentHandoffManager`.
- Add tools:
  - `handoff_to_agent`
  - `return_from_handoff`
- Add handoff state to root session/team state.
- Add UI event state for active specialist.
- Add specialist capabilities:
  - `compile-fixer`
  - `citation-assistant`
  - `rebuttal-writer`
  - `writing-editor`
- Add return conditions:
  - completed
  - user cancel
  - timeout
  - policy denial
  - specialist asks to return
- Add tests for handoff policy, cancellation, and return.

### Acceptance Criteria

- Compile-fixer can temporarily own the active task flow.
- UI shows current handoff owner.
- User can cancel handoff and return to root agent.
- Handoff cannot escalate tools or write policy.

### Verification

```bash
cd services/ai-writing-agent
npm run test:unit -- test/unit/js/agent-team test/unit/js/tool test/unit/js/agent
npx eslint app/js/agent-team app/js/tool app/js/agent test/unit/js
```

### E2E Evidence

- Browser/live model triggers compile-fixer handoff, runs compile, creates a draft fix, and returns control to root.

### Implementation Progress - 2026-06-24

Implemented:

- Added `AgentHandoffManager` for explicit specialist takeover.
- Added `handoff_to_agent` and `return_from_handoff` model-visible tools.
- Added handoff toolset exposure for root/default profiles and policy flag `allowHandoff`.
- Added root session `activeHandoff` state with team/task/child session/capability/tool policy summary.
- Added handoff events: `agent_handoff.requested`, `agent_handoff.accepted`, `agent_handoff.completed`.
- Added compile-fixer/citation/writing handoff tool entry points with monotonic tool-policy enforcement. Handoff requests fail if specialist tools are outside parent policy.

Verification:

```bash
cd services/ai-writing-agent
npm run test:unit -- test/unit/js/agent-team/AgentHandoffManagerTests.test.js test/unit/js/tool/HandoffToolsTests.test.js test/unit/js/tool/ToolRegistryTests.test.js test/unit/js/agent-team
npx eslint app/js/agent-team app/js/tool test/unit/js/agent-team test/unit/js/tool/HandoffToolsTests.test.js test/unit/js/tool/ToolRegistryTests.test.js
```

Results:

- Unit tests: 16 files / 66 tests passed.
- ESLint: passed.

Handoff Mongo smoke:

```json
{"ok":true,"teamId":"6a3c064e38626ba21ad3b011","taskId":"6a3c064e38626ba21ad3b012","childSessionId":"6a3c064e38626ba21ad3b014","denied":true,"activeCapability":"compile-fixer","cleared":true,"events":["agent_handoff.requested","agent_handoff.accepted","agent_handoff.completed"]}
```

The smoke created a temporary root session, started compile-fixer handoff, verified `activeHandoff`, verified a reduced parent policy rejects compile/edit escalation, returned control to root, verified `activeHandoff` was cleared, and cleaned up temporary Mongo records.

Browser handoff banner and full compile-fix browser flow remain part of M7/M10.

## 18. M7: Team Trace UI And Reload/Resume

### Objective

Make team execution visible and recoverable in the AI panel.

### Implementation Tasks

- Add frontend team state model.
- Add task cards:
  - status
  - agent
  - objective
  - progress
  - finding count
  - artifact count
  - draft change count
  - elapsed time
  - budget summary
- Add expandable diagnostics.
- Add cancel controls where policy allows.
- Keep retry controls hidden until a real recovery scheduler can execute queued retries.
- Add active handoff banner.
- Restore team trace after page reload.
- Link findings to files and draft changes.
- Add console/runtime error checks.

### Acceptance Criteria

- User can see running team state without reading raw tool logs.
- Reload restores team progress and completed results.
- Cancel works for eligible active teams and tasks without letting late child results overwrite cancellation.
- Retry is not exposed until M9 recovery scheduling can execute it safely.
- Draft changes show agent/task provenance.

### Verification

```bash
cd services/web
npm run type-check
npx eslint frontend/js/features/ai-assistant app/src/Features/AIAssistant

cd ../ai-writing-agent
npm run test:unit -- test/unit/js/agent-team
```

### E2E Evidence

- Playwright verifies team trace for Deep Review, handoff, failed task, retry, and reload.

### Implementation Progress - 2026-06-24

Implemented:

- Added session-scoped team run APIs:
  - `GET /sessions/:sessionId/team-runs`
  - `GET /sessions/:sessionId/team-runs/:teamId`
  - `POST /sessions/:sessionId/team-runs/:teamId/cancel`
  - `POST /sessions/:sessionId/team-runs/:teamId/tasks/:taskId/retry`
- Added `AgentTeamRunService` to serialize reloadable team summaries, tasks, results, events, counters, and diagnostics.
- Added cancel support that:
  - cancels active queued/running tasks,
  - archives the team run,
  - records `agent_team.cancelled`,
  - clears matching root-session `activeHandoff`.
- Kept task retry API policy-safe but disabled until M9 recovery scheduling exists; the frontend hides retry controls instead of creating queued tasks with no runner.
- Exposed `activeHandoff` in session reload payload.
- Added frontend team run API hydration during `getSession()`.
- Added team trace state to the AI assistant context and refreshes team trace from both live `agent_team.started` stream events and final team tool results.
- Added `TeamTraceBlock` with task cards, counters, elapsed time, diagnostics, and cancel controls.
- Added active handoff banner with cancel action.
- Preserved legacy `delegate_task` rendering while routing `start_agent_team`, `start_agent_task`, and `handoff_to_agent` to the new team trace UI when a persisted team run is available.
- Converted `start_agent_team` and `start_agent_task` into streaming tools that emit `agent_team.started` as soon as the persisted team run exists, then yield the final tool result when execution completes.
- Added runtime cancellation hardening:
  - team cancel first verifies session/team ownership,
  - stops active root/child loops and confirmation channels,
  - prevents cancelled tasks from being overwritten by late `completeTask()` calls.
- Fixed empty-session reload rendering so persisted orphan team runs display as Team Trace blocks instead of being hidden behind the welcome state.

Verification:

```bash
cd services/ai-writing-agent
npm run test:unit -- test/unit/js/agent-team test/unit/js/tool/StartAgentTeamToolTests.test.js test/unit/js/tool/StartAgentTaskToolTests.test.js test/unit/js/RouterAdminGuardTests.test.js
npx eslint app/js/agent-team app/js/tool/start_agent_team.js app/js/tool/start_agent_task.js app/js/AgentController.js app/js/Router.js test/unit/js/agent-team test/unit/js/tool/StartAgentTeamToolTests.test.js test/unit/js/tool/StartAgentTaskToolTests.test.js test/unit/js/RouterAdminGuardTests.test.js

cd ../web
npm run type-check
npx eslint frontend/js/features/ai-assistant app/src/Features/AIAssistant
```

Results:

- AI service unit tests: 18 files / 48 tests passed.
- AI service ESLint: passed.
- Web TypeScript: passed.
- Web ESLint: passed.

Browser evidence:

- Playwright opened the real dev editor through `http://127.0.0.1:18080`, logged in as `agent-smoke@example.com`, restored a persisted AI session/team run from Mongo, opened the AI panel, and verified `.ai-team-trace-block`.
- Observed Team Trace text: `Team deep-review · running · 3s`, `1 findings · 1 artifacts · 0 drafts`, and `Cancel team`.
- Screenshot: `/tmp/m7-team-trace-smoke.png`.
- Smoke data cleanup verified: no `M7 Team Trace Smoke` sessions and no deep-review smoke teams remained in Mongo after the script completed.

Known limitation carried to M9:

- Retry remains API-gated with `409 Task retry requires the recovery scheduler and is not available yet`; UI retry controls are hidden. This avoids persisting queued retries that cannot execute.
- The dev editor still reports a LaTeX auto-compile 500 (`spawn latexmk ENOENT`) in the local container, which is unrelated to Team Trace and matches the existing development CLSI toolchain gap.

## 19. M8: Skill-Provided Agent Capabilities And Dependency Policy Integration

### Objective

Let validated skills provide agent capabilities without bypassing sandbox or dependency policy.

### Implementation Tasks

- Extend skill package schema to declare agent capabilities.
- Validate skill-provided capabilities:
  - namespaced names
  - versions
  - roles
  - prompt refs
  - schemas
  - default policy
  - context policy
  - script/runtime dependencies
- Integrate with UV Python Dependency Broker:
  - skill agent can use only approved env snapshots
  - missing env creates dependency request
  - child policy cannot install packages
- Add activation flow:
  - activating a skill exposes its team capabilities
  - deactivation hides them
- Add tests for malicious skill agent declarations.

### Acceptance Criteria

- A skill can register a bounded agent capability.
- Skill agent cannot escape parent policy.
- Skill agent scripts use approved Python envs only.
- Invalid or risky skill agents are skipped safely.

### Verification

```bash
cd services/ai-writing-agent
npm run test:unit -- test/unit/js/skill test/unit/js/agent-team test/unit/js/python
npx eslint app/js/skill app/js/agent-team app/js/python test/unit/js
```

### E2E Evidence

- Browser/live model activates a skill, starts a skill-provided agent task, runs an approved script, and creates a draft change.
- Package install bypass by skill agent is denied.

### Implementation Progress - 2026-06-24

Implemented:

- Extended `skill.json` with optional `agentCapabilities`.
- Added registry validation for skill-provided capabilities:
  - names must be scoped as `<skill-name>.<local-capability>`,
  - versions must be semantic,
  - roles must match the team runtime role set,
  - prompt refs must target the owning skill `SKILL.md` or declared `references/*`,
  - schemas must be object JSON schemas,
  - default policy is restricted to safe tools and sandbox-compatible network/Python settings,
  - spawn/handoff escalation is rejected at skill metadata load time.
- Added `AgentCapabilityRegistry` support for activation-scoped skill capabilities. Installed skills do not become globally available; only `sessionState.activatedSkills` are merged into the per-task capability registry.
- Added skill prompt loading for `promptRef.kind = "skill"` and `promptRef.kind = "skill-reference"` through the existing safe SkillRegistry read paths.
- Updated `activate_skill` output and `skill.activated` events to expose declared agent capabilities to the model.
- Updated `AgentLoop` to record activated skills in turn-local session state.
- Updated `start_agent_task` to pass activated skill names into the orchestrator.

Verification:

```bash
cd services/ai-writing-agent
npm run test:unit -- test/unit/js/skill test/unit/js/agent-team/AgentCapabilityRegistryTests.test.js test/unit/js/agent-team/AgentCapabilityPromptLoaderTests.test.js test/unit/js/tool/ActivateSkillToolTests.test.js test/unit/js/tool/StartAgentTaskToolTests.test.js
npx eslint app/js/skill app/js/agent-team app/js/tool/activate_skill.js app/js/tool/start_agent_task.js app/js/agent/AgentLoop.js app/js/AgentController.js test/unit/js/skill test/unit/js/agent-team/AgentCapabilityRegistryTests.test.js test/unit/js/agent-team/AgentCapabilityPromptLoaderTests.test.js test/unit/js/tool/ActivateSkillToolTests.test.js test/unit/js/tool/StartAgentTaskToolTests.test.js
```

Results:

- M8 unit tests: 7 files / 60 tests passed.
- M8 ESLint: passed.

Deferred full-browser evidence:

- Browser/live-model proof that a skill-provided capability executes a task and creates a draft change remains part of the final M10 acceptance sweep, where the runtime is exercised end-to-end with live model, sandbox, and writeback enabled.

## 20. M9: Security, Budgets, Cancellation, Conflict, And Cleanup

### Objective

Prove the team runtime cannot escape policy or leave corrupt state.

### Implementation Tasks

- Add budget tests:
  - max team tasks
  - max parallel tasks
  - max depth
  - max child turns
  - max wall time
  - token/tool call caps
- Add policy negative tests:
  - child write escalation
  - child network escalation
  - child Python env escalation
  - child model tier escalation
  - child spawn escalation
  - file glob escape
- Add cancellation tests:
  - cancel team
  - cancel task
  - stop root session cascades to children
  - stopped handoff returns safe state
- Add conflict tests:
  - two child edits same doc
  - stale draft apply
  - Auto Accept CAS conflict
- Add cleanup:
  - orphan child sessions
  - stuck running tasks
  - active handoff after root stop
  - sandbox temp files
  - pending draft residue

### Acceptance Criteria

- Security probes fail closed with clear events.
- Cancellation leaves no active child sessions.
- Conflicts are visible and do not corrupt canonical docs.
- Cleanup leaves no orphan team/sandbox state.

### Verification

```bash
cd services/ai-writing-agent
npm run test:unit
npx eslint .
node test/manual/sandbox-limits-smoke-test.mjs

cd ../web
npm run type-check
npx eslint frontend/js/features/ai-assistant app/src/Features/AIAssistant
```

### E2E Evidence

- Independent verification subagent runs policy escalation probes.
- Independent verification subagent runs cancellation/reload/conflict flows in browser.

### Implementation Progress - 2026-06-24

Implemented:

- Hardened child policy fail-closed behavior:
  - write tools now require a non-empty intersected `writeGlobs`,
  - covered `edit_document`, `delete_file`, `sync_workspace_changes`, `write_workspace_file`, and `bib_manage`,
  - Python environment, model-tier, file-glob, write-glob, network, spawn, and handoff escalation probes are covered by unit tests.
- Enforced graph parallelism at execution time:
  - `AgentGraphRunner` now runs `parallel` nodes through `team.policySummary.maxParallelTasks`,
  - Deep Review can still fan out when policy allows it, but low parallel budgets batch work instead of starting every reviewer at once.
- Hardened cancellation and cleanup state:
  - root stop tests now cover the child-session lookup path,
  - team cleanup cancels only stale queued/running tasks,
  - stale team cleanup skips teams with recently updated active tasks,
  - cleanup returns child session ids and `AgentTeamRunService` stops in-memory child sessions when available,
  - cleanup also marks child sessions stopped in Mongo and clears matching root `activeHandoff` state using root session ids plus team ids.
- Preserved existing conflict behavior:
  - canonical writeback version conflicts remain draft conflicts instead of throwing,
  - AgentLoop does not auto-sync workspace edits after writeback conflicts,
  - Accept/Reject conflict regressions remain covered.
- 2026-06-25 hardening checkpoint:
  - `start_agent_task` and `start_agent_team` now fail closed before orchestration when shared `RunBudget` delegation depth or concurrent delegation slots are exhausted,
  - delegation slots are released in `finally` after team/task tool completion or failure,
  - child task `timeoutMs` now produces a timeout-aware abort signal and returns an explicit timeout result,
  - team task retry now queues a persistent retry task, records `agent_task.retry_queued`, restores the team to running state, and exposes retryable failed/cancelled/timeout tasks to Team Trace instead of returning a permanent 409.

Verification:

```bash
cd services/ai-writing-agent
npm run test:unit -- test/unit/js/agent-team test/unit/js/agent/CanonicalWritebackServiceTests.test.js test/unit/js/agent/AgentLoopTests.test.js test/unit/js/agent/RunBudgetTests.test.js test/unit/js/AgentController/AcceptRejectTests.test.js test/unit/js/tool/StartAgentTeamToolTests.test.js test/unit/js/tool/StartAgentTaskToolTests.test.js
npx eslint app/js/agent-team app/js/agent/AgentLoop.js app/js/AgentController.js test/unit/js/agent-team test/unit/js/AgentController/AcceptRejectTests.test.js test/unit/js/tool/StartAgentTeamToolTests.test.js test/unit/js/tool/StartAgentTaskToolTests.test.js
npm run test:unit -- test/unit/js/tool/StartAgentTaskToolTests.test.js test/unit/js/tool/StartAgentTeamToolTests.test.js test/unit/js/agent-team/AgentTeamChildRunnerTests.test.js test/unit/js/agent-team/AgentTeamRunServiceTests.test.js test/unit/js/agent-team/AgentTaskStoreTests.test.js
npx eslint app/js/tool/agent_team_budget.js app/js/tool/start_agent_task.js app/js/tool/start_agent_team.js app/js/agent-team/AgentTeamChildRunner.js app/js/agent-team/AgentTeamRunService.js app/js/agent-team/AgentTaskStore.js test/unit/js/tool/StartAgentTaskToolTests.test.js test/unit/js/tool/StartAgentTeamToolTests.test.js test/unit/js/agent-team/AgentTeamChildRunnerTests.test.js test/unit/js/agent-team/AgentTeamRunServiceTests.test.js test/unit/js/agent-team/AgentTaskStoreTests.test.js
```

Results:

- M9 targeted unit regression: 22 files / 127 tests passed.
- M9 targeted ESLint: passed.
- M9 hardening regression: 5 files / 24 tests passed.
- M9 hardening ESLint: passed.
- Independent read-only verification subagent reviewed the original M9 patch and identified gaps in graph parallel budget enforcement, cleanup child-session stopping, stale-team cleanup heartbeat handling, and write-tool policy coverage; the implementation above closes those code-level gaps.
- Independent read-only verification subagents later identified remaining gaps in retry, `RunBudget` delegation consumption, child task timeout enforcement, and browser/live-model M9 evidence; this hardening checkpoint closes the retry/budget/timeout code-level gaps.
- 2026-06-25 browser acceptance checkpoint:
  - Added `test/manual/agent-team-browser-acceptance-smoke.mjs` as a checked-in repeatable smoke for deployed editor/API behavior.
  - The smoke logs in through the real dev web entry (`http://127.0.0.1:18080`), opens a real project editor with a temporary `aiSession`, verifies Team Trace reload from Mongo, verifies active handoff banner rendering, verifies Deep Review fan-out/join task visibility, verifies skill-capability and policy-denial diagnostics, clicks the Team Trace retry button, clicks the Team Trace cancel button, reloads the editor, captures a screenshot, and then deletes seeded sessions/teams/tasks/drafts.
  - Smoke result: `node services/ai-writing-agent/test/manual/agent-team-browser-acceptance-smoke.mjs` passed with retry task queued, running Deep Review team cancelled, retry team restored to running, and cleanup counts `0` across `aiSessions`, `aiAgentTeams`, `aiAgentTasks`, `aiAgentDraftChanges`, `aiAgentTaskResults`, `aiAgentTeamEvents`, `aiAgentContextPacks`, `aiAgentChangeSets`, and `aiAgentApplyOperations`.
  - Screenshot: `/tmp/agent-team-browser-acceptance-smoke.png`.
- 2026-06-25 live writeback checkpoint:
  - Added `test/manual/agent-team-live-writeback-smoke.mjs` as a checked-in repeatable smoke for live model + web proxy + Auto Accept writeback.
  - The smoke logs in through the real dev web entry, creates an AI session through `/api/ai/sessions`, sends a live-model SSE request through `/api/ai/sessions/:sessionId/messages` with `autoAccept=true`, requires exactly one live `edit_document` call and no team/shell tool calls, observes `draft_change.created`, `canonical_change.applying`, `canonical_change.applied`, and `draft_change.accepted`, verifies the real document version advanced, restores the document through document-updater CAS, and deletes the smoke session/change/apply records.
  - Smoke result: `node services/ai-writing-agent/test/manual/agent-team-live-writeback-smoke.mjs` passed; latest replay advanced the document version `18 -> 19` during live writeback, restored it to `20`, and cleanup counts were `0` across `aiSessions`, `aiMessages`, `aiAgentChangeSets`, `aiAgentDraftChanges`, `aiAgentApplyOperations`, `aiAgentTeams`, `aiAgentTasks`, and `aiAgentTeamEvents`.
  - Serial replay of `agent-team-browser-acceptance-smoke.mjs && agent-team-live-writeback-smoke.mjs` passed after adding a Mongo-backed smoke-user password lock with a 10-minute stale-lock TTL, so the two checked-in manual smokes no longer race on the shared smoke login.
- 2026-06-25 child writeback checkpoint:
  - Fixed child team runtime writeback inheritance: `start_agent_task` now forwards `currentDocId`, `currentDocPath`, `profile`, `model`, and `autoAccept` into `AgentTeamOrchestrator`; `AgentTeamChildRunner` forwards current document context and effective child policy into the child loop base context so child tools see `autoAccept=true`, `fileGlobs`, and `writeGlobs`.
  - Added path-level child policy guards for `read_document` and `edit_document` in both canonical and persistent-workspace paths, and repaired policy inheritance so omitted parent/capability `writeGlobs` do not silently broaden Auto Accept writes but explicit task `writeGlobs` still flow into the child.
  - Added `test/manual/agent-team-child-writeback-smoke.mjs` as a checked-in repeatable smoke for live root model + `start_agent_task` + live child model + Auto Accept writeback.
  - The smoke logs in through the real dev web entry, creates an AI session through `/api/ai/sessions`, sends a live root-model SSE request with `autoAccept=true`, requires exactly one root `start_agent_task` call and no root `edit_document` call, constrains the child task to `read_document` + `edit_document` with `fileGlobs`/`writeGlobs`, verifies the child accepted draft includes `parentSessionId`, `childSessionId`, `teamId`, `taskId`, and `capabilityName=writing-editor`, verifies canonical writeback advanced the real document version, restores the document through document-updater CAS, and deletes root/child session, team, task, message, draft, apply-operation, task-result, and context-pack records.
  - Smoke result: `node services/ai-writing-agent/test/manual/agent-team-child-writeback-smoke.mjs` passed with path `web-proxy -> root live model -> start_agent_task -> child live model -> edit_document -> canonical writeback`; latest replay advanced the document version `24 -> 25`, restored it to `26`, and cleanup counts were `0` across `aiSessions`, `aiMessages`, `aiAgentChangeSets`, `aiAgentDraftChanges`, `aiAgentApplyOperations`, `aiAgentTeams`, `aiAgentTasks`, `aiAgentTeamEvents`, `aiAgentTaskResults`, `aiAgentContextPacks`, and change-set-linked apply operations.
- 2026-06-25 forced writeback conflict checkpoint:
  - Added `test/manual/agent-team-writeback-conflict-smoke.mjs` as a checked-in repeatable smoke for real document-updater writeback conflict handling.
  - The smoke creates a real AI session/change set/draft change with stale `baseVersion`, advances the real document through document-updater before applying the draft through `CanonicalWritebackService`, verifies the draft becomes `conflict`, verifies a conflict apply operation is persisted, verifies the concurrent user edit is not overwritten by the AI proposal, restores the document through document-updater CAS, and deletes smoke session/change/apply records.
  - Smoke result: `node services/ai-writing-agent/test/manual/agent-team-writeback-conflict-smoke.mjs` passed; latest replay advanced the document version `28 -> 29` with a concurrent edit, marked the Auto Accept draft as conflict (`NOT_FOUND` rebase conflict), restored the document to version `30`, and cleanup counts were `0` across `aiSessions`, `aiMessages`, `aiAgentChangeSets`, `aiAgentDraftChanges`, and `aiAgentApplyOperations`.
- 2026-06-25 sandbox cleanup checkpoint:
  - Added `test/manual/sandbox-cleanup-smoke.mjs` as a checked-in repeatable smoke for persistent workspace expiry and local Docker sandbox cleanup.
  - The smoke inserts a scoped real Mongo `aiAgentWorkspaces` record and matching `aiSessions` workspace state, runs `PersistentWorkspaceManager.cleanupExpired()` through a scoped collection adapter so only the smoke workspace is eligible, verifies the workspace is marked `expired`, verifies the session `workspaceStatus` is set to `expired` and `workspaceId` is unset, creates a real local Docker sandbox from `resink-ai-sandbox:dev`, verifies the managed container and workspace parent exist, runs `LocalDockerSandboxProvider.manualCleanup({ includeActive: true, removeWorkspaces: true })`, and verifies the container and workspace directory are removed.
  - Smoke result: `node services/ai-writing-agent/test/manual/sandbox-cleanup-smoke.mjs` passed with expired workspace `workspace-sandbox-cleanup-smoke-1782329294708`, managed container `overleaf-ai-sandbox-sandbox-cleanup-smoke-1782329294708`, and cleanup counts returning the smoke workspace, container, and workspace directory.
- 2026-06-25 final M9 sweep:
  - Serial E2E replay passed: `node services/ai-writing-agent/test/manual/agent-team-browser-acceptance-smoke.mjs && node services/ai-writing-agent/test/manual/agent-team-live-writeback-smoke.mjs && node services/ai-writing-agent/test/manual/agent-team-child-writeback-smoke.mjs && node services/ai-writing-agent/test/manual/agent-team-writeback-conflict-smoke.mjs && node services/ai-writing-agent/test/manual/sandbox-cleanup-smoke.mjs`.
  - Latest replay evidence: browser retry task queued and cancel/reload cleanup counts stayed `0`; root live writeback advanced the real doc `30 -> 31` and restored it to `32`; child/team live writeback advanced the real doc `32 -> 33` and restored it to `34`; stale Auto Accept conflict advanced a concurrent edit `34 -> 35`, marked the draft conflict (`NOT_FOUND`), and restored the doc to `36`; sandbox cleanup removed the smoke managed container and workspace directory.
  - Post-run residue audit passed: `docker ps -a --filter 'label=overleaf.ai.sandbox.managed=true' --format '{{.Names}}'` returned no containers, smoke `aiSessions`/`aiAgentTeams`/`aiAgentTasks`/`aiAgentWorkspaces` counts were `0`, and the smoke doc content was restored to `["Live browser writeback accepted via Web proxy after dedupe fix.", ""]` at version `36`.
  - Targeted regression passed: `npm run test:unit -- test/unit/js/tool/StartAgentTaskToolTests.test.js test/unit/js/agent-team/AgentTeamChildRunnerTests.test.js test/unit/js/agent-team/AgentPolicyEngineTests.test.js test/unit/js/tool/EditToolTests.test.js test/unit/js/tool/ReadDocumentToolTests.test.js test/unit/js/agent/LiveDraftChangeBridgeTests.test.js test/unit/js/agent/CanonicalWritebackServiceTests.test.js test/unit/js/agent-team/AgentTeamOrchestratorTests.test.js test/unit/js/agent-team/DeepReviewWorkflowTests.test.js test/unit/js/sandbox/LocalDockerSandboxProvider.test.js test/unit/js/sandbox/PersistentWorkspaceManagerTests.test.js` passed 10 files / 71 tests.
  - Targeted ESLint passed for `AgentLoop`, child runner/policy/path guard, start/read/edit tools, and the checked-in browser/live/child/conflict/sandbox manual smokes.

Full-browser and runtime evidence:

- No deferred M9 evidence remains. The checked-in browser smoke proves the deployed web/editor route for persisted Team Trace reload, UI retry, UI cancel, active handoff clearing, conflict diagnostics, policy-denial diagnostics, skill capability diagnostics, and post-run Mongo cleanup. The checked-in live writeback smokes prove both root-agent Auto Accept writeback and child/team Auto Accept writeback, the checked-in conflict smoke proves stale Auto Accept drafts are marked conflict without overwriting concurrent edits, and the checked-in sandbox cleanup smoke proves scoped persistent-workspace expiry plus real local Docker container/workspace cleanup.

## 21. M10: Remove Legacy Multi-Agent Paths And Full Acceptance

### Objective

Delete old product paths and prove the new team runtime end to end.

### Implementation Tasks

- Remove old model-visible `delegate_task` from normal product toolsets.
- Remove old `AgentTypeRegistry` product path.
- Remove old `agents/*.md` dependency after migrating capabilities.
- Remove old sequential Deep Review prompt dispatch.
- Remove old child event UI assumptions.
- Update docs and tests.
- Run final full validation.
- Archive or delete temporary compatibility tests.

### Acceptance Criteria

- Product multi-agent execution uses `AgentTeamOrchestrator`.
- Deep Review uses workflow graph.
- Handoff works for compile fix.
- Structured results/reducer/critic are used in final reports.
- Team trace UI restores after reload.
- Live Agent Workspace writeback works for child edits.
- Old `delegate_task({ task, agent })` is not exposed to model-visible product tools.
- Legacy code is deleted or explicitly admin/test-only with no product path.

### Verification

```bash
cd services/ai-writing-agent
npm run test:unit
npx eslint .

cd ../web
npm run type-check
npx eslint frontend/js/features/ai-assistant app/src/Features/AIAssistant
```

### E2E Evidence

Required final evidence:

- Dev stack deployed from `develop/`.
- Browser/editor flow through real Overleaf project.
- Live `deepseek-v4-flash` or current approved dev model through deployed app path.
- Deep Review parallel fan-out/join.
- Handoff compile fix.
- Background explorer context pack.
- Skill-provided agent capability.
- Review-mode draft change from child agent.
- Auto Accept writeback from child agent.
- Reload/resume of team trace.
- Cancellation and retry.
- Policy escalation denial.
- Conflict handling.
- Cleanup: no active smoke sessions, orphan child sessions, unmanaged sandbox containers, or pending draft residue.

### Implementation Progress - 2026-06-24

Code removal checkpoint:

- Removed `DelegateTaskTool` and `AgentTypeRegistry` from product startup and deleted their implementation/tests/manual smoke.
- Deleted the legacy `agents/*.md` product prompt directory after migrating built-in capability prompts into structured capability metadata.
- Updated `AgentCapabilityPromptLoader` to load built-in prompts from structured capability definitions, while runtime status metadata redacts prompt bodies.
- Removed `legacy_subagent` from `ToolsetPolicy` and removed old delegate child-session UI rendering/state (`childSessionParts`, `childActiveBlocks`, `child_session_init` SSE handling).
- Updated citation/pre-submit skills and tool prompt text to use `start_agent_task` with structured task specs.
- Preserved tests that explicitly assert `delegate_task` is absent from normal tool policy output.

Verification:

```bash
cd services/ai-writing-agent
npm run test:unit -- test/unit/js/agent-team test/unit/js/tool/ToolRegistryTests.test.js test/unit/js/tool/StartAgentTaskToolTests.test.js test/unit/js/tool/StartAgentTeamToolTests.test.js test/unit/js/agent/AgentLoopTests.test.js test/unit/js/AgentController/AcceptRejectTests.test.js
npx eslint app/js/AgentController.js app/js/agent/AgentLoop.js app/js/agent-team app/js/tool/ToolPool.js app/js/tool/ToolsetPolicy.js app/js/tool/start_agent_task.js app/js/tool/start_agent_team.js test/unit/js/agent-team test/unit/js/tool/ToolRegistryTests.test.js
npm run test:unit
npx eslint .

cd ../web
npm run type-check
npx eslint frontend/js/features/ai-assistant app/src/Features/AIAssistant test/frontend/features/ai-assistant/components/agent-workspace-panel.spec.tsx
```

Results:

- M10 targeted AI unit regression: 21 files / 145 tests passed.
- M10 targeted AI ESLint: passed.
- Full AI unit regression: 86 files / 791 tests passed.
- Full AI ESLint: passed.
- Web type-check: passed.
- Web targeted ESLint: passed.

Deployed dev-stack evidence:

- `develop` stack was running with `web`, `webpack`, and `ai-writing-agent`; `ai-writing-agent` was restarted after a stale hot-reload parse failure and then reported healthy.
- `curl http://127.0.0.1:43060/status` and `/api/ai/health` both returned `{"status":"ok"}`.
- Browser smoke opened the real editor at `http://127.0.0.1:18080/project/6a390bf87a13c32e536c279c?aiSession=<temp>`, logged in as the smoke user, loaded a persisted team run from Mongo, opened the AI Assistant panel, and verified `.ai-team-trace-block`.
- Team Trace browser evidence: `/tmp/m7-team-trace-smoke.png`; trace text included `Team deep-review · running`, one finding, one artifact, and the cancel control.
- The only browser console/server 500 during the team-trace smoke was the unrelated editor auto-compile request failing with `spawn latexmk ENOENT`; all AI runtime/session/team-run requests returned 200.
- Live-model smoke ran inside the deployed `ai-writing-agent` container using `deepseek-v4-flash` through `AgentLoop` and `LLMAdapter`; the model called `start_agent_team` once with `workflowType: "deep-review"`.
- The live tool-name assertion exposed `start_agent_team` and `start_agent_task` and did not expose `delegate_task`.
- Cleanup audit after browser/live smoke: recent active teams `0`, unarchived smoke sessions `0`, recent pending/draft residue `0`; one stale June 20 smoke session was archived during cleanup.

M10 closure note:

- This milestone closes the legacy multi-agent removal and structured team-tool acceptance. M9 is also closed: the final E2E sweep covered browser retry/cancel/reload, root and child live-model Auto Accept writeback, stale writeback conflict, sandbox cleanup, targeted regression, targeted ESLint, and Docker/Mongo residue audits.

## 22. Frontend UX Requirements

The AI panel should render team state as product objects, not raw stream noise.

Required UI elements:

- Team run header:
  - workflow name
  - status
  - elapsed time
  - task counts
  - budget summary
- Task cards:
  - agent name
  - role
  - objective
  - status
  - progress summary
  - finding/artifact/draft counts
  - retry/cancel where allowed
- Handoff banner:
  - active specialist
  - reason
  - return/cancel state
- Findings view:
  - severity
  - category
  - evidence refs
  - source agent/task
- Diagnostics view:
  - context pack metadata
  - policy summary
  - hidden low-level events redacted

Layout constraints:

- Avoid nested cards inside cards.
- Keep task cards compact and scannable.
- Do not expose hidden prompts or raw child reasoning.
- Make reload state indistinguishable from live state where possible.

## 23. Development Subagent Strategy

Use implementation subagents for disjoint workstreams:

- **Capability/policy worker**
  - `AgentCapabilityRegistry`, schemas, `AgentPolicyCapsule`, `AgentPolicyEngine`.

- **Task/context worker**
  - `AgentTaskStore`, Mongo models, `AgentContextPackBuilder`.

- **Orchestrator worker**
  - `AgentTeamOrchestrator`, child AgentLoopV2 creation, structured task tool.

- **Graph/reducer worker**
  - `AgentGraphRunner`, Deep Review graph, reducer, critic, finding schema.

- **Handoff worker**
  - `AgentHandoffManager`, compile/citation/rebuttal specialist flows.

- **Skill integration worker**
  - Skill-provided capabilities, skill activation, Python dependency policy integration.

- **Frontend worker**
  - Team trace UI, task cards, handoff banner, reload, diagnostics.

Use independent verification subagents:

- Deployment verification.
- Browser E2E verification.
- Live model verification.
- Writeback verification.
- Multi-agent parallelism verification.
- Handoff verification.
- Policy/security probe verification.
- Reload/recovery verification.
- Cleanup verification.

Verification subagents should report evidence and should not edit implementation code.

## 24. Commit Discipline

After each completed milestone:

```bash
git status --short
git add <milestone files>
git commit -m "feat(ai-agent): <milestone summary>" \
  -m "Motivation: ..." \
  -m "Main changes: ..." \
  -m "Verification: ..." \
  -m "E2E/Security evidence: ..."
```

Rules:

- Commit only milestone-coherent work.
- Do not mix unrelated user/other-agent changes.
- Do not claim runtime completion without browser/live-model evidence.
- Preserve unrelated dirty worktree files.
- Do not commit secrets, raw logs, screenshots with tokens, or hidden prompt dumps.
- If a check is skipped, state the exact reason and whether it blocks the milestone.

## 25. Definition Of Done

The Agent Team Runtime migration is complete when:

- Static `.md AgentTypeRegistry` product path is replaced by `AgentCapabilityRegistry`.
- Old `delegate_task({ task, agent })` is not exposed to normal model-visible tools.
- Agent tasks are structured and persisted.
- Context packs are built, budgeted, and recorded.
- Policy capsules enforce monotonic permission inheritance.
- Deep Review uses workflow graph with parallel reviewers, reducer, and critic.
- Handoff works for at least compile fix and one writing/citation workflow.
- Child edits flow through Live Agent Workspace and CAS writeback.
- Skill-provided agent capabilities work under sandbox and Python dependency policy.
- Team trace UI supports progress, reload, cancel, retry, findings, artifacts, and draft-change provenance.
- Security probes prove child agents cannot escalate tools, files, network, Python env, model tier, spawn rights, or writeback.
- Cleanup leaves no orphan child sessions, team runs, sandbox containers, temp dirs, or pending draft residue.
- Full E2E evidence is captured from deployed dev stack, browser, live model, Mongo, document-updater/canonical document state, and independent verification subagents.

## 26. One-Shot `/goal` Prompt

```text
/goal Implement the Agent Team Runtime architecture described in services/ai-writing-agent/doc/agent-team-runtime-development-plan.md. Continue through every milestone until the Definition of Done is satisfied. Treat this as a clean replacement: do not preserve old delegate_task({ task, agent }), static AgentTypeRegistry, agents/*.md product path, sequential Deep Review dispatch, or Markdown-only child result contracts as final product behavior. Use implementation subagents for capability/policy, task/context, orchestrator, graph/reducer, handoff, skill integration, and frontend workstreams. Use independent verification subagents for deployment, browser E2E, live-model, writeback, multi-agent parallelism, handoff, policy/security probes, reload/recovery, and cleanup checks. Do not stop after unit/lint/type checks. Do not mark a runtime milestone complete without deployed browser/live-model evidence where behavior changes. Commit after every completed milestone using Conventional Commits with motivation, main changes, verification commands, E2E/security evidence, and skipped-check reasons. Preserve unrelated worktree changes and never commit secrets, raw hidden prompts, package-index credentials, or token-bearing logs/screenshots.
```

## 27. First Implementation Checklist

Before coding:

1. Read this document fully.
2. Read `multi-agent-orchestration-architecture-design.md`.
3. Read `live-agent-workspace-development-plan.md`.
4. Read `sandbox-command-skill-runtime-development-plan.md`.
5. Read `uv-python-dependency-broker-development-plan.md`.
6. Run `git status --short` and preserve unrelated work.
7. Audit current `delegate_task`, `AgentTypeRegistry`, child session handling, frontend child event rendering, and Deep Review skills.
8. Dispatch baseline and verification subagents.

First code milestone:

1. Write the deletion map.
2. Add capability and policy schemas.
3. Add registry tests before deleting old registry.
4. Keep all product behavior behind AgentLoopV2/Live Agent Workspace.
5. Do not add compatibility features unless they are removed by M10.
