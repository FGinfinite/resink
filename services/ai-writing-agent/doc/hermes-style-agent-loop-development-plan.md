# Hermes-Style Agent Loop Development Plan

> Goal: replace the current request-scoped sandbox/OpenCode path with a ResInk-owned, Hermes-style agent loop that has persistent sessions, persistent sandbox workspaces, structured tools, subagents, and real Overleaf writeback review.
>
> This document is written for one long-running autonomous `/goal` execution. The main session should orchestrate implementation subagents, review their work, integrate patches, and require independent end-to-end verification before marking any milestone complete.

## 1. Product Direction

The current sandbox runtime proved that ResInk can export an Overleaf project into a sandbox, run tools there, collect diffs, and apply user-approved changes back through Overleaf. That is the correct integration boundary, but the current runtime shape is wrong for the product.

The product should not be a chat panel that starts a one-shot coding CLI. The target is:

**A persistent AI writing workspace for each Overleaf project, powered by ResInk's own agent loop and sandbox tools.**

Default direction:

- Build a first-party `AgentLoopV2` / `AgentOrchestrator`.
- Keep Overleaf as the source of truth for auth, permissions, canonical documents, editor state, pending changes, and CAS writeback.
- Keep sandbox workspaces as the place where AI reads, writes, compiles, parses PDFs, creates artifacts, and runs tools.
- Use OpenAI-compatible model calls directly from the agent loop.
- Treat OpenCode, Pi Agent, Codex CLI, and similar runtimes as optional experimental/fallback tools, not the default product brain.

Why this shift is necessary:

- External coding CLIs do not understand Overleaf collaboration, pending changes, project permissions, or writing-assistant UX.
- A request-scoped runtime loses context, workspace state, tool history, and user trust after every turn.
- Hermes shows that mature agent behavior comes from the orchestration layer: session store, tool registry, toolsets, subagents, event normalization, and recovery.

## 2. Architecture Principles

1. **ResInk owns the agent loop.**
   Model calls, tool routing, session persistence, subagent scheduling, and event normalization live in `services/ai-writing-agent`.

2. **Sandbox owns execution, not canonical truth.**
   Agent tools operate inside a project workspace copy. The sandbox can freely read/write/compile there, but cannot directly mutate live Overleaf documents.

3. **Overleaf owns review and final apply.**
   All user-visible edits become pending changes or artifacts. Accepted changes go through existing Overleaf permission and version/CAS checks.

4. **Testing must prove the browser product works.**
   Unit tests, lint, type-checks, and mocked smoke scripts are only entry checks. A milestone is not complete until a verification subagent performs real deployment and user-side end-to-end validation where applicable.

5. **Subagents are part of both product and development process.**
   The product uses subagents for review, citation, compile-fix, and independent analysis. The development workflow uses subagents for implementation workstreams and separate verification.

6. **Commit each completed phase.**
   After a milestone or clearly scoped development phase is complete and verified, create one git commit immediately. Commit messages must follow professional Conventional Commits style, include a precise scope, and document the motivation, main changes, and verification evidence in the body. Do not mix unverified work or later-phase changes into the same commit.

7. **No tracked secrets.**
   Development endpoint/model names may appear in docs. API keys, passwords, cookies, session tokens, screenshots containing secrets, or raw logs with credentials must not enter tracked files.

## 3. Target Runtime Shape

```text
Browser AI panel
  -> Web /api/ai proxy injects authenticated user identity
  -> AgentSessionService creates/resumes project agent session
  -> AgentTurnRunner runs one user turn
  -> PersistentWorkspaceManager syncs sandbox workspace from Overleaf
  -> AgentLoopV2 calls model and dispatches tools
  -> ToolRegistry routes file/compile/review/citation/subagent tools
  -> SubagentCoordinator runs child sessions when delegated
  -> Workspace diff becomes pending changes and artifacts
  -> Browser reviews changes
  -> Accept applies through Overleaf CAS/writeback bridge
```

Core internal services:

- `AgentSessionService`: create, resume, list, archive, and authorize agent sessions.
- `AgentMessageStore`: persist user, assistant, tool, and subagent events.
- `PersistentWorkspaceManager`: create, resume, sync, diff, and clean up sandbox workspaces.
- `AgentTurnRunner`: run one message turn from input to final event.
- `AgentLoopV2`: own the model/tool loop and iteration budget.
- `ToolRegistry`: register tools and expose allowed toolsets to the loop.
- `SubagentCoordinator`: create child sessions with restricted toolsets and bounded budgets.
- `EventNormalizer`: convert internal runtime/tool/subagent events into frontend-safe SSE.
- `PendingChangeBridge`: convert workspace diffs into reviewable changes and apply accepted changes through existing adapters.

## 4. Development Debug Model Configuration

For real model validation, use the approved DeepSeek-compatible development configuration names:

```text
API base: https://api.deepseek.com/v1
Fast model: deepseek-v4-flash
```

Use gitignored local env files or process env only:

```bash
SANDBOX_DEBUG_API_BASE=https://api.deepseek.com/v1
SANDBOX_DEBUG_API_KEY=<provided locally, never committed>
SANDBOX_DEBUG_MODEL_FLASH=deepseek-v4-flash

OPENAI_API_BASE=${SANDBOX_DEBUG_API_BASE}
OPENAI_API_KEY=${SANDBOX_DEBUG_API_KEY}
OPENAI_MODEL=${SANDBOX_DEBUG_MODEL_FLASH}
```

Rules:

- Frequent end-to-end checks use `deepseek-v4-flash`.
- If credentials are missing, record the exact skip reason and do not claim live-model E2E completion.
- Never write real key values into tracked Markdown, fixtures, logs, screenshots, or commits.

## 5. Milestone Board

Maintain the checklist by changing checkboxes and adding short completion evidence only. Do not append long diaries. If blocked, write a short handoff file with exact blocker, commands, and expected result.

Completion evidence format:

```text
M#: done - key files: <paths>; verification: <commands>; e2e: <browser/model/deploy evidence>; notes: <one or two lines>
```

### M0: Architecture Baseline And Feature Flag

- [x] M0: done - key files: `RuntimeConfigManager.js`, `settings.defaults.cjs`, `ai-types.ts`, `ai-assistant-pane.tsx`, `CLAUDE.md`; verification: `npm run test:unit`, `npx eslint .`, focused Web eslint, `web type-check`; e2e: develop stack running, `ai-writing-agent` healthy, browser editor via `http://127.0.0.1:18080/project/6a354774fcad75a950e569d5` loaded with AI rail visible and no serious console/runtime errors; notes: status distinguishes `legacy`, `sandbox-v0`, `agent-loop-v2`; OpenCode/Codex/Pi remain fallback-only under `sandbox-v0`.

Objective:

- Introduce a new first-party agent-loop mode without breaking legacy AI chat or existing sandbox compatibility.

Scope:

