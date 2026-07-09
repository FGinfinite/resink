# Live Agent Workspace Development Plan

> Goal: replace the current "agent edits a hidden workspace, then syncs pending changes at the end" flow with a live Overleaf-aware agent workspace. Agent edits must become observable immediately: Review mode shows live draft diffs, and Auto Accept mode writes each accepted edit through Overleaf CAS/writeback as soon as the edit is produced.
>
> This document is written for one long-running autonomous `/goal` execution. The agent should drive the whole migration to completion, use implementation subagents for separable workstreams, require independent verification subagents for live browser/writeback/conflict checks, and commit after every completed milestone.

## 1. Product Direction

The current AgentLoopV2 path is a good orchestration baseline, but the edit/writeback model is still too indirect:

```text
edit_document mutates persistent sandbox
  -> workspace stays dirty
  -> sync_workspace_changes runs near the end
  -> pendingChanges are stored on the session
  -> frontend finally sees reviewable changes
  -> accept writes canonical Overleaf docs
```

This is fragile and slow. The user can see the agent claim that edits were made while Overleaf files remain unchanged and no review UI is visible yet. Mature agent products avoid this shape:

- Hermes-style agents expose direct file tools such as patch/write file inside an observable working directory.
- OpenHands runs agents in local/Docker/remote workspaces and streams workspace/tool events to the UI.
- Aider applies model-produced diffs directly to the repository and uses git diff/commit/undo as the review boundary.
- Claude Code can automatically accept file edits under an explicit permission mode while still relying on filesystem state and permission policy.

ResInk's Overleaf integration cannot simply let an agent write canonical documents directly in all modes, because Overleaf owns permissions, collaboration, document versions, and CAS conflict handling. The target model is therefore:

**A live AI draft workspace embedded in Overleaf, with immediate draft visibility in Review mode and immediate CAS writeback in Auto Accept mode.**

Overleaf remains responsible for:

- User identity, project membership, and write permissions.
- Canonical project tree, document versions, real-time collaboration, and editor state.
- CAS/version-guarded canonical writes.
- Final review UI, conflict UI, and user-initiated accept/reject.

`services/ai-writing-agent` becomes responsible for:

- Persistent agent sessions and turns.
- Persistent sandbox workspaces for tool execution.
- Live AI change sets and draft changes.
- Immediate draft events for the browser.
- Auto Accept writeback orchestration.
- Subagent provenance, event normalization, and cleanup of obsolete runtime paths.

## 2. Architecture Principles

1. **Agent edits must materialize immediately.**
   Every successful file edit creates a durable change-set entry and an SSE event during the same tool call. The browser must not wait for a final sync tool to learn that an edit exists.

2. **Review and Auto Accept share one pipeline.**
   Review mode and Auto Accept mode both create `draft_change` records. Review mode leaves canonical Overleaf docs unchanged. Auto Accept mode immediately applies each draft change through the canonical writeback service.

3. **Overleaf CAS is the canonical write boundary.**
   Sandbox files and AI draft state are never the source of truth for live collaborators. Canonical writes must pass through existing Overleaf permission and version checks.

4. **`sync_workspace_changes` is not a user-facing commit step.**
   It may remain temporarily as a recovery/debug tool during migration, but it must not be required for normal edit visibility or Auto Accept writeback.

5. **The frontend renders product-level events, not tool accidents.**
   The AI panel and CodeMirror overlays consume normalized `draft_change.*`, `change_set.*`, `canonical_change.*`, and `workspace.*` events.

6. **Delete obsolete paths after the new path is verified.**
   This project is still in development. Once live draft/writeback passes full E2E, remove sandbox-v0/OpenCode/Codex CLI product fallback paths and the naive legacy AgentLoop path instead of keeping long-term compatibility clutter.

7. **Commit every completed milestone.**
   After each completed and verified milestone, create one Conventional Commits-style git commit. The commit body must include motivation, main changes, validation commands, E2E evidence, and any skipped checks with exact reasons.

8. **No tracked secrets.**
   Development endpoint and model names may appear in docs. Real API keys, cookies, session tokens, and secret-bearing logs/screenshots must never be committed.

## 3. Target Runtime Shape

```text
Browser AI panel
  -> Web /api/ai proxy injects authenticated user identity
  -> AgentSessionService resumes project agent session
  -> AgentTurnRunner prepares persistent workspace and turn context
  -> AgentLoopV2 dispatches tools
  -> edit_document writes sandbox workspace and creates a draft_change immediately
  -> EventNormalizer streams draft_change.created to the browser
  -> Review mode: CodeMirror shows live draft diff, canonical doc is unchanged
  -> Auto Accept mode: CanonicalWritebackService applies the change through CAS
  -> Browser receives canonical_change.applied / draft_change.accepted
  -> Refresh restores change-set state from Mongo
```

### Core Services

- `AgentWorkspaceService`
  - Owns persistent workspace creation, resume, drift detection, and cleanup.
  - Replaces scattered direct use of `PersistentWorkspaceManager` in tool/controller code.

- `AgentChangeSetService`
  - Creates one active change set per user turn.
  - Stores draft changes, statuses, provenance, conflicts, and apply results.
  - Provides list/restore APIs for browser reload.

- `LiveDraftChangeBridge`
  - Converts workspace edits into browser-ready draft changes during the edit tool call.
  - Computes positions/diff metadata needed by CodeMirror overlays.
  - Emits normalized SSE events immediately.

- `CanonicalWritebackService`
  - Applies accepted draft changes through existing `DocumentAdapter`/project adapters.
  - Handles edit/create/delete, CAS conflict, rebase metadata, apply locks, and audit fields.

