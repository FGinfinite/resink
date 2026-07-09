# Sandbox Agent Runtime Development Plan

> Goal: move ResInk AI from a hand-built Overleaf-specific agent runtime toward a sandbox-first LaTeX research workspace that can run mature coding-agent CLIs inside isolated workspaces.
>
> This document is written for one long-running autonomous `/goal` execution. The agent should drive the whole migration to completion, using the milestones below as checkpoints rather than separate human-triggered tasks.

## 1. Product Positioning

ResInk AI should not be "an AI chat panel bolted onto Overleaf." The target product is:

**An AI workspace for LaTeX projects, embedded in Overleaf but powered by isolated agent workspaces.**

Overleaf remains responsible for:

- User identity, project permissions, and collaboration state.
- The canonical project tree and document versions.
- Editor UI, review UI, pending changes, and final user confirmation.
- Conflict handling when applying edits back to live documents.

The sandbox runtime becomes responsible for:

- A complete project working directory.
- Shell execution, package/tool usage, and filesystem operations.
- LaTeX compilation, log inspection, PDF parsing, image extraction, OCR, tables, bibliography tooling, and generated artifacts.
- Running mature coding-agent CLIs such as OpenCode, Claude Code, Codex CLI, or Pi in a controlled workspace.
- Returning structured events, logs, artifacts, and patches to Overleaf.

The engineering goal is to stand on mature agent tooling rather than continuing to grow local replacements for streaming parsers, shell tools, PDF parsers, code runners, and bespoke tool loops.

## 2. Target Users

Primary users:

- Researchers and students writing LaTeX papers in self-hosted Overleaf.
- Research groups that want BYOK AI assistance without sending source projects to a managed SaaS.
- Power users who already understand API providers and want to configure their preferred agent/runtime.

Secondary users:

- Lab administrators maintaining a shared Overleaf deployment.
- Open-source contributors who want a small integration surface rather than a large proprietary agent implementation.

Important implications:

- Default runtime must be open-source friendly and provider-neutral. OpenCode is the preferred first adapter.
- Commercial/high-quality runtimes should be optional adapters, not product foundations. Claude Code and Codex CLI should be supported through the same adapter boundary.
- Every user-supplied credential must stay scoped to a sandbox session and must not be persisted unless the admin explicitly configures persistent model credentials.
- The system must work with private LaTeX projects and should never require public repository hosting.

### 2.1 Development Debug Model Configuration

The user has approved a DeepSeek-compatible endpoint for development and smoke testing:

```text
API base: https://api.deepseek.com/v1
Fast/smoke-test model: deepseek-v4-flash
```

A real API key was provided in the planning conversation for local development. **Do not write the key value into this Markdown file, tracked source files, fixtures, test logs, screenshots, or public documentation.** This repository has a public-sync boundary, and tracked secrets must be treated as leaks.

Autonomous agents should use this local, gitignored file convention:

```text
services/ai-writing-agent/.env.sandbox.local
```

Suggested local variables:

```bash
SANDBOX_DEBUG_API_BASE=https://api.deepseek.com/v1
SANDBOX_DEBUG_API_KEY=<provided locally, never committed>
SANDBOX_DEBUG_MODEL_FLASH=deepseek-v4-flash

# Compatibility aliases for existing manual scripts that expect OpenAI-style names.
OPENAI_API_BASE=https://api.deepseek.com/v1
OPENAI_API_KEY=${SANDBOX_DEBUG_API_KEY}
OPENAI_MODEL=deepseek-v4-flash
```

Implementation rules:

- Prefer `deepseek-v4-flash` for frequent live smoke tests.
- If `.env.sandbox.local` or equivalent environment variables are missing, do not repeatedly ask the user for the key. Run mocked/unit/sandbox tests and skip live model smoke tests with a clear message.
- Do not assume whether the endpoint requires `/v1`; implementation should normalize carefully or probe the expected OpenAI-compatible path in a manual smoke test.
- Runtime adapters must pass credentials only to the sandbox process that needs them, then clean up temporary credential files.

## 3. Architecture Principles

1. **All AI work happens in a sandbox workspace.**
   The agent reads, writes, compiles, parses, and experiments inside an isolated copy of the project.

2. **Overleaf remains the source of truth.**
   The sandbox never writes directly to `document-updater`, `docstore`, or project-history. It returns patches and artifacts.

3. **Agent CLI permissions are not the security boundary.**
   CLI permission prompts are useful UX/policy controls. Container/VM isolation, network policy, filesystem scope, resource limits, and credential scoping are the real security boundary.

4. **The orchestrator owns integration, not intelligence.**
   `services/ai-writing-agent` should coordinate sessions, sandboxes, patches, artifacts, and SSE events. It should avoid reimplementing generic agent cognition where a mature CLI can do the job.

5. **Runtime adapters must be replaceable.**
   OpenCode, Claude Code, Codex CLI, Pi, and future tools should implement the same internal contract.

6. **Patch application must stay reviewable.**
   Even if the agent rewrites files freely in sandbox, the Overleaf-facing result must be a diff or a set of pending changes that users can accept or reject.

7. **Develop vertically before broadening.**
   Build one production-grade OpenCode + local Docker path before adding multiple runtimes and cloud sandbox providers.

## 4. Existing Code To Preserve

Do not discard these parts without a replacement and tests:

- Web proxy auth bridge: `services/web/app/src/Features/AIAssistant/AIAssistantProxy.mjs`
- Session, message, and model config APIs: `services/ai-writing-agent/app/js/AgentController.js`
- Project/document permission checks.
- Pending change UI and accept/reject endpoints.
- Document apply safety: `services/ai-writing-agent/app/js/adapter/DocumentAdapter.js`
- Project file operations that must ultimately pass through Overleaf permissions.