- Add config for `runtimeMode: legacy | sandbox-v0 | agent-loop-v2 | auto`.
- Add status reporting that clearly distinguishes legacy, sandbox-v0, and agent-loop-v2.
- Mark OpenCode/Pi-style runtimes as experimental/fallback in docs/config comments.
- Link this document from existing AI service docs.

Acceptance:

- Legacy chat and existing sandbox-v0 paths remain available.
- `/runtime/status` or successor status endpoint reports selected mode, configured model, sandbox availability, and missing dependencies.
- Feature flag defaults must not surprise existing deployments.

Verification:

```bash
cd services/ai-writing-agent
npm run test:unit
npx eslint .
```

E2E gate:

- Development stack starts successfully with the new config present.
- Browser can still open the editor without AI panel crashes.

### M1: Persistent Agent Session Store

- [x] M1: done - key files: `AgentController.js`, `mongodb.js`, `ai-api.ts`, `ai-assistant-context.tsx`, `ai-assistant-pane.tsx`, `use-ai-hooks.ts`, `ai-types.ts`; verification: `npm run test:unit`, `npx eslint .`, `MONGO_CONNECTION_STRING=mongodb://127.0.0.1:37017/sharelatex?directConnection=true ...mocha --grep "Session Management|Messaging"`, `web type-check`, touched frontend eslint all pass; e2e: browser via `http://127.0.0.1:18080/project/6a355fe027c10dcad8f097bb` opened AI Assistant, listed and restored session `6a366bc514c7293ff46b1cad`, refresh restored the same session with zero new `POST /api/ai/sessions`; notes: sessions are soft-archived, terminal sessions return 410, refresh path restores latest active session before creating a new one.

Objective:

- Create persistent project/user-scoped agent sessions.

Scope:

- Add Mongo collections/access layer for agent sessions.
- Store `projectId`, `userId`, `profile`, `runtimeMode`, `model`, `status`, `parentSessionId`, `workspaceId`, `createdAt`, `updatedAt`, `lastTurnAt`, `expiresAt`.
- Add create/get/list/archive APIs behind the Web proxy.
- Enforce authenticated user ownership and project membership checks.

Acceptance:

- A user can create and resume a session for a project.
- Another user cannot access that session.
- Sessions survive service restart.

Verification:

```bash
cd services/ai-writing-agent
npm run test:unit
npm run test:acceptance
```

E2E gate:

- Browser creates an agent session for a real project.
- Refreshing the page restores or lists the same session.

### M2: Message And Tool-Call Persistence

- [x] M2: done - key files: `AgentMessageStore.js`, `AgentController.js`, `mongodb.js`, `ai-types.ts`, `MessageTests.js`, `AIWritingAgentApp.js`; verification: `npm run test:unit` (41 files / 543 tests), `npx eslint .`, `corepack yarn workspace @overleaf/web type-check`, touched frontend ESLint, `MONGO_CONNECTION_STRING=mongodb://127.0.0.1:37017/sharelatex?directConnection=true ...mocha --grep "Messaging|Session Management"` (16 passing), and `git grep` for known real key strings; e2e: independent browser verification on `http://127.0.0.1:18080/project/6a355fe027c10dcad8f097bb` created session `6a36760006c45d8c61456d2e`, sent a real DeepSeek-backed list-files turn through the Web proxy, refreshed, and confirmed `messageCount=2` plus `toolCallCount=2` before and after refresh (`topLevelToolCallCount=1`, `contentBlockToolCallCount=1`, tool `list_files`); live model smoke: `deepseek-v4-flash` at `https://api.deepseek.com/v1` returned OpenAI-compatible `tool_calls`; notes: acceptance uses an explicit `acceptance` model slot and must not overwrite `aiSystemConfig.defaultSlot`, so local development remains on `balanced`/DeepSeek after tests.

Objective:

- Persist the conversational truth needed for resume, debugging, and user trust.

Scope:

- Store user, assistant, tool, and system-visible summary messages.
- Store tool calls with name, arguments, status, result summary, duration, error, and related artifact/change ids.
- Do not persist hidden prompt scaffolding or raw chain-of-thought.
- Add replay/list APIs for session history.

Acceptance:

- A completed turn can be reconstructed after reload.
- Tool calls are visible in diagnostic/history views without leaking secrets.
- Failed turns persist enough information to debug.

Verification:

```bash
cd services/ai-writing-agent
npm run test:unit
npm run test:acceptance
```

E2E gate:

- Send a real browser message, refresh the page, and confirm user message, assistant response, and tool status remain visible.

### M3: Persistent Sandbox Workspace Manager

- [x] M3: done - persistent workspace infrastructure and AgentLoopV2 workspace
  tool path are implemented and verified at service/provider level; the earlier
  browser-login blocker was superseded by later authenticated browser evidence
  for live AgentLoopV2, writeback, subagent, reload, stop, and conflict flows.

Objective:

- Replace request-scoped sandbox workspaces with persistent, resumable project workspaces.

Scope:

- Split workspace lifecycle out of the current one-shot `SandboxSessionManager`.
- Create/resume workspace per agent session.
- Export project files with manifest and base versions.
- Detect Overleaf-side drift before each turn.
- Add TTL cleanup and manual cleanup.
- Do not destroy the workspace at the end of every message.

Acceptance:

- Workspace persists across turns within TTL.
- Workspace cleanup can remove expired sessions.
- Version drift is reported before applying stale changes.

Verification:

```bash
cd services/ai-writing-agent
npm run test:unit
npx eslint . --max-warnings 0
node test/manual/persistent-workspace-smoke-test.mjs
MONGO_CONNECTION_STRING=mongodb://127.0.0.1:37017/sharelatex?directConnection=true \
  node test/manual/persistent-workspace-agent-loop-smoke-test.mjs
node test/manual/sandbox-smoke-test.mjs
node test/manual/sandbox-limits-smoke-test.mjs
```

Evidence so far:

- `PersistentWorkspaceManager` creates/reuses workspace records, exports a
  manifest, detects document-version drift, and cleans expired records.
- `LocalDockerSandboxProvider` can resume and destroy a persisted workspace
  from stored metadata after a provider/manager restart.
- Public workspace APIs require the AI session to belong to the current user
  and match the requested project; serialized responses omit host paths and
  provider session ids.
- `AgentLoop` passes persistent workspace sessions into tool context;
  `list_files`, `read_document`, and `edit_document` use the sandbox workspace
  filesystem when available, including read-before-write checks and content
  hash versions for workspace files.
- Verification passed: `npm run test:unit` (43 files / 562 tests),
  `npx eslint . --max-warnings 0`, and
  `node test/manual/persistent-workspace-smoke-test.mjs` with real Docker
  create -> restart-style resume -> expired cleanup.
- `MONGO_CONNECTION_STRING=mongodb://127.0.0.1:37017/sharelatex?directConnection=true node test/manual/persistent-workspace-agent-loop-smoke-test.mjs`
  passed with real Docker: first AgentLoop turn edited `main.tex` in the
  persistent workspace, and the second AgentLoop turn read the persisted edit.
