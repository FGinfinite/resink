# Sandbox Command And Skill Runtime Development Plan

> Goal: turn the AgentLoopV2 persistent sandbox into a first-class command and skill runtime. The agent must be able to write scripts, execute bounded commands, activate modern directory-based skills, run skill-provided scripts, and surface results in the AI workspace while preserving Overleaf permissions, draft review, CAS writeback, and host isolation.
>
> This document is written for one long-running autonomous `/goal` execution. The agent should drive the whole migration to completion, use implementation subagents for separable workstreams, require independent verification subagents for browser/live-model/writeback/security checks, and commit after every completed milestone.

## 1. Product Direction

The current Live Agent Workspace gives AgentLoopV2 a persistent sandbox workspace, live draft changes, Auto Accept writeback, and subagent provenance. The remaining weakness is that the sandbox is still mostly consumed through narrow hand-written tools:

```text
compile_latex -> sandboxSession.run(latexmk)
read/edit/list -> workspace file helpers
activate_skill -> inject one Markdown body into context
```

That shape leaves too much product value trapped behind bespoke adapters. A real agent workspace should let the model use ordinary project-local tools in a controlled sandbox:

- write a short Python/Node/shell script to inspect or transform workspace files;
- run bounded commands and read structured stdout/stderr/exit status;
- use skill packages that contain instructions, references, scripts, and reusable assets;
- turn workspace changes from scripts into the same draft/change-set pipeline as `edit_document`;
- never execute on the host or bypass Overleaf canonical writeback.

The target product model is therefore:

**A sandbox-only command and skill runtime embedded in AgentLoopV2, where scripts and skills extend the agent's workspace abilities without extending host privileges.**

Overleaf remains responsible for:

- User identity, project membership, and write permissions.
- Canonical project tree, document versions, collaboration, and editor state.
- CAS/version-guarded canonical writes.
- Review, conflict, accept/reject, and audit UI.

`services/ai-writing-agent` becomes responsible for:

- Command policy, command execution, output redaction, and event normalization.
- Agent-generated scripts inside the persistent workspace.
- Directory-based skill discovery, validation, activation, reference loading, and script execution.
- Script-to-draft integration through the existing Live Agent Workspace pipeline.
- Security gates that fail closed instead of falling back to host or sandbox-v0 research paths.

## 2. Architecture Principles

1. **Sandbox-only execution.**
   Product command execution must always use `persistentWorkspace.sandboxSession.run()`. If no persistent sandbox exists, the command fails. It must never fall back to the host, web container, or admin-only sandbox-v0 routes.

2. **Commands operate on workspace state, not canonical truth.**
   Commands may read and write `/workspace`. Canonical Overleaf files are changed only through draft accept or Auto Accept CAS writeback.

3. **Agent scripts are allowed, but scoped.**
   The agent may create temporary scripts under `.agent/tmp/` or `.agent/scripts/` and run them through the sandbox command tool. Those scripts are turn/session artifacts, not installed skills.

4. **Skills are capability packages, not prompt blobs.**
   A skill is a directory with `SKILL.md`, optional `references/`, optional `scripts/`, and optional assets. Startup loads only metadata. Activation loads `SKILL.md`. References and scripts are used only through explicit tools.

5. **Skill scripts execute from copied sandbox material.**
   The service may read tracked skill files from the host, but execution happens only after copying or projecting allowed skill files into `.skills/<skill>/` inside the sandbox workspace.

6. **Command output is product data.**
   stdout, stderr, exit status, timeouts, output limits, artifacts, and workspace dirty state should be stored or streamed as normalized safe events. Raw low-level sandbox noise belongs behind diagnostics.

7. **Network and host escape fail closed.**
   Default command execution should have no public egress and no access to Docker socket, host mounts, privileged container mode, other project workspaces, service env, or local credentials.

8. **Commit every completed milestone.**
   After each completed and verified milestone, create one Conventional Commits-style git commit. The commit body must include motivation, main changes, validation commands, E2E evidence, and skipped checks with exact reasons.

## 3. Target Runtime Shape

