# Agent Memory Development Plan

> Goal: replace the current Mongo-only Project Rules and ad-hoc MemoryManager path with a clean Codex/Claude-Code-style Agent Context system for ResInk AI.
>
> Primary design source: `services/ai-writing-agent/doc/agent-memory-architecture-design.md`.
>
> This migration assumes the product is still in closed development. There are no external users, public API consumers, or historical memory/rules workflows that require compatibility. Do not build a long-term compatibility layer for `/projects/:projectId/rules`, `aiProjectRules`, `ProjectRulesEditor`, `ProjectRulesProvider`, or the current string-concatenating `MemoryManager`.
>
> This document is written for one long-running autonomous `/goal` execution. The agent should drive the whole migration to completion, use implementation subagents for separable workstreams, require independent verification subagents for browser/live-model/writeback/privacy/reload checks, and commit after every completed milestone.

## 1. Product Positioning

ResInk AI should not expose memory as a complex knowledge graph or a set of many memory types. The target product is:

**A compact Agent Context system for Overleaf projects, using project-file instructions plus private user memories.**

User-facing concepts:

- **Project Instructions**: project-shared AI guidance stored in `AGENTS.md`.
- **Memories**: current user's private, reviewable, deletable memories.
- **Agent Context**: the single UI entry that contains Instructions, Memories, and Trace.

Internal concepts:

- **Session Summary**: continuity state for compaction, reload, and multi-agent context packs.
- **Context Recall**: bounded internal retrieval over memories and summaries.
- **Context Snapshot**: debug/audit metadata about what context a turn used.

The final UI should not add multiple top-level panels. The AI panel gets one stable `Agent Context` entry, and the drawer/modal uses tabs or sections for:

```text
Instructions
Memories
Trace
```

## 2. Design Inputs

Primary architecture document:

- `services/ai-writing-agent/doc/agent-memory-architecture-design.md`

Required existing architecture boundaries:

- `services/ai-writing-agent/doc/live-agent-workspace-development-plan.md`
- `services/ai-writing-agent/doc/hermes-style-agent-loop-development-plan.md`
- `services/ai-writing-agent/doc/agent-team-runtime-development-plan.md`
- `services/ai-writing-agent/doc/sandbox-command-skill-runtime-development-plan.md`

Relevant existing implementation to replace:

- `services/web/frontend/js/features/ai-assistant/components/project-rules-editor.tsx`
- `services/web/frontend/js/features/ai-assistant/api/ai-api.ts`
- `services/ai-writing-agent/app/js/AgentController.js`
- `services/ai-writing-agent/app/js/Router.js`
- `services/ai-writing-agent/app/js/memory/MemoryManager.js`
- `services/ai-writing-agent/app/js/memory/MemoryProvider.js`
- `services/ai-writing-agent/app/js/memory/ProjectRulesProvider.js`
- `services/ai-writing-agent/app/js/mongodb.js`

The migration must preserve these product facts:

- Overleaf owns auth, project permissions, canonical documents, editor state, collaboration, and CAS writeback.
- Project Instructions are project files and must flow through project file operations, draft changes, Review mode, Auto Accept mode, and CAS writeback.
- Memories are private to `userId`, can be scoped globally or to one project, and must never be visible to collaborators.
- Session Summary is internal state and must not be automatically promoted into Memories.
- Context Recall is an internal implementation detail and must not become another visible product surface.
- Child agents receive scoped context packs and must not write long-term memories by default.

## 3. Non-Goals

- Do not build semantic/episodic/procedural memory categories.
- Do not build memory wiki, DREAMS.md, active-memory subagent, graph memory, or multiple memory backends.
- Do not make vector search the source of truth.
- Do not expose Session Summary as a first-class user panel.
- Do not create separate top-level panels for Instructions, Memories, and Session.
- Do not keep `/projects/:projectId/rules` as the final API.
- Do not keep `aiProjectRules` as the final source of truth.
- Do not allow Memories, Context Recall, or Session Summary to bypass Overleaf permissions, Live Agent Workspace, or CAS.
- Do not let child agents write Memories or Project Instructions unless a later explicit policy grants that behavior.
- Do not mark runtime milestones complete with only unit/lint/type checks.

## 4. Architecture Principles

1. **Instruction-first, not memory-first.**
   Durable project behavior belongs in `AGENTS.md`. Memories are private preferences and repeated corrections, not project facts.

2. **One visible context entry.**
   The frontend should add a single `Agent Context` entry. Internally it may have tabs, but the AI panel header must stay compact.

3. **Project Instructions are file-backed.**
   The canonical source is the Overleaf project file `AGENTS.md`, not Mongo-only rules.

4. **Memories are user-private.**
   Memories are keyed by `userId`, optionally `projectId`, and are never exported with the project.

5. **Suggestion-first memory writes.**
   The model can propose a memory. A durable memory is written only after user confirmation or explicit user command.

6. **Frozen context per turn.**
   Context built for a turn remains stable for that turn. Memories created during the turn are available from the next turn.

7. **Context is traceable but not overexposed.**
   Context Snapshot records source refs and budgets. It does not persist full system prompts or hidden prompt bodies.

8. **Context Recall starts simple.**
   First version uses scoped Mongo text search and ranking. Embeddings are deferred until real data volume justifies them.

9. **Security boundaries are mechanical.**
   Prompt guidance is not enforcement. Project writes use Live Agent Workspace and CAS; Memories use user-private APIs; tools use ToolsetPolicy.

10. **Clean replacement.**
    Remove old project rules paths after the new vertical path is verified. Do not maintain two product models.

## 5. Target Runtime Shape

```text
Browser AI panel
  -> Agent Context button
  -> AgentContextPanel
      -> Instructions tab
          -> ProjectInstructionService
          -> LiveDraftChangeBridge / CanonicalWritebackService
          -> Overleaf project file AGENTS.md
      -> Memories tab
          -> MemoryService
          -> aiMemories / aiMemorySuggestions
      -> Trace tab
          -> ContextSnapshotService
          -> SessionSummaryService

Agent turn
  -> AgentContextBuilder
      -> ProjectInstructionService snapshot
      -> MemoryService scoped memories
      -> SessionSummaryService current summary
      -> ContextRecallService bounded recall
      -> ContextSnapshotService source refs
  -> AgentLoopV2 / AgentTeamRuntime
```

## 6. Development Milestones

The milestones are checkpoints for a single long-running `/goal`, not separate user prompts. The main agent should continue through the full board unless blocked by a real technical dependency. Do not stop after Milestone 0.

Maintain this board by changing checkboxes and adding short completion evidence only. Do not append chronological logs, transcripts, or every failed attempt here; put detailed handoff notes in a separate handoff file only when blocked.

Every completed milestone must be committed immediately. Commit messages must use Conventional Commits and include body evidence: motivation, main changes, verification commands, and results.

### 6.0 One-Shot Delivery Board