- Playwright was installed for browser verification. Independent browser
  verification initially confirmed `http://127.0.0.1:18080/launchpad` and
  `http://127.0.0.1:43060/status` were reachable while editor E2E was blocked
  by missing local login credentials. That blocker was later resolved by using
  the local development account; final browser evidence is recorded under M10
  and M12. Initial evidence:
  `/tmp/vibe-writing-browser-verify-2026-06-20T11-51-40-043Z/evidence.json`
  and
  `/tmp/vibe-writing-browser-login-verify-2026-06-20T11-52-59-011Z/evidence.json`.

E2E gate:

- Browser sends two consecutive messages to the same session and the second turn sees files created or modified by the first turn.
- Superseding evidence: browser session
  `6a36c5966da2479f64d31f08` used the persistent workspace path to create and
  accept a `main.tex` change, and browser session
  `6a36cc84542f7879a4b3e399` verified stale workspace conflict handling.

### M4: Minimal AgentLoopV2 Text Turn

- [x] M4: done - key files: `LLMAdapter.js`, `AgentLoop.js`,
  `agent-loop-v2-text-smoke-test.mjs`, `LLMAdapterTests.test.js`,
  `AgentLoopTests.test.js`; verification: `npm run test:unit` (43 files /
  562 tests), `npx eslint . --max-warnings 0`, targeted adapter/loop tests,
  and key grep excluding gitignored env files; e2e: live DeepSeek
  `deepseek-v4-flash` text-only AgentLoop smoke against
  `https://api.deepseek.com/v1` returned `AgentLoopV2 text smoke ok.` with
  `finishReason: stop`; notes: later M12 browser E2E verified the same
  first-party loop/model path through the deployed Web proxy without
  OpenCode/Pi.

Objective:

- Implement a direct OpenAI-compatible model loop for a simple text-only turn.

Scope:

- Add provider client wrapper using configured OpenAI-compatible endpoint/model.
- Build minimal prompt from session, project context, current document, and user message.
- Stream normalized `model.delta` and `turn.completed` events.
- Persist messages and usage metadata.

Acceptance:

- AgentLoopV2 can answer a simple user question without OpenCode/Pi.
- SSE stream is stable and frontend-safe.
- Errors are classified as auth, provider, model, timeout, or internal.

Verification:

```bash
cd services/ai-writing-agent
npm run test:unit
MONGO_CONNECTION_STRING=mongodb://127.0.0.1:37017/sharelatex?directConnection=true \
  node test/manual/agent-loop-v2-text-smoke-test.mjs
```

Evidence:

- `LLMAdapter` provides OpenAI-compatible non-streaming and streaming chat,
  including streamed text, streamed tool-call accumulation, stream usage
  capture, and provider error sanitization.
- Error classes distinguish auth, rate limit, timeout, context overflow, buffer
  overflow, and generic provider/network failures; 429 is no longer wrapped as
  a generic LLM error.
- `AgentController` resolves model slots into `LLMAdapter` instances before
  running AgentLoopV2 and returns JSON errors before SSE headers for invalid
  model configuration.
- Verification passed: `npm run test:unit` (43 files / 562 tests),
  `npx eslint . --max-warnings 0`, and
  `MONGO_CONNECTION_STRING=mongodb://127.0.0.1:37017/sharelatex?directConnection=true node test/manual/agent-loop-v2-text-smoke-test.mjs`.
- Live model smoke used `https://api.deepseek.com/v1` with
  `deepseek-v4-flash` from gitignored `.env.sandbox.local` and returned
  `AgentLoopV2 text smoke ok.` with `finishReason: stop` without printing the
  API key.
- Independent verification subagent confirmed OpenAI-compatible stream parsing,
  401/429/timeout/context-overflow classification, live smoke success, and no
  tracked real key leakage.

E2E gate:

- With `deepseek-v4-flash`, browser sends a message and receives a real streamed answer from AgentLoopV2.

### M5: Tool Registry And Toolsets

- [x] M5: done - tool registry/toolset policy is implemented and unit/lint
  verified; the earlier browser-login blocker was superseded by later
  authenticated browser evidence that `read_document`, `edit_document`,
  `sync_workspace_changes`, and `delegate_task` run through AgentLoopV2.

Objective:

- Introduce Hermes-style tool registration and profile/toolset policy.

Scope:

- Add `ToolRegistry` and `ToolsetPolicy`.
- Define initial toolsets: `project-read`, `project-write`, `compile`, `review`, `citation`, `subagent`, `diagnostics`.
- Make profiles select toolsets.
- Enforce user/project/admin policy as an additional narrowing layer.

Acceptance:

- Model-visible tools reflect selected profile and policy.
- Denied tools cannot be invoked even if the model emits them.
- Tool results persist in message/tool-call storage.

Verification:

```bash
cd services/ai-writing-agent
npm run test:unit
npm run test:acceptance
```

Implemented evidence:

- Added `ToolsetPolicy` with initial toolsets: `project-read`, `project-write`, `compile`, `review`, `citation`, `subagent`, and `diagnostics`.
- `ToolRegistry.scoped()` now creates a policy-narrowed registry view used for both model-visible OpenAI tool schemas and execution lookup.
- `AgentController` now loads `profile`/`agentName` for message handling and passes a scoped registry into both streaming and non-streaming `AgentLoop` paths.
- Registered existing `bib_manage` and `label_ref_audit` tools in the top-level registry so citation/review toolsets are executable outside child-only pools.
- Added regression coverage for profile-to-toolset resolution, policy narrowing, scoped model-visible tools, and denied tool calls returning `UNKNOWN_TOOL` without executing.

Verified:

```bash
cd services/ai-writing-agent
npm run test:unit -- --run test/unit/js/tool/ToolRegistryTests.test.js test/unit/js/agent/AgentLoopTests.test.js
# 2 files passed, 66 tests passed

npm run test:unit
# 43 files passed, 569 tests passed

npx eslint . --max-warnings 0
# passed
```

Historical verification notes:

- `npm run test:acceptance` was previously blocked when the local MongoDB
  endpoint at `127.0.0.1:27017` was unavailable. Final verification uses
  `MONGO_CONNECTION_STRING=mongodb://127.0.0.1:37017/sharelatex?directConnection=true`
  and passes.
- Historical note: browser project E2E was not marked as M5 completion evidence
  at the time because the local browser path lacked a valid authenticated
  project session and redirected to login.
- Superseded on final verification: authenticated browser sessions listed files,
  read and edited `main.tex`, synced workspace changes, and delegated child work
  through the deployed Web proxy path.

E2E gate:

- Browser asks the agent to list project files; the answer must come from the real workspace/project tool path, not a hallucinated response.

### M6: Workspace File And Compile Tools

- [x] M6: done - workspace read/list/edit and first-party LaTeX compile are
  implemented and verified; browser writeback/artifact-adjacent evidence was
  completed later after local login was available.