Expected long-term change:

- Existing `AgentLoop`, custom `LLMAdapter`, many bespoke tools, and custom parsing utilities become legacy fallback code while sandbox-backed runtimes become the default path.

## 5. Target Runtime Shape

### 5.1 High-Level Flow

```text
User request in Overleaf
  -> AI Orchestrator
  -> create/resume sandbox workspace
  -> export project snapshot into sandbox
  -> run selected agent runtime inside sandbox
  -> stream runtime events/logs/artifacts
  -> compute workspace diff
  -> return patch + artifacts to Overleaf
  -> user accepts/rejects pending changes
  -> Overleaf applies accepted changes with CAS/version guards
```

### 5.2 Core Interfaces

Use TypeScript-style shapes for design clarity. Implementation may remain JavaScript initially if that matches local patterns.

```ts
type SandboxProvider = {
  createSession(input: SandboxCreateInput): Promise<SandboxSession>
  resumeSession(sessionId: string): Promise<SandboxSession>
  destroySession(sessionId: string): Promise<void>
}

type SandboxSession = {
  id: string
  workspacePath: string
  run(command: RunCommandInput): AsyncIterable<SandboxEvent>
  readFile(path: string): Promise<Buffer>
  writeFile(path: string, content: Buffer | string): Promise<void>
  listFiles(path?: string): Promise<SandboxFile[]>
  collectArtifacts(globs: string[]): Promise<Artifact[]>
}

type AgentRuntimeAdapter = {
  id: string
  displayName: string
  detect(): Promise<RuntimeDetectionResult>
  prepare(input: AgentPrepareInput): Promise<void>
  run(input: AgentRunInput): AsyncIterable<AgentRuntimeEvent>
  stop(sessionId: string): Promise<void>
}

type AgentRunResult = {
  summary: string
  diff: string
  artifacts: Artifact[]
  logs: LogRef[]
  exitCode: number | null
}
```

### 5.3 First Runtime Adapter

Default adapter: **OpenCode**.

Reasoning:

- Open source and provider-neutral.
- Fits BYOK/self-hosted deployment.
- Better match for open-source product positioning than vendor-specific CLIs.
- Existing local research already examined OpenCode workflow patterns in `services/ai-writing-agent/doc/opencode-workflow-research.md`.

Other adapters are intentionally deferred:

- Claude Code: high-quality commercial runtime.
- Codex CLI: OpenAI-friendly runtime.
- Pi: minimal experimental runtime, useful only inside a real sandbox.

## 6. Development Milestones

The milestones are checkpoints for a single long-running `/goal`, not separate user prompts. The main agent should continue through the full board unless blocked by a real technical dependency. Do not stop after Milestone 0.

Maintain this board by changing checkboxes and adding short completion evidence only. Do not append chronological logs, transcripts, or every failed attempt here; put detailed handoff notes in a separate handoff file only when blocked.

### 6.0 One-Shot Delivery Board