- `AgentEventBus` / `EventNormalizer`
  - Emits frontend-safe product events.
  - Redacts secrets and hides low-level sandbox noise unless the UI is in diagnostics mode.

- `LegacyRuntimeRemovalTracker`
  - Tracks old runtime paths that must be removed after live workspace acceptance.
  - Prevents accidental reintroduction of OpenCode/sandbox-v0 as default product behavior.

### Mongo Data Model

Use Mongo collections instead of storing all review state on `aiSessions.pendingChanges`.

```javascript
aiAgentChangeSets: {
  _id,
  sessionId,
  projectId,
  userId,
  turnId,
  status: 'open' | 'review' | 'applying' | 'applied' | 'rejected' | 'conflict' | 'abandoned',
  mode: 'review' | 'auto',
  createdAt,
  updatedAt,
  closedAt,
  summary,
  changeIds: [ObjectId],
}

aiAgentDraftChanges: {
  _id,
  changeSetId,
  sessionId,
  turnId,
  toolCallId,
  parentSessionId,
  childSessionId,
  projectId,
  userId,
  type: 'edit' | 'create' | 'delete' | 'artifact',
  source: 'agent-loop-v2',
  path,
  docId,
  entityId,
  baseVersion,
  position,
  oldText,
  newText,
  newContent,
  content,
  status: 'draft' | 'pending' | 'applying' | 'accepted' | 'rejected' | 'conflict' | 'stale',
  createdAt,
  updatedAt,
  appliedAt,
  rejectedAt,
  conflictAt,
  conflictType,
  conflictMessage,
  appliedVersion,
  wasRebased,
  provenance: { agentName, toolName, model, profile },
}

aiAgentApplyOperations: {
  _id,
  changeId,
  changeSetId,
  sessionId,
  projectId,
  userId,
  status: 'started' | 'succeeded' | 'failed' | 'conflict',
  startedAt,
  finishedAt,
  errorCode,
  errorMessage,
  appliedVersion,
}
```

Migration rule:

- During migration, `aiSessions.pendingChanges` may be populated as a compatibility mirror for old UI components.
- At the end of the goal, all default UI/API paths must read from change-set state, and the compatibility mirror must either be removed or marked legacy-only.

### Normalized Events

The browser should consume these events from `/sessions/:id/messages` SSE:

```text
change_set.started
draft_change.created
draft_change.updated
draft_change.accepted
draft_change.rejected
draft_change.conflict
canonical_change.applying
canonical_change.applied
workspace.syncing
workspace.clean
workspace.drift_detected
turn.completed
```

Event payloads must include stable ids, status, document identity, path, base version, diff fields required by CodeMirror, and safe provenance. They must not include secrets or raw hidden prompts.

## 4. Mode Semantics

### Review Mode

Default behavior when Auto Accept is off:

1. `edit_document` validates read-before-write and workspace path.
2. The tool updates the persistent sandbox workspace.
3. The tool creates an `aiAgentDraftChanges` record in status `pending`.
4. The service emits `draft_change.created` immediately.
5. The frontend renders CodeMirror pending diff and the change-set review panel immediately.
6. Canonical Overleaf docs remain unchanged.
7. User accept calls the change-set accept API, which applies the specific draft change through CAS.
8. User reject marks the draft change rejected and removes overlays.

### Auto Accept Mode

Default behavior when Auto Accept is on:

1. `edit_document` follows the same validation and draft-change creation.
2. The browser still receives `draft_change.created` for traceability.
3. `CanonicalWritebackService` immediately applies the draft change through CAS.
4. On success, the service marks the draft change `accepted`, records `appliedVersion`, and emits `canonical_change.applied` plus `draft_change.accepted`.
5. The Overleaf editor updates through its normal real-time document path.
6. The frontend shows a temporary applied ghost/highlight, not a pending row.

### Conflict And Drift

- If the base document version changed before apply, mark the draft change `conflict`.
- The frontend must keep the conflicted draft visible and offer reject/retry/rebase actions.
- Auto Accept conflicts must not silently disappear.
- Workspace drift should be reported before the next tool call and should not require the user to understand sandbox internals.

## 5. One-Shot Delivery Board

Maintain this board by changing checkboxes and adding short completion evidence only. Do not append long diaries. If blocked, write a short handoff file with exact blocker, commands, and expected result.

Completion evidence format:

```text
M#: done - key files: <paths>; verification: <commands>; e2e: <browser/model/deploy evidence>; notes: <one or two lines>
```

### M0: Baseline Audit And Deprecation Map

- [x] M0: done - key files: `RuntimeConfigManager.js`, `AgentLoopFactory.js`, `AgentLoop.js`, `edit.js`, `sync_workspace_changes.js`, `PersistentWorkspaceManager.js`, `AgentController.js`, `Router.js`, `ToolsetPolicy.js`, `ai-assistant-context.tsx`, `ai-api.ts`, `ai-assistant-pane.tsx`; verification: `npm run test:unit` (47 files / 602 tests), `npx eslint .`; e2e: `develop` stack was already running, `http://127.0.0.1:43060/status` returned `{"status":"ok"}`, Playwright opened `http://127.0.0.1:18080/project/6a355fe027c10dcad8f097bb`, editor and AI panel were visible, and `/api/ai/runtime/status` returned 200; notes: this milestone is an audit/map only, no runtime deletion before M7. Existing CLSI auto-compile smoke is noisy because `develop-clsi-1` is missing `multer`, causing `/compile?auto_compile=true` 500 independent of the AI panel.

M0 deprecation/removal map:

| Area | Current path | M1-M6 migration target | M7 removal rule |
|------|--------------|------------------------|-----------------|
| Runtime selection | `RuntimeConfigManager` accepts `auto`, `agent-loop-v2`, `sandbox-v0`, and `legacy`; `auto` already prefers AgentLoopV2 when first-party API base/model are configured. | Keep `agent-loop-v2` as the guarded product path while change-set/live-writeback code is developed. | Remove `legacy` and normal `sandbox-v0` product selection from default UI/config; keep only explicitly admin/test-only research hooks if still justified. |
| Loop factory | `AgentLoopFactory` routes only `agent-loop-v2` sessions to `AgentLoopV2`; all other runtime modes instantiate the legacy `AgentLoop`. `AgentLoopV2` is currently a thin subclass of the legacy loop, not an independent live-workspace loop. | Preserve factory while live workspace behavior lands inside the AgentLoopV2/default path. | Delete naive legacy loop selection once AgentLoopV2 passes Review, Auto Accept, reload, conflict, and subagent E2E. |
| Edit visibility | Workspace `edit_document` writes the persistent sandbox file and returns `workspaceEdit`; `AgentLoop` marks the workspace dirty and later auto-calls `sync_workspace_changes`. | `edit_document` must call `LiveDraftChangeBridge` during the same tool call and emit `draft_change.created`. | `sync_workspace_changes` must not be in normal prompt/toolsets or required for browser-visible edits. |
| Pending state storage | `PersistentWorkspaceManager.syncPendingChanges()` converts workspace diff into `aiSessions.pendingChanges`; accept/reject APIs also read and mutate `aiSessions.pendingChanges`. | `AgentChangeSetService` owns `aiAgentChangeSets`, `aiAgentDraftChanges`, and `aiAgentApplyOperations`, with a temporary compatibility mirror only where needed. | Default UI/API must restore and mutate change-set state, not session-level pending mirrors. |
| Canonical writeback | `AgentController.acceptChange()` and `acceptAllChanges()` apply session pending changes through `DocumentAdapter`, create/delete handlers, and ad hoc locking/conflict updates. | `CanonicalWritebackService` centralizes edit/create/delete apply, CAS conflict, apply operation audit, and accepted/conflict events. | The old `/confirm-change` synchronous channel and direct pending-change apply internals are removed or made legacy-only. |
| Workspace attach | `AgentController.ensurePersistentWorkspaceForSession()` creates/resumes a workspace for AgentLoopV2 sessions, but failures are currently logged and the turn continues without a workspace. | Make live workspace availability explicit for live draft/edit turns and surface recovery errors as `workspace.*` events. | No silent fallback to a non-live edit path for normal AgentLoopV2 product turns. |
| Sandbox-v0 routes | `/sandbox/*` routes expose one-shot sandbox sessions, workspace creation, artifact download, and sandbox pending-change accept/reject. | Live Agent Workspace reuses persistent workspace infrastructure, not sandbox-v0 as a user product route. | Remove default product access to `/sandbox/*`; move any remaining diagnostics behind admin-only research tooling. |
| CLI adapters | `OpenCodeRuntimeAdapter`, `CodexRuntimeAdapter`, and `RuntimeAdapterFactory` remain available under sandbox-v0 config. | No M1-M6 work should depend on external CLI runtimes for normal product behavior. | Remove from default product config and status; keep only test/admin research path if explicitly documented. |
| Tool policy | `ToolsetPolicy` includes `sync_workspace_changes` in `project-write`, so normal profiles can call it. | During M2, live draft creation becomes the normal edit side effect; the sync tool may remain recovery/debug only. | Normal profiles cannot call `sync_workspace_changes`. |
| Frontend pending UI | AI context hydrates `session.pendingChanges`, listens for `awaiting_confirmation`, consumes `tool_result.data.pendingChanges`, and treats `sync_workspace_changes`/`persistent-workspace` as review sources. The AI panel still exposes sandbox-v0/fallback labels and a sandbox review action. | Add change-set/draft event types and restore APIs; drive context, review panel, and CodeMirror overlays from draft changes. | Remove sync-driven pending-change assumptions and sandbox-v0 controls from the user-facing AI panel. |
| Auto Accept | Frontend Auto Accept currently accepts `awaiting_confirmation` through `/confirm-change` and workspace pending changes after sync through `/changes/:id/accept`. | Auto mode creates a draft and immediately invokes `CanonicalWritebackService` during the edit pipeline, emitting `canonical_change.*`. | Auto Accept no longer waits for turn completion or sync-derived pending changes. |

Config guard evidence:

- `AI_RUNTIME_MODE=auto|agent-loop-v2|sandbox-v0|legacy` and `AI_AGENT_LOOP_V2_ENABLED` are wired through `settings.defaults.cjs` and `RuntimeConfigManager`; after M8 completion, `legacy` is a deprecated input alias and product sessions still execute through AgentLoopV2.
- `auto` resolves to `agent-loop-v2`; missing first-party API base/model are reported as dependencies instead of falling back to sandbox-v0 or legacy.
- `getAgentRuntimeStatus()` exposes `runtimeMode`, `configuredRuntimeMode`, `agentLoopV2Enabled`, sanitized `apiBase`, and missing dependency information without exposing secrets.
- Existing AgentLoopV2 remains guarded by `runtimeMode: 'agent-loop-v2'`; this goal will move live draft/change-set behavior behind that path before deleting compatibility routes.

Objective:

- Establish the exact current edit/writeback/runtime paths and mark what will be preserved, replaced, or deleted.

Scope:

- Audit current `AgentLoop`, `AgentLoopV2`, `sync_workspace_changes`, `PersistentWorkspaceManager`, `AgentController` accept/reject, sandbox-v0 routes, OpenCode/Codex adapters, and AI Assistant frontend state.
- Add a short deprecation/removal map to this document or a linked doc section.
- Do not delete runtime code in M0.

Acceptance:

- The implementation agent can point to every old path that must be replaced.
- The new live workspace path has a feature flag or config guard ready for incremental development.
- Existing working AgentLoopV2 path remains usable.

Verification:

```bash
cd services/ai-writing-agent
npm run test:unit
npx eslint .
```

E2E gate:

- Develop stack starts.
- Browser opens a project and AI panel without regressions.

### M1: Change-Set Data Model And Service

- [x] M1: done - key files: `mongodb.js`, `AgentChangeSetService.js`, `AgentController.js`, `AgentChangeSetServiceTests.test.js`, `AcceptRejectTests.test.js`; verification: `npm run test:unit -- test/unit/js/agent test/unit/js/AgentController`, `npx eslint app/js test/unit/js`; e2e: after restarting `develop-ai-writing-agent-1`, Web proxy created session `6a370e7e02c6372dc13b801e`, Mongo-backed `aiAgentChangeSets`/`aiAgentDraftChanges` were inserted, `GET /api/ai/sessions/:id?limit=200` returned one review change set with one pending draft change and zero messages, then smoke records were cleaned/archived; notes: M1 establishes persistent change-set state and session restore, while writeback is still handled by the old pending-change path until M4.

Objective:

- Introduce Mongo-backed change sets as the primary state for AI edits.

Scope:

- Implement `AgentChangeSetService`.
- Add collections/access helpers for `aiAgentChangeSets`, `aiAgentDraftChanges`, and `aiAgentApplyOperations`.
- Add create/list/get/update methods with project/user authorization.
- Mirror pending changes into existing session shape only where needed for temporary UI compatibility.

Acceptance:

- A session turn can create an open change set.
- Draft changes can be created, listed, restored after service restart, accepted, rejected, and marked conflict.
- No raw hidden prompts or secrets are stored.

Verification:

```bash
cd services/ai-writing-agent
npm run test:unit -- test/unit/js/agent test/unit/js/AgentController
npx eslint app/js test/unit/js
```

E2E gate:

- Browser session restore can load change-set metadata without starting a model call.

### M2: Live Draft Edit Tool

- [x] M2: done - key files: `LiveDraftChangeBridge.js`, `AgentLoop.js`, `edit.js`, `AgentController.js`, `LiveDraftChangeBridgeTests.test.js`, `EditToolTests.test.js`, `AgentLoopTests.test.js`; verification: `npm run test:unit -- test/unit/js/tool/EditToolTests.test.js test/unit/js/agent/LiveDraftChangeBridgeTests.test.js test/unit/js/agent/AgentLoopTests.test.js test/unit/js/agent/AgentChangeSetServiceTests.test.js` passed 62 tests, and focused `npx eslint ...` passed; e2e: after restarting `develop-ai-writing-agent-1`, authenticated Web proxy SSE session `6a3710ed856d71b70966f582` used live `deepseek-v4-flash` to edit `/main.tex`, emitted `draft_change.created` at event index 164 before the `edit_document` `tool_result` at index 165 and before a later model-triggered `sync_workspace_changes` result at index 291; Mongo showed one pending draft change with the marker, hydrated session restore returned one change set, and canonical `docs` stayed at version 16 without the marker; smoke draft/change-set/message/tool-call records were cleaned and the smoke session archived.

Objective:

- Make `edit_document` create visible draft changes during the tool call.

Scope:

- Refactor `edit_document` so persistent-workspace edits call `LiveDraftChangeBridge`.
- Emit `draft_change.created` in the same SSE stream as the tool result.
- Preserve read-before-write, replacer behavior, path validation, and max text limits.
- Stop relying on `sync_workspace_changes` for normal edit visibility.

Acceptance:

- In Review mode, a single `edit_document` call creates a draft change before the model finishes the turn.
- The frontend receives full `docId`, `oldText`, `newText`, `position`, `baseVersion`, and provenance.
- Canonical docs do not change in Review mode.

Verification:

```bash
cd services/ai-writing-agent
npm run test:unit -- test/unit/js/tool/EditToolTests.test.js test/unit/js/agent/AgentLoopTests.test.js
npx eslint app/js/tool app/js/agent test/unit/js/tool test/unit/js/agent
```

E2E gate:

- Authenticated Playwright uses live `deepseek-v4-flash`, asks for a small edit, and sees a pending draft diff before the assistant's final answer completes or immediately when the edit tool completes.
- Mongo shows the draft change; canonical `docs` content is unchanged.

### M3: Frontend Live Draft Review UI

- [x] M3: done - key files: `ai-types.ts`, `ai-assistant-context.tsx`, `ai-assistant-context.test.tsx`, `AgentChangeSetService.js`; implementation commit: `fff5533b77 feat(ai-assistant): hydrate draft changes in frontend state`; follow-up compatibility: legacy mirrored draft changes now use `source: persistent-workspace` so existing accept/reject UI routes to the writeback API; verification: `npm run type-check` passed, focused `npx eslint frontend/js/features/ai-assistant/types/ai-types.ts frontend/js/features/ai-assistant/context/ai-assistant-context.tsx test/frontend/features/ai-assistant/context/ai-assistant-context.test.tsx` passed, `npm run test:unit -- test/unit/js/agent/AgentChangeSetServiceTests.test.js` passed 5 tests, focused AI-service eslint passed; note: `npm run test:frontend` remains blocked before test selection by the existing `@/features` alias resolution error while loading `test/frontend/features/ai-assistant/api/ai-api.test.ts`; e2e: authenticated Playwright opened project `6a355fe027c10dcad8f097bb`, restored Web session `6a3714d2bc1e4578182ea972`, saw AI panel title `M3 restore draft UI smoke 2`, review nav text for `main.tex`, and 8 CodeMirror AI change decorations before and after reload; Mongo had one change set, one pending draft, one mirrored pending change, and canonical doc stayed version 18 without the M3 marker; smoke records were cleaned and session archived.