- [x] M0: Baseline audit, route map, and feature flag - key files: `config/settings.defaults.cjs`, `app/js/RuntimeConfigManager.js`, `test/unit/js/RuntimeConfigManagerTests.test.js`, this document; verification: RuntimeConfigManager unit test, syntax checks, targeted ESLint; notes: `aiAssistant.agentContext` defaults off, runtime status exposes safe config, old `/rules` path remains unchanged until M11.
- [x] M1: Mongo models and service skeletons for Memories, Suggestions, Summaries, and Context Snapshots - key files: `app/js/mongodb.js`, `app/js/agent-context/*`, `test/unit/js/agent-context/*`; verification: agent-context unit suite, targeted ESLint, node syntax checks; notes: services are not wired into prompts or routes yet.
- [x] M2: ProjectInstructionService reads and creates project-file `AGENTS.md` - key files: `ProjectInstructionService.js`, `ProjectInstructionServiceTests.test.js`; verification: agent-context unit suite, targeted ESLint, syntax check; notes: reads/creates canonical project file only, draft/CAS writeback remains M3.
- [x] M3: Project Instructions write path through Live Agent Workspace draft changes and Auto Accept CAS writeback - key files: `ProjectInstructionService.js`, `AgentController.js`, `Router.js`, `AgentContextErrors.js`, `RouterAgentContextRoutesTests.test.js`, `ProjectInstructionServiceTests.test.js`, `test/manual/agent-context-instructions-writeback-smoke.mjs`; verification: agent-context and route unit tests, targeted ESLint, node syntax checks; deployed smoke: with `AGENT_CONTEXT_ENABLED=true` temporary compose override, browser login through Web proxy created session `6a3cd202b5a23fab9b84956a`, Review draft `6a3cd202b5a23fab9b84956c` accepted via CAS, Auto Accept draft `6a3cd202b5a23fab9b84956e` applied immediately, Reject left canonical `AGENTS.md` unchanged, stale baseVersion returned 409, temporary `AGENTS.md` was deleted, smoke session/change/apply records cleaned, and service was restored to default `agentContext.enabled=false`.
- [x] M4: Agent Context backend APIs replace `/rules` - key files: `Router.js`, `AgentController.js`, `agent-context/*Service.js`, `ai-api.ts`, `ai-types.ts`, `RouterAgentContextRoutesTests.test.js`, `agent-context/*Tests.test.js`, `test/manual/agent-context-api-smoke.mjs`; verification: agent-context and route unit tests, targeted AI-service ESLint, web `npm run type-check`, targeted web ESLint; deployed smoke: with temporary `AGENT_CONTEXT_ENABLED=true`, browser login through Web proxy session `6a3cd53656f6e2eac6dc83d0` created/listed/deleted project memory, verified another user's marker memory was not listed, listed and accepted suggestion `6a3cd536013e4a396664889a`, read context snapshot refs/totals without hidden prompt body, read session summary, cleaned smoke data, and restored service to default `agentContext.enabled=false`; notes: old `/rules` remains deprecated until M11, new frontend API uses Agent Context endpoints.
- [x] M5: AgentContextBuilder integrates Project Instructions, Memories, Session Summary, Context Recall, and Context Snapshot - key files: `AgentContextBuilder.js`, `AgentLoop.js`, `prompt/system.js`, `AgentContextBuilderTests.test.js`, `AgentLoopTests.test.js`, `PromptTests.test.js`, `test/manual/agent-context-builder-live-smoke.mjs`; verification: M5 target unit tests plus full agent-context suite, targeted ESLint and syntax checks; deployed live smoke: with temporary `AGENT_CONTEXT_ENABLED=true`, browser/Web proxy/live AgentLoopV2 session `6a3cd7b06649bd102a300e4f` completed a live model turn and created context snapshot source refs `memory` and `session-summary`; smoke data was cleaned and service restored to default `agentContext.enabled=false`; notes: AgentLoopV2 now uses structured `agentContextBlock` and skips legacy `MemoryManager.getMemoryContent()` when structured Agent Context is available.
- [x] M6: MemoryService CRUD, memory suggestions, recall toggle, and privacy enforcement - key files: `MemorySuggestionService.js`, `ContextRecallService.js`, `ToolsetPolicy.js`, `ToolPool.js`, `propose_memory.js`, `AgentController.js`, `AgentLoop.js`, `AgentContextBuilder.js`, `test/unit/js/agent-context/*`, `test/unit/js/tool/ProposeMemoryToolTests.test.js`, `test/manual/agent-context-memory-tool-live-smoke.mjs`; verification: full agent-context and tool unit suites, targeted ESLint and syntax checks; deployed live smoke: with temporary `AGENT_CONTEXT_ENABLED=true`, browser/Web proxy/live AgentLoopV2 session `6a3cda2845ee76225dfbe061` called `propose_memory`, created pending suggestion `6a3cda2a45ee76225dfbe065`, accepted it into memory `6a3cda2b45ee76225dfbe067`, verified memory listing for owning user, cleaned smoke data, and restored service to default `agentContext.enabled=false`; notes: `propose_memory` is suggestion-only, hidden when Agent Context is disabled, and blocked for child agents by policy and ToolPool.
- [x] M7: SessionSummaryService extraction from ContextManager and compaction integration - key files: `ContextManager.js`, `SessionSummaryService.js`, `AgentController.js`, `ContextManagerTests.test.js`, `SessionSummaryServiceTests.test.js`, `test/manual/compaction-test.mjs`; verification: M7 target unit tests, `npx eslint .`, syntax/diff checks; deployed manual endpoint smoke: browser/Web proxy mode created a session, seeded compactable history, called `/api/ai/sessions/:id/compact`, wrote a protected `aiMessages` summary plus active `aiSessionSummaries` record with source seq range `1-4`, created one pending memory suggestion, cleaned smoke data, and exited PASS; notes: automatic compaction persists summaries without auto memory writes, while manual compact opts into pending suggestion generation only.
- [x] M8: ContextRecallService with scoped text search and bounded ranking - key files: `ContextRecallService.js`, `AgentContextBuilder.js`, `ContextRecallServiceTests.test.js`, `AgentContextBuilderTests.test.js`; verification: M8 target tests, full agent-context suite, targeted ESLint, diff check; notes: recall now ranks active user Memories and same-project session summaries by keyword score, project scope, source type, and recency, clamps by count/char budgets, records `lastUsedAt`/`useCount` for used Memories, and injects selected recall into a fenced `<context_recall>` reference block.
- [x] M9: AgentContextPanel frontend with Instructions, Memories, and Trace tabs - key files: `agent-context-panel.tsx`, `ai-assistant-pane.tsx`, `ai-assistant.scss`; verification: web `npm run type-check`, web `npm run lint`, `git diff --check`; deployed browser smoke: with temporary `AGENT_CONTEXT_ENABLED=true`, browser/Web proxy session `6a3ce138c0e1e118116615c4` opened the single Agent Context button, loaded Instructions, switched to Memories and Trace, verified the panel stayed inside a 1280x900 viewport at `{x:744,y:78,width:520,height:359}`, saw no Agent Context API errors, cleaned smoke session data, and restored service to default `agentContext.enabled=false`; skipped-check: `npm run test:frontend -- --grep "ai-assistant"` is blocked by existing frontend test alias resolution error `Cannot find package '@/features'` in `test/frontend/features/ai-assistant/api/ai-api.test.ts`.
- [x] M10: Multi-agent context pack integration and child-agent memory write restrictions - key files: `AgentContextPackBuilder.js`, `AgentTaskStore.js`, `AgentTeamOrchestrator.js`, `AgentTeamChildRunner.js`, `start_agent_task.js`, `builtInCapabilities.js`, `deepReviewWorkflow.js`, `test/unit/js/agent-team/*`, `test/unit/js/tool/ToolRegistryTests.test.js`; verification: `npm run test:unit -- --run test/unit/js/agent-team test/unit/js/tool`, `npx eslint .`, `git diff --check`; notes: context packs now use `projectInstructions`, selected `memories`, `sessionSummary`, and `recalledContext` fields; child prompts show only selected slices; team events record `contextSourceCounts` without context body; child tool policy/ToolPool continue to exclude `propose_memory` by default.
- [x] M11: Security hardening, injection/secret scans, and old-path removal - key files: `ContentSafetyGuard.js`, `MemoryService.js`, `ProjectInstructionService.js`, `Router.js`, `AgentController.js`, `AgentLoop.js`, `prompt/system.js`, `mongodb.js`, `ai-api.ts`, `completion-rules-editor.tsx`, `ai-assistant.scss`; verification: AI service `npm run test:unit` (94 files / 843 tests), AI service `npx eslint .`, web `npm run type-check`, web `npm run lint`, `git diff --check`; security evidence: Memories and Project Instructions reject secret-looking and prompt-injection-looking content before persistence; old product-path grep for `ProjectRules|project rules|/rules|aiProjectRules|MemoryManager|ProjectRulesProvider|MemoryProvider|includeProjectRules|getProjectRules|updateProjectRules|projectRules` across AI app/tests and AI Assistant frontend returns no matches; notes: legacy `/projects/:projectId/rules`, `aiProjectRules`, `ProjectRulesEditor`, `MemoryManager`, `ProjectRulesProvider`, and prompt `projectRules` injection were removed as product paths.
- [x] M12: End-to-end deployment, browser, live-model, writeback, privacy, reload, and regression verification - key files: `test/manual/agent-context-api-smoke.mjs`, `agent-context-instructions-writeback-smoke.mjs`, `agent-context-builder-live-smoke.mjs`, `agent-context-memory-tool-live-smoke.mjs`, `compaction-test.mjs`, `agent-team-child-writeback-smoke.mjs`, `agent-team-context-pack-smoke.mjs`; verification: develop stack `docker compose -f docker-compose.yml -f docker-compose.dev.yml ps`, AI `/status`, AI service `npm run test:unit` (94 files / 844 tests), AI service `npx eslint .`, web `npm run type-check`, web `npm run lint`, `git diff --check`, old-path grep returned no matches; deployed evidence: temporary `AGENT_CONTEXT_ENABLED=true` ran browser/Web proxy Agent Context UI smoke session `6a3ce8b34cf6c314c8d9179b` with no Agent Context API errors; API/privacy smoke session `6a3ce69f35b5fb6e9e4b548c` verified memory CRUD, another-user isolation, suggestions, context snapshot, and session summary APIs; AGENTS.md writeback smoke session `6a3ce6ab35b5fb6e9e4b548f` verified Review accept, Auto Accept, reject, stale 409 conflict, canonical versions 1->4, and cleanup; live AgentLoopV2 builder smoke session `6a3ce6b535b5fb6e9e4b549c` produced context snapshot refs `memory`, `session-summary`, and `recall`; memory tool live smoke session `6a3ce6c535b5fb6e9e4b54a2` verified `propose_memory` suggestion accept to memory; compaction Web proxy smoke passed with summary message, durable `aiSessionSummaries`, source seq range `1-4`, pending suggestions info, and zero Memories created from compaction; child live writeback smoke session `6a3ce7a835b5fb6e9e4b54b0` verified `web-proxy -> root live model -> start_agent_task -> child live model -> edit_document -> canonical writeback`; context pack smoke team `6a3ce8827614a91e71766b8d` verified one selected Memory slice, source counts, and child allowed tools `read_document` only; service restored to default with no `AGENT_CONTEXT_ENABLED` env and `/status` ok; independent read-only verifier confirmed old product paths are gone and content guard covers instruction/memory persistence.