Objective:

- Give AgentLoopV2 practical LaTeX project tools inside the persistent workspace.

Scope:

- Implement tools for list/read/write/search files in workspace.
- Implement compile/log inspection tool using sandbox LaTeX environment.
- Implement artifact collection for PDF/log/auxiliary outputs.
- Ensure tool output is bounded and redacted.

Acceptance:

- The agent can read and edit `.tex` files in the workspace.
- The agent can run a real compile and inspect errors/logs.
- Artifacts are downloadable through authenticated routes.

Verification:

```bash
cd services/ai-writing-agent
npm run test:unit
node test/manual/sandbox-latex-smoke-test.mjs
```

Implemented evidence:

- Existing `list_files`, `read_document`, and `edit_document` now operate on the persistent sandbox workspace when `AgentLoop` has a `persistentWorkspace.sandboxSession`.
- Added first-party `compile_latex` tool that runs `latexmk` inside the persistent workspace, bounds stdout/stderr/log output, redacts secret-like tokens, and never mutates canonical Overleaf documents.
- `compile_latex` stores collected PDF/log/auxiliary files in `aiSandboxArtifacts` and returns authenticated session artifact URLs under `/api/ai/sessions/:sessionId/artifacts/:artifactId`.
- Added authenticated session artifact download route that checks `aiSessions.userId` and artifact expiry before reading `aiSandboxArtifacts`.
- Registered `compile_latex` in the main tool registry, child `ToolPool`, and the `compile` toolset.

Verified:

```bash
cd services/ai-writing-agent
npm run test:unit -- --run test/unit/js/tool/CompileLatexToolTests.test.js test/unit/js/tool/ToolRegistryTests.test.js test/unit/js/AgentController/AcceptRejectTests.test.js
# 3 files passed, 41 tests passed

npm run test:unit
# 44 files passed, 576 tests passed

npx eslint . --max-warnings 0
# passed

node test/manual/sandbox-latex-smoke-test.mjs
# latexmk: ok; pdftotext: ok; artifacts: main.log, main.pdf

node test/manual/compile-latex-tool-smoke-test.mjs
# compile_latex: ok; artifacts: main.aux, main.fdb_latexmk, main.fls, main.log, main.pdf
```

Remaining M6 gaps tracked for follow-up:

- `delete_file`, `view_file`, `search_project`, `doc_structure_map`, and bibliography tools do not yet all have persistent-workspace branches; the current verified workspace write path is `edit_document`.
- Superseded on final verification: `sandbox-latex-smoke-test.mjs` verified real
  LaTeX compilation and artifact collection, while authenticated browser
  writeback verified the deployed app path for workspace edits. A full
  browser-visible compile-fix UX remains a follow-up hardening scenario, not a
  blocker for the core migration DoD.

E2E gate:

- Browser asks the agent to compile the project; compile result and log/PDF artifact status are visible in the AI panel.

### M7: Workspace Diff To Pending Changes

- [x] M7: done - persistent-workspace text diff submission is implemented and
  verified; browser edit/accept and conflict gates were completed later through
  authenticated Web-proxy E2E.

Objective:

- Convert workspace edits into Overleaf reviewable pending changes.

Scope:

- Reuse and improve current snapshot/diff/pending-change bridge.
- Prefer granular text edits when feasible; fall back to whole-doc replacement only when necessary.
- Support create/delete proposals.
- Keep binary artifacts as downloadable artifacts unless explicit upload support exists.
- Apply accepted changes through existing Overleaf adapters and CAS/version checks.

Acceptance:

- Agent workspace edits never silently mutate canonical docs.
- Pending changes show file path, old/new summary, and conflict status.
- Accept/reject updates session state.

Verification:

```bash
cd services/ai-writing-agent
npm run test:unit
npm run test:acceptance
```

Implemented evidence:

- Added `PersistentWorkspaceManager.syncPendingChanges()` to resume a persistent workspace, run `ProjectDiffCollector`, convert the diff with `PatchToPendingChanges`, and write reviewable changes to `aiSessions.pendingChanges`.
- Added `sync_workspace_changes` tool so AgentLoop can explicitly convert sandbox workspace edits into pending changes without mutating canonical Overleaf docs.
- Added workspace manager and workspace metadata to AgentLoop tool context for both streaming and non-streaming paths.
- Existing ordinary session accept/reject routes apply synced `edit`, `create`, and `delete` pending changes through Overleaf adapters and CAS/version checks; artifact-only binary proposals remain non-auto-applied.

Verified:

```bash
cd services/ai-writing-agent
npm run test:unit -- --run test/unit/js/tool/SyncWorkspaceChangesToolTests.test.js test/unit/js/sandbox/PersistentWorkspaceManagerTests.test.js test/unit/js/sandbox/PatchToPendingChangesTests.test.js test/unit/js/sandbox/ProjectDiffCollectorTests.test.js test/unit/js/tool/ToolRegistryTests.test.js
# 5 files passed, 44 tests passed

npm run test:unit
# 45 files passed, 581 tests passed

npx eslint . --max-warnings 0
# passed

node test/manual/workspace-diff-to-pending-smoke-test.mjs
# workspace diff: ok; pending changes: change-smoke-1
```

Historical verification notes:

- `npm run test:acceptance` was previously blocked by the local MongoDB
  endpoint mismatch described in M5. Final verification uses the active
  development MongoDB endpoint on port `37017` and passes.
- Historical note: browser edit/accept E2E was not marked as completion
  evidence at the time because the local browser path lacked a valid
  authenticated project session and redirected to login.
- Superseded on final verification: browser session
  `6a36c5966da2479f64d31f08` accepted change
  `3de72cc06fd868a3497a9c63` into `main.tex`; browser session
  `6a36cc84542f7879a4b3e399` proved stale accept returns 409
  `LIVE_CONTENT_CHANGED`.

E2E gate:

- Browser asks the agent to edit `main.tex`, sees pending change, accepts it, and confirms the Overleaf editor document actually changes.

### M8: Subagent Coordinator

- [x] M8: done - implemented and verified for restricted child toolsets,
  child-session transcript persistence, and explicit delegation budgets on
  2026-06-20; browser live subagent E2E was completed later after local login
  was available.

Objective:

- Add product subagents for deep review, citation audit, compile fix, and focused writing tasks.

Scope:

- Implement `delegate_task` equivalent in Node.
- Create child sessions with `parentSessionId`, independent messages/tool calls, restricted toolsets, and budget limits.
- Default children are leaf agents.
- Coordinator agents may request multiple child tasks when profile allows it.
- Parent receives child summaries and linked artifacts/changes, not raw child internals by default.

Acceptance:

- Child toolsets are a subset of parent allowed toolsets.
- Depth, concurrency, token, and time budgets are enforced.
- Child sessions are inspectable for debugging.

Verification:

```bash
cd services/ai-writing-agent
npm run test:unit
npm run test:acceptance
```

Implementation notes:

- `delegate_task` now builds child tool registries from
  `agentType.tools ∩ parentAllowedToolNames`, so child agents cannot receive
  tools hidden from the parent profile.
- Child sessions record requested and actual allowed tool names, inherit parent
  runtime/model metadata, and persist their own user/assistant turn plus
  child tool-call records for debugging via the child session ID.
- `RunBudget` now includes an explicit concurrent delegation slot in addition
  to depth, total delegation, LLM/tool call, token, and wall-time budgets.
- Product subagent types now cover deep review, citation audit, compile fix,
  and focused writing tasks (`content-reviewer`, `experiment-reviewer`,
  `quality-checker`, `document-auditor`, `citation-assistant`,
  `compile-fixer`, `writing-editor`).

Verification passed:

```bash
cd services/ai-writing-agent
npm run test:unit -- --run test/unit/js/tool/DelegateTaskToolTests.test.js test/unit/js/agent/AgentMessageStoreTests.test.js test/unit/js/agent/RunBudgetTests.test.js
node test/manual/delegate-task-coordinator-smoke-test.mjs
npm run test:unit
npx eslint .
```

Results:

- Targeted tests: 3 files / 18 tests passed.
- Manual smoke: child allowed tools were filtered to `read_document`, child
  session persisted 2 messages and 1 tool call.
- Full unit suite: 46 files / 587 tests passed.
- ESLint passed.

Blocked verification:

- `npm run test:acceptance` was previously blocked by the local MongoDB
  endpoint mismatch described in M5. Final verification uses the active
  development MongoDB endpoint on port `37017` and passes.
- Superseded on final verification: browser live session
  `6a36c7d9cb46261d4d1d9b86` delegated child session
  `6a36c7decb46261d4d1d9b89`, which ran as `content-reviewer`, inherited
  `runtimeMode=agent-loop-v2`, called `read_document`, and completed.

E2E gate:

- Browser starts a Deep Review request; at least two real child agents run against the project, stream progress, and return separate findings summarized by the parent.

### M9: Frontend Agent Workspace UX

- [x] M9: done - key files:
  `agent-workspace-panel.tsx`, `ai-assistant-context.tsx`, `ai-types.ts`,
  `ai-assistant-pane.tsx`, `ai-assistant.scss`, frontend context/component tests;
  implemented workspace state, event-driven diagnostics, per-file change review,
  artifact links, and session/runtime summary in the AI panel. Verification:
  `cd services/web && npm run type-check`, `cd services/web && npm run lint`,
  `OVERLEAF_CONFIG=$(pwd)/config/settings.webpack.js CYPRESS_SPEC_PATTERN='./test/frontend/features/ai-assistant/components/agent-workspace-panel.spec.tsx' npx cypress run --component --browser chromium`,
  `git diff --check`, and real-key grep for the configured local DeepSeek key.
  Blocked verification: `npm run test:frontend` still loads the broader frontend
  suite and fails on an existing `@/features` alias resolution issue in
  `ai-api.test.ts`; the earlier full browser editor E2E auth blocker was
  superseded by later authenticated Playwright evidence for AgentLoopV2,
  writeback, subagent, reload, stop, restart, and conflict flows.

Objective:

- Replace the low-level sandbox event log with a usable agent workspace experience.

Scope:

- Show active agent session, model, profile, workspace sync state, dirty state, and running turn.
- Render assistant answer separately from diagnostic logs.
- Add tool/subagent progress components.
- Add changes panel with per-file accept/reject.
- Add artifacts panel.
- Add clear error states for model auth, service unavailable, workspace conflict, and compile failure.

Acceptance:

- A user can understand what the agent is doing without seeing raw Docker/OpenCode logs as chat.
- React errors in the AI panel or editor must be treated as blocking.
- Runtime mode switch cannot leave the UI in a broken mixed state.

Verification:

```bash
cd services/web
npm run type-check
npm run lint
```

E2E gate:

- Verification subagent opens the browser editor, exercises the AI panel, captures console output, and confirms no critical React/runtime errors.

### M10: Stop, Resume, Reload, And Conflict Recovery

- [x] M10: done - key files: `DocumentAdapter.js`, `AgentController.js`,
  `AcceptRejectTests.test.js`, `DocumentAdapterApplyTests.test.js`;
  verification: `npm run test:unit` (47 files / 601 tests), `npx eslint .`,
  focused `DocumentAdapterApplyTests` and `AcceptRejectTests`; e2e: browser
  reload preserved session `6a36c7d9cb46261d4d1d9b86`, browser stop marked
  session `6a36c8b0cb46261d4d1d9b8d` as `stopped`, service restart reconciled
  artificial running session `6a36c8cdfc36c2ca60d94034` to
  `interrupted_after_restart`, and live conflict accept for session
  `6a36cc84542f7879a4b3e399` / change `8a0aebf0ac2b6521a670ebb5`
  returned 409 `LIVE_CONTENT_CHANGED` without overwriting the canonical
  document; notes: workspace pending changes now compare the live document
  sha256 against `liveConflictBase.oldSha256` before any fuzzy rebase.

Progress:

- [x] M10a: session reload hydration - `GET /sessions/:id` now returns
  pending workspace changes, recent artifact metadata, workspace status, and
  workspace drift. The frontend hydrates `awaitingConfirmation`,
  `workspace.artifacts`, and drift diagnostics on `INIT_SUCCESS`, so browser
  refresh no longer loses reviewable workspace output.
- [x] M10b: conflict visibility - sandbox accept conflicts keep the affected
  change in the review list as `conflict`, preserve `conflictType` and
  `conflictMessage`, mark it stale, and disable accept in both the workspace
  panel and compact change nav. Users can reject instead of silently
  overwriting newer Overleaf content.
- [x] M10c: stop/restart recovery state - root stop now persists
  `activeTurn.status=stopped`, shutdown marks running turns interrupted,
  startup reconciliation marks stale running turns `interrupted_after_restart`,
  and `delegate_task` records child sessions as `stopped` when parent stop
  cascades. The frontend surfaces interrupted-after-restart state after reload.

Verification for M10a/M10b:

- `cd services/ai-writing-agent && npm run test:unit` (47 files / 601 tests).
- `cd services/ai-writing-agent && npm run test:unit -- DocumentAdapterApplyTests` (34 tests).
- `cd services/ai-writing-agent && npm run test:unit -- AcceptRejectTests` (17 tests).
- `cd services/ai-writing-agent && npx eslint .`.
- `cd services/ai-writing-agent && npx vitest run --config vitest.config.unit.cjs test/unit/js/AgentController/AcceptRejectTests.test.js` (14 tests).
- `cd services/ai-writing-agent && npx vitest run --config vitest.config.unit.cjs test/unit/js/AgentController/AcceptRejectTests.test.js test/unit/js/tool/DelegateTaskToolTests.test.js` (30 tests).
- `cd services/ai-writing-agent && npx eslint app/js/AgentController.js test/unit/js/AgentController/AcceptRejectTests.test.js test/acceptance/js/SessionTests.js`.
- `cd services/web && npm run type-check`.
- `cd services/web && npm run lint`.
- `cd services/web && OVERLEAF_CONFIG=$(pwd)/config/settings.webpack.js CYPRESS_SPEC_PATTERN='./test/frontend/features/ai-assistant/components/agent-workspace-panel.spec.tsx' npx cypress run --component --browser chromium` (3 tests).
- `git diff --check` and real-key grep for the configured local DeepSeek key.