- [x] M0: Architecture baseline and feature flag. M0: done - key files: `config/settings.defaults.cjs`, `app/js/RuntimeConfigManager.js`, `app/js/Router.js`, `CLAUDE.md`; verification: `node --check` on changed M0 JS/CJS/test files; notes: runtime mode supports `auto | legacy | sandbox`, `/runtime/status` reports sandbox config without starting Docker.
- [x] M1: Local Docker sandbox provider interface. M1: done - key files: `app/js/sandbox/SandboxProvider.js`, `LocalDockerSandboxProvider.js`, `SandboxErrors.js`, `test/manual/sandbox-smoke-test.mjs`; verification: worker ran focused Vitest via temporary `npx` and real `node test/manual/sandbox-smoke-test.mjs`; notes: local Docker path uses temp workspace bind mount only, no repo/socket mount, process env is injected per `docker exec`.
- [x] M2: Project snapshot export and diff collection. M2: done - key files: `app/js/sandbox/ProjectSnapshotExporter.js`, `ProjectDiffCollector.js`, `app/js/util/project-path.js`; verification: `node --check` plus worker Node smoke exported, mutated, and collected modified/created/binary diff; notes: supports safe paths, manifest, text baselines, binary copy/manifest-only policy.
- [x] M3: OpenCode runtime adapter. M3: done - key files: `app/js/runtime/AgentRuntimeAdapter.js`, `OpenCodeRuntimeAdapter.js`, `RuntimeErrors.js`, `test/manual/opencode-runtime-smoke-test.mjs`; verification: worker ran focused Vitest via temporary `npx`, `node --check`, and manual smoke skipped cleanly when OpenCode missing; notes: adapter is sandbox-session based, redacts credentials, and distinguishes missing binary/auth/execution failures.
- [x] M4: Sandbox session orchestrator and SSE flow. M4: done - key files: `app/js/SandboxAgentController.js`, `app/js/sandbox/SandboxSessionManager.js`, `app/js/Router.js`, `app/js/mongodb.js`; verification: `node --check` on changed M4 files; notes: `POST /sandbox/sessions` is feature-flag gated, supports JSON/SSE event flow, records `aiSandboxSessions`, and leaves legacy message route unchanged.
- [x] M5: Patch-to-pending-changes bridge. M5: done - key files: `app/js/sandbox/PatchToPendingChanges.js`, `ProjectDiffCollector.js`, `SandboxAgentController.js`; verification: focused Vitest for patch conversion and controller accept/reject paths, `node --check`; notes: sandbox diffs produce pending edit/create/delete/artifact proposals, accept/reject routes apply user-approved text/create/delete changes through existing adapters with rollback on create write failure.
- [x] M6: LaTeX/PDF sandbox tooling image. M6: done - key files: `sandbox/Dockerfile`, `sandbox/requirements.txt`, `test/fixtures/sandbox-latex/main.tex`, `test/manual/sandbox-latex-smoke-test.mjs`; verification: `docker build -f sandbox/Dockerfile -t resink-ai-sandbox:dev .`, `node test/manual/sandbox-latex-smoke-test.mjs`; notes: fixture compiles with `latexmk`, `pdftotext` extracts expected PDF text, artifacts stay inside sandbox workspace.
- [x] M7: Frontend sandbox experience. M7: done - key files: `services/web/frontend/js/features/ai-assistant/api/ai-api.ts`, `context/ai-assistant-context.tsx`, `components/ai-assistant-pane.tsx`, `types/ai-types.ts`, `stylesheets/pages/editor/ai-assistant.scss`; verification: `npx eslint --max-warnings 0` on touched AI Assistant frontend files, sequential `npx -y esbuild@0.24.2 ... --bundle --external:*` on changed frontend TS/TSX files, and `git diff --check`; notes: UI shows runtime mode, exposes a sandbox review action, consumes sandbox SSE/JSON fallback events, appends compact progress, shows artifact summary, routes sandbox pending changes through sandbox accept/reject endpoints, and Stop aborts the fetch plus calls sandbox stop after session id is known. Full `services/web` type-check/lint runs now but still fails on pre-existing module/generated-file/admin-panel issues outside this slice.
- [x] M8: Runtime profile system. M8: done - key files: `app/js/runtime/ProfileRegistry.js`, `profiles/compile-fixer.md`, `profiles/paper-reviewer.md`, `profiles/citation-auditor.md`, `app/js/sandbox/SandboxSessionManager.js`; verification: `npx -y -p vitest@1.2.0 vitest run test/unit/js/runtime/ProfileRegistryTests.test.js --environment node --globals=false --pool forks`, `node --check`; notes: selected profiles inject runtime-neutral instructions, command hints, artifact globs, and output format into sandbox runtime prompts.
- [x] M9: Additional runtime adapters. M9: done - key files: `app/js/runtime/CommandRuntimeAdapter.js`, `CodexRuntimeAdapter.js`, `RuntimeAdapterFactory.js`, `test/unit/js/runtime/CodexRuntimeAdapterTests.test.js`; verification: `node --check` on runtime files and focused Vitest for runtime/config/session manager; notes: OpenCode now shares the command runtime contract, Codex CLI supports non-interactive `codex exec`, detection, credential redaction, and config-driven model/reasoning/sandbox args.
- [x] M10: Cloud sandbox providers. M10: done - key files: `app/js/sandbox/E2BSandboxProvider.js`, `test/unit/js/sandbox/E2BSandboxProviderTests.test.js`, `test/manual/e2b-sandbox-smoke-test.mjs`; verification: `node --check`, focused Vitest for E2B/local Docker/provider contracts, `node test/manual/e2b-sandbox-smoke-test.mjs` skipped clearly without `RUN_E2B_TESTS=1`; notes: E2B uses admin-scoped credentials, local mirror plus remote workspace sync, mocked round-trip/diff semantics, and env-gated cloud smoke.
- [x] M11: Production hardening. M11: done - key files: `app/js/sandbox/LocalDockerSandboxProvider.js`, `SandboxStartupCleanup.js`, `SandboxSessionManager.js`, `SandboxAgentController.js`, `RuntimeConfigManager.js`, `config/settings.defaults.cjs`, `test/manual/sandbox-limits-smoke-test.mjs`; verification: `node --check` on hardening files, standard `npm run test:unit -- <sandbox/runtime/controller tests>` under Vitest 4, `node test/manual/sandbox-limits-smoke-test.mjs`, `node test/manual/sandbox-smoke-test.mjs`, `node test/manual/sandbox-latex-smoke-test.mjs`; notes: local Docker provider enforces CPU/memory/pids/file/output/artifact/time limits, explicit network policy, startup/manual orphan cleanup, stop API destroys provider sessions, artifacts are session-scoped, and logs/events redact credential values.
- [x] M12: Legacy runtime deprecation plan. M12: done - key files: `RuntimeConfigManager.js`, `config/settings.defaults.cjs`, `CLAUDE.md`, `doc/legacy-runtime-deprecation-plan.md`; verification: `node --check` on config/docs-adjacent JS and focused Vitest for runtime config/provider/runtime/controller; notes: new installs default to `auto`, which resolves to sandbox when dependencies are configured; `AI_RUNTIME_MODE=legacy` remains an explicit fallback and legacy removal gates are documented.

Completion evidence format:

```text
M#: done - key files: <paths>; verification: <commands>; notes: <one or two lines>
```

Each milestone should still be implemented as a small vertical slice. Within a single `/goal`, the main agent may move to the next milestone after acceptance checks pass. If checks are blocked by optional external dependencies, record the skip reason and continue with mocked/unit coverage.

### Milestone 0: Architecture Baseline And Feature Flag

Objective:

Create the skeleton for sandbox-backed AI without changing default user behavior.

Scope:

- Add a runtime mode feature flag, for example `aiAssistant.runtimeMode = "legacy" | "sandbox"`.
- Add config stubs for sandbox provider and runtime adapter.
- Add documentation links from existing AI docs to this plan.
- Add a small status endpoint or health method that reports whether sandbox mode is configured.