Completion evidence format:

```text
M#: done - key files: <paths>; verification: <commands>; notes: <one or two lines>
```

### Milestone 0: Baseline Audit, Route Map, And Feature Flag

Objective:

Create the migration baseline and feature switch without changing default behavior.

Scope:

- Audit current Project Rules, MemoryManager, ContextManager compaction, AI panel header, and Live Agent Workspace writeback paths.
- Add a temporary feature flag, for example `aiAssistant.agentContext.enabled`.
- Add route guards so new APIs can be introduced behind the flag.
- Record old paths that must be removed before final acceptance.
- Confirm whether `AGENTS.md` root creation can reuse existing create-doc flow or needs a dedicated helper.

Expected files:

- `services/ai-writing-agent/config/settings.defaults.cjs`
- `services/ai-writing-agent/app/js/RuntimeConfigManager.js` if config centralization is appropriate
- `services/ai-writing-agent/app/js/Router.js`
- `services/ai-writing-agent/test/unit/js/*`
- This document's delivery board.

Acceptance:

- Existing AI panel still opens with the flag disabled.
- Existing `/projects/:projectId/rules` behavior is unchanged before removal.
- New config default is off or harmless until implementation exists.
- Audit identifies every old route/component/service to remove in M11.

Verification commands:

```bash
cd services/ai-writing-agent
npm run test:unit
npx eslint .

cd ../web
npm run type-check
```

Commit:

```text
chore(ai-agent): baseline agent context memory migration
```

M0 completion evidence:

- Current Project Rules chain is still:

  ```text
  ProjectRulesEditor
    -> ai-api getProjectRules/updateProjectRules
    -> Router GET/PUT /projects/:projectId/rules
    -> AgentController getProjectRules/updateProjectRules
    -> aiProjectRules
    -> MemoryManager + ProjectRulesProvider
    -> AgentLoop enriched.projectRules
    -> prompt/system.js projectRules section
  ```

- Current ContextManager compaction remains in `app/js/agent/ContextManager.js` and is still owned by AgentLoop/AgentController. M7 must extract summary persistence into `SessionSummaryService`.
- AI panel header still renders `ProjectRulesEditor` from `ai-assistant-pane.tsx`; M9 must replace this with one Agent Context entry.
- `AGENTS.md` root creation can reuse `ProjectAdapter.createDoc(projectId, name, parentFolderId, userId)` with `parentFolderId=null`; initial content writing currently exists in create-change paths through `DocumentAdapter._callSetDocAPI`, but the product implementation must expose this through ProjectInstructionService and the Live Draft / CAS writeback pipeline.
- Live writeback helpers available for M3:
  - `AgentChangeSetService`
  - `LiveDraftChangeBridge`
  - `CanonicalWritebackService`
  - existing create/delete handling in AgentLoop and AgentController pending-change paths.
- M0 added `aiAssistant.agentContext` config with default `enabled=false`, file name `AGENTS.md`, context/memory/recall budgets, suggestion TTL, and secret/prompt-injection blocking switches. Runtime status exposes this config without secrets.

### Milestone 1: Data Models And Service Skeletons

Objective:

Introduce the storage schema and service boundaries without wiring them into prompt construction.

Scope:

- Add Mongo collections and indexes:
  - `aiMemories`
  - `aiMemorySuggestions`
  - `aiSessionSummaries`
  - `aiContextSnapshots`
- Add service skeletons:
  - `MemoryService`
  - `MemorySuggestionService`
  - `SessionSummaryService`
  - `ContextSnapshotService`
  - `ContextRecallService`
- Add basic validation helpers for scope, status, content length, and user ownership.
- Add feature-flag-aware service factory if needed.

Expected files:

- `services/ai-writing-agent/app/js/mongodb.js`
- `services/ai-writing-agent/app/js/agent-context/MemoryService.js`
- `services/ai-writing-agent/app/js/agent-context/MemorySuggestionService.js`
- `services/ai-writing-agent/app/js/agent-context/SessionSummaryService.js`
- `services/ai-writing-agent/app/js/agent-context/ContextSnapshotService.js`
- `services/ai-writing-agent/app/js/agent-context/ContextRecallService.js`
- Unit tests under `services/ai-writing-agent/test/unit/js/agent-context/`

Acceptance:

- Index creation is idempotent.
- Memory CRUD service enforces `userId` ownership.
- Suggestion service supports pending, accepted, dismissed, expired states.
- Context snapshot service stores refs only, not full hidden prompts.
- No prompt path uses the new services yet.

Verification commands:

```bash
cd services/ai-writing-agent
npm run test:unit -- --run test/unit/js/agent-context
npx eslint .
node --check app/js/agent-context/MemoryService.js app/js/agent-context/ContextSnapshotService.js
```

Commit:

```text
feat(ai-agent): add agent context storage services
```

M1 completion evidence:

- Added Mongo collections and idempotent indexes for `aiMemories`, `aiMemorySuggestions`, `aiSessionSummaries`, and `aiContextSnapshots`.
- Added `MemoryService`, `MemorySuggestionService`, `SessionSummaryService`, `ContextRecallService`, and `ContextSnapshotService` under `app/js/agent-context/`.
- `MemoryService` enforces user ownership on update/delete and filters active memories by user/scope.
- `MemorySuggestionService` supports pending creation, accepted -> memory creation, dismissed, and user ownership denial.
- `ContextSnapshotService` persists refs/totals only and drops hidden prompt/content fields.
- No prompt path, route, or frontend path uses the new services yet.

### Milestone 2: ProjectInstructionService Read And Create

Objective:

Make `AGENTS.md` the canonical source for Project Instructions reads and creation.

Scope:

- Add `ProjectInstructionService`.
- Resolve project root `AGENTS.md`.
- Read canonical content through existing Overleaf project/document adapters and permission checks.
- Create `AGENTS.md` when missing through project file creation flow.
- Return doc id, version, path, content, existence, and source metadata.
- Do not yet remove old `/rules`.

Expected files:

- `services/ai-writing-agent/app/js/agent-context/ProjectInstructionService.js`
- `services/ai-writing-agent/app/js/adapter/ProjectAdapter.js` if helper additions are needed
- `services/ai-writing-agent/app/js/adapter/DocumentAdapter.js` if helper additions are needed
- Unit tests for missing file, existing file, unsafe duplicate paths, and permission failures.

Acceptance:

- Existing project with `AGENTS.md` returns content and version.
- Project without `AGENTS.md` returns `exists=false`.
- Create path creates a root document named `AGENTS.md` and returns version metadata.
- Service never reads from `aiProjectRules`.

Verification commands:

```bash
cd services/ai-writing-agent
npm run test:unit -- --run test/unit/js/agent-context/ProjectInstructionServiceTests.test.js
npx eslint .
```

Commit:

```text
feat(ai-agent): read project instructions from AGENTS.md
```

M2 completion evidence:

- Added `ProjectInstructionService` as the canonical Project Instructions read/create boundary.
- Existing `AGENTS.md` is resolved through `ProjectAdapter.resolvePathToEntity()` and read through `DocumentAdapter.getDocumentContent()`.
- Missing `AGENTS.md` returns `exists=false` with source `project-file`.
- Creation uses `ProjectAdapter.createDoc(projectId, 'AGENTS.md', null, userId)` and initializes content through the existing document set API.
- Creation fails if any existing entity already occupies `AGENTS.md`, including non-doc entities.
- Service never reads from `aiProjectRules`; old `/rules` remains untouched until replacement/removal milestones.

### Milestone 3: Project Instructions Draft And CAS Writeback

Objective:

Make edits to Project Instructions flow through Live Agent Workspace and CAS, not Mongo-only writes.

Scope:

- Build draft changes for `AGENTS.md` edits.
- Support Review mode: create visible draft change and wait for accept/reject.
- Support Auto Accept: create draft change and immediately apply through canonical writeback.
- Preserve project/doc base version in requests.
- Emit events suitable for the frontend to show pending diff.
- Ensure conflict handling if `AGENTS.md` changed after load.

Expected files:

- `services/ai-writing-agent/app/js/agent-context/ProjectInstructionService.js`
- `services/ai-writing-agent/app/js/live-workspace/*` or existing Live Workspace services as needed
- `services/ai-writing-agent/app/js/AgentController.js`
- `services/ai-writing-agent/test/unit/js/agent-context/ProjectInstructionWritebackTests.test.js`

Acceptance:

- Review save creates a pending draft change for `AGENTS.md`.
- Accept applies via existing CAS/version guard.
- Reject leaves canonical `AGENTS.md` unchanged.
- Auto Accept applies immediately and reports applied version.
- Conflict returns a specific conflict response and does not overwrite user edits.

Verification commands:

```bash
cd services/ai-writing-agent
npm run test:unit -- --run test/unit/js/agent-context/ProjectInstructionWritebackTests.test.js
npx eslint .
```

Manual smoke:

- Create or load a project.
- Save Project Instructions in Review mode.
- Inspect pending change status.
- Accept and verify canonical file content.

Commit:

```text
feat(ai-agent): route project instructions through draft writeback
```

### Milestone 4: Agent Context Backend APIs

Objective:

Expose clean backend APIs for Agent Context and begin replacing old rules endpoints.

Scope:

- Add API routes:
  - `GET /projects/:projectId/agent-instructions`
  - `POST /projects/:projectId/agent-instructions/create`
  - `PUT /projects/:projectId/agent-instructions/draft`
  - `GET /memories`
  - `POST /memories`
  - `PATCH /memories/:memoryId`
  - `DELETE /memories/:memoryId`
  - `GET /memory-suggestions`
  - `POST /memory-suggestions/:suggestionId/accept`
  - `POST /memory-suggestions/:suggestionId/dismiss`
  - `GET /sessions/:sessionId/context-snapshot/:turnId`
- Require user identity on every route.
- Enforce project permission on project-scoped routes.
- Add request/response types for frontend.
- Keep old `/rules` only until M11.

Expected files:

- `services/ai-writing-agent/app/js/Router.js`
- `services/ai-writing-agent/app/js/AgentController.js`
- `services/ai-writing-agent/app/js/agent-context/*`
- `services/web/frontend/js/features/ai-assistant/api/ai-api.ts`
- `services/web/frontend/js/features/ai-assistant/types/ai-types.ts`
- Unit/API tests.

Acceptance:

- All new routes validate malformed ids and missing user id.
- Memories routes cannot access another user's records.
- Context snapshot route returns refs only and fails closed for unauthorized sessions.
- Old `/rules` route is marked deprecated in code comments and not used by new frontend APIs.

Verification commands:

```bash
cd services/ai-writing-agent
npm run test:unit -- --run test/unit/js/AgentController test/unit/js/Router
npx eslint .

cd ../web
npm run type-check
```

Commit:

```text
feat(ai-agent): expose agent context APIs
```

### Milestone 5: AgentContextBuilder Integration

Objective:

Replace string-concatenating memory prompt construction with a structured AgentContextBuilder.

Scope:

- Add `AgentContextBuilder`.
- Load Project Instructions snapshot from `AGENTS.md`.
- Load current user's Memories according to recall settings.
- Load current Session Summary.
- Call ContextRecallService for bounded memories/summaries.
- Create Context Snapshot refs for the turn.
- Inject context into AgentLoopV2 with source fencing.
- Keep context stable for the turn.

Expected files:

- `services/ai-writing-agent/app/js/agent-context/AgentContextBuilder.js`
- `services/ai-writing-agent/app/js/agent/AgentLoop.js`
- `services/ai-writing-agent/app/js/prompt/system.js`
- `services/ai-writing-agent/test/unit/js/agent-context/AgentContextBuilderTests.test.js`
- `services/ai-writing-agent/test/unit/js/agent/AgentLoopTests.test.js`

Acceptance:

- Prompt includes Project Instructions from `AGENTS.md` when present.
- Prompt includes only current user's active Memories.
- Prompt excludes disabled/deleted memories.
- Prompt includes current session summary when available.
- Context snapshot records refs and token estimates.
- No code path calls old `MemoryManager.getMemoryContent()` in AgentLoopV2.

Verification commands:

```bash
cd services/ai-writing-agent
npm run test:unit -- --run test/unit/js/agent-context/AgentContextBuilderTests.test.js test/unit/js/agent/AgentLoopTests.test.js
npx eslint .
```

Commit:

```text
feat(ai-agent): build prompts from structured agent context
```

### Milestone 6: Memories CRUD, Suggestions, And Privacy

Objective:

Implement durable private Memories and user-confirmed memory suggestions end to end.

Scope:

- Implement MemoryService CRUD fully.
- Implement recall enable/disable setting.
- Implement MemorySuggestionService accept/dismiss/expiry.
- Add `propose_memory` tool for root Agent only.
- Ensure child agents cannot call `propose_memory` by default.
- Add privacy tests with two users on the same project.

Expected files:

- `services/ai-writing-agent/app/js/agent-context/MemoryService.js`
- `services/ai-writing-agent/app/js/agent-context/MemorySuggestionService.js`
- `services/ai-writing-agent/app/js/tool/propose_memory.js`
- `services/ai-writing-agent/app/js/tool/ToolPool.js`
- `services/ai-writing-agent/app/js/tool/ToolsetPolicy.js`
- Unit tests for memory CRUD, suggestions, tool policy, and privacy.

Acceptance:

- User can create global and project-scoped Memories.
- User can edit/delete/disable Memories.
- Suggestion accept creates a Memory; dismiss does not.
- Deleted Memories are not recalled and not injected.
- User A cannot list or recall User B's Memories on the same project.
- Child agents cannot propose or write Memories unless explicitly granted by future policy.

Verification commands:

```bash
cd services/ai-writing-agent
npm run test:unit -- --run test/unit/js/agent-context test/unit/js/tool
npx eslint .
```

Commit:

```text
feat(ai-agent): add private memories and suggestions
```

### Milestone 7: SessionSummaryService And Compaction

Objective:

Move session summary responsibility out of ContextManager and make it usable by AgentContextBuilder and Trace.

Scope:

- Extract summary generation into `SessionSummaryService`.
- Preserve current compaction behavior while changing ownership.
- Store summaries in `aiSessionSummaries`.
- Link source message seq range.
- Trigger optional memory suggestion pass before compaction, but do not auto-write Memories.
- Update manual compaction endpoint.

Expected files:

- `services/ai-writing-agent/app/js/agent-context/SessionSummaryService.js`
- `services/ai-writing-agent/app/js/agent/ContextManager.js`
- `services/ai-writing-agent/app/js/AgentController.js`
- `services/ai-writing-agent/test/unit/js/agent-context/SessionSummaryServiceTests.test.js`
- `services/ai-writing-agent/test/manual/compaction-test.mjs`

Acceptance:

- Existing compaction tests still pass.
- New summaries are queryable by session id.
- AgentContextBuilder uses latest summary.
- Memory suggestions from compaction are pending only.
- Summary text is fenced as historical context, not instructions.

Verification commands:

```bash
cd services/ai-writing-agent
npm run test:unit -- --run test/unit/js/agent-context/SessionSummaryServiceTests.test.js test/unit/js/agent/ContextManagerTests.test.js
npx eslint .
node test/manual/compaction-test.mjs --project=<dev-project-id>
```

Manual command may be skipped only if no dev project is available; record the skip reason.

Commit:

```text
feat(ai-agent): persist session summaries for agent context
```

### Milestone 8: ContextRecallService

Objective:

Add bounded internal recall without making Memory Search a user-facing product.

Scope:

- Implement scoped text search over active Memories and session summaries.
- Rank by scope, keyword score, recency, and source type.
- Return at most configured counts.
- Update `lastUsedAt` for used Memories.
- Add context budget clamps.
- Defer embeddings.

Expected files:

- `services/ai-writing-agent/app/js/agent-context/ContextRecallService.js`
- `services/ai-writing-agent/app/js/agent-context/AgentContextBuilder.js`
- `services/ai-writing-agent/config/settings.defaults.cjs`
- Unit tests for ranking, scope filtering, budget, and privacy.

Acceptance:

- Recall does not return other users' Memories.
- Project-scoped Memories rank above global Memories for project tasks.
- Deleted/disabled Memories never return.
- Session summaries are returned only for authorized user's sessions.
- Builder clamps recall by token/char budget.

Verification commands:

```bash
cd services/ai-writing-agent
npm run test:unit -- --run test/unit/js/agent-context/ContextRecallServiceTests.test.js
npx eslint .
```

Commit:

```text
feat(ai-agent): add scoped context recall
```

### Milestone 9: AgentContextPanel Frontend

Objective:

Replace the old Project Rules dropdown with a single Agent Context UI.

Scope:

- Remove or stop rendering `ProjectRulesEditor`.
- Add `AgentContextPanel`.
- Add tabs/sections:
  - Instructions
  - Memories
  - Trace
- Instructions tab:
  - load/create `AGENTS.md`
  - edit Markdown
  - preview
  - save as Review draft
  - support Auto Accept
  - display pending/conflict/applied state
- Memories tab:
  - list global/project Memories
  - create/edit/delete/disable
  - accept/dismiss pending suggestions
  - recall toggle
- Trace tab:
  - show context sources for current/last turn
  - show session summary compactly
  - manual compact action if allowed
- Keep AI panel header compact with one Agent Context icon/button.

Expected files:

- `services/web/frontend/js/features/ai-assistant/components/agent-context-panel.tsx`
- `services/web/frontend/js/features/ai-assistant/components/agent-context/*`
- `services/web/frontend/js/features/ai-assistant/components/ai-assistant-pane.tsx`
- `services/web/frontend/js/features/ai-assistant/api/ai-api.ts`
- `services/web/frontend/js/features/ai-assistant/types/ai-types.ts`
- `services/web/frontend/stylesheets/pages/editor/ai-assistant.scss`
- Frontend tests if local harness supports them.

Acceptance:

- AI panel has one Agent Context entry, not separate Instructions/Memories/Session buttons.
- Existing chat send, Auto Accept toggle, and pending change UI remain usable.
- Instructions save produces visible pending change state.
- Memories CRUD works without page reload.
- Trace tab is collapsed/quiet by default and does not expose hidden prompt text.
- Text fits on mobile and desktop widths without overlapping.

Verification commands:

```bash
cd services/web
npm run type-check
npm run lint
npm run test:frontend -- --grep "ai-assistant"
```

If frontend test selection is blocked by known alias issues, run focused TypeScript/ESLint and record the blocker.

Commit:

```text
feat(web): add agent context panel
```

### Milestone 10: Multi-Agent Context Pack Integration

Objective:

Make multi-agent context packs use Project Instructions and Memories safely.

Scope:

- Rename `projectRules` context pack fields to `projectInstructions`.
- Add optional `memories` slice to context packs.
- Add `sessionSummary` and `recalledContext` refs.
- Ensure child agents receive only selected slices.
- Deny child access to `propose_memory` by default.
- Record context source refs in team/task events where useful.

Expected files:

- `services/ai-writing-agent/app/js/agent-team/AgentContextPackBuilder.js`
- `services/ai-writing-agent/app/js/agent-team/AgentTeamOrchestrator.js`
- `services/ai-writing-agent/app/js/tool/start_agent_task.js`
- `services/ai-writing-agent/app/js/tool/ToolsetPolicy.js`
- Unit tests under `test/unit/js/agent-team/`

Acceptance:

- Child context pack includes Project Instructions when policy allows.
- Child context pack includes only selected Memories, never all user Memories by default.
- Child toolset excludes memory write/propose tools.
- Existing team runtime tests pass after field rename.
- Team trace can reference context pack source counts without showing hidden prompt text.

Verification commands:

```bash
cd services/ai-writing-agent
npm run test:unit -- --run test/unit/js/agent-team test/unit/js/tool
npx eslint .
```

Commit:

```text
feat(ai-agent): scope memories in agent context packs
```

### Milestone 11: Security Hardening And Old Path Removal

Objective:

Remove old Project Rules implementation and harden the new memory/instructions path.

Scope:

- Remove old `/projects/:projectId/rules` routes.
- Remove frontend usage of `getProjectRules` / `updateProjectRules`.
- Remove `aiProjectRules` source-of-truth usage.
- Remove or replace `MemoryManager`, `MemoryProvider`, `ProjectRulesProvider`.
- Add injection/secret-looking content scanning for Project Instructions and Memories.
- Add route-level and service-level ownership tests.
- Add data migration or explicit cleanup for old `aiProjectRules` if needed.