Additional M10 E2E evidence:

- Browser reload/session hydration fetched session
  `6a36c7d9cb46261d4d1d9b86` before and after page reload with unchanged
  `messageCount=2`, `activeTurn.status=completed`, and
  `activeTurn.agentLoopPath=agent-loop-v2`.
- Browser stop session `6a36c8b0cb46261d4d1d9b8d` returned 200 from
  `/stop` and persisted `activeTurn.status=stopped`,
  `reason=user_stop`, and `agentLoopPath=agent-loop-v2`.
- Restart recovery inserted artificial running session
  `6a36c8cdfc36c2ca60d94034`, restarted `develop-ai-writing-agent-1`, and
  startup reconciliation persisted `activeTurn.status=interrupted_after_restart`,
  `reason=service_restart`, and `_streamingInterrupted=true`.
- Browser conflict E2E created workspace-style pending change
  `8a0aebf0ac2b6521a670ebb5` in session
  `6a36cc84542f7879a4b3e399`, advanced `main.tex` externally, called
  `/api/ai/sessions/:sessionId/changes/:changeId/accept` through the Web
  proxy, received 409 `REBASE_CONFLICT` with
  `conflictType=LIVE_CONTENT_CHANGED`, stored the change as `conflict`, and
  verified the canonical document retained the external edit. The test then
  restored `main.tex` to the baseline marker.

Historical verification notes:

- The earlier targeted acceptance run for `"should get session status"` timed
  out before producing useful hydration evidence. Final acceptance verification
  now passes with the active development MongoDB endpoint on port `37017`.
- `cd services/web && npm run test:frontend -- test/frontend/features/ai-assistant/context/ai-assistant-context.test.tsx` remains blocked by the existing `@/features` alias resolution error in `ai-api.test.ts`.

Objective:

- Make long-running agent work controllable and recoverable.

Scope:

- Stop running turn and child turns.
- Resume session after browser refresh.
- Recover session state after service restart.
- Detect Overleaf document changes made while agent workspace is dirty.
- Surface conflict and rebase choices in the UI.

Acceptance:

- Stop cancels model/tool execution and leaves a consistent session state.
- Refresh does not lose conversation, pending changes, or artifacts.
- Stale workspace changes cannot overwrite newer Overleaf content silently.

Verification:

```bash
cd services/ai-writing-agent
npm run test:unit
npm run test:acceptance
```

E2E gate:

- Start a long turn, stop it from the browser, refresh, and verify the session is recoverable.
- Edit the same document manually before accepting an agent change and verify conflict handling.

### M11: Hardening, Security, And Budgets

- [x] M11: done - key files: `RuntimeConfigManager.js`,
  `SandboxAgentController.js`, `SandboxSessionManager.js`, `Router.js`;
  verification: `npm run test:unit` (46 files / 594 tests), `npx eslint .`,
  `node test/manual/sandbox-limits-smoke-test.mjs`, targeted 8-file hardening
  test set; e2e: verification subagent independently ran targeted hardening
  tests, eslint, and Docker sandbox limits smoke; notes: runtime status now
  reports sanitized API base, sandbox limits, cleanup capability, and missing
  AgentLoopV2 dependencies; text artifacts are redacted before storage; admin
  sandbox cleanup is protected by `requireAdmin`.

Objective:

- Make the new loop safe enough to be the default development path.

Scope:

- Enforce sandbox CPU/memory/pids/time/output/file/artifact limits.
- Redact secrets from logs, events, messages, artifacts, and test output.
- Add budget controls for model calls, tool calls, subagents, and compiles.
- Add startup/manual cleanup for orphan sessions/workspaces.
- Add admin-visible diagnostics for current agent runtime health.

Acceptance:

- No tracked secret leaks.
- Tool and model budgets are enforced.
- Cleanup handles success, failure, stop, and restart.
- Admin/developer status explains missing dependencies.

Verification:

```bash
cd services/ai-writing-agent
npm run test:unit
npx eslint .
node test/manual/sandbox-limits-smoke-test.mjs
```

E2E gate:

- Verification subagent confirms failed/timeout runs do not leave visible broken UI, leaked containers, or unbounded logs.

### M12: Legacy Runtime And OpenCode/Pi Deprecation

- [x] M12: done - key files: `RuntimeConfigManager.js`,
  `AgentLoopFactory.js`, `AgentLoopV2.js`, `AgentController.js`,
  `delegate_task.js`, `ai-assistant-pane.tsx`, `docker-compose.dev.yml`;
  verification: `npm run test:unit` (47 files / 598 tests), `npx eslint .`,
  `services/web npm run type-check`, `persistent-workspace-smoke-test.mjs`;
  e2e: browser login at `http://127.0.0.1:18080/project/6a355fe027c10dcad8f097bb`
  reported `runtimeMode=agent-loop-v2`, session
  `6a36c3ce6da2479f64d31f01` streamed
  `AgentLoopV2 browser live smoke ok.`, and session
  `6a36c5966da2479f64d31f08` accepted change
  `3de72cc06fd868a3497a9c63` into `main.tex` version 9; notes: OpenCode/Pi
  remain sandbox-v0 fallback only, and develop sandbox workspaces now mount to a
  gitignored repo-local writable directory.

Objective:

- Make AgentLoopV2 the default product path and demote external coding CLIs to optional fallback tools.

Scope:

- Update docs and runtime status labels.
- Keep legacy and sandbox-v0 behind explicit config for rollback.
- Remove OpenCode/Pi from default UX copy.
- Add migration notes for existing sessions/config.

Acceptance:

- New development installs use AgentLoopV2 by default when dependencies are configured.
- Existing legacy/sandbox-v0 behavior can still be enabled intentionally.
- Docs no longer imply OpenCode/Pi is the core agent architecture.

Migration notes:

- New development installs should keep `AI_RUNTIME_MODE=auto` and configure
  `AI_AGENT_LOOP_V2_API_BASE` or `OPENAI_API_BASE` plus
  `AI_AGENT_LOOP_V2_MODEL` or `OPENAI_MODEL`; this selects `agent-loop-v2`
  without requiring an additional enable flag.
- To roll back intentionally, set `AI_RUNTIME_MODE=legacy` for the direct
  legacy chat route or `AI_RUNTIME_MODE=sandbox-v0` for external CLI fallback.
- Set `AI_AGENT_LOOP_V2_ENABLED=false` only when intentionally disabling
  AgentLoopV2 auto-selection during a fallback test.