```text
Browser AI panel
  -> Web /api/ai proxy injects authenticated user identity
  -> AgentSessionService resumes project agent session
  -> PersistentWorkspaceManager resumes sandbox workspace
  -> AgentLoopV2 dispatches tools
  -> activate_skill loads skill metadata/instructions
  -> read_skill_reference loads only requested reference files
  -> write_workspace_file/edit_document creates agent script or project edit
  -> run_command executes bounded command in sandbox /workspace
  -> run_skill_script executes declared skill script copied into .skills/
  -> workspace diff/draft bridge emits live draft changes when files change
  -> Review mode: user reviews draft changes before CAS writeback
  -> Auto Accept mode: accepted edits write through canonical CAS immediately
```

### Core Services

- `WorkspaceCommandService`
  - Validates command requests, workdir, env, timeout, output limits, and deny rules.
  - Calls `sandboxSession.run()` and normalizes stdout/stderr/exit/timeout/output-limit events.
  - Records command provenance and redacts secrets.

- `WorkspaceScriptService`
  - Provides safe locations for agent-generated scripts.
  - Supports writing, reading, executing, and cleaning `.agent/tmp/` artifacts.
  - Marks workspace dirty state for draft generation when scripts edit project files.

- `SkillPackageRegistry`
  - Replaces flat Markdown loading.
  - Loads directory-based skills from `services/ai-writing-agent/skills/<name>/`.
  - Validates `SKILL.md` frontmatter, directory/name match, reference paths, script paths, token/size limits, and no symlink escape.

- `SkillRuntimeService`
  - Activates skills, reads references on demand, projects script files into sandbox `.skills/<skill>/`, and runs declared scripts through `WorkspaceCommandService`.
  - Keeps skill-provided script provenance distinct from agent-generated scripts.

- `CommandEventNormalizer`
  - Emits product-safe command and skill events to SSE.
  - Hides raw logs unless diagnostics mode is enabled.

- `SandboxEscapeGuard`
  - Centralizes path, symlink, env, network, host mount, and forbidden command checks.
  - Gives unit-testable failure reasons for every blocked operation.

### Skill Directory Shape

```text
services/ai-writing-agent/skills/
  latex-polish/
    SKILL.md
    references/
      style-guide.md
      examples.md
    scripts/
      polish_pass.py
      detect_passive_voice.js
    assets/
      templates/
        response-checklist.md
```

`SKILL.md` must follow modern agent skill conventions:

```markdown
---
name: latex-polish
description: "Polish LaTeX prose and structure. WHEN: \"polish this section\", \"improve academic writing\", \"tighten LaTeX wording\"."
---

# Latex Polish

Use this skill for academic prose polishing in LaTeX projects.
Load references only when needed:
- [Style guide](references/style-guide.md)
- [Examples](references/examples.md)

Use scripts only when they materially improve the task:
- `polish_pass.py`: scans a target `.tex` file and reports candidate issues.
```

Skill constraints:

- `name` is lowercase hyphenated and matches the directory name.
- `description` explains what the skill does and when to use it.
- `SKILL.md` is short enough for activation.
- `references/*.md` are individually small and only loaded on explicit request.
- `scripts/` are executable only through `run_skill_script`, not directly from the host path.

### Tool Interfaces

`run_command`

```json
{
  "command": ["python3", ".agent/tmp/check_labels.py", "main.tex"],
  "workdir": ".",
  "timeout_ms": 120000,
  "max_output_bytes": 1048576,
  "env": {
    "PYTHONUNBUFFERED": "1"
  }
}
```

Rules:

- `command` is argv-first. Shell strings are not part of the required MVP.
- `workdir` resolves inside `/workspace`.
- `env` accepts only explicit safe variable names and values.
- The tool returns structured output, not free-form hidden state.
- Missing sandbox is an error.

`write_workspace_file`

```json
{
  "path": ".agent/tmp/check_labels.py",
  "content": "..."
}
```

Rules:

- Allows agent-generated scripts and helper files in `.agent/`.
- Allows project-file writes only if the same write would be legal through the live draft pipeline.
- Script writes under `.agent/` do not create draft changes by themselves.

`activate_skill`

```json
{
  "name": "latex-polish"
}
```

Returns:

```json
{
  "skillName": "latex-polish",
  "instructions": "...SKILL.md body...",
  "references": [
    {
      "path": "references/style-guide.md",
      "title": "Style guide"
    }
  ],
  "scripts": [
    {
      "name": "polish_pass.py",
      "path": "scripts/polish_pass.py",
      "runtime": "python3"
    }
  ]
}
```