Expected files:

- `services/ai-writing-agent/app/js/Router.js`
- `services/ai-writing-agent/app/js/AgentController.js`
- `services/ai-writing-agent/app/js/memory/*` removed or deprecated only if no import remains
- `services/web/frontend/js/features/ai-assistant/api/ai-api.ts`
- `services/web/frontend/js/features/ai-assistant/components/project-rules-editor.tsx` removed
- Security tests.

Acceptance:

- `rg "ProjectRules|project rules|/rules|aiProjectRules|MemoryManager"` shows no product path references except migration docs/tests that intentionally mention old names.
- Saving prompt-injection-looking Memories fails or marks blocked.
- Secret-looking content is rejected or blocked before prompt injection.
- No route returns another user's Memories.
- Project Instructions cannot be written without project write permission.

Verification commands:

```bash
cd services/ai-writing-agent
npm run test:unit
npx eslint .

cd ../web
npm run type-check
npm run lint

git diff --check
```

Commit:

```text
refactor(ai-agent): remove legacy project rules memory path
```

### Milestone 12: End-To-End Verification And Handoff

Objective:

Prove the new Agent Context system works in the deployed development stack with real browser behavior, live model path, writeback, privacy, reload, and multi-agent restrictions.

Scope:

- Start real develop stack.
- Start AI Writing Agent with development DeepSeek-compatible config if available.
- Use Playwright browser verification.
- Use independent verification subagents that do not edit implementation code.
- Capture screenshots/log snippets/test ids in completion evidence.

Required verification subagents:

- Deployment verifier: checks services, health, proxy, logs.
- Browser verifier: checks Agent Context UI, Instructions/Memories/Trace flow.
- Writeback verifier: checks Review and Auto Accept `AGENTS.md` CAS writeback.
- Privacy verifier: checks two users/collaborators cannot see each other's Memories.
- Live model verifier: checks a real `deepseek-v4-flash` turn uses `AGENTS.md` and Memories through deployed app path.
- Multi-agent verifier: checks child context pack memory slice and child memory-write denial.
- Regression verifier: checks old chat, pending changes, compile/fix paths, and console errors.

E2E scenarios:

1. Create project, open editor, open Agent Context.
2. Create `AGENTS.md` from Instructions tab.
3. Save in Review mode and accept pending change.
4. Edit `AGENTS.md` with Auto Accept on and verify canonical document updates immediately.
5. Add a Memory and verify the next live model turn uses it.
6. Delete/disable the Memory and verify it is no longer used.
7. Add collaborator user and verify collaborator cannot list original user's Memories.
8. Trigger compaction and verify Session Summary appears in Trace but not as a Memory.
9. Start a multi-agent task and verify child context has only allowed context.
10. Refresh browser and restart AI service; verify context state reloads.

Verification commands:

```bash
cd develop
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d

cd ../services/ai-writing-agent
npm run test:unit
npx eslint .

cd ../web
npm run type-check
npm run lint
```

Browser verification:

```bash
npx playwright test <focused-agent-context-e2e-spec>
```

If no E2E spec exists yet, create a focused manual Playwright script under the appropriate test/manual path and run it against the deployed stack.

Acceptance:

- All required verification subagents report evidence.
- Live model path uses deployed Web proxy and AI service, not a direct local script shortcut.
- `AGENTS.md` is visible in Overleaf project file tree and project history.
- Review and Auto Accept writeback both work.
- Memories are private and deleted memories are not recalled.
- Context Trace shows refs but not hidden prompts.
- Old `/rules` route is gone or returns a deliberate removed response.
- No serious browser console/runtime errors.
- No tracked secret values are added.

Commit:

```text
test(ai-agent): verify agent context end to end
```

## 7. Subagent Strategy

Use subagents for implementation and verification, but keep ownership disjoint.

Implementation subagents:

- Backend storage/API worker:
  - Owns `agent-context/*`, Mongo indexes, API routes, service tests.
- Project instructions/writeback worker:
  - Owns `ProjectInstructionService` and Live Workspace integration tests.
- Frontend worker:
  - Owns `AgentContextPanel`, API types, CSS, frontend tests.
- Agent runtime integration worker:
  - Owns `AgentContextBuilder`, AgentLoop prompt integration, context snapshots.
- Multi-agent worker:
  - Owns context pack field rename and child memory restrictions.
- Security worker:
  - Owns injection/secret scanning tests, ownership tests, old-path removal audit.

Verification subagents:

- Deployment verifier.
- Browser verifier.
- Live model verifier.
- Writeback verifier.
- Privacy verifier.
- Multi-agent verifier.
- Regression verifier.

Rules for subagents:

- They are not alone in the codebase; they must not revert unrelated edits.
- Each implementation subagent must own a disjoint write set.
- Verification subagents must not edit implementation code.
- Verification reports must include commands, URLs, project/session ids, screenshots/log paths where applicable, and pass/fail conclusions.

## 8. Test Strategy

Unit tests:

- Service validation and ownership.
- Mongo index creation.
- Project instruction path resolution.
- Draft/writeback conflict handling.
- Memory CRUD/suggestions.
- Context recall ranking and scope.
- AgentContextBuilder prompt fragments and snapshots.
- Tool policy denial for child agents.

Frontend tests:

- Agent Context button opens a single panel.
- Instructions tab create/edit/save states.
- Memories tab CRUD and suggestion accept/dismiss.
- Trace tab displays source refs without hidden prompt.
- Responsive layout does not overlap.

Integration tests:

- API route auth and permission checks.
- Project file creation and version handling.
- Live Draft Change creation and accept/reject.
- Auto Accept writeback.
- Compaction summary persistence.

E2E tests:

- Real deployed develop stack.
- Browser editor/AI panel flow.
- Live `deepseek-v4-flash` through Web proxy and AI service.
- Review and Auto Accept `AGENTS.md` writeback.
- Memory privacy across two users.
- Reload/restart recovery.
- Multi-agent child memory restrictions.

## 9. Migration And Cleanup

Clean replacement still needs explicit cleanup.

Old path cleanup checklist:

- Remove `ProjectRulesEditor`.
- Remove `getProjectRules` / `updateProjectRules`.
- Remove `/projects/:projectId/rules`.
- Remove `getProjectRules` / `updateProjectRules` controller methods.
- Remove `aiProjectRules` from active Mongo initialization after migration decision.
- Remove `MemoryManager`, `MemoryProvider`, `ProjectRulesProvider` or leave only if renamed/replaced with new services.
- Rename `projectRules` fields in team runtime to `projectInstructions`.
- Update docs that still call the feature "Project Rules".

Data migration decision:

- If existing `aiProjectRules` rows exist in dev data, provide a one-time migration command that creates `AGENTS.md` draft changes per project.
- Do not silently write project files without user/admin action.
- If migration is not needed for closed development, document that old collection is ignored and can be dropped.

## 10. Security Checklist

- Memories keyed by `userId` and never returned cross-user.
- Project Instructions require project read/write permissions.
- Agent Context APIs strip client-forged user headers through Web proxy as existing `/api/ai/*` paths do.
- Prompt-injection-looking content is blocked or marked non-injectable.
- Secret-looking content is blocked before prompt injection.
- Context Snapshot stores refs and counts, not full hidden prompts.
- `propose_memory` is root-agent only by default.
- Child agents receive selected memory slices, not full user memory.
- Deleted/disabled Memories cannot be recalled.
- Session Summary is historical context, not instruction authority.
- Context Recall uses scope filters before ranking.
- Logs and SSE events redact memory content where needed.

## 11. Final Acceptance Criteria