Expected files:

- `services/ai-writing-agent/config/settings.defaults.cjs`
- `services/ai-writing-agent/app/js/RuntimeConfigManager.js` if runtime config is appropriate
- `services/ai-writing-agent/app/js/Router.js`
- `services/ai-writing-agent/doc/*.md`
- Tests under `services/ai-writing-agent/test/unit/js/`

Acceptance:

- Legacy AI chat still works when `runtimeMode` is absent or `legacy`.
- Sandbox mode can be enabled in config without starting a real sandbox.
- Health/status output clearly shows selected runtime mode and missing dependencies.
- Unit tests cover config parsing and default fallback.

Verification commands:

```bash
cd services/ai-writing-agent
npm run test:unit
npx eslint .
```

Handoff note:

- Record the exact feature flag name and default value in this document or a sibling implementation note.

### Milestone 1: Local Sandbox Provider Interface

Objective:

Introduce a sandbox provider abstraction with a local Docker implementation sufficient for development.

Scope:

- Define `SandboxProvider` and `SandboxSession` modules.
- Implement `LocalDockerSandboxProvider`.
- Use a minimal pinned image first; do not optimize the final image yet.
- Support create, run command, copy files in, copy files out, and destroy.
- Enforce basic limits: workspace directory scope, timeout, max output bytes, and cleanup on failure.

Expected files:

- `services/ai-writing-agent/app/js/sandbox/SandboxProvider.js`
- `services/ai-writing-agent/app/js/sandbox/LocalDockerSandboxProvider.js`
- `services/ai-writing-agent/app/js/sandbox/SandboxErrors.js`
- `services/ai-writing-agent/test/unit/js/sandbox/*`
- Optional: `services/ai-writing-agent/Dockerfile.sandbox`

Acceptance:

- Unit tests can run with a mocked command runner.
- An integration/manual script can create a sandbox, run `pwd`, write/read a file, and destroy the sandbox.
- Timeouts and max output limits are tested.
- No AI user request path uses the sandbox yet.

Verification commands:

```bash
cd services/ai-writing-agent
npm run test:unit
npx eslint .
node test/manual/sandbox-smoke-test.mjs
```

Manual smoke expectations:

- The script prints a sandbox id.
- `pwd` resolves inside the sandbox workspace.
- A test file copied into the sandbox can be read back unchanged.
- The sandbox is removed after completion.

Risk controls:

- Do not mount the Overleaf repository into the sandbox.
- Use a temporary workspace directory containing only copied project files.
- Disable Docker socket mounting inside the sandbox.

### Milestone 2: Project Snapshot Export And Diff Import

Objective:

Move an Overleaf project into a sandbox workspace and compute a patch after sandbox changes.

Scope:

- Export project documents and binary files into a workspace tree.
- Preserve file paths safely and reject unsafe paths.
- Track a manifest mapping sandbox paths to Overleaf entity ids and base versions.
- Compute unified diff between the exported snapshot and modified sandbox workspace.
- Return diff metadata without applying changes.

Expected files:

- `services/ai-writing-agent/app/js/sandbox/ProjectSnapshotExporter.js`
- `services/ai-writing-agent/app/js/sandbox/ProjectDiffCollector.js`
- `services/ai-writing-agent/app/js/util/project-path.js`
- Unit tests for path safety, manifest shape, diff generation, binary handling.

Acceptance:

- Text docs are exported with stable UTF-8 content.
- Binary files are copied or represented according to an explicit policy.
- Unsafe paths such as `../x`, absolute paths, and duplicate normalized paths are rejected.
- Diff collector reports created, modified, deleted, and binary-changed files separately.
- No live Overleaf documents are changed by this milestone.

Verification commands:

```bash
cd services/ai-writing-agent
npm run test:unit
npx eslint .
```

Manual verification:

- Use a fixture project tree or mocked adapters.
- Export snapshot, mutate a `.tex` file in sandbox, collect diff, inspect unified diff.

### Milestone 3: Runtime Adapter Interface And OpenCode Adapter

Objective:

Run OpenCode inside the sandbox through a stable adapter interface.

Scope:

- Define `AgentRuntimeAdapter`.
- Implement `OpenCodeRuntimeAdapter`.
- Support non-interactive request execution.
- Stream normalized events back to the orchestrator.
- Pass provider credentials through sandbox environment variables only for the process lifetime.
- Add runtime detection and clear error messages when OpenCode is missing.

Expected files:

- `services/ai-writing-agent/app/js/runtime/AgentRuntimeAdapter.js`
- `services/ai-writing-agent/app/js/runtime/OpenCodeRuntimeAdapter.js`
- `services/ai-writing-agent/app/js/runtime/RuntimeErrors.js`
- `services/ai-writing-agent/test/unit/js/runtime/*`
- `services/ai-writing-agent/test/manual/opencode-runtime-smoke-test.mjs`

Acceptance:

- Adapter can run a trivial prompt in a sandbox and produce a normalized final result.
- Adapter can stream command/log/text events without leaking raw credentials.
- Runtime detection distinguishes missing binary, auth/config failure, and execution failure.
- The runtime adapter does not know about Overleaf internals.

Verification commands:

```bash
cd services/ai-writing-agent
npm run test:unit
npx eslint .
node test/manual/opencode-runtime-smoke-test.mjs
```

Credential handling acceptance:

- API keys are not written to MongoDB.
- API keys are not printed in logs or SSE events.
- API keys are passed as environment variables or runtime config files inside a temporary sandbox path and removed during cleanup.