Objective:

- Replace sync-driven pending UI with live change-set review.

Scope:

- Extend frontend AI event types for change-set and draft-change events.
- Store live draft changes in AI Assistant context.
- Drive CodeMirror overlays from draft changes instead of only `awaitingConfirmation`.
- Update review panel language from generic pending changes to live AI draft changes.
- Keep existing inline accept/reject widgets, but route them to change-set APIs.

Acceptance:

- `draft_change.created` immediately renders highlight/diff for the current document.
- File/create/delete/artifact changes are visible in the review panel.
- Refresh restores pending draft changes.
- Reject removes overlays; accept moves the change to applied/conflict state.

Verification:

```bash
cd services/web
npm run type-check
npx eslint frontend/js/features/ai-assistant test/frontend/features/ai-assistant
```

E2E gate:

- Browser Review mode shows pending draft changes without needing `sync_workspace_changes`.
- A user can accept and reject from the UI.

### M4: Auto Accept Immediate Writeback

- [x] M4: done - key files: `CanonicalWritebackService.js`, `LiveDraftChangeBridge.js`, `edit.js`, `AgentLoop.js`, `AgentController.js`, `AgentChangeSetService.js`, `ai-api.ts`, `ai-assistant-context.tsx`, `ai-types.ts`, `services/document-updater/app/js/Errors.js`; implementation: Auto Accept draft edits now emit `draft_change.created`, `canonical_change.applying`, write canonical docs through CAS, then emit `canonical_change.applied` and `draft_change.accepted`; accepted/conflicted workspace edits are finalized so `sync_workspace_changes` does not run as a fallback; frontend sends `context.autoAccept` and hydrates applied/conflict events into review state; document-updater now exports `VersionMismatchError` so CAS mismatch returns 409 instead of causing a 500 in `setDoc` catch handling. Verification: `npm run test:unit` in `services/ai-writing-agent` passed 50 files / 616 tests; `npx eslint .` in `services/ai-writing-agent` passed; `npm run type-check` in `services/web` passed; focused web ESLint for `frontend/js/features/ai-assistant/{api,context,types}` and related tests passed; `node --check services/document-updater/app/js/Errors.js services/document-updater/app/js/HttpController.js` passed. Note: `npm run test:frontend -- --grep "ai-assistant"` remains blocked before test selection by the existing `@/features` alias resolution error while loading `test/frontend/features/ai-assistant/api/ai-api.test.ts`. E2E: authenticated Playwright opened project `6a355fe027c10dcad8f097bb`, created session `6a371c17d6a62bde7b100f3f`, sent a live `deepseek-v4-flash` Auto Accept prompt against `/main.tex`, and observed SSE events `draft_change.created -> canonical_change.applying -> canonical_change.applied -> draft_change.accepted` with no `sync_workspace_changes` tool result; Mongo recorded draft `6a371c1ad6a62bde7b100f43` as `accepted`, apply operations `started` and `succeeded`, mirrored pending change status `accepted`, and both DocumentUpdater and Mongo `docs` advanced to version 22 with marker `% M4 auto accept 1781996563466`; browser reload saw the marker in the editor. Cleanup used the same canonical writeback path to restore `main.tex` to `此处填写摘要。`, with DU and Mongo both clean at version 23; smoke session was archived.

Objective:

- In Auto Accept mode, each edit writes canonical Overleaf docs immediately through CAS.

Scope:

- Implement `CanonicalWritebackService`.
- Wire Auto Accept mode so `edit_document` creates draft change, then immediately applies it.
- Emit `canonical_change.applying`, `canonical_change.applied`, or `draft_change.conflict`.
- Record apply operation documents for audit/debug.
- Update frontend auto mode to show applied ghosts and no pending residue.

Acceptance:

- Auto Accept no longer waits for turn completion or `sync_workspace_changes`.
- Canonical doc version increments after each successful edit.
- Editor content updates through normal Overleaf real-time mechanisms.
- Failed apply leaves a visible conflict instead of silent loss.

Verification:

```bash
cd services/ai-writing-agent
npm run test:unit -- test/unit/js/AgentController/AcceptRejectTests.test.js test/unit/js/tool/EditToolTests.test.js
npx eslint app/js test/unit/js

cd services/web
npm run type-check
npx eslint frontend/js/features/ai-assistant
```

E2E gate:

- Authenticated Playwright turns Auto Accept on, asks for a unique edit, and observes canonical doc content/version changed in Mongo and browser.
- No pending draft remains for the applied change.

### M5: Conflict, Drift, And Collaboration Semantics