The migration is complete only when:

- `AGENTS.md` is the only Project Instructions source of truth.
- Agent Context UI is a single entry, not multiple panel buttons.
- Memories are private, reviewable, deletable, and suggestion-first.
- Agent turns use AgentContextBuilder with source refs.
- Context Snapshot can explain source usage without exposing hidden prompts.
- Session Summary is extracted and used for continuity.
- Context Recall works internally without becoming a user-facing feature.
- Multi-agent context packs use scoped Project Instructions and Memories.
- Old Project Rules product path is removed.
- Real browser E2E verifies Instructions, Memories, Trace, writeback, privacy, reload, live-model path, and multi-agent restrictions.
- Every milestone has a Conventional Commit with verification evidence in the commit body.

## 12. Normative Implementation Contracts

This section is part of the implementation contract. If an implementation detail below conflicts with an earlier high-level milestone description, this section wins unless the implementer records and justifies a deliberate update in the completion evidence.

### 12.1 Mongo Collections

`aiMemories`

```javascript
{
  _id: ObjectId,
  userId: string,
  projectId: string | null,
  scope: 'global' | 'project',
  content: string,
  status: 'active' | 'disabled' | 'deleted',
  source: 'manual' | 'suggestion' | 'migration',
  tags: string[],
  createdFrom: {
    sessionId: ObjectId | null,
    messageId: ObjectId | null,
    suggestionId: ObjectId | null,
  },
  createdAt: Date,
  updatedAt: Date,
  disabledAt: Date | null,
  deletedAt: Date | null,
  lastUsedAt: Date | null,
  useCount: number,
}
```

Required indexes:

```javascript
{ userId: 1, scope: 1, status: 1, updatedAt: -1 }
{ userId: 1, projectId: 1, status: 1, updatedAt: -1 }
{ userId: 1, status: 1, content: 'text', tags: 'text' }
```

`aiMemorySuggestions`

```javascript
{
  _id: ObjectId,
  userId: string,
  projectId: string | null,
  sessionId: ObjectId,
  messageId: ObjectId | null,
  proposedContent: string,
  scope: 'global' | 'project',
  reason: string,
  status: 'pending' | 'accepted' | 'dismissed' | 'expired',
  createdAt: Date,
  updatedAt: Date,
  acceptedAt: Date | null,
  dismissedAt: Date | null,
  expiresAt: Date,
  memoryId: ObjectId | null,
}
```

Required indexes:

```javascript
{ userId: 1, status: 1, createdAt: -1 }
{ sessionId: 1, status: 1, createdAt: -1 }
{ expiresAt: 1 }
```

`aiSessionSummaries`

```javascript
{
  _id: ObjectId,
  sessionId: ObjectId,
  projectId: string,
  userId: string,
  summary: string,
  sourceMessageRange: { fromSeq: number, toSeq: number },
  tokenEstimate: number,
  status: 'active' | 'superseded' | 'deleted',
  createdAt: Date,
  updatedAt: Date,
  supersededAt: Date | null,
}
```

Required indexes:

```javascript
{ sessionId: 1, status: 1, createdAt: -1 }
{ projectId: 1, userId: 1, status: 1, createdAt: -1 }
```

`aiContextSnapshots`

```javascript
{
  _id: ObjectId,
  sessionId: ObjectId,
  projectId: string,
  userId: string,
  turnId: string,
  messageId: ObjectId | null,
  sourceRefs: [
    {
      type: 'project-instructions' | 'memory' | 'session-summary' | 'recall',
      refId: string,
      path: string | null,
      scope: 'project' | 'global' | 'session',
      tokenEstimate: number,
      included: boolean,
      reason: string,
    },
  ],
  totals: {
    sourceCount: number,
    tokenEstimate: number,
    memoryCount: number,
    recalledCount: number,
  },
  createdAt: Date,
}
```

Required indexes:

```javascript
{ sessionId: 1, turnId: 1 }
{ projectId: 1, userId: 1, createdAt: -1 }
```

Snapshot rule:

- Store references, counts, scopes, token estimates, and safe reasons.
- Do not store the final system prompt, hidden prompt bodies, full `AGENTS.md` content, full memory content, API keys, cookies, access tokens, or raw model messages.

### 12.2 Agent Context APIs

All routes are served by `services/ai-writing-agent` behind the existing Web `/api/ai/*` proxy. The service must trust the server-injected user identity and reject missing identity. It must ignore client-forged user headers.

Project Instructions:

```text
GET  /projects/:projectId/agent-instructions
POST /projects/:projectId/agent-instructions/create
PUT  /projects/:projectId/agent-instructions/draft
```

`GET /projects/:projectId/agent-instructions` response:

```json
{
  "exists": true,
  "path": "AGENTS.md",
  "docId": "6a...",
  "version": 7,
  "content": "# Project Instructions\n...",
  "source": "project-file",
  "updatedAt": "2026-06-25T00:00:00.000Z"
}
```

`POST /projects/:projectId/agent-instructions/create` request:

```json
{
  "content": "# Project Instructions\n",
  "mode": "review"
}
```

`PUT /projects/:projectId/agent-instructions/draft` request:

```json
{
  "docId": "6a...",
  "baseVersion": 7,
  "content": "# Project Instructions\n...",
  "mode": "review"
}
```

`PUT` response:

```json
{
  "changeSetId": "6a...",
  "draftChangeId": "6a...",
  "status": "pending",
  "path": "AGENTS.md",
  "baseVersion": 7,
  "appliedVersion": null,
  "conflict": null
}
```

Memories:

```text
GET    /memories?projectId=<optional>&scope=<global|project|all>
POST   /memories
PATCH  /memories/:memoryId
DELETE /memories/:memoryId
GET    /memory-suggestions?projectId=<optional>&status=pending
POST   /memory-suggestions/:suggestionId/accept
POST   /memory-suggestions/:suggestionId/dismiss
```

Memory create request:

```json
{
  "content": "User prefers concise Chinese progress updates for this project.",
  "scope": "project",
  "projectId": "6a..."
}
```

Memory response:

```json
{
  "id": "6a...",
  "content": "User prefers concise Chinese progress updates for this project.",
  "scope": "project",
  "projectId": "6a...",
  "status": "active",
  "source": "manual",
  "createdAt": "2026-06-25T00:00:00.000Z",
  "updatedAt": "2026-06-25T00:00:00.000Z",
  "lastUsedAt": null,
  "useCount": 0
}
```

Trace:

```text
GET /sessions/:sessionId/context-snapshot/:turnId
GET /sessions/:sessionId/session-summary
POST /sessions/:sessionId/compact
```

Trace responses must return source refs and short summaries only. They must not return the final prompt.

### 12.3 Normalized Events

The browser should consume these product-level events from session SSE and reload APIs:

```text
agent_context.loaded
agent_context.snapshot.created
project_instructions.loaded
project_instructions.missing
project_instructions.draft_created
project_instructions.applied
project_instructions.conflict
memory.created
memory.updated
memory.disabled
memory.deleted
memory_suggestion.created
memory_suggestion.accepted
memory_suggestion.dismissed
session_summary.updated
context_recall.used
security.context_blocked
```

Payload requirements:

- Include stable ids, session id, project id, user-safe source refs, status, and timestamps.
- Include document path/version for Project Instructions events.
- Include memory ids only for Memories events visible to the current user.
- Redact full hidden prompts, secrets, cookies, raw model messages, and memory content from team/task diagnostic events unless the event is explicitly returned through the authenticated Memories UI.

### 12.4 Prompt Context Format

`AgentContextBuilder` must emit structured prompt sections with source fencing:

```text
<project_instructions source="AGENTS.md" doc_id="..." version="7">
...
</project_instructions>

<user_memories scope="project" count="2">
- ...
</user_memories>

<session_summary session_id="..." source_range="12-48">
...
</session_summary>

<recalled_context count="3" budget_chars="3000">
...
</recalled_context>
```