### Milestone 4: Sandbox Session Orchestrator

Objective:

Add a new AI request path that creates a sandbox, exports the project, runs the runtime adapter, and returns a diff/artifact result.

Scope:

- Add `SandboxAgentController` or equivalent service layer.
- Add a private/internal route gated behind the sandbox feature flag.
- Keep legacy `/sessions/:sessionId/messages` behavior unchanged.
- Store sandbox session metadata in MongoDB with TTL or explicit cleanup policy.
- Stream events using the existing SSE shape where possible.

Expected files:

- `services/ai-writing-agent/app/js/SandboxAgentController.js`
- `services/ai-writing-agent/app/js/sandbox/SandboxSessionManager.js`
- `services/ai-writing-agent/app/js/Router.js`
- `services/ai-writing-agent/app/js/mongodb.js`
- Acceptance tests if local test harness supports it.

Acceptance:

- With sandbox mode disabled, new route returns a clear not-enabled error.
- With sandbox mode enabled and mocked provider/runtime, the full flow emits:
  - session started
  - project exported
  - runtime started
  - runtime event(s)
  - diff collected
  - done
- Failure at each step produces a safe user-facing error and a useful internal log.
- Legacy chat tests remain green.

Verification commands:

```bash
cd services/ai-writing-agent
npm run test:unit
npm run test:acceptance
npx eslint .
```

### Milestone 5: Patch-To-Pending-Changes Bridge

Objective:

Convert sandbox diffs into Overleaf pending changes without allowing direct sandbox writes to canonical documents.

Scope:

- Parse unified diffs into per-file change proposals.
- Map sandbox paths back to Overleaf docs/entities through the export manifest.
- For modified text docs, create pending changes compatible with existing accept/reject UI.
- For new/deleted files, reuse or extend existing create/delete pending change support.
- Keep binary file changes visible as artifacts first; defer binary apply unless explicitly implemented.

Expected files:

- `services/ai-writing-agent/app/js/sandbox/PatchToPendingChanges.js`
- `services/ai-writing-agent/app/js/adapter/DocumentAdapter.js`
- `services/ai-writing-agent/app/js/agent/ConfirmationChannel.js` only if required
- Frontend type updates under `services/web/frontend/js/features/ai-assistant/types/`
- Focused unit tests.

Acceptance:

- A sandbox modification to one `.tex` file appears as a pending change in the existing AI panel.
- Accepting the pending change applies through existing document version guards.
- Rejecting it leaves the live Overleaf document unchanged.
- Conflicts are reported if the live document changed after export.
- Create/delete proposals are previewed and require explicit confirmation.

Verification commands:

```bash
cd services/ai-writing-agent
npm run test:unit
npx eslint .

cd ../web
npm run type-check
npm run lint
```

Manual verification:

- Create an Overleaf project with `main.tex`.
- Run sandbox request: "Change the abstract sentence to mention sandbox testing."
- Confirm the AI panel shows a pending diff.
- Accept it and verify the editor updates.
- Repeat after manually editing the same text before accepting; verify conflict handling.

### Milestone 6: Sandbox-First LaTeX Tooling Image

Objective:

Provide a sandbox image that makes common academic-writing tasks work without bespoke Overleaf code.

Scope:

- Build a pinned image with:
  - TeX Live basics needed by current development environment.
  - `latexmk`, `pdflatex`, `xelatex`, `bibtex`/`biber` as appropriate.
  - `ripgrep`, `git`, `diffutils`, `patch`.
  - `poppler-utils` for `pdftotext`/`pdfinfo`.
  - Python 3 with a small pinned requirements file for PDF/text utilities if needed.
  - Optional later: `chktex`, `pandoc`, `bibtool`, OCR utilities.
- Add a smoke test that compiles a minimal LaTeX fixture.
- Add a smoke test that extracts text from a small PDF fixture.

Expected files:

- `services/ai-writing-agent/sandbox/Dockerfile`
- `services/ai-writing-agent/sandbox/requirements.txt`
- `services/ai-writing-agent/test/fixtures/sandbox-latex/*`
- `services/ai-writing-agent/test/manual/sandbox-latex-smoke-test.mjs`

Acceptance:

- Image builds reproducibly.
- Minimal LaTeX fixture compiles to PDF inside sandbox.
- `pdftotext` can extract text from the generated PDF.
- Test output/artifacts are collected without writing outside sandbox workspace.

Verification commands:

```bash
cd services/ai-writing-agent
docker build -f sandbox/Dockerfile -t resink-ai-sandbox:dev .
node test/manual/sandbox-latex-smoke-test.mjs
npm run test:unit
npx eslint .
```

Risk controls:

- Keep image size acceptable but do not prematurely optimize before the smoke path is stable.
- Pin major package versions where practical.
- Document any large dependency or slow build step.

### Milestone 7: Frontend Sandbox Experience

Objective:

Expose sandbox-backed runs in the AI UI while keeping the first user experience simple.

Scope:

- Add runtime status display: legacy vs sandbox, runtime adapter, sandbox provider.
- Stream sandbox events in the AI panel.
- Display generated artifacts and logs.
- Display patch preview and accept/reject actions.
- Keep the existing chat UI usable; avoid a separate product surface unless necessary.

Expected files:

- `services/web/frontend/js/features/ai-assistant/components/*`
- `services/web/frontend/js/features/ai-assistant/context/ai-assistant-context.tsx`
- `services/web/frontend/js/features/ai-assistant/api/ai-api.ts`
- `services/web/frontend/js/features/ai-assistant/types/ai-types.ts`

Acceptance:

- User can send a sandbox-backed request from the AI panel.
- UI shows progress without blocking the editor.
- Logs/artifacts are visible but do not overwhelm normal chat output.
- Pending changes are previewable and accept/reject works.
- Legacy mode UI remains unchanged.

Verification commands:

```bash
cd services/web
npm run type-check
npm run lint
```

Manual verification:

- Start development environment.
- Enable sandbox mode.
- Run a request that compiles the project and edits a `.tex` file.
- Verify no UI overlap, no broken stream state, and no syntax/runtime console errors.

### Milestone 8: Runtime Profile System

Objective:

Move product-specific academic workflows into profiles/skills rather than hard-coded backend tools.

Scope:

- Define a profile format for tasks such as compile-fix, paper-review, citation-audit, polish, rebuttal, camera-ready.
- Profiles should generate runtime instructions, allowed command hints, artifact globs, and expected output format.
- Add project-local rules injection if present.
- Keep profiles runtime-neutral where possible.

Expected files:

- `services/ai-writing-agent/app/js/runtime/ProfileRegistry.js`
- `services/ai-writing-agent/profiles/*.md`
- `services/ai-writing-agent/test/unit/js/runtime/ProfileRegistryTests.test.js`

Acceptance:

- At least three profiles exist:
  - `compile-fixer`
  - `paper-reviewer`
  - `citation-auditor`
- Each profile can be selected through API input.
- Profile instructions are injected into the runtime prompt.
- Profiles do not contain secrets or deployment-specific paths.

Verification commands:

```bash
cd services/ai-writing-agent
npm run test:unit
npx eslint .
```

### Milestone 9: Additional Runtime Adapters

Objective:

Add optional adapters after the OpenCode path is stable.

Priority order:

1. Codex CLI adapter.
2. Claude Code adapter.
3. Pi adapter.

Scope per adapter:

- Runtime detection.
- Non-interactive execution.
- Event normalization.
- Credential injection.
- Stop/timeout behavior.
- Smoke test.

Acceptance per adapter:

- Adapter passes the shared runtime contract tests.
- Adapter can process a simple fixture project in sandbox.
- Adapter failure modes are distinguishable and user-readable.
- Adapter-specific docs explain required user configuration.

Verification commands:

```bash
cd services/ai-writing-agent
npm run test:unit
npx eslint .
node test/manual/<adapter>-runtime-smoke-test.mjs
```

Important:

- Do not add an adapter by special-casing the orchestrator.
- If the adapter contract is insufficient, improve the contract and update OpenCode tests first.

### Milestone 10: Cloud Sandbox Providers

Objective:

Support cloud sandbox providers for deployments where local Docker is not acceptable.

Candidate providers:

- E2B
- Daytona
- Modal

Scope:

- Add provider interface implementations only after local Docker provider is stable.
- Keep provider credentials admin-scoped and separate from user model credentials.
- Preserve the same project export, runtime adapter, diff collection, and cleanup behavior.

Acceptance:

- Provider passes the shared sandbox contract tests with provider-specific integration tests gated by env vars.
- Missing provider credentials skip integration tests with a clear message.
- A project snapshot can round-trip through the provider and produce a diff.

Verification commands:

```bash
cd services/ai-writing-agent
npm run test:unit
npx eslint .
RUN_E2B_TESTS=1 node test/manual/e2b-sandbox-smoke-test.mjs
```

### Milestone 11: Production Hardening

Objective:

Make sandbox mode safe enough for self-hosted deployments.

Scope:

- Per-session resource limits:
  - CPU/memory
  - wall-clock time
  - max output bytes
  - max artifact size
  - max file count
- Network policy:
  - default deny or explicit allowlist
  - provider API egress only if required
- Cleanup:
  - TTL cleanup job
  - startup cleanup of orphaned local sandboxes
  - manual admin cleanup command
- Audit logging:
  - runtime adapter id
  - sandbox provider id
  - project id
  - user id
  - command summaries
  - artifact metadata
  - no secrets

Acceptance:

- A runaway command is stopped.
- Oversized output is truncated with a clear event.
- Oversized artifacts are rejected or summarized.
- Orphaned sandbox cleanup works.
- Logs contain enough audit detail without secrets.

Verification commands:

```bash
cd services/ai-writing-agent
npm run test:unit
npx eslint .
node test/manual/sandbox-limits-smoke-test.mjs
```

### Milestone 12: Legacy Runtime Deprecation Plan

Objective:

Reduce maintenance burden after sandbox runtime is stable.

Scope:

- Identify legacy tools that are replaced by sandbox workflows.
- Keep compatibility wrappers for existing sessions if needed.
- Remove or freeze bespoke PDF/parsing/agent-loop features that are no longer needed.
- Update docs and admin configuration defaults.

Acceptance:

- New installations default to sandbox mode when configured dependencies are present.
- Legacy mode remains available for one release cycle or as an explicit fallback.
- Removed code has equivalent sandbox-backed coverage.
- `OVERLEAF-PATCHES.md` is updated for any core Overleaf changes.

Verification commands:

```bash
cd services/ai-writing-agent
npm run test:unit
npm run test:acceptance
npx eslint .

cd ../web
npm run type-check
npm run lint
```

## 7. Autonomous `/goal` Operating Rules

The intended execution style is one long `/goal` that completes the full migration. The main agent should act as an orchestrator: split work into subagents, review their outputs, integrate patches, and keep the final architecture coherent.

### 7.1 Main Agent Responsibilities

The main agent should:

1. Start with:

   ```bash
   git status --short --branch
   ```