`read_skill_reference`

```json
{
  "skill": "latex-polish",
  "path": "references/style-guide.md"
}
```

`run_skill_script`

```json
{
  "skill": "latex-polish",
  "script": "polish_pass.py",
  "args": ["main.tex"],
  "timeout_ms": 120000
}
```

Rules:

- Only scripts declared by the registry are executable.
- The service copies allowed script files into `.skills/<skill>/scripts/` before execution.
- Script args are passed as argv, not interpolated into a shell string.
- Script output and workspace changes are tracked like `run_command`.

### Normalized Events

The browser should consume these events from `/sessions/:id/messages` SSE:

```text
command.started
command.output
command.completed
command.failed
skill.activated
skill.reference.loaded
skill.script.started
skill.script.completed
workspace.file_written
workspace.dirty
draft_change.created
canonical_change.applied
security.command_blocked
```

Payloads must include stable ids, session id, turn id, tool call id, workspace-relative paths, safe command summaries, exit status, output truncation flags, and provenance. They must not include API keys, cookies, raw hidden prompts, host paths outside approved diagnostics, or service env values.

## 4. Security Model

### Required Denials

The first implementation must block or fail closed for:

- Missing persistent sandbox.
- Path escape via `..`, absolute host paths, symlinks, bind mounts, or archive extraction paths.
- Host execution fallback.
- Docker socket access and Docker CLI access.
- Privileged container flags, mount, chroot, nsenter, unshare, ptrace, systemctl, service managers.
- `sudo` and privilege escalation.
- SSH/SCP and arbitrary remote shell access.
- Raw network exfiltration tools such as `curl`, `wget`, `nc`, and unrestricted package installers unless the milestone explicitly adds a sandbox egress policy.
- Destructive root operations such as `rm -rf /`, device writes, mkfs, dd to block devices.
- Env injection through `PATH`, `LD_*`, `DYLD_*`, `NODE_OPTIONS`, or equivalent loader hooks.
- Output larger than configured command limits.
- Long-running foreground commands beyond configured timeout.

### Required Allowances

The product path should allow ordinary workspace work:

- `python3`, `node`, `perl`, `ruby`, POSIX utilities, `grep`/`rg` if present, and TeX tools available in the sandbox image.
- Reading and writing files inside the workspace.
- Creating `.agent/tmp/` helper scripts.
- Running skill scripts copied into `.skills/`.
- Collecting artifacts within configured size and glob limits.

### Boundary With Live Agent Workspace

- Commands that modify project files must not directly apply canonical changes.
- Review mode creates draft changes visible in the browser.
- Auto Accept applies accepted command/script changes through the existing canonical writeback service.
- Conflict behavior remains the same as `edit_document`: visible, deterministic, and recoverable.

## Threat Model Completion Notes

Controls verified during implementation:

- Host escape: commands run only through `persistentWorkspace.sandboxSession.run()`; path and symlink escape checks remain in providers; cleanup uses Docker fallback only for sandbox root deletion.
- Project cross-read: product sessions are authorized through Web proxy identity and project access checks before session/message/change APIs.
- Network exfiltration: forbidden command/network probes through browser product path fail closed (`curl` blocked; inline shell blocked).
- Secret leakage: command output is bounded/redacted; diagnostics show summaries and policy errors, not service env or host paths.
- Canonical write bypass: script edits become pending changes or Auto Accept CAS writes; command execution itself never writes canonical docs.
- Runaway commands: argv-first commands enforce timeout/output/artifact/file-count limits; oversized artifact and output cases are covered by unit tests.

## 5. One-Shot Delivery Board

Maintain this board by changing checkboxes and adding short completion evidence only. Do not append long diaries. If blocked, write a short handoff file with exact blocker, commands, and expected result.

Completion evidence format:

```text
M#: done - key files: <paths>; verification: <commands>; e2e: <browser/model/deploy/security evidence>; notes: <one or two lines>
```

### M0: Baseline Audit And Threat Model

- [x] M0: done - key files: `doc/sandbox-command-skill-runtime-development-plan.md`; verification: `npm run test:unit`, `npx eslint .`; e2e: runtime status/product path and browser AI panel validated; notes: threat model controls recorded above.

Objective:

- Establish the current command, sandbox, skill, and writeback paths before editing implementation code.

Scope:

- Audit `compile_latex`, `LocalDockerSandboxProvider`, `E2BSandboxProvider`, `PersistentWorkspaceManager`, `AgentLoop`, `ToolPool`, `ToolsetPolicy`, `SkillRegistry`, `activate_skill`, `ContextManager`, and admin-only `/sandbox/*` routes.
- Confirm the current product path has no model-visible generic command tool.
- Confirm sandbox-v0 remains admin-only research and is not a product fallback.
- Write a short threat model into this document or a linked section covering host escape, project cross-read, network exfiltration, secret leakage, canonical write bypass, and runaway commands.

Acceptance:

- The implementer can point to every old code path that will be replaced or extended.
- The threat model lists concrete controls and tests for each risk.
- No runtime behavior changes are made in M0.

Verification:

```bash
cd services/ai-writing-agent
npm run test:unit
npx eslint .
```

E2E gate:

- Develop stack starts.
- Browser opens a project and AI panel.
- `/api/ai/runtime/status` reports AgentLoopV2 as the product path and ordinary users cannot access `/api/ai/sandbox/sessions`.

### M1: Sandbox Command Service And `run_command`

- [x] M1: done - key files: `app/js/sandbox/WorkspaceCommandService.js`, `app/js/tool/run_command.js`, `app/js/tool/ToolPool.js`; verification: `npm run test:unit -- --run`, focused eslint; e2e: live browser/model command events and security blocked commands captured.

Objective:

- Add the first-class sandbox-only command execution tool.

Scope:

- Implement `WorkspaceCommandService`.
- Add `run_command` to the tool pool and policy under an `exec` toolset.
- Implement argv-first schema, workdir validation, env allowlist, timeout/output limits, forbidden command checks, redaction, structured results, and normalized events.
- Fail closed when `context.persistentWorkspace?.sandboxSession` is missing.
- Keep host execution impossible from product code.

Acceptance:

- The model can run a bounded command in `/workspace`.
- The result includes exit code, stdout, stderr, timeout/output-limit flags, command id, and safe summary.
- Blocked commands return deterministic security errors.
- `run_command` is available to the default AgentLoopV2 profile and unavailable to read-only/reviewer profiles unless explicitly allowed.

Verification:

```bash
cd services/ai-writing-agent
npm run test:unit -- test/unit/js/tool test/unit/js/sandbox test/unit/js/agent
npx eslint app/js test/unit/js
```

E2E gate:

- Live browser session asks the model to run a harmless command such as `python3 --version` or `printf`.
- SSE shows command events and no canonical document change.

### M2: Agent-Generated Script Workflow

- [x] M2: done - key files: `app/js/tool/write_workspace_file.js`, workspace diff/writeback bridge; verification: AI unit suite and web type-check/eslint; e2e: browser Review script flow `6a39200fb16cc216f547664a`, Auto Accept CAS `6a3925862be69eafd44b2767` appliedVersion 9.

Objective:

- Let the agent write and execute temporary scripts inside the sandbox workspace.

Scope:

- Add `write_workspace_file` or equivalent workspace-file write support for `.agent/tmp/` and `.agent/scripts/`.
- Ensure script writes do not create user-visible draft changes unless they modify project files.
- Let `run_command` execute those scripts with argv args.
- Mark workspace dirty when scripts change project files, and bridge those changes into live draft changes using the existing change-set pipeline.

Acceptance:

- The model can write a Python or Node script under `.agent/tmp/`.
- The model can execute it with `run_command`.
- If the script edits `main.tex`, Review mode shows a draft change and canonical docs remain unchanged.
- Auto Accept writes script-produced edits through CAS, not direct document mutation.

Verification:

```bash
cd services/ai-writing-agent
npm run test:unit -- test/unit/js/tool test/unit/js/agent
npx eslint app/js/tool app/js/agent test/unit/js

cd services/web
npm run type-check
npx eslint frontend/js/features/ai-assistant test/frontend/features/ai-assistant
```

E2E gate:

- Live model writes a script that appends a unique comment to `/main.tex`, runs it, sees the output, and Review mode shows the live draft.
- Accept writes the change through canonical CAS and cleanup restores the document.

### M3: Directory-Based Skill Registry

- [x] M3: done - key files: `app/js/skill/SkillRegistry.js`, `skills/*/SKILL.md`; verification: `SkillRegistryTests`, `ActivateSkillToolTests`; e2e: live migrated `polish` activation without prompt bloat.