Rules:

- Project Instructions have instruction authority only inside their fenced section.
- Session Summary is historical context, not instruction authority.
- Memories are user preferences, not project facts.
- Recalled context is bounded and must list source type/counts in the snapshot.
- Context for a turn is frozen before the first model call. New Memories created during the turn are eligible only for later turns.

### 12.5 Feature Flags And Settings

Required config shape:

```javascript
aiAssistant: {
  agentContext: {
    enabled: false,
    projectInstructionsFile: 'AGENTS.md',
    maxInstructionChars: 40000,
    maxMemoryChars: 2000,
    maxMemoriesPerTurn: 12,
    maxRecallChars: 6000,
    suggestionTtlMs: 30 * 24 * 60 * 60 * 1000,
    blockSecretLookingContent: true,
    blockPromptInjectionLookingContent: true,
  },
}
```

Default rule:

- The flag may default off during M0-M8.
- By M12, the deployed development acceptance path must run with Agent Context enabled.

## 13. Permission, Privacy, And Policy Matrix

| Operation | Required identity | Project permission | Memory owner | Write path | Child agent default |
| --- | --- | --- | --- | --- | --- |
| Read `AGENTS.md` | user id | project read | n/a | project file read | allowed when context policy includes project instructions |
| Create `AGENTS.md` | user id | project write | n/a | Live Draft / CAS | denied |
| Edit `AGENTS.md` in Review mode | user id | project write | n/a | draft change only | denied |
| Edit `AGENTS.md` in Auto Accept | user id | project write | n/a | draft + CAS writeback | denied |
| List Memories | user id | optional project read for project scope | same `userId` | memory API | denied |
| Create Memory manually | user id | optional project read for project scope | same `userId` | memory API | denied |
| Propose Memory | root session user id | optional project read | same `userId` | suggestion API | denied |
| Accept Memory suggestion | user id | optional project read | same `userId` | suggestion -> memory | denied |
| Read Context Snapshot | user id | session project read | same session user | refs only | selected refs only |
| Start child task with context | parent session user id | project read | same `userId` | context pack | selected slices only |

Hard privacy invariants:

- User A cannot list, recall, snapshot, or infer User B's Memories on the same project.
- Project-scoped Memories remain private to the user; they are not collaborator-visible project state.
- `AGENTS.md` is collaborator-visible project state and must not contain private user Memories unless a user explicitly writes them into the project file.
- Child agents do not receive all user Memories by default. They receive only selected, policy-approved slices.

## 14. Current Legacy Path Audit

This audit reflects the current worktree at the time this plan was completed. M0 must refresh it before editing, because nearby runtime work may have changed paths.

Backend product paths to remove or replace:

- `services/ai-writing-agent/app/js/AgentController.js`
  - `getProjectRules`
  - `updateProjectRules`
  - `MemoryManager` initialization with `ProjectRulesProvider`
- `services/ai-writing-agent/app/js/Router.js`
  - `GET /projects/:projectId/rules`
  - `PUT /projects/:projectId/rules`
- `services/ai-writing-agent/app/js/agent/AgentLoop.js`
  - direct `getMemoryManager()` call and string injection of project rules
  - `snap.projectRules` compatibility hydration
  - `enriched.projectRules` forwarding into prompt context
- `services/ai-writing-agent/app/js/prompt/system.js`
  - `projectRules` prompt splice
- `services/ai-writing-agent/app/js/mongodb.js`
  - active `aiProjectRules` collection and index initialization
- `services/ai-writing-agent/app/js/memory/MemoryManager.js`
- `services/ai-writing-agent/app/js/memory/MemoryProvider.js`
- `services/ai-writing-agent/app/js/memory/ProjectRulesProvider.js`

Frontend product paths to remove or replace:

- `services/web/frontend/js/features/ai-assistant/components/project-rules-editor.tsx`
- `services/web/frontend/js/features/ai-assistant/components/ai-assistant-pane.tsx`
  - `showProjectRules`
  - `ProjectRulesEditor` import/render
- `services/web/frontend/js/features/ai-assistant/api/ai-api.ts`
  - `getProjectRules`
  - `updateProjectRules`

Multi-agent fields to rename or migrate:

- `includeProjectRules` in capability policies and `start_agent_task`.
- `projectRules` context pack fields in `AgentContextPackBuilder` outputs.
- `projectRules` persistence fields in `AgentTaskStore`.
- `projectRules` orchestration inputs in `AgentTeamOrchestrator`.
- `Project rules:` rendering in `AgentTeamChildRunner`.
- `includeProjectRules` defaults in `builtInCapabilities` and `deepReviewWorkflow`.
- Tests and fixtures under `test/unit/js/agent-team` and `test/unit/js/skill` that assert `includeProjectRules`.
- Prompt tests under `test/unit/js/prompt` that assert the old `projectRules` section.
- Memory tests under `test/unit/js/memory` that cover `MemoryManager` and `ProjectRulesProvider`; delete or replace them with `agent-context` tests when the old implementation is removed.

Allowed remaining references after M11:

- Historical docs and migration tests may mention `Project Rules`, `/rules`, or `aiProjectRules` only when explicitly asserting old-path removal or migration behavior.
- No product route, UI control, prompt builder, or model-visible field may depend on the old names.

## 15. Completion Audit Template

Before marking this goal complete, run a requirement-by-requirement audit and paste a concise result into the M12 evidence.

Use this format:

```text
Completion audit:
- Project Instructions source of truth: proven by <file/API/browser/history evidence>.
- Review writeback: proven by <draft id/change set/browser evidence>.
- Auto Accept writeback: proven by <doc id/version/apply operation evidence>.
- Memories privacy: proven by <two-user API/browser evidence>.
- Memory suggestion flow: proven by <suggestion id/accept/dismiss evidence>.
- AgentContextBuilder prompt path: proven by <unit/live model/snapshot evidence>.
- Session Summary: proven by <summary id/compaction evidence>.
- Context Recall: proven by <ranking/privacy/budget tests>.
- Multi-agent restrictions: proven by <context pack/tool denial evidence>.
- Trace redaction: proven by <snapshot/UI evidence>.
- Old path removal: proven by <rg output and route behavior>.
- Full regression: proven by <AI/Web commands>.
- Browser/live model/deploy: proven by <URLs/project ids/screenshots/logs>.
- Secrets check: proven by <scan command and result>.
```

Do not use a broad green test suite as proof for a specific requirement unless the test name and assertion directly cover that requirement.

## 16. One-Shot Goal Prompt

```text
/goal Implement the Agent Memory architecture described in services/ai-writing-agent/doc/agent-memory-development-plan.md. Continue through every milestone until the Final Acceptance Criteria and Completion Audit are satisfied. Treat this as a clean replacement: do not preserve /projects/:projectId/rules, aiProjectRules, ProjectRulesEditor, ProjectRulesProvider, or string-concatenating MemoryManager as product paths. Use implementation subagents for storage/API, project instructions/writeback, frontend Agent Context UI, AgentContextBuilder/runtime integration, multi-agent context packs, and security hardening. Use independent verification subagents for deployment, browser E2E, live-model, AGENTS.md writeback, memory privacy, reload/compaction, multi-agent restrictions, old-path removal, and cleanup checks. Do not stop after unit/lint/type checks. Do not mark a milestone complete without deployed browser/live-model/writeback/privacy evidence where behavior changes. Commit after every completed milestone using Conventional Commits with motivation, main changes, validation commands, E2E/security evidence, and skipped-check reasons. Keep Project Instructions file-backed in AGENTS.md, keep Memories private to userId, keep Session Summary internal, expose one Agent Context UI entry, and never commit secrets or raw hidden prompts.
```