- [x] M5: done - key files: `AgentController.js`, `AcceptRejectTests.test.js`, `ai-assistant-context.test.tsx`; implementation: Review accept/reject now synchronizes draft-backed `pendingChanges` with `aiAgentDraftChanges` for accepted, conflict, and rejected states; accept conflict responses include the conflict change payload with `stale: true`; frontend persistent-workspace conflict handling is covered by regression tests and keeps the change visible/rejectable. Verification: `npm run test:unit` in `services/ai-writing-agent` passed 50 files / 616 tests; `npx eslint .` in `services/ai-writing-agent` passed; `npm run type-check` in `services/web` passed; focused web ESLint for `ai-assistant-context.tsx` and its test passed; `npm run test:frontend -- --grep "ai-assistant"` remains blocked before test selection by the existing `@/features` alias resolution error while loading `test/frontend/features/ai-assistant/api/ai-api.test.ts`. E2E: authenticated Playwright/API flow created session `6a371e1cbf265904fe2d44a4` and draft `6a371e1ccaeed8e110b8ba35` at base version 23, mutated canonical `/main.tex` to version 24, then accepted the stale draft; accept returned 409 `LIVE_CONTENT_CHANGED`, `aiAgentDraftChanges` and mirrored session pending change both became `conflict`, the 409 payload included the recoverable conflict change, reject returned 200 and moved the draft to `rejected`; cleanup restored DU and Mongo to clean `此处填写摘要。` at version 25 and archived the smoke session.

Objective:

- Make conflicts explicit and recoverable.

Scope:

- Add CAS conflict paths for Review accept and Auto Accept apply.
- Detect stale draft positions when the user or collaborator edits the same document.
- Add retry/rebase/reject APIs for conflicted draft changes.
- Ensure change sets can hold mixed accepted/rejected/conflict states.

Acceptance:

- A live document version mismatch marks the draft change `conflict`.
- The frontend keeps conflict details visible.
- Reject clears the conflict.
- Retry/rebase either reapplies cleanly or returns a deterministic conflict.

Verification:

```bash
cd services/ai-writing-agent
npm run test:unit -- test/unit/js/AgentController/AcceptRejectTests.test.js test/unit/js/sandbox/PersistentWorkspaceManagerTests.test.js

cd services/web
npm run type-check
```

E2E gate:

- Playwright or API-driven flow creates a draft, mutates canonical doc, then accepts the draft and observes a visible conflict.

### M6: Subagent Provenance And Multi-Edit Change Sets

- [x] M6: done - key files: `LiveDraftChangeBridge.js`, `delegate_task.js`, `LiveDraftChangeBridgeTests.test.js`, `DelegateTaskToolTests.test.js`; implementation: delegated child loops inherit the parent active change set, and child draft changes are rooted in the parent session/change set while retaining `parentSessionId`, `childSessionId`, `agentName`, `profile`, `model`, and `toolName` provenance; child tool registries remain limited to the parent-scoped allowed tools. Verification: `npm run test:unit -- test/unit/js/agent/LiveDraftChangeBridgeTests.test.js test/unit/js/tool/DelegateTaskToolTests.test.js test/unit/js/agent/AgentLoopTests.test.js` passed 65 tests; full `npm run test:unit` passed 50 files / 618 tests after rerunning a transient `BibLookupToolTests` timeout; `npx eslint .` in `services/ai-writing-agent` passed; `npm run type-check` in `services/web` passed; focused web ESLint for AI Assistant provenance-related files passed. E2E: authenticated Playwright/API flow created root session `6a371f5aa3dfb404e354caa7`, child session `6a371f5a4c5ec907461820c8`, root change set `6a371f5a4c5ec907461820c9`, and child draft `6a371f5a4c5ec907461820ca`; Mongo verified the draft is in the root change set, `draft.sessionId` is the root session, `parentSessionId` is the root session, `childSessionId` is the child session, provenance is `m6-reviewer`/`reviewer`/`deterministic`/`edit_document`, the root session has the mirrored pending change, and the child session has no duplicate pending residue; smoke sessions were archived.

Objective:

- Ensure child agents and multi-edit turns produce coherent live change sets.

Scope:

- Attach parent/child session provenance to each draft change.
- Aggregate multiple tool edits into the active turn's change set.
- Ensure child agents cannot bypass parent toolset/writeback policy.
- Show child provenance in diagnostics/review UI without exposing hidden prompts.

Acceptance:

- A delegated editor/reviewer can create draft changes under the parent change set.
- Review UI identifies the source agent/profile.
- Accept/reject still applies per change.

Verification:

```bash
cd services/ai-writing-agent
npm run test:unit -- test/unit/js/tool/DelegateTaskToolTests.test.js test/unit/js/agent/AgentLoopTests.test.js
npx eslint app/js/tool app/js/agent
```

E2E gate:

- Browser triggers a delegated task that produces at least one draft change and verifies provenance in Mongo/UI diagnostics.

### M7: Remove Sync-Driven And Legacy Runtime Paths