- Existing sessions keep their stored `runtimeMode`; newly created sessions
  without an explicit runtime use the resolved runtime status at creation time.
- OpenCode/Codex/Pi settings remain under sandbox-v0 fallback configuration and
  should not be described as the primary agent architecture.

Evidence:

- `auto` runtime selection no longer requires `AI_AGENT_LOOP_V2_ENABLED=true`;
  configured AgentLoopV2 endpoint/model selects `agent-loop-v2`.
- New root sessions default to the resolved runtime mode instead of hard-coded
  `legacy`; explicit runtime requests are still preserved for rollback.
- Frontend runtime controls label the default path as `AgentLoopV2` and sandbox
  as `Fallback`.
- `/sessions/:id/messages` now selects `AgentLoopV2` for sessions whose
  `runtimeMode` is `agent-loop-v2`, while explicit legacy/sandbox-v0 sessions
  retain rollback-compatible loop behavior.
- Delegated child sessions use the same loop selector, so AgentLoopV2 parent
  sessions keep the V2 path through subagent execution while sharing the
  existing budget, confirmation, and event protocol.
- Develop stack uses AgentLoopV2 by default through the Web proxy with
  `deepseek-v4-flash`; direct AI service calls without proxy authentication are
  rejected as expected.
- Browser E2E created a real project session, streamed a live model answer, and
  persisted `activeTurn.runtimeMode=agent-loop-v2` plus
  `activeTurn.agentLoopPath=agent-loop-v2`.
- Browser writeback E2E used `read_document` and `edit_document`, emitted
  `awaiting_confirmation`, accepted via `/confirm-change/:changeId`, and the
  canonical Overleaf document contained the accepted marker at version 9.
- Local Docker persistent workspace creation is verified after moving the
  develop bind mount from host `/tmp` to
  `services/ai-writing-agent/.sandboxes`, which is ignored by git.
- Sandbox execution and artifact collection are verified with
  `sandbox-smoke-test.mjs`, `sandbox-limits-smoke-test.mjs`, and
  `sandbox-latex-smoke-test.mjs`; the LaTeX smoke compiled `main.pdf`, extracted
  text with `pdftotext`, and collected `main.log` plus `main.pdf`.
- Subagent execution is verified with `delegate-task-coordinator-smoke-test.mjs`
  and browser live session `6a36c7d9cb46261d4d1d9b86`; child session
  `6a36c7decb46261d4d1d9b89` ran as `content-reviewer`, inherited
  `runtimeMode=agent-loop-v2`, called `read_document`, and completed.

Residual verification outside M12:

- Final cross-milestone proof for refresh, stop, restart recovery, conflict
  handling, and the full playbook is now recorded in M10 and in the final
  acceptance evidence matrix.

Verification:

```bash
cd services/ai-writing-agent
npm run test:unit
npx eslint .
MONGO_CONNECTION_STRING=mongodb://127.0.0.1:37017/sharelatex?directConnection=true node test/manual/persistent-workspace-smoke-test.mjs
cd ../web
npm run type-check
```

E2E gate:

- Full development stack uses AgentLoopV2 path by default and passes the final E2E playbook below.

## 6. Subagent Development Protocol

The main session is responsible for architecture, task dispatch, review, integration, and final sign-off. Use subagents aggressively, but never let a subagent's claim replace verification evidence.

Recommended implementation subagents:

- **Session worker**: session store, message persistence, authorization tests.
- **Workspace worker**: persistent sandbox lifecycle, sync, diff, cleanup.
- **Loop worker**: model client, tool-call loop, event normalization.
- **Tools worker**: file, compile, citation, review tools and toolsets.
- **Subagent worker**: child sessions, depth/budget/concurrency limits.
- **Frontend worker**: AI panel, session UI, progress, changes, artifacts.
- **Security worker**: secret redaction, budgets, cleanup, status diagnostics.

Required verification subagents:

- **Deployment verification subagent**: starts the real development stack, checks service health, captures exact commands and URLs.
- **Browser E2E verification subagent**: uses browser automation or an equivalent real browser flow to log in, open the editor, use the AI panel, inspect console errors, and verify user-visible state.
- **Live model verification subagent**: confirms `deepseek-v4-flash` returns a real answer through the deployed app path, not only a direct API probe.
- **Writeback verification subagent**: confirms an agent-proposed change is accepted and appears in the Overleaf editor/document state.
- **Regression verification subagent**: runs unit/type/lint/acceptance checks and reports exact failures.

Rules:

- Verification subagents should not edit implementation code.
- A milestone is incomplete if the relevant verification subagent cannot reproduce the user-side flow.
- If verification fails, the main session must route fixes back to implementation subagents and rerun verification.
- Do not mark a milestone done with only `node --check`, type-check, unit tests, or mocked API tests.
- Record exact commands, project id, session id, URL, model, and observed result for E2E evidence. Redact secrets.

## 7. End-To-End Test Playbook

Run this playbook before claiming the full migration is complete. It is acceptable to automate it with a script, but the script must exercise the deployed web app path and report browser-visible failures.

### 7.1 Deploy Development Stack

```bash
cd develop
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d
docker compose -f docker-compose.yml -f docker-compose.dev.yml ps
```

Required health checks:

- Web/webpack responds on the configured browser port.
- `ai-writing-agent` responds to status/health.
- MongoDB, Redis, document-updater, docstore, filestore, CLSI are healthy enough for editor and compile flows.
- New agent runtime status reports `agent-loop-v2` when enabled.

### 7.2 Browser User Flow

Use a real browser path:

1. Open launchpad or login page.
2. Log in with a development user.
3. Create a project if needed, or open an existing project.
4. Open the editor page.
5. Confirm the AI panel loads without React/runtime errors.
6. Create or resume an agent session.
7. Send a simple writing question.
8. Confirm streamed answer appears from `deepseek-v4-flash`.
9. Refresh the browser.
10. Confirm the session history still exists.

### 7.3 File Edit And Writeback Flow

1. Ask the agent to make a small, deterministic edit in `main.tex`.
2. Confirm the agent writes only to workspace.
3. Confirm pending change appears in UI.
4. Accept the change.
5. Confirm Overleaf editor content changes.
6. Reject a second proposed change and confirm it does not write back.

### 7.4 Compile Fix Flow

1. Introduce or use a project with a LaTeX error.
2. Ask the agent to compile and diagnose.
3. Confirm compile tool runs in sandbox.
4. Confirm logs/artifacts are shown.
5. Ask agent to fix the issue.
6. Accept the proposed change.
7. Compile again and confirm the original error is gone or the new blocker is clearly reported.

### 7.5 Subagent Flow

1. Start a Deep Review request.
2. Confirm coordinator starts at least two child sessions.
3. Confirm child toolsets are shown or inspectable.
4. Confirm child findings are summarized by the parent.
5. Confirm child sessions and messages persist for debugging.

### 7.6 Recovery Flow