2. Read this document and the most relevant current code before editing.

3. Treat existing dirty files as user work unless clearly created by the current run.

4. Drive all milestones to completion in one `/goal`, using the board in Section 6.0 as checkpoints.

5. If touching Overleaf core code under `services/web`, update `OVERLEAF-PATCHES.md` when the change is a lasting custom patch.

6. Prefer mocked unit tests for provider/runtime contracts, plus gated manual smoke tests for Docker/cloud dependencies.

7. Do not put real API keys in tracked files, fixtures, logs, screenshots, or tests.

8. Keep this plan maintainable:

   - update checklist state and short completion evidence;
   - do not write chronological progress logs into this file;
   - do not paste long command output into this file;
   - create a separate handoff note only when blocked or when a long `/goal` must be resumed.

9. Use subagents aggressively for independent workstreams, but keep final design decisions in the main session.

10. Before final completion, run the broad verification set in Section 12 and update the delivery board.

### 7.2 Required Subagent Strategy

Use subagents to reduce context pollution and speed up implementation. The main session should assign narrow ownership and collect results instead of loading every detail into the primary context.

Recommended parallel workstreams:

- **Sandbox provider worker**: owns `app/js/sandbox/*`, sandbox smoke tests, Docker lifecycle, cleanup.
- **Snapshot/diff worker**: owns project export, path safety, manifest, diff collector.
- **Runtime adapter worker**: owns `app/js/runtime/*`, OpenCode adapter, credential injection, runtime event normalization.
- **Orchestrator/API worker**: owns sandbox session controller, router wiring, Mongo metadata, SSE event mapping.
- **Patch bridge worker**: owns patch-to-pending-change conversion and document apply integration.
- **Frontend worker**: owns AI panel status, sandbox event rendering, artifact display, pending patch UI.
- **Verification worker**: runs tests, smoke scripts, lint/type checks, and reports failures with exact commands.

Subagent rules:

- Give every subagent a disjoint write scope.
- Tell workers they are not alone in the codebase and must not revert unrelated changes.
- Require every worker to report:
  - files changed;
  - commands run;
  - tests passed/failed;
  - risks or blockers;
  - short integration notes.
- Do not let subagents edit this plan except when explicitly assigned documentation ownership.
- The main agent must review and integrate subagent work; do not blindly trust generated patches.

### 7.3 Context Hygiene

- Keep large source-code exploration in subagents where possible.
- Main session should maintain architecture decisions, checklist status, and integration state.
- Do not duplicate the same exploration across multiple agents.
- Prefer small implementation notes or final summaries over pasting long logs.
- If a subagent discovers a design conflict, main session resolves it and updates the relevant implementation, not a running diary.

### 7.4 Handoff Rule

If the full migration cannot be completed, create or update a local handoff note with:

- objective
- current status
- files changed
- exact commands run
- failing command output summary
- next command to run

Suggested handoff path:

```text
services/ai-writing-agent/doc/sandbox-runtime-handoff-YYYY-MM-DD.md
```

## 8. Testing Strategy

### Unit Tests

Use for:

- Config parsing.
- Path safety.
- Manifest generation.
- Diff classification.
- Runtime event normalization.
- Provider interface behavior with mocked process runners.
- Patch-to-pending-change conversion.

Command:

```bash
cd services/ai-writing-agent
npm run test:unit
```

### Acceptance Tests

Use for:

- API-level route behavior.
- Session authorization.
- Legacy compatibility.
- Mocked sandbox orchestrator flows.

Command:

```bash
cd services/ai-writing-agent
npm run test:acceptance
```

### Manual Smoke Tests

Use for:

- Docker availability.
- Real sandbox lifecycle.
- Real runtime CLI behavior.
- LaTeX compile/PDF extraction.
- Cloud provider integration.

Pattern:

```bash
node test/manual/<name>-smoke-test.mjs
```

Manual tests should:

- Print dependency checks first.
- Skip with clear instructions when optional dependencies are absent.
- Avoid requiring real API calls unless an explicit env var is set.
- Clean up sandboxes even after failure.

### Web Frontend Checks

Required when touching `services/web/frontend`:

```bash
cd services/web
npm run type-check
npm run lint
```

### Web Backend Checks

Required when touching `services/web/app`:

```bash
cd services/web
npm run test:unit
npx eslint .
```

## 9. Security Checklist

Sandbox implementation is not acceptable until these are addressed:

- [x] No direct mount of host repository into sandbox. Evidence: local Docker provider bind-mounts only the temporary per-session workspace path to `/workspace`.
- [x] No Docker socket inside sandbox. Evidence: local Docker provider creates only the workspace bind mount and does not mount `/var/run/docker.sock`.
- [x] Workspace contains only exported project files and runtime config. Evidence: session manager exports project snapshot into provider workspace; provider does not mount repo/source tree.
- [x] User credentials are injected only for the runtime process. Evidence: OpenCode adapter passes credential env to the sandbox command and local Docker provider injects env with `docker exec --env`, not container creation.
- [x] Secrets are redacted from logs and SSE events. Evidence: OpenCode runtime adapter redacts credential env values and secret-like tokens before yielding normalized runtime events.
- [x] Command output has byte limits. Evidence: provider command runner and `docker exec` path enforce `maxOutputBytes`; focused unit coverage exists.
- [x] Runtime wall-clock timeout exists. Evidence: provider command runner and runtime adapter use command timeout settings; focused unit coverage exists.
- [x] Sandbox cleanup runs on success and failure. Evidence: session manager destroys provider session in `finally`, and stop API also destroys active provider session.
- [x] Orphan cleanup exists on service startup or scheduled job. Evidence: app startup calls `runSandboxStartupCleanup()`, which invokes local Docker provider `startupCleanup()` when sandbox mode is enabled.
- [x] Network policy is documented, even if initially permissive in development. Evidence: provider maps explicit policies (`deny`, `development-permissive`, `docker-network:<name>`) to Docker network mode and rejects unsupported policies.
- [x] Artifact size limits exist. Evidence: provider enforces `maxArtifactBytes` during artifact collection.
- [x] Patch application goes through Overleaf permission/version checks. Evidence: sandbox accept routes use existing `DocumentAdapter.applyEdit` and project adapters under the authenticated `x-user-id`, with conflict status on apply failures.