Objective:

- Replace flat Markdown skills with modern directory-based skill packages.

Scope:

- Implement `SkillPackageRegistry` for `skills/<name>/SKILL.md`, `references/`, `scripts/`, and optional `assets/`.
- Validate directory/name match, frontmatter constraints, file size/token budget, no symlink/path escape, no duplicate skill names, no orphan executable scripts, and safe relative links.
- Keep startup metadata small.
- Remove or migrate old single-file `.md` skills.

Acceptance:

- Existing skills are migrated into directories.
- Startup lists skill names/descriptions/triggers without loading every reference.
- Invalid skills are skipped with safe diagnostics.
- Activation loads only `SKILL.md`, not all references/scripts.

Verification:

```bash
cd services/ai-writing-agent
npm run test:unit -- test/unit/js/skill test/unit/js/tool/ActivateSkillToolTests.test.js
npx eslint app/js/skill app/js/tool test/unit/js/skill test/unit/js/tool
```

E2E gate:

- Browser/live model can see and activate a migrated skill without bloating the initial prompt with all reference content.

### M4: Skill Runtime Tools

- [x] M4: done - key files: `app/js/tool/read_skill_reference.js`, `app/js/tool/run_skill_script.js`, `app/js/skill/SkillRuntimeService.js`, `skills/polish/references/style-guide.md`; verification: `SkillRuntimeServiceTests`, `ReadSkillReferenceToolTests`; e2e: live skill/reference/script draft `6a3925512be69eafd44b2763`.

Objective:

- Turn skills into executable sandbox capabilities.

Scope:

- Refactor `activate_skill` to return structured metadata: instructions, references list, scripts list, and safe provenance.
- Add `read_skill_reference`.
- Add `run_skill_script`, implemented through `SkillRuntimeService` and `WorkspaceCommandService`.
- Copy allowed skill scripts into `.skills/<skill>/scripts/` in the sandbox before execution.
- Prevent direct execution of undeclared scripts or host skill paths.

Acceptance:

- A skill reference can be loaded on demand.
- A declared skill script can run in the sandbox.
- Undeclared scripts, path escapes, and host paths are rejected.
- Skill script output is visible in SSE diagnostics and model context.

Verification:

```bash
cd services/ai-writing-agent
npm run test:unit -- test/unit/js/skill test/unit/js/tool
npx eslint app/js/skill app/js/tool test/unit/js
```

E2E gate:

- Live model activates a skill, loads one reference, runs a declared skill script, and uses the result to create a draft change.

### M5: Command And Skill Events In Frontend Diagnostics

- [x] M5: done - key files: AI Assistant diagnostics/context event handling; verification: web `npm run type-check`, frontend eslint, AI unit suite; e2e: reload diagnostics screenshot `/tmp/overleaf-reload-diagnostics-skill-subagent.png` showed restored command/skill/subagent summaries.

Objective:

- Make command and skill activity understandable without exposing dangerous internals.

Scope:

- Add frontend event types for command and skill events.
- Store command summaries, exit codes, truncated output indicators, and skill provenance in AI Assistant context.
- Show concise diagnostics in the AI panel, with full output hidden unless diagnostics mode is enabled.
- Redact secrets consistently in service and UI.

Acceptance:

- Users can tell which command/script ran and whether it succeeded.
- Long output does not overwhelm chat.
- Diagnostics never show API keys, cookies, hidden prompts, host-only paths, or service env.

Verification:

```bash
cd services/web
npm run type-check
npx eslint frontend/js/features/ai-assistant test/frontend/features/ai-assistant

cd services/ai-writing-agent
npm run test:unit
npx eslint .
```

E2E gate:

- Browser shows command/script success and failure summaries during a live model run.

### M6: Subagent Policy And Provenance

- [x] M6: done - key files: `app/js/tool/delegate_task.js`, agent profiles, `DelegateTaskToolTests`; verification: child policy/provenance unit tests and AI unit suite; e2e: delegated `writing-editor` skill/script run `6a39276e2752856d0c78b7c2` -> child `6a3927722752856d0c78b7c5`.

Objective:

- Allow subagents to use command and skill runtime safely under parent policy.

Scope:

- Extend `ToolsetPolicy` with `exec` and `skill-runtime`.
- Ensure child agents inherit parent policy and cannot escalate to forbidden tools.
- Default leaf subagents may use read-only commands and declared skill scripts only when parent policy allows them.
- Dangerous command approvals are fail-closed for subagents unless explicitly configured for a test/admin profile.
- Preserve parent/child provenance on command events, skill events, and draft changes.

Acceptance:

- A delegated task can run an allowed script and create a draft under the parent change set.
- A child agent cannot call forbidden commands or activate undeclared skill runtime paths.
- Review UI or diagnostics identifies the source child session/profile.

Verification:

```bash
cd services/ai-writing-agent
npm run test:unit -- test/unit/js/tool/DelegateTaskToolTests.test.js test/unit/js/tool test/unit/js/agent
npx eslint app/js/tool app/js/agent test/unit/js
```

E2E gate:

- Browser triggers a delegated skill/script task and verifies command provenance in Mongo and UI diagnostics.

### M7: Hardening And Escape Verification

- [x] M7: done - key files: sandbox providers, guard/policy tests, cleanup hardening; verification: 669 AI unit tests incl path/symlink/output/artifact limits; e2e: browser product path blocked `curl` and `sh -c` in `6a3929602752856d0c78b7cb`.

Objective:

- Prove command and skill runtime cannot escape the sandbox or leak host state.

Scope:

- Add explicit tests and manual probes for path escape, symlink escape, archive extraction escape, env injection, output overflow, timeout, forbidden commands, network denied, artifact over-limit, missing sandbox fail-closed, cross-project access, and admin-only sandbox-v0 isolation.
- Verify local Docker sandbox is not privileged, has no Docker socket, and uses the configured network policy.
- Verify E2B provider applies equivalent workspace/path/output restrictions or is disabled until equivalent guarantees exist.

Acceptance:

- Every listed negative case fails deterministically.
- No test requires or demonstrates host shell fallback.
- Ordinary browser users cannot reach admin-only sandbox-v0 endpoints.
- Logs and SSE contain redacted, safe error messages.

Verification:

```bash
cd services/ai-writing-agent
npm run test:unit
npx eslint .
node test/manual/sandbox-limits-smoke-test.mjs
```

E2E gate:

- Independent verification subagent attempts the negative probes through the deployed product path and records pass/fail evidence.

### M8: Full Live Acceptance And Cleanup

- [x] M8: done - key files: plan evidence, prompt-only skill compatibility removal, cleanup fixes; verification: AI full unit suite, AI eslint, Web type-check/eslint; e2e: Review, Auto Accept, skill script, subagent, reload, security, restore, cleanup all completed; cleanup left zero sandbox containers and empty `.sandboxes`.

Objective:

- Prove the final command and skill runtime end to end and leave the repo clean.

Scope:

- Run full live model Review mode flow with agent-generated script.
- Run full live model Auto Accept flow with agent-generated script.
- Run full live model skill activation/reference/script flow.
- Run subagent skill/script flow.
- Run reload/resume flow preserving command/skill diagnostics.
- Run independent verification subagents for deploy, browser, live model, writeback, security, and cleanup.
- Remove obsolete flat skill behavior and prompt-only compatibility paths.
- Update `CLAUDE.md`, settings defaults, and this document with final evidence.

Acceptance:

- The model can write and execute a script in the sandbox.
- The model can activate a directory-based skill, load a reference, and run a declared skill script.
- Script-produced project edits become Review drafts or Auto Accept CAS writes.
- Canonical docs are never directly mutated by command execution.
- Host escape and network-exfiltration probes fail closed.
- Reload restores command/skill diagnostic state.
- Cleanup leaves no active smoke sessions, pending draft residue, or unmanaged sandbox containers/directories.

Verification:

```bash
cd services/ai-writing-agent
npm run test:unit
npx eslint .

cd services/web
npm run type-check
npx eslint frontend/js/features/ai-assistant test/frontend/features/ai-assistant
```

E2E gate:

- Develop stack deployed with browser at the Webpack endpoint, Web API, AI service, Mongo, Redis, and document-updater healthy.
- Live `deepseek-v4-flash` executes all accepted flows through the Web proxy.
- Mongo/document-updater evidence proves Review, Auto Accept, skill script, subagent, reload, conflict, and cleanup behavior.

## 6. API And Interface Changes

New or changed tool names:

```text
run_command
write_workspace_file
activate_skill
read_skill_reference
run_skill_script
```

New or changed toolsets:

```text
exec: run_command, write_workspace_file
skill-runtime: activate_skill, read_skill_reference, run_skill_script
```

New normalized events:

```text
command.started
command.output
command.completed
command.failed
security.command_blocked
skill.activated
skill.reference.loaded
skill.script.started
skill.script.completed
workspace.file_written
workspace.dirty
```

Compatibility rule:

- Old flat `.md` skill loading should be removed by M8, not kept as a long-term product path.
- Existing `compile_latex` may remain as a high-level UX tool, but it should share the command execution service instead of owning a parallel command policy.
- Existing live draft/change-set/writeback APIs remain the canonical review and writeback path.

## 7. Testing And Verification Requirements

Do not mark a milestone complete with only unit, lint, type, or mocked tests when runtime behavior changes. Required proof levels:

- **Service unit tests** for command policy, path/env validation, skill registry, skill runtime, event normalization, subagent policy, and writeback integration.
- **Frontend unit/type/lint** for command/skill event handling and diagnostics UI.
- **Manual sandbox smoke tests** for limits and provider behavior.
- **Playwright browser E2E** for command execution, skill activation, script-produced draft, Auto Accept, reload, and blocked-command UX.
- **Live model E2E** using `deepseek-v4-flash` unless credentials are missing.
- **Mongo/document-updater evidence** for draft state and canonical writeback.
- **Independent verification subagents** for final acceptance and negative security probes.

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

## 9. Subagent Strategy

Use implementation subagents for separable workstreams:

- **Command runtime worker**: command service, tool schema, events, limits, and compile tool reuse.
- **Skill runtime worker**: directory registry, reference loading, script projection, and skill tool migration.
- **Security worker**: escape guard, deny rules, provider parity, and negative tests.
- **Frontend diagnostics worker**: AI Assistant context and diagnostics rendering.
- **Subagent policy worker**: delegated command/skill policy and provenance.

Use independent verification subagents that do not edit implementation code:

- **Deployment verifier**: starts the real development stack and records service health and URLs.
- **Browser verifier**: uses Playwright to verify AI panel flows and diagnostics.
- **Live model verifier**: runs `deepseek-v4-flash` through the deployed Web proxy.
- **Writeback verifier**: checks Review/Auto Accept CAS behavior in Mongo/document-updater/browser.
- **Security verifier**: attempts escape/network/host/forbidden-command probes.
- **Cleanup verifier**: verifies no smoke sessions, draft residue, containers, temp dirs, or secrets remain.

## 10. Final Definition Of Done

The goal is complete only when all are true:

- `run_command` is model-visible in allowed AgentLoopV2 profiles and executes only in the persistent sandbox workspace.
- The agent can write and run temporary scripts inside `.agent/`.
- Skills are directory-based packages with progressive disclosure and optional executable scripts.
- `activate_skill`, `read_skill_reference`, and `run_skill_script` replace prompt-only skill behavior.
- Skill scripts execute only after being projected into the sandbox workspace.
- Command/script-produced edits flow through live draft review or Auto Accept CAS writeback.
- Host fallback, host path escape, Docker socket access, unsafe env injection, and default public egress are blocked.
- Subagents cannot escalate beyond parent command/skill policy.
- Frontend diagnostics show safe command and skill provenance.
- Full unit/lint/type checks and live browser/model/writeback/security E2E evidence are recorded.
- All milestone commits exist and follow the commit rules.

## 11. One-Shot Goal Prompt

```text
/goal Implement the Sandbox Command And Skill Runtime architecture described in services/ai-writing-agent/doc/sandbox-command-skill-runtime-development-plan.md. Continue through every milestone until the Definition of Done is satisfied. Use implementation subagents for command runtime, skill runtime, security hardening, frontend diagnostics, and subagent policy workstreams. Use independent verification subagents for deployment, browser E2E, live-model, writeback, security probes, reload, and cleanup checks. Do not stop after unit/lint/type checks. Do not mark a milestone complete without deploy/browser/live-model evidence where runtime behavior changes. Commit after every completed milestone using Conventional Commits with motivation, changes, validation commands, E2E evidence, and skipped checks. Keep all command execution sandbox-only, remove prompt-only skill compatibility by the end, and never commit secrets.
```