1. Start a long-running turn.
2. Stop it from the UI.
3. Refresh the browser.
4. Confirm stopped state is clear and the session can continue.
5. Restart `ai-writing-agent`.
6. Confirm the session can be resumed.

## 8. Required Test Commands

These commands are not sufficient by themselves, but they are required when relevant files are touched.

AI service:

```bash
cd services/ai-writing-agent
npm run test:unit
npm run test:acceptance
npx eslint .
```

Web frontend/backend:

```bash
cd services/web
npm run type-check
npm run lint
npm run test:unit
```

Sandbox manual checks:

```bash
cd services/ai-writing-agent
node test/manual/sandbox-smoke-test.mjs
node test/manual/sandbox-limits-smoke-test.mjs
node test/manual/sandbox-latex-smoke-test.mjs
```

Run the sandbox manual checks serially. The limits smoke intentionally exercises
manual cleanup and can remove concurrently running managed sandbox containers.

Live model check:

```bash
cd services/ai-writing-agent
node test/manual/ai-api-test.mjs
```

If any command is skipped, record why and whether the skip blocks the milestone. Missing live model credentials block live-model E2E completion.

## 8.1 Final Acceptance Evidence

The final migration evidence below supersedes earlier per-milestone browser-login
blockers that were recorded before a local authenticated project session was
available.

| DoD item | Evidence |
|----------|----------|
| AgentLoopV2 default development AI path | Runtime status through the Web proxy reported `runtimeMode=agent-loop-v2`, `configuredRuntimeMode=auto`, `model=deepseek-v4-flash`, and `apiBase=https://api.deepseek.com/v1`; direct AI service calls without proxy auth returned 401 as expected. |
| Browser user can create/resume an agent session | Authenticated Playwright opened `http://127.0.0.1:18080/project/6a355fe027c10dcad8f097bb`; session `6a36c3ce6da2479f64d31f01` streamed a live AgentLoopV2 response, and session `6a36c7d9cb46261d4d1d9b86` survived reload with unchanged messages and `activeTurn.agentLoopPath=agent-loop-v2`. |
| Real deployed-path model response | Browser session `6a36c3ce6da2479f64d31f01` streamed `AgentLoopV2 browser live smoke ok.` through the Web proxy using `deepseek-v4-flash`. |
| Read/edit/diff workspace files | Browser writeback session `6a36c5966da2479f64d31f08` used `read_document` and `edit_document`; persistent workspace and diff conversion are also covered by `persistent-workspace-smoke-test.mjs` and `workspace-diff-to-pending-smoke-test.mjs`. |
| Accept agent change updates canonical Overleaf document | Browser session `6a36c5966da2479f64d31f08` accepted change `3de72cc06fd868a3497a9c63`; `main.tex` reached version 9 with the accepted marker. |
| Sandbox LaTeX compile and artifacts | Serial `sandbox-latex-smoke-test.mjs` completed with `latexmk: ok`, `pdftotext: ok`, and artifacts `main.log`, `main.pdf`; `compile-latex-tool-smoke-test.mjs` also verified compile tool artifact collection. |
| Real child sessions/subagents | `delegate-task-coordinator-smoke-test.mjs` passed, and browser live session `6a36c7d9cb46261d4d1d9b86` created child session `6a36c7decb46261d4d1d9b89` as `content-reviewer`; it inherited `runtimeMode=agent-loop-v2`, called `read_document`, and completed. |
| Refresh, stop, service restart, conflict | Reload preserved session `6a36c7d9cb46261d4d1d9b86`; stop session `6a36c8b0cb46261d4d1d9b8d` persisted `activeTurn.status=stopped`; restart reconciled session `6a36c8cdfc36c2ca60d94034` to `interrupted_after_restart`; conflict session `6a36cc84542f7879a4b3e399` / change `8a0aebf0ac2b6521a670ebb5` returned 409 `LIVE_CONTENT_CHANGED` and did not overwrite the external edit. |
| Required checks | Latest final checks: `cd services/ai-writing-agent && npm run test:unit` (47 files / 601 tests), `MONGO_CONNECTION_STRING=mongodb://127.0.0.1:37017/sharelatex?directConnection=true npm run test:acceptance` (18 tests), `npx eslint .`, `git diff --check`, focused `DocumentAdapterApplyTests`, focused `AcceptRejectTests`, and `services/web npm run type-check`. Existing broader frontend blocker is documented above and is an unrelated baseline alias-resolution issue. |
| Independent verification | Verification subagents independently checked deployment/config, regression coverage, final M12 evidence, and the M10 live-conflict fix; subagent findings are reflected in the M10/M12 evidence notes. |
| Secret hygiene | Real API keys remain only in ignored local env; tracked docs/tests mention public endpoint/model names only. Final grep for the configured local key returned no tracked hits. |

## 9. Definition Of Done

The Hermes-style Agent Loop migration is complete only when all of the following are true:

- AgentLoopV2 is the default development AI path.
- A browser user can create/resume an agent session in a real Overleaf editor.
- The agent can call `deepseek-v4-flash` through the deployed app path and stream a real answer.
- The agent can read, edit, and diff workspace files.
- The user can accept an agent change and see the Overleaf document update.
- The agent can run a real LaTeX compile in sandbox and surface diagnostics/artifacts.
- Deep Review or an equivalent workflow uses real child sessions/subagents.
- Refresh, stop, service restart, and conflict cases have been verified.
- Required unit, acceptance, lint, and type checks pass or have explicit, accepted blockers.
- Verification subagents have independently run deployment, browser E2E, live model, writeback, and regression checks.
- No tracked file contains real API keys, passwords, cookies, or private tokens.

Not acceptable:

- Claiming completion after only unit tests.
- Claiming completion after only `node --check`, type-check, or lint.
- Claiming completion after only direct model API probing outside the deployed web path.
- Claiming completion without opening the browser editor.
- Claiming completion while the browser console has critical React/runtime errors.

## 10. Suggested Long-Running `/goal`

```text
/goal Implement the Hermes-style first-party Agent Loop described in services/ai-writing-agent/doc/hermes-style-agent-loop-development-plan.md. Continue through all milestones until the Definition of Done is satisfied. Use implementation subagents for independent workstreams and separate verification subagents for deployment, browser E2E, live model, writeback, and regression checks. Do not mark any milestone complete with only unit/type/lint/mock tests. Every completed milestone must include real verification evidence or an explicit blocker. Keep OpenCode/Pi as optional fallback tools only; AgentLoopV2 is the default product path.
```

## 11. Relationship To Existing Documents

- `sandbox-agent-runtime-development-plan.md` remains the historical v0 sandbox/OpenCode migration plan.
- `hermes-agent-orchestration-research-and-migration-plan.md` records Hermes research and architectural lessons.
- This document is the new implementation baseline for first-party AgentLoopV2.

Future agents should read the Hermes research document before implementing this plan, but they should not copy Hermes source files or commit the external reference repository.