- [x] M7: done - key files: `ToolsetPolicy.js`, `RuntimeConfigManager.js`, `AgentLoopFactory.js`, `CLAUDE.md`, `ai-assistant-pane.tsx`, `chat-input.tsx`, `ai-assistant-context.tsx`, `ai-types.ts`, `RuntimeConfigManagerTests.test.js`, `AgentLoopFactoryTests.test.js`, `ToolRegistryTests.test.js`; implementation: normal profiles no longer include `sync_workspace_changes`, sandbox-v0 is no longer advertised as a user-enabled runtime in `/runtime/status`, runtime status hides CLI adapters unless `sandbox-v0` is explicitly selected, the AI panel no longer exposes runtime-mode fallback controls or sandbox review action, chat input always uses the AgentLoop product path with model selection/attachments, and historical/non-v2 session records are forced through AgentLoopV2 instead of the old naive `AgentLoop`. The legacy sync tool, `/sandbox/*` routes, and CLI runtime adapters remain present only as explicit research/test compatibility internals, not default product UI/config. Verification: `npm run test:unit` in `services/ai-writing-agent` passed 50 files / 618 tests; `npx eslint .` in `services/ai-writing-agent` passed; `npm run type-check` in `services/web` passed; focused web ESLint for changed AI Assistant files passed; `npm run test:frontend -- --grep "ai-assistant"` remains blocked before test selection by the existing `@/features` alias resolution error while loading `test/frontend/features/ai-assistant/api/ai-api.test.ts`. E2E: after restarting `develop` `ai-writing-agent`, `web`, and `webpack`, authenticated Playwright opened project `6a355fe027c10dcad8f097bb`; `/api/ai/runtime/status` returned `runtimeMode=agent-loop-v2`, `sandboxEnabled=false`, `sandboxResearchEnabled=false`, `agentLoopV2Enabled=true`, `sandboxProvider=null`, `runtimeAdapter=null`, and no missing dependencies; the project page body had no `Fallback`, `Run sandbox review`, or `Sandbox v0` text; live-model session `6a37212ffa295d4157fda1e0` read `/main.tex` through the Web proxy, completed with `message_complete`, and tool calls contained `read_document` only with no `sync_workspace_changes`; smoke session was archived, canonical document remained clean at version 25, and the temporary browser verification user/collaborator grant was removed.

Objective:

- Delete obsolete product code after the live workspace path is verified.

Scope:

- Remove `sync_workspace_changes` from default toolsets and user-visible prompts.
- Remove sandbox-v0 UI controls and product fallback route from the AI Assistant panel.
- Remove OpenCode/Codex runtime adapters from default product config; keep only if a test or admin-only research path is explicitly justified.
- Remove naive legacy `AgentLoop` selection path once AgentLoopV2 covers all accepted E2E scenarios.
- Update docs and `CLAUDE.md` to state that Live Agent Workspace is the default and old paths are removed.

Acceptance:

- Runtime status no longer advertises sandbox-v0 as a normal user option.
- The model cannot call `sync_workspace_changes` in normal profiles.
- Tests do not depend on old pending sync behavior.
- Dead code removal does not break quick edit, autocomplete, project rules, attachment/image support, or AI panel boot.

Verification:

```bash
cd services/ai-writing-agent
npm run test:unit
npx eslint .

cd services/web
npm run type-check
npx eslint frontend/js/features/ai-assistant
```

E2E gate:

- Full browser smoke still passes with only the Live Agent Workspace product path available.

### M8: Full Acceptance And Handoff

- [x] M8: completed 2026-06-21

Objective:

- Prove the final product behavior end to end and leave the repo in a clean, committed state.

Implementation:

- Hardened `/sandbox/*` routes behind `requireAdmin`; ordinary proxied users now receive 403 and cannot access sandbox-v0/OpenCode/Codex/Pi research surfaces.
- Updated module docs so Live Agent Workspace is the product path and sandbox-v0 is admin-only research, not a fallback.
- Removed the legacy AgentLoop selection path from the session loop factory; product and historical session records now execute through AgentLoopV2.
- Fixed persistent workspace reads to retain canonical `docId`, `entityId`, `baseVersion`, and `canonicalVersion`; `edit_document` now preserves that metadata after workspace writes. This fixes Review-mode accept/writeback after draft hydration.
- Added unit coverage for canonical metadata tracking during workspace reads.

Scope:

- Run full live-model Review mode flow.
- Run full live-model Auto Accept flow.
- Run conflict flow.
- Run reload/resume flow.
- Run independent verification subagents.
- Clean test pending changes or document intentional canonical changes.
- Commit final docs and cleanup.

Acceptance:

- Review mode: live model session `6a372762d3a5edb6c6f8b66c` created draft `6a372765d3a5edb6c6f8b670`; canonical doc stayed unchanged before accept, reload restored the draft, accept wrote the canonical doc and incremented version 25 -> 26. Cleanup restored the canonical doc.
- Auto Accept: live model session `6a372aa5d3a5edb6c6f8b69c` created draft `6a372aa9d3a5edb6c6f8b6a0`, emitted `canonical_change.applying`, `canonical_change.applied`, and `draft_change.accepted`, and wrote the marker to canonical content immediately.
- Conflict: live model session `6a372aaad3a5edb6c6f8b6a4` created draft `6a372aaed3a5edb6c6f8b6a8`; after an external canonical replacement, accept returned 409 and the draft was rejected cleanly.
- Reload: Review-mode GET `/api/ai/sessions/:id` restored pending draft state before accept and accepted state after accept.
- Legacy OpenCode/sandbox-v0/naive AgentLoop product paths are gone from normal runtime/tool/UI behavior or explicitly documented as admin-only research/legacy configuration.
- Current-state legacy audit: a deliberately inserted historical session with `runtimeMode: legacy` (`6a372cbb7d9b149eb2811c19`) completed through `/api/ai/sessions/:id/messages`, and session restore serialized `runtimeMode: agent-loop-v2`, proving the old factory no longer selects naive `AgentLoop`.
- Cleanup audit: canonical root doc restored to `["此处填写摘要。"]`, active M8 sessions `0`, pending draft changes `0`, `m8-*` users `0`, and `overleaf-ai-sandbox-workspace-*` containers plus sandbox temp directories removed.

Independent verification:

- Subagent Harvey verified M7/M8 legacy exposure risk and recommended admin-only `/sandbox/*` hardening plus docs cleanup.
- Subagent Hume verified the final acceptance checklist and identified required Review, Auto Accept, Conflict, reload, cleanup, and no-leak evidence.