## 10. Configuration Sketch

Final names may change during implementation, but keep the shape close to this:

```js
aiAssistant: {
  runtimeMode: 'auto', // auto | legacy | sandbox
  sandbox: {
    provider: 'local-docker',
    image: 'resink-ai-sandbox:dev',
    e2bTemplate: null,
    workspaceTtlMs: 86_400_000,
    commandTimeoutMs: 120_000,
    maxOutputBytes: 2_000_000,
    maxArtifactBytes: 50_000_000,
    networkPolicy: 'development-permissive',
  },
  agentRuntime: {
    adapter: 'opencode',
    executable: 'opencode',
    model: null,
    reasoningEffort: null,
    sandboxMode: null,
    defaultProfile: 'paper-reviewer',
    eventFormat: 'json',
  },
}
```

## 11. API Sketch

The final API should be designed during implementation, but this is the desired shape:

```http
POST /api/ai/sandbox/sessions
POST /api/ai/sandbox/sessions/:sandboxSessionId/stop
GET  /api/ai/sandbox/sessions/:sandboxSessionId/artifacts/:artifactId
POST /api/ai/sandbox/sessions/:sandboxSessionId/changes/:changeId/accept
POST /api/ai/sandbox/sessions/:sandboxSessionId/changes/:changeId/reject
```

The public browser-facing API should continue to flow through the existing web proxy so session identity is injected by `AIAssistantProxy`.

## 12. Definition Of Done For The Full Migration

The sandbox migration is complete when:

- A normal user can ask the AI to inspect, compile, diagnose, and edit a LaTeX project through a sandbox-backed runtime.
- The runtime can parse PDFs and logs using sandbox tools without bespoke Overleaf parser code.
- At least one open-source runtime adapter works end to end. Preferred: OpenCode.
- The sandbox returns a patch and artifacts; Overleaf applies only user-approved changes.
- Legacy agent mode can be disabled without losing core AI workflows.
- All touched modules pass their required checks.
- Deployment docs explain how admins configure sandbox provider, runtime adapter, and user/API credentials.

Current verification boundary:

- Sandbox/runtime/controller touched backend files pass `node --check`, targeted ESLint with `--max-warnings 0`, and the targeted `npm run test:unit -- <sandbox/runtime/controller tests>` suite under the installed Vitest 4 toolchain.
- Full `services/ai-writing-agent npm run test:unit` passes under the installed Vitest 4 toolchain (40 files, 536 tests), and full `services/ai-writing-agent npx eslint .` passes.
- Touched AI Assistant/frontend integration files pass targeted ESLint with `--max-warnings 0` and esbuild bundle checks; required web dependencies for Lexical input, AI proxying, and runtime config are declared in `services/web/package.json`, and ignored generated lezer parser modules have CE-safe type declarations for clean-checkout type-checks.
- Real local Docker sandbox smoke tests pass for lifecycle, limits, LaTeX compilation, PDF text extraction, artifact collection, and cleanup.
- Full `services/web npm run type-check` passes after declaring CE-safe optional module types for absent private modules and ignored generated lezer parser modules.
- Full `services/web npm run lint` passes after declaring required web dependencies, cleaning touched AI Assistant/admin integration lint, and configuring CE-safe lint exceptions for absent optional/private module paths.
- 2026-06-19 deployment verification updated the boundary: direct model calls are mandatory for runtime work. The development endpoint at `https://api.deepseek.com/v1` returned `正常` from `deepseek-v4-flash` via the AI container environment. Local Docker sandbox lifecycle and LaTeX/PDF smoke pass when `AI_SANDBOX_ROOT_DIR=/tmp/overleaf-ai-sandboxes` is shared with the host Docker daemon.
- OpenCode is not yet accepted as the full end-to-end runtime for this endpoint. The sandbox image contains `opencode 1.17.8` and OpenCode can discover the custom provider/model, but streaming through `@ai-sdk/openai-compatible` currently fails with `AI_APICallError: openai_error`; keep this as an integration blocker until a real OpenCode run produces a normal result event.

## 13. Near-Term Recommended `/goal` Sequence

Use a single `/goal` objective rather than issuing one prompt per milestone:

```text
/goal Implement the full sandbox-backed agent runtime migration described in services/ai-writing-agent/doc/sandbox-agent-runtime-development-plan.md. Continue through all milestones until the Definition of Done is satisfied. Use subagents for independent workstreams, keep the main session focused on dispatch/review/integration, update the checklist with short evidence, and do not stop after early milestones unless a real blocker requires a handoff.
```

Execution order inside that single goal:

1. Complete the OpenCode + local Docker vertical path first: M0 through M8.
2. Start M9 only after the OpenCode path is accepted.
3. Start M10 only after the local Docker provider is accepted.
4. Complete M11 hardening before any claim of production readiness.
5. Complete M12 only after sandbox mode covers the core AI workflows.