Verification:

```bash
cd services/ai-writing-agent
npm run test:unit -- test/unit/js/RuntimeConfigManagerTests.test.js test/unit/js/AgentController/AcceptRejectTests.test.js
npm run test:unit -- test/unit/js/tool/ReadToolTests.test.js test/unit/js/tool/EditToolTests.test.js test/unit/js/agent/LiveDraftChangeBridgeTests.test.js test/unit/js/AgentController/AcceptRejectTests.test.js
npm run test:unit
npx eslint .

cd services/web
npm run type-check
npx eslint frontend/js/features/ai-assistant test/frontend/features/ai-assistant
```

E2E gate:

- Develop stack deployed with Webpack at `http://127.0.0.1:18080`, Web at `http://127.0.0.1:13000`, AI at `http://127.0.0.1:43060`, Mongo at `127.0.0.1:37017`.
- Browser smoke verified `/api/ai/runtime/status` resolves to `agent-loop-v2`, no sandbox provider/adapter is exposed, and the AI panel no longer shows sandbox/fallback actions.
- Ordinary browser user POST to `/api/ai/sandbox/sessions` returned 403 `Admin access required`.
- Direct runtime audit after the final legacy-removal patch returned `runtimeMode=agent-loop-v2`, `sandboxEnabled=false`, `sandboxProvider=null`, `runtimeAdapter=null`, sandbox POST 403, and restored a legacy-tagged session as `agent-loop-v2`.
- Live model path used `deepseek-v4-flash` through the configured OpenAI-compatible endpoint.
- Mongo evidence records `aiSessions.m8Evidence`, `aiAgentDraftChanges`, `aiAgentChangeSets`, and `aiAgentApplyOperations` states for Review, Auto Accept, and Conflict flows.
- Independent verification subagents reported pass/fail evidence and the implementation addressed their blockers.

## 6. API And Interface Changes

Add new session-scoped APIs behind the existing Web proxy:

```text
GET  /api/ai/sessions/:sessionId/change-sets
GET  /api/ai/sessions/:sessionId/change-sets/:changeSetId
POST /api/ai/sessions/:sessionId/changes/:changeId/accept
POST /api/ai/sessions/:sessionId/changes/:changeId/reject
POST /api/ai/sessions/:sessionId/changes/:changeId/retry
POST /api/ai/sessions/:sessionId/change-sets/:changeSetId/accept-all
POST /api/ai/sessions/:sessionId/change-sets/:changeSetId/reject-all
```

Compatibility rule:

- Existing `/sessions/:id/changes/:changeId/accept` may be reused if its internals are migrated to `CanonicalWritebackService`.
- Existing `/sessions/:id/confirm-change/:changeId` should be removed with the naive synchronous confirmation path.
- Existing `/sandbox/sessions/*` endpoints should be deleted or moved to admin-only research tooling by M7.

Frontend type changes:

- Add `ChangeSet`, `DraftChange`, `ApplyOperation`, and normalized event types.
- `PendingChange` can be kept temporarily as a compatibility alias only if it maps 1:1 to `DraftChange`.
- AI context should store change sets separately from chat messages.

## 7. Testing And Verification Requirements

Do not mark a milestone complete with only unit, lint, type, or mocked tests when runtime behavior changes. Required proof levels:

- **Service unit tests** for data model, edit tool, writeback, conflict, and subagent provenance.
- **Frontend unit/type/lint** for event handling and editor overlays.
- **Manual smoke scripts** only for narrow service checks; they do not replace browser E2E.
- **Playwright browser E2E** for Review, Auto Accept, reload, and conflict.
- **Live model E2E** using `deepseek-v4-flash` unless credentials are missing.
- **Mongo/document-updater evidence** for canonical writes and draft state.
- **Independent verification subagent** for final acceptance.

If `services/web npm run test:frontend` remains blocked by unrelated alias/test-runner issues, record the exact error and compensate with focused lint/type plus Playwright E2E. Do not claim the blocked test passed.

## 8. Development Model Configuration

Use the approved OpenAI-compatible development endpoint names:

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

Never write the real key into Markdown, tracked env files, fixtures, logs, screenshots, commits, or test output.

## 9. Final Definition Of Done

The goal is complete only when all are true:

- Review mode live draft diffs appear immediately after `edit_document`.
- Auto Accept writes each edit to canonical Overleaf docs immediately through CAS.
- Reload restores sessions, change sets, and draft/apply states.
- Conflict handling is visible, deterministic, and recoverable.
- Subagent edits preserve provenance.
- `sync_workspace_changes` is no longer required for normal user-visible edit flow.
- OpenCode/sandbox-v0 and naive legacy AgentLoop product paths are removed or explicitly unreachable from default UI/config.
- All milestone commits exist and follow the commit rules.
- Full E2E evidence is recorded in this document or a final handoff note.

## 10. One-Shot Goal Prompt

```text
/goal Implement the Live Agent Workspace architecture described in services/ai-writing-agent/doc/live-agent-workspace-development-plan.md. Continue through every milestone until the Definition of Done is satisfied. Use implementation subagents for separable workstreams and independent verification subagents for browser E2E, live-model, writeback, conflict, reload, and cleanup checks. Do not stop after unit/lint/type checks. Do not mark a milestone complete without deploy/browser evidence where the milestone affects runtime behavior. Commit after every completed milestone using Conventional Commits with motivation, changes, and verification evidence. When the new live draft/auto-writeback path is fully verified, remove obsolete OpenCode/sandbox-v0 fallback paths and the legacy naive AgentLoop path as specified by the plan.
```
