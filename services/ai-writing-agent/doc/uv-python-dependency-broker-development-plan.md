# UV Python Dependency Broker Development Plan

> Goal: make Python useful inside the AgentLoopV2 sandbox without turning package installation into an uncontrolled supply-chain risk.
>
> The target is a `uv`-based dependency broker that resolves, locks, audits, caches, and approves Python environments outside the normal agent runtime. Agents and skills can request capabilities; only approved, reproducible environment snapshots execute inside project sandboxes.
>
> This document is written for one long-running autonomous `/goal` execution. The agent should drive the whole migration to completion, use implementation subagents for separable workstreams, require independent security/runtime/browser verification subagents, and commit after every completed milestone.

## 1. Product Direction

The sandbox command and skill runtime gives ResInk AI a real workspace:

```text
AgentLoopV2
  -> persistent sandbox workspace
  -> run_command / run_skill_script
  -> scripts and artifacts
  -> Live Agent Workspace draft/change-set pipeline
```

The next product gap is Python dependencies. A bare Python interpreter is too weak for research writing workflows, but unrestricted package installation is not acceptable in a SaaS-style agent:

- A pure Python image cannot reliably parse PDFs, inspect data, transform tables, plot figures, validate BibTeX, or run skill-provided analysis scripts.
- Letting the model run `pip install`, `uv add`, `uv pip install`, or arbitrary `uv tool install` at task time creates supply-chain, egress, reproducibility, and cost risks.
- Skill scripts often have predictable dependencies, so forcing them through a human package-install loop makes the skill system less useful than mature agent products.
- Project-specific Python dependencies may be legitimate, but they must be resolved under platform policy rather than through model-generated shell commands.

The target product model is:

**A brokered Python capability layer: `uv` resolves dependencies, the platform approves locked environment snapshots, and sandbox scripts run only against approved snapshots.**

This keeps the useful parts of mature products:

- OpenAI/Codex-style managed environments, setup phases, skills with scripts, and separated harness/compute boundaries.
- OpenHands-style custom sandbox images and dependency-capable runtimes.
- Hermes-style skills that can call external tools through `uv`, but only when the platform has decided that the tool environment is allowed.

It avoids the unsafe parts:

- No package manager execution as an unreviewed model action.
- No direct runtime access to arbitrary PyPI, private indexes, Git URLs, or direct wheel URLs.
- No host Python, host shell, or global environment mutation.
- No hidden, non-reproducible dependency state.

## 2. Ownership Model

This problem should not be assigned to the end user or the LLM. It should be assigned to a platform service.

| Actor | Owns | Does not own |
|---|---|---|
| Skill author | Declares required Python capabilities, dependencies, Python version, scripts, references, and test commands. | Production approval, index credentials, or runtime sandbox privileges. |
| Agent | Requests a capability or reports a missing dependency. | Choosing arbitrary indexes, installing packages directly, bypassing locks, or approving risk. |
| Dependency broker | Resolves dependencies with `uv`, creates lockfiles, audits packages, stores snapshots, and returns environment handles. | Applying Overleaf document changes or deciding user-facing edit acceptance. |
| Platform admin/security policy | Defines trusted indexes, approval rules, package risk thresholds, license rules, and egress policy. | Per-turn model reasoning or user document editing. |
| Project owner/user | Approves whether a skill may process the project and whether declared runtime network access is allowed. | Supply-chain triage for packages and indexes. |
| Overleaf/ResInk control plane | Auth, project permissions, Live Agent Workspace change sets, CAS writeback, billing, audit, and UI. | Executing untrusted code directly. |
| Sandbox execution plane | Runs scripts against approved environments with bounded filesystem, network, CPU, memory, pids, time, and output. | Persisting secrets or deciding package trust. |

## 3. Architecture Principles

1. **Use `uv`, but never expose `uv` as a free-form model tool.**
   The product path uses `uv` inside the dependency broker and approved sandbox setup paths. Normal agent toolsets must not expose raw `uv add`, `uv pip install`, `pip install`, or unconstrained `uv tool install`.

2. **Capabilities are approved; packages are implementation details.**
   Skills and agents should request "run the latex-table-analysis Python environment" or "approve dependency request X", not "please install package Y from URL Z" during a live edit.

3. **Resolution and execution are separate.**
   Dependency resolution, download, audit, and snapshot creation happen in a broker/quarantine worker. Runtime project sandboxes consume existing snapshots and should not reach public package indexes.

4. **Lockfiles are required for execution.**
   `uv.lock`, script lockfiles, exported hash manifests, or broker-generated environment manifests are required before an environment can be used by `run_skill_script`.

5. **Runtime sandboxes default to no package egress.**
   The dependency broker may have restricted egress to approved package indexes and advisory services. Normal agent runtime sandboxes should use approved caches/snapshots and deny package manager network access.

6. **Index trust is explicit and ordered.**
   Do not use pip-style `--extra-index-url` semantics. Keep `uv`'s default `first-index` behavior and pin packages to explicit indexes where needed.

7. **Wheels are normal; source builds are exceptions.**
   Prefer audited wheels for the target platform. Source distributions, native extension builds, Git dependencies, editable installs, and direct URLs require higher-risk approval or are denied by default.

8. **Secrets stay in the control plane.**
   Index credentials, model keys, Overleaf cookies, and platform secrets are never stored in projects, skills, lockfiles, screenshots, logs, or Mongo records visible to the model.

9. **Environment state is observable and reproducible.**
   Every approved snapshot records inputs, lockfiles, uv version, Python version, source indexes, hashes, audit results, SBOM, approver, and build logs with secrets redacted.

10. **The final output still flows through Live Agent Workspace.**
    Python scripts may create artifacts or modify workspace files. User-visible document changes still become draft changes and CAS-gated writeback operations.

## 4. Reference Systems And Takeaways

### OpenAI Agents SDK / Sandbox Agents

OpenAI's sandbox-agent model separates the agent harness from sandbox compute. The harness owns orchestration, approvals, tracing, and recovery; the sandbox session owns files, commands, and environment isolation.

Relevant takeaways:

- Keep ResInk's `AgentLoopV2` and Overleaf integration in the control plane.
- Treat Python environments as sandbox compute state, not as privileged service state.
- Store enough environment state to resume, snapshot, or recreate work.

Sources:

- <https://developers.openai.com/api/docs/guides/agents/sandboxes>
- <https://openai.github.io/openai-agents-python/sandbox/guide/>

### OpenAI Codex Environments And Skills

Codex cloud uses setup scripts and managed environments before agent work. Agent internet access is off by default unless configured. Codex skills are directories with `SKILL.md`, optional `scripts/`, `references/`, and `assets/`.

Relevant takeaways:

- ResInk should split dependency setup from agent execution.
- Skill scripts should be package resources, not ad hoc prompt text.
- Skills can carry dependency declarations, but the platform decides how and when those dependencies are installed.

Sources:

- <https://developers.openai.com/codex/cloud/environments>
- <https://developers.openai.com/codex/skills>
- <https://developers.openai.com/cookbook/examples/skills_in_api>

### Anthropic Claude Code / Agent Skills

Claude Code and Agent Skills use reusable skill directories with instructions and optional scripts/resources. Claude Code also emphasizes permissions and sandbox settings for subprocesses.

Relevant takeaways:

- File-tool permissions are not enough if scripts can run subprocesses.
- `run_skill_script` needs OS/container-level restrictions, not only LLM policy.
- Per-skill and per-subagent permissions should be explicit.

Sources:

- <https://docs.anthropic.com/en/docs/claude-code/skills>
- <https://code.claude.com/docs/en/permissions>

### OpenHands

OpenHands recommends Docker sandboxes and supports custom images for dependencies. Process sandboxes are documented as unsafe. Its custom sandbox guidance shows that tools and languages can be pre-installed into a runtime image.

Relevant takeaways:

- A curated base sandbox image is a valid Tier 0 dependency layer.
- Custom runtime images are useful, but product code still needs a policy layer for user/project/skill dependencies.
- Do not copy the "always approve inside an unsafe process" pattern into a SaaS product.

Sources:

- <https://docs.openhands.dev/openhands/usage/sandboxes/overview>
- <https://docs.openhands.dev/openhands/usage/advanced/custom-sandbox-guide>

### Hermes-Style Skills

Hermes optional agent skills show patterns like installing an external CLI with `uv tool install` and then invoking it through a terminal tool.

Relevant takeaways:

- `uv tool install` is useful for CLI-like skill capabilities, but it belongs in a brokered build/setup path.
- A skill may define a reusable tool environment; the model should not install it freely in a live user session.

Source:

- <https://hermes-agent.nousresearch.com/docs/user-guide/skills/optional/autonomous-ai-agents/autonomous-ai-agents-openhands>

### Python Packaging And `uv`

`uv` supports inline script dependency metadata, script lockfiles, project lock/sync workflows, index configuration, and a default `first-index` strategy intended to reduce dependency-confusion risk.

Relevant takeaways:

- Support PEP 723 metadata for single-file skill scripts.
- Support `pyproject.toml` and `uv.lock` for skill or project environments.
- Require locked execution paths (`uv sync --locked` / `--frozen`, script lockfiles, broker snapshots).
- Keep `first-index`; deny `unsafe-first-match` and `unsafe-best-match`.

Sources:

- <https://docs.astral.sh/uv/guides/scripts/>
- <https://docs.astral.sh/uv/concepts/projects/sync/>
- <https://docs.astral.sh/uv/concepts/indexes/>
- <https://peps.python.org/pep-0723/>

### Python Supply-Chain Controls

Pip warns that `--extra-index-url` can cause dependency confusion. Hash-checking mode requires pinned requirements and hashes for all dependencies.

Relevant takeaways:

- Do not expose `--extra-index-url` style configuration to agents.
- Export hash manifests for approved environments.
- Deny or heavily review source builds because build backends can execute code during installation.

Sources:

- <https://pip.pypa.io/en/stable/cli/pip_install/>
- <https://pip.pypa.io/en/stable/topics/secure-installs/>
- <https://pypi.org/project/pip-audit/>

## 5. Target Runtime Shape

```text
SkillPackageRegistry
  -> discovers skill metadata and dependency declarations
  -> does not install dependencies

AgentLoopV2
  -> activates skill
  -> run_skill_script requests environment by skill/env key

PythonEnvironmentBroker
  -> validates request against policy
  -> resolves with uv in quarantine worker
  -> produces uv.lock / script.lock / env manifest / SBOM / audit report
  -> stores approved environment snapshot

SandboxEnvironmentStore
  -> caches or restores approved snapshots into project sandbox
  -> exposes env handle to WorkspaceCommandService

WorkspaceCommandService
  -> runs script with approved env
  -> enforces time/output/resource/network limits
  -> emits command and skill events

Live Agent Workspace
  -> detects changed project files/artifacts
  -> creates draft changes
  -> applies through CAS only when accepted or Auto Accept allows it
```

### Environment Tiers

| Tier | Name | Purpose | Allowed by default | Network during runtime |
|---|---|---|---|---|
| 0 | Base sandbox image | Common research-writing tools. | Yes. Built by platform CI. | No package egress. |
| 1 | Built-in skill env | Official ResInk skills with locked dependencies. | Yes after CI approval. | No package egress. |
| 2 | Project locked env | User project has `pyproject.toml` and `uv.lock`. | Optional, project-owner controlled. | No package egress after restore. |
| 3 | New dependency request | Unknown packages or new versions. | No. Requires broker review. | Broker-only restricted egress. |
| 4 | High-risk env | Native builds, direct URLs, VCS deps, private indexes, GPU/large packages. | Admin/security approval only. | Broker-only restricted egress plus special runtime policy if needed. |

### Curated Tier 0 Baseline

The sandbox image should include `uv` plus a conservative scientific/document-processing profile. Exact versions are pinned in the sandbox image build, not in this plan.

Candidate baseline:

```text
python 3.12
uv
numpy
scipy
pandas
matplotlib
seaborn
scikit-learn
sympy
statsmodels
networkx
pillow
beautifulsoup4
lxml
bibtexparser
pylatexenc
pypdf
python-docx
PyYAML
rich
```

Guidelines:

- Keep Tier 0 broad enough for common research writing work.
- Avoid large, GPU, browser, database, or language-server packages in Tier 0 unless repeated E2E evidence justifies them.
- Add Tier 0 packages through normal image PR/review, not through user sessions.

## 6. Skill Dependency Contract

Directory-based skills may include dependency metadata, but not installer commands as executable policy.

Recommended shape:

```text
services/ai-writing-agent/skills/latex-table-analysis/
  SKILL.md
  skill.json
  pyproject.toml
  uv.lock
  scripts/
    analyze_tables.py
  references/
    table-style-guide.md
  tests/
    fixture.tex
    expected.json
```

`skill.json`:

```json
{
  "name": "latex-table-analysis",
  "runtime": {
    "python": {
      "environment": "skill",
      "pythonVersion": "3.12",
      "lockfile": "uv.lock",
      "projectFile": "pyproject.toml",
      "network": "none",
      "approvedSnapshot": null
    }
  },
  "scripts": [
    {
      "name": "analyze_tables",
      "path": "scripts/analyze_tables.py",
      "runtime": "python",
      "entrypoint": ["python", "scripts/analyze_tables.py"],
      "timeoutMs": 30000,
      "outputLimitBytes": 131072
    }
  ]
}
```

Single-file scripts may use PEP 723 inline metadata:

```python
# /// script
# requires-python = ">=3.12,<3.13"
# dependencies = [
#   "pandas==2.2.3",
# ]
# [tool.uv]
# exclude-newer = "2026-06-24T00:00:00Z"
# ///
```

Execution rule:

- The broker may read PEP 723 metadata and generate a script lockfile.
- Runtime execution must use the locked/broker-approved environment.
- If metadata changes, the broker creates a new environment request.
- The agent cannot edit dependency metadata and immediately execute it without broker approval.

## 7. Project Dependency Contract

Some Overleaf projects may legitimately include Python helpers, data-processing scripts, or notebooks.

Allowed project sources:

- `pyproject.toml`
- `uv.lock`
- `.python-version`
- PEP 723 metadata in project scripts

Default behavior:

- If `uv.lock` exists and the project owner enables project Python environments, the broker may validate the lock and create a project snapshot.
- If `pyproject.toml` exists without a lockfile, the broker may create a pending dependency request but must not auto-install during the agent turn.
- If scripts contain PEP 723 metadata without adjacent locks, the broker may create a pending dependency request.
- Project-supplied index URLs, direct URLs, Git dependencies, local path dependencies, editable installs, and build-system requirements require policy review.

User-facing behavior:

```text
This project includes Python dependencies that are not approved for sandbox execution.
Dependency request: depreq_...
Status: pending review
The agent can continue without this script, or an admin/project owner can approve the environment.
```

## 8. Policy Model

### Package Source Policy

Allowed source categories:

| Source | Default | Notes |
|---|---|---|
| Public PyPI through platform proxy | Allowed for low-risk Tier 1/2 after audit. | Direct public access from runtime sandbox denied. |
| Internal package mirror/proxy | Preferred. | Supports caching, index credentials, and artifact retention. |
| Explicit third-party wheel index | Admin-approved only. | Example: PyTorch CPU wheels; use explicit index pinning. |
| Private organization index | Admin-approved only. | Credentials injected only into broker. |
| Direct wheel URL | Deny by default. | May be allowed for reviewed high-risk envs with hash pinning. |
| Git/VCS URL | Deny by default. | Requires source review and immutable commit pin. |
| Local path dependency | Deny for shared skills; limited project-local use only. | Must not escape workspace. |
| Editable install | Deny by default. | Not reproducible enough for shared env snapshots. |
| Source distribution build | Deny by default. | Build backends execute code. |

### Resolver Policy

Required:

- `uv` is the only supported Python resolver/installer for brokered environments.
- Use `first-index` behavior.
- Pin Python major/minor version.
- Record `uv --version`.
- Store lockfile and exported manifest.
- Prefer `--no-build` / wheel-only policies unless high-risk approval is present.
- Run vulnerability and malware advisory checks where available.

Denied in normal product path:

```text
pip install
uv pip install
uv add
uv tool install
uv run without approved env
uv sync without --locked or --frozen equivalent
unsafe-first-match
unsafe-best-match
--extra-index-url
direct URL dependencies
VCS dependencies
editable installs
sdist builds
```

### Runtime Network Policy

Default:

```text
Broker quarantine worker:
  egress allowlist:
    - internal package proxy
    - approved upstream package indexes
    - OSV / advisory services
    - license/SBOM metadata services if configured

Project agent sandbox:
  egress:
    - none by default
    - optional domain/method allowlist per skill or project
  package indexes:
    - denied
```

### Audit Fields

Each approved environment snapshot must store:

```json
{
  "environmentId": "pyenv_...",
  "scope": "base|skill|project|request",
  "ownerType": "platform|skill|project|admin",
  "ownerId": "...",
  "pythonVersion": "3.12.x",
  "uvVersion": "0.8.22",
  "platform": "linux-x86_64",
  "sourceFiles": ["pyproject.toml", "uv.lock"],
  "lockHash": "sha256:...",
  "manifestHash": "sha256:...",
  "sbomHash": "sha256:...",
  "indexes": [
    {
      "name": "platform-pypi-proxy",
      "urlRedacted": "https://packages.example.invalid/simple",
      "explicit": true
    }
  ],
  "packages": [
    {
      "name": "pandas",
      "version": "2.2.3",
      "sourceIndex": "platform-pypi-proxy",
      "artifact": "pandas-2.2.3-...whl",
      "hash": "sha256:..."
    }
  ],
  "policyDecision": "approved",
  "riskTier": "low|medium|high",
  "approver": "system|admin|security",
  "approvedAt": "2026-06-24T00:00:00Z"
}
```

## 9. Services And Data Model

### Services

- `PythonEnvironmentBroker`
  - Main orchestration service for dependency requests, resolution, audit, approval, and snapshot publication.

- `SkillDependencyResolver`
  - Reads skill dependency metadata from `skill.json`, `pyproject.toml`, `uv.lock`, and script PEP 723 blocks.
  - Produces normalized dependency requests.

- `ProjectDependencyResolver`
  - Reads project-level Python metadata from sandbox workspace snapshots.
  - Produces project-scoped dependency requests without installing packages.

- `DependencyPolicyEngine`
  - Applies source, package, index, license, vulnerability, malware, native-build, size, and egress policies.

- `QuarantineUvWorker`
  - Runs `uv` in a separate locked-down build/resolve sandbox.
  - Has restricted package egress and no Overleaf/model/user secrets.

- `SandboxEnvironmentStore`
  - Stores approved environment snapshots and restores them into persistent project sandboxes.
  - May be implemented with OCI image layers, tar snapshots, volume snapshots, or provider-native sandbox templates.

- `PythonRuntimeMountService`
  - Projects an approved Python environment into the runtime sandbox in a read-only or controlled writable location.

- `DependencyEventNormalizer`
  - Emits frontend-safe and audit-safe events for dependency requests, approvals, resolution, and runtime attachment.

### Mongo Collections

`aiPythonDependencyRequests`:

```js
{
  _id,
  projectId,
  sessionId,
  userId,
  scope: 'skill' | 'project' | 'script' | 'manual',
  requester: {
    type: 'agent' | 'user' | 'admin' | 'system',
    id
  },
  skillName,
  scriptPath,
  sourceFiles: [
    { path, hash, kind: 'skill-json' | 'pyproject' | 'uv-lock' | 'pep723' }
  ],
  requestedPackages: [
    { name, specifier, sourceHint, reason }
  ],
  requestedPythonVersion,
  requestedNetworkPolicy,
  status: 'pending' | 'resolving' | 'needs-approval' | 'approved' | 'denied' | 'failed',
  riskTier,
  policyFindings: [
    { code, severity, message, packageName }
  ],
  environmentId,
  createdAt,
  updatedAt
}
```

`aiPythonEnvironmentSnapshots`:

```js
{
  _id,
  environmentKey,
  scope: 'base' | 'skill' | 'project' | 'request',
  skillName,
  projectId,
  pythonVersion,
  uvVersion,
  platform,
  lockHash,
  manifestHash,
  sbomHash,
  artifactRef,
  packageCount,
  packages: [
    { name, version, sourceIndex, artifactHash, riskFlags }
  ],
  indexes: [
    { name, urlRedacted, explicit, authenticated }
  ],
  policyDecision,
  approvedBy,
  approvedAt,
  expiresAt,
  createdAt
}
```

`aiPythonEnvironmentUsages`:

```js
{
  _id,
  environmentId,
  projectId,
  sessionId,
  turnId,
  skillName,
  scriptPath,
  commandId,
  attachedAt,
  detachedAt,
  result: 'completed' | 'failed' | 'timeout' | 'denied',
  outputBytes,
  artifactIds
}
```

## 10. API And Event Surface

### Internal/Admin APIs

```text
GET  /api/ai/python/environments
GET  /api/ai/python/environments/:environmentId
POST /api/ai/python/dependency-requests
GET  /api/ai/python/dependency-requests/:requestId
POST /api/ai/python/dependency-requests/:requestId/resolve
POST /api/ai/python/dependency-requests/:requestId/approve
POST /api/ai/python/dependency-requests/:requestId/deny
POST /api/ai/python/environments/:environmentId/rebuild
```

Rules:

- Approval/deny/rebuild endpoints are admin-only or project-owner-only depending on policy.
- Normal agents do not call approval endpoints.
- All endpoints redact credentials, package index tokens, and raw logs with secrets.

### Tool-Level Behavior

`activate_skill` should include dependency summary:

```json
{
  "skillName": "latex-table-analysis",
  "python": {
    "required": true,
    "environmentStatus": "approved|pending|missing|denied",
    "environmentId": "pyenv_...",
    "dependencyRequestId": "depreq_..."
  }
}
```

`run_skill_script` should fail closed:

```json
{
  "ok": false,
  "error": {
    "code": "PYTHON_ENV_NOT_APPROVED",
    "dependencyRequestId": "depreq_...",
    "message": "The script requires an approved Python environment before execution."
  }
}
```

`run_command` should block package manager commands in normal profiles:

```json
{
  "ok": false,
  "error": {
    "code": "PACKAGE_MANAGER_DENIED",
    "message": "Python package installation is handled by the dependency broker, not by runtime commands."
  }
}
```

### Events

```text
python_dependency.requested
python_dependency.resolving
python_dependency.policy_findings
python_dependency.approved
python_dependency.denied
python_dependency.failed
python_environment.snapshot_created
python_environment.attached
python_environment.detached
python_environment.audit_ready
python_environment.runtime_denied
```

Frontend behavior:

- In normal AI chat, show concise dependency status only when it affects the task.
- In diagnostics, show request id, environment id, package count, risk tier, and policy findings.
- Never show index credentials, full private URLs, tokens, or secret-bearing logs.

## 11. Milestone Board

Status format:

```text
- [ ] Mx: pending
- [~] Mx: in progress - owner/evidence
- [x] Mx: done - key files, verification, E2E/security evidence, commit
```

- [x] M0: Baseline audit and threat model - 2026-06-24 backend audit plus browser AI panel harmless command/denied command evidence complete.
- [x] M1: Dependency metadata schema and skill/project discovery - 2026-06-24 backend discovery slice and activation diagnostics complete; dependency-backed skill activation output now exposes scripts, references, Python dependency status, and `run_skill_script` usage.
- [x] M2: Policy engine and package-manager command denial - 2026-06-24 backend policy, sandbox-tool denial, and browser/live-model denial E2E complete.
- [x] M3: Quarantine `uv` resolver worker - 2026-06-24 local worker, broker approval integration, and admin/project-owner approval surfaces complete.
- [x] M4: Environment snapshot store and sandbox attachment - 2026-06-24 uv runtime site-packages snapshot restore, snapshot integrity verification, cache GC, Local Docker read-only runtime env mounts, and explicit fail-closed unsupported-provider handling complete.
- [x] M5: `run_skill_script` integration - 2026-06-24 dependency-backed skill request/retry, approved env attach, browser Auto Accept writeback, and reload diagnostics complete.
- [x] M6: Project-level Python environment requests - 2026-06-24 read-only project metadata request tool and project-owner request decision API complete.
- [x] M7: Admin/project-owner approval UI and APIs - 2026-06-24 admin UI/API, authenticated dev-stack web admin approval, project-owner decision API, and AI diagnostics project-owner UI complete.
- [x] M8: Security hardening, SBOM, audit, and egress controls - 2026-06-24 audit metadata, CycloneDX SBOM export, script package-manager bypass hardening, approval lease hardening, broker policy hardening, Docker-isolated restricted broker runner, package-index proxy egress verification, snapshot integrity checks, Local Docker read-only env mounts, unsupported-provider fail-closed handling, and default runtime egress deny complete.
- [x] M9: Full E2E acceptance and cleanup - 2026-06-24 live browser skill request/approve/retry, Auto Accept CAS writeback, reload diagnostics, denied bypass browser evidence, targeted cleanup, snapshot cache GC, Local Docker independent security verification, package-index proxy independent security verification, independent live browser/model smoke, and independent full dependency-smoke browser re-run complete.

### 2026-06-24 Implementation Checkpoint

This checkpoint establishes the backend safety baseline needed before building the broker worker.

Implemented:

- `SkillDependencyResolver` reads optional `skill.json`, `pyproject.toml`, `uv.lock`, and script PEP 723 metadata without installing dependencies.
- `ProjectDependencyResolver` can normalize project `pyproject.toml`, `uv.lock`, `.python-version`, and PEP 723 metadata into project-scoped dependency requests.
- `DependencyPolicyEngine` evaluates normalized requests against source-kind, runtime-network, package-count, and default policy config.
- `activate_skill` returns `python` metadata so diagnostics can show whether an environment is required.
- Skill `approvedSnapshot` metadata is treated as a requested key only; it does not self-approve execution.
- `run_skill_script` fails closed for Python scripts that require dependencies but do not have a broker-approved environment.
- `SandboxEscapeGuard` blocks direct and wrapper package-manager commands, including `pip`, `python -m pip`, `python -I -m pip`, `python -c` subprocess package-manager spawns, `/usr/bin/env uv ...`, `uv add|pip|tool|run|sync|lock|export|python|venv`, `uvx`, `pipx`, `poetry`, `conda|mamba|micromamba`, `npm`, `npx`, `yarn`, `pnpm`, and `corepack`.
- Package-manager denials now emit `python_environment.runtime_denied` through `WorkspaceCommandService`, and tool wrappers preserve that event.

Verified:

```bash
cd services/ai-writing-agent
npm run test:unit -- test/unit/js/python test/unit/js/sandbox test/unit/js/skill test/unit/js/tool
npx eslint app/js/python app/js/sandbox app/js/skill app/js/tool test/unit/js/python test/unit/js/sandbox test/unit/js/skill test/unit/js/tool
node test/manual/sandbox-smoke-test.mjs
```

Results:

- Vitest: 34 files / 290 tests passed.
- ESLint: passed for touched backend areas.
- Docker sandbox smoke: created sandbox `5b89d383-d2b2-44df-ad7b-fa8c2d80e9de`, verified `/workspace`, file roundtrip, artifact collection, and destroy.
- Manual tool-level Python policy probe in real `resink-ai-sandbox:dev`: `python3 --version` succeeded with Python 3.11.2; `python3 -m pip install cowsay` returned `PACKAGE_MANAGER_DENIED` and emitted `python_environment.runtime_denied`.

Not yet complete:

- Project-level dependency discovery is implemented as a resolver but is not wired into a product request flow yet.
- Broker-owned approved environment provisioning does not exist yet; M3/M4 must provide the authoritative approval and snapshot boundary.

### 2026-06-24 M1 Activation Diagnostics Checkpoint

Implemented:

- `activate_skill` now returns the original `SKILL.md` instructions plus an explicit `Available skill assets` section in the model-visible output.
- The activation output lists declared references, runnable scripts using the exact `run_skill_script skill="<name>" script="<script>"` shape, script runtime, Python environment status, and package requirements.
- Structured tool data and `skill.activated` events still carry the same `references`, `scripts`, `python`, and provenance fields for UI/SSE consumers.

Verified:

```bash
cd services/ai-writing-agent
npm run test:unit -- test/unit/js/tool/ActivateSkillToolTests.test.js
node --check app/js/tool/activate_skill.js
npx eslint app/js/tool/activate_skill.js test/unit/js/tool/ActivateSkillToolTests.test.js
node --input-type=module <dependency-smoke-activation-smoke>
```

Results:

- Vitest: 1 file / 6 tests passed.
- ESLint: passed for `activate_skill` and its focused tests.
- Real skill registry smoke loaded `dependency-smoke` and printed:
  - `Scripts:`
  - `run_skill_script skill="dependency-smoke" script="dependency_probe.py" (python3)`
  - `Python environment: missing; packages: typing-extensions==4.12.2`

### 2026-06-24 M3 Worker Checkpoint

Implemented:

- `QuarantineUvWorker` resolves dependency metadata in a temporary quarantine workspace outside the project runtime sandbox.
- Worker supports project lock, project lock validation, and PEP 723 script lock command shapes.
- Worker injects a restricted environment only: safe process variables, `UV_CACHE_DIR` inside the temp workspace, `UV_NO_PROGRESS=1`, and `UV_INDEX_STRATEGY=first-index`.
- Worker evaluates `DependencyPolicyEngine` before invoking `uv`, so direct URL, VCS, local path, network, and package-count policy findings can deny before resolution.
- Worker redacts secret-like stdout/stderr and returns structured lock artifacts with SHA-256 hashes.
- Missing `uv` returns `UV_MISSING`; non-zero resolver exits return `UV_RESOLUTION_FAILED`.

Verified:

```bash
cd services/ai-writing-agent
npm run test:unit -- test/unit/js/python
npx eslint app/js/python test/unit/js/python
```

Results:

- Vitest: 5 files / 15 tests passed.
- ESLint: passed for Python broker files.
- Manual local `uv` fixture: `QuarantineUvWorker` ran `uv lock --script scripts/no_deps.py` with `uv 0.8.22` and produced `scripts/no_deps.py.lock`.

Not yet complete:

- M3 has no admin API endpoint yet.
- Resolver egress was process-local in this slice; a later M8 checkpoint moves restricted resolution into the Docker broker runner.
- This worker produces lock artifacts, not approved runtime snapshots; M4 must add snapshot storage and attachment.

### 2026-06-24 M4 Snapshot Checkpoint

Implemented:

- `SandboxEnvironmentStore` stores approved Python environment snapshots under platform-owned storage with a manifest, file hashes, environment id validation, and path escape rejection.
- `PythonRuntimeMountService` restores a snapshot into the persistent sandbox under `.agent/python-envs/<environmentId>/`.
- Runtime attach writes `.resink-env-manifest.json` with sandbox/session provenance and emits `python_environment.attached`.
- The snapshot format is file-list based for the local provider and current sandbox API; tar/OCI layers and read-only mounts remain future hardening work.
- Local Docker now projects approved runtime env files from a provider-managed host directory mounted read-only at `/workspace/.agent/python-envs`.

Verified:

```bash
cd services/ai-writing-agent
npm run test:unit -- test/unit/js/python
npx eslint app/js/python test/unit/js/python
```

Results:

- Vitest: 7 files / 19 tests passed.
- ESLint: passed for Python broker files.
- Manual real sandbox attach probe: stored `pyenv_smoke`, attached it to `.agent/python-envs/pyenv_smoke`, read back `bin/python`, and verified `.resink-env-manifest.json` plus `python_environment.attached`.

Not yet complete:

- Providers that do not expose provider-managed immutable runtime env storage fail closed for Python environment attachment.
- Detach currently records provenance but does not delete restored files because the sandbox provider does not expose a delete API yet.
- Snapshot GC, TTL, max disk accounting, and cross-project reuse policy enforcement need follow-up in M8.

### 2026-06-24 M5 Skill Runtime Checkpoint

Implemented:

- `SkillRuntimeService` automatically attaches an approved Python environment before running dependency-backed Python skill scripts.
- Missing or unapproved dependency environments still fail closed with `PYTHON_ENV_NOT_APPROVED`.
- Approved scripts receive `PYTHON_ENV_ROOT` pointing at `.agent/python-envs/<environmentId>/`.
- `python_environment.attached` events are included in the `run_skill_script` event stream before command execution events.
- `SandboxEscapeGuard` allows the broker-controlled `PYTHON_ENV_ROOT` env var while continuing to reject `PATH`, loader hooks, and package-manager commands.

Verified:

```bash
cd services/ai-writing-agent
npm run test:unit -- test/unit/js/skill/SkillRuntimeServiceTests.test.js test/unit/js/tool/RunSkillScriptToolTests.test.js test/unit/js/sandbox/WorkspaceCommandServiceTests.test.js test/unit/js/python
npx eslint app/js/skill/SkillRuntimeService.js app/js/sandbox/SandboxEscapeGuard.js app/js/python test/unit/js/skill/SkillRuntimeServiceTests.test.js test/unit/js/sandbox/WorkspaceCommandServiceTests.test.js test/unit/js/python
```

Results:

- Vitest: 10 files / 39 tests passed.
- ESLint: passed for touched M5 files.
- Manual real sandbox skill smoke: approved env `pyenv_skill_smoke` attached, Python script read `.agent/python-envs/pyenv_skill_smoke/lib/marker.txt` through `PYTHON_ENV_ROOT`, stdout was `mounted-env`, and event order included `skill.script.started`, `python_environment.attached`, command events, and `skill.script.completed`.

Not yet complete:

- Python scripts still use the base `python3` interpreter in this slice; M4/M5 attach exposes environment files, but interpreter shims or virtualenv activation need the final snapshot format.
- Script-produced file changes still need browser/live-model Live Agent Workspace E2E evidence.

### 2026-06-24 M6 Project Request Checkpoint

Implemented:

- Added read-only `inspect_python_environment` diagnostics tool.
- The tool scans the persistent sandbox workspace for `pyproject.toml`, `uv.lock`, `.python-version`, and optional PEP 723 script metadata.
- It uses `ProjectDependencyResolver` plus `DependencyPolicyEngine` to produce project-scoped dependency request data without running installers or `uv`.
- It emits frontend-safe `python_dependency.requested` events with project/session provenance, request fingerprint, risk tier, and findings.
- The tool is available through the diagnostics toolset and remains removable through `allowDiagnostics: false`.

Verified:

```bash
cd services/ai-writing-agent
npm run test:unit -- test/unit/js/tool/InspectPythonEnvironmentToolTests.test.js test/unit/js/tool/ToolRegistryTests.test.js test/unit/js/python
npx eslint app/js/tool/inspect_python_environment.js app/js/tool/ToolPool.js app/js/tool/ToolsetPolicy.js test/unit/js/tool/InspectPythonEnvironmentToolTests.test.js test/unit/js/tool/ToolRegistryTests.test.js app/js/python test/unit/js/python
```

Results:

- Vitest: 9 files / 50 tests passed.
- ESLint: passed for touched M6 files.
- Manual real sandbox project probe: wrote `pyproject.toml` plus `uv.lock`, ran `inspect_python_environment`, received status `locked`, package `pandas==2.2.3`, and event `python_dependency.requested`.

Not yet complete:

- Project-owner/admin approval is not implemented until M7.
- Project snapshots are not yet automatically built from approved project requests.
- UI diagnostics still need browser verification.

### 2026-06-24 M7 Approval API Checkpoint

Implemented:

- Added Mongo collections and indexes for `aiPythonDependencyRequests`, `aiPythonEnvironmentSnapshots`, and `aiPythonEnvironmentUsages`.
- Added `PythonDependencyRequestService` for request list/detail/upsert/approve/deny.
- Added admin-only API endpoints:
  - `GET /api/ai/admin/python/dependency-requests`
  - `GET /api/ai/admin/python/dependency-requests/:requestId`
  - `POST /api/ai/admin/python/dependency-requests/:requestId/approve`
  - `POST /api/ai/admin/python/dependency-requests/:requestId/deny`
- Approval/deny responses serialize audit fields and do not expose credentials or raw resolver logs.
- Router admin guard covers the new approval endpoints.

Verified:

```bash
cd services/ai-writing-agent
npm run test:unit -- test/unit/js/python/PythonDependencyRequestServiceTests.test.js test/unit/js/PythonDependencyControllerTests.test.js test/unit/js/RouterAdminGuardTests.test.js
npx eslint app/js/python/PythonDependencyRequestService.js app/js/PythonDependencyController.js app/js/Router.js app/js/mongodb.js test/unit/js/python/PythonDependencyRequestServiceTests.test.js test/unit/js/PythonDependencyControllerTests.test.js test/unit/js/RouterAdminGuardTests.test.js
```

Results:

- Vitest: 3 files / 7 tests passed.
- ESLint: passed for touched M7 backend files.

Not yet complete:

- Project-owner scoped low-risk approval policy is not implemented; current endpoints are admin-only.

### 2026-06-24 M7 Project-Owner Decision API Checkpoint

Implemented:

- Added project-scoped dependency decision endpoints that do not require site admin:
  - `POST /api/ai/projects/:projectId/python/dependency-requests/:requestId/approve`
  - `POST /api/ai/projects/:projectId/python/dependency-requests/:requestId/deny`
- Project routes require the authenticated user to have write access to the project via `checkProjectWriteAccess(projectId, userId)`.
- Project-owner approval is intentionally narrower than admin approval:
  - request must belong to the route `projectId`;
  - request status must be `pending`, `needs-approval`, or `failed`;
  - requested runtime network policy must be `none`;
  - risk tier must be empty, `none`, or `low`;
  - `error`, `high`, or `critical` policy findings are not project-owner approvable.
- Project-owner deny is allowed for the project request after write-access and project-id checks, so project owners can decline unwanted dependency requests without involving a site admin.
- Admin approval routes are unchanged and still require `x-user-is-admin = true`.

Verified:

```bash
cd services/ai-writing-agent
npm run test:unit -- test/unit/js/PythonDependencyControllerTests.test.js test/unit/js/RouterAdminGuardTests.test.js
npx eslint app/js/PythonDependencyController.js app/js/Router.js test/unit/js/PythonDependencyControllerTests.test.js test/unit/js/RouterAdminGuardTests.test.js

cd develop
docker compose -f docker-compose.yml -f docker-compose.dev.yml exec -T ai-writing-agent node --input-type=module <project-owner-decision-probe>
```

Results:

- Controller/router suite passed: 2 files / 10 tests.
- Focused ESLint passed for controller, router, and tests.
- Real AI service HTTP probe used user `6a31658e9fdcbec69eaf2b4d` and project `6a355fe027c10dcad8f097bb` through signed proxy headers:
  - high-risk project approval with `requestedNetworkPolicy = network` returned `403` and `Project owner approval is not allowed for this dependency request`;
  - project-owner deny for a project request returned `200`, `status = denied`, `decisionReason = project owner declined`, and `deniedBy = 6a31658e9fdcbec69eaf2b4d`;
  - temporary probe requests were removed after verification.

Not yet complete:

- Project-owner approval still resolves through the same broker worker and can fail if policy/resolver/snapshot publication fails.

### 2026-06-24 M7 Project-Owner Diagnostics UI Checkpoint

Implemented:

- The AI workspace diagnostics panel now preserves structured `python_dependency.requested` event metadata in workspace log entries.
- Added project-scoped frontend API wrappers for:
  - `POST /api/ai/projects/:projectId/python/dependency-requests/:requestId/approve`
  - `POST /api/ai/projects/:projectId/python/dependency-requests/:requestId/deny`
- Low-risk project dependency requests now show Approve/Deny icon actions in the AI workspace diagnostics panel.
- The UI only shows project-owner actions when the diagnostic log has a project id, request id, pending/non-final status, low/none risk tier, and no high-severity policy finding.
- Approval/denial reasons are fixed product audit strings, not free-form model output.

Verified:

```bash
cd services/web
OVERLEAF_CONFIG=$(pwd)/config/settings.webpack.js npx cypress run --component --browser chromium --spec test/frontend/features/ai-assistant/components/agent-workspace-panel.spec.tsx
npx eslint frontend/js/features/ai-assistant/api/ai-api.ts frontend/js/features/ai-assistant/components/agent-workspace-panel.tsx frontend/js/features/ai-assistant/context/ai-assistant-context.tsx frontend/js/features/ai-assistant/types/ai-types.ts test/frontend/features/ai-assistant/components/agent-workspace-panel.spec.tsx
npm run type-check
```

Results:

- Cypress Chromium component browser: 4 tests passed, including project-owner dependency Approve/Deny API calls and request bodies.
- ESLint: passed for touched AI assistant frontend files.
- TypeScript: `tsc --noEmit` passed.

Not yet complete:

- This is component-browser coverage for the AI workspace diagnostics UI. A full live-model browser flow that creates a dependency request and approves it from the project-owner UI remains part of M9.

### 2026-06-24 M8 Audit Hardening Checkpoint

Implemented:

- `QuarantineUvWorker` now returns audit manifest data, `manifestHash`, CycloneDX 1.5 SBOM JSON, and `sbomHash` for resolver outputs.
- CycloneDX SBOM output includes deterministic package components, package URLs for pinned PyPI packages, resolver tool metadata, dependency request properties, and artifact hash properties.
- `SandboxEnvironmentStore` stores snapshot audit fields: `manifestHash`, `sbomHash`, `policyDecision`, `approvedBy`, and `approvedAt`.
- Added `PythonEnvironmentUsageService` and wired `PythonRuntimeMountService` to record `aiPythonEnvironmentUsages` attach audit entries.
- `python_environment.attached` events include `usageId`.
- Skill runtime passes skill/script provenance into environment attachment usage records.
- Independent security verification found a script-execution bypass where agents could write `.agent/scripts/*` and invoke package managers from inside the script.
- `WorkspaceCommandService` now reads workspace/skill scripts before execution and rejects package-manager invocations hidden inside script content.
- `LocalDockerSandboxProvider` and `E2BSandboxProvider` now create write-parent directories one segment at a time after realpath checks, preventing symlink parent `mkdir` side effects outside the workspace.
- `write_workspace_file` no longer pre-creates host directories outside the provider write-path guard.

Verified:

```bash
cd services/ai-writing-agent
npm run test:unit -- test/unit/js/python test/unit/js/skill/SkillRuntimeServiceTests.test.js
npx eslint app/js/python app/js/skill/SkillRuntimeService.js test/unit/js/python test/unit/js/skill/SkillRuntimeServiceTests.test.js
npm run test:unit -- test/unit/js/sandbox/WorkspaceCommandServiceTests.test.js test/unit/js/sandbox/LocalDockerSandboxProvider.test.js test/unit/js/sandbox/E2BSandboxProviderTests.test.js test/unit/js/tool/WriteWorkspaceFileToolTests.test.js test/unit/js/tool/RunCommandToolTests.test.js test/unit/js/tool/RunSkillScriptToolTests.test.js test/unit/js/skill/SkillRuntimeServiceTests.test.js
npx eslint app/js/sandbox app/js/tool/write_workspace_file.js test/unit/js/sandbox test/unit/js/tool/WriteWorkspaceFileToolTests.test.js test/unit/js/tool/RunCommandToolTests.test.js test/unit/js/tool/RunSkillScriptToolTests.test.js test/unit/js/skill/SkillRuntimeServiceTests.test.js
node --input-type=module <script-deny-probe>
npm run test:unit -- test/unit/js/python/QuarantineUvWorkerTests.test.js test/unit/js/python/DependencyMetadataTests.test.js test/unit/js/python/PythonDependencyRequestServiceTests.test.js
npx eslint app/js/python/QuarantineUvWorker.js app/js/python/DependencyMetadata.js test/unit/js/python/QuarantineUvWorkerTests.test.js
docker exec -i develop-ai-writing-agent-1 env -u NODE_OPTIONS node --input-type=module <cyclonedx-sbom-probe>
```

Results:

- Vitest: 11 files / 33 tests passed.
- Vitest security hardening slice: 7 files / 57 tests passed.
- Vitest CycloneDX slice: 3 files / 19 tests passed.
- ESLint: passed for touched M8 files.
- ESLint CycloneDX slice: passed for worker, dependency metadata, and worker tests.
- Manual real sandbox probe: `PACKAGE_MANAGER_DENIED:workspace-script-package-manager` before Docker exec.
- Container CycloneDX probe: `sbom.bomFormat = CycloneDX`, `specVersion = 1.5`, component `pandas@2.2.3` with `pkg:pypi/pandas@2.2.3`, and no `UV_INDEX_URL` forwarded into the broker subprocess environment.

Not yet complete:

- Broker resolver now defaults to the Docker-isolated broker runner in the later M8 checkpoint; this earlier slice was process-local at the time.
- Runtime restored environment files require provider-level immutable runtime env storage. Local Docker satisfies this with a read-only mount; providers without `writeRuntimeEnvironmentFile` fail closed.

### 2026-06-24 M8 Broker Network Policy Checkpoint

Implemented:

- Added `aiAssistant.pythonDependencyBroker.networkPolicy`, defaulting to `restricted` via `AI_PYTHON_DEPENDENCY_BROKER_NETWORK_POLICY`.
- `PythonDependencyRequestService` passes the broker network policy into its default `QuarantineUvWorker`, while preserving explicit test/controlled-call overrides.
- `QuarantineUvWorker` now fails closed before invoking `uv` unless the broker policy is one of `restricted` or `package-index-proxy`.
- `QuarantineUvWorker` no longer forwards arbitrary `UV_*` environment variables. It only forwards the safe UV variables that the worker itself controls: `UV_CACHE_DIR`, `UV_INDEX_STRATEGY`, and `UV_NO_PROGRESS`.
- Dangerous package index and keyring environment variables such as `UV_INDEX_URL`, `UV_EXTRA_INDEX_URL`, `UV_KEYRING_PROVIDER`, and `PIP_INDEX_URL` are stripped from broker subprocess environments.

Verified:

```bash
cd services/ai-writing-agent
npm run test:unit -- test/unit/js/python/QuarantineUvWorkerTests.test.js test/unit/js/python/PythonDependencyRequestServiceTests.test.js test/unit/js/python/DependencyPolicyEngineTests.test.js
npx eslint app/js/python/QuarantineUvWorker.js app/js/python/PythonDependencyRequestService.js test/unit/js/python/QuarantineUvWorkerTests.test.js test/unit/js/python/PythonDependencyRequestServiceTests.test.js config/settings.defaults.cjs
docker exec -i develop-ai-writing-agent-1 env -u NODE_OPTIONS node --input-type=module <broker-network-policy-probe>
```

Results:

- Vitest: 3 files / 20 tests passed.
- ESLint: passed for touched broker hardening files.
- Container probe: unsupported `development-permissive` broker policy returned `BROKER_NETWORK_POLICY_DENIED` with `runnerCalls = 0`.
- Container probe: default service-created worker reported `serviceNetworkPolicy = restricted`.
- Container probe: `UV_INDEX_URL`, `UV_EXTRA_INDEX_URL`, `UV_KEYRING_PROVIDER`, and `PIP_INDEX_URL` were not present in the `uv` runner environment; `UV_NO_PROGRESS = 1` and `UV_INDEX_STRATEGY = first-index` were set by the worker.

Not yet complete:

- This checkpoint was process-level fail-closed hardening at the time. The later Docker broker runner checkpoint moves restricted resolution into a container network namespace.
- The allowlisted `package-index-proxy` policy is a named policy gate only; the actual package-index proxy implementation and egress verification remain open.

### 2026-06-24 M8 Approval Surface Hardening Checkpoint

Implemented:

- Removed the latent `PythonDependencyRequestService.approveExistingEnvironment()` helper so approval cannot mark a request approved by directly passing an `environmentId`.
- Project-owner diagnostics events now use `policyFindings`, matching the frontend and serialized request terminology.
- The AI workspace diagnostics approval predicate now mirrors the server's project-owner policy more closely:
  - risk tier must be explicitly `low` or `none`;
  - unclassified requests no longer show Approve/Deny actions;
  - `error`, `high`, or `critical` findings suppress project-owner actions.

Verified:

```bash
cd services/ai-writing-agent
npm run test:unit -- test/unit/js/python/PythonDependencyRequestServiceTests.test.js test/unit/js/tool/InspectPythonEnvironmentToolTests.test.js test/unit/js/PythonDependencyControllerTests.test.js
npx eslint app/js/python/PythonDependencyRequestService.js app/js/tool/inspect_python_environment.js test/unit/js/python/PythonDependencyRequestServiceTests.test.js test/unit/js/tool/InspectPythonEnvironmentToolTests.test.js

cd services/web
OVERLEAF_CONFIG=$(pwd)/config/settings.webpack.js npx cypress run --component --browser chromium --spec test/frontend/features/ai-assistant/components/agent-workspace-panel.spec.tsx
npx eslint frontend/js/features/ai-assistant/components/agent-workspace-panel.tsx test/frontend/features/ai-assistant/components/agent-workspace-panel.spec.tsx
```

Results:

- AI service Vitest: 3 files / 23 tests passed.
- AI service ESLint: passed for touched approval-surface files.
- Web Cypress Chromium component browser: 5 tests passed, including unclassified/high-risk dependency diagnostics not showing project-owner decision actions.
- Web ESLint: passed for touched AI diagnostics component and component tests.

Follow-up:

- Resolver lease hardening is covered by the next M8 checkpoint.

### 2026-06-24 M8 Resolver Lease Checkpoint

Implemented:

- Dependency approvals now acquire an atomic resolver lease before invoking `uv`.
- Active `resolving` requests with an unexpired lease return the current request without starting another resolver.
- Stale `resolving` requests can be recovered by acquiring a new lease.
- Successful, denied, failed, and exception approval exits clear resolver lease fields.
- Added `aiAssistant.pythonDependencyBroker.resolverLeaseTtlMs`, defaulting to 15 minutes via `AI_PYTHON_DEPENDENCY_BROKER_RESOLVER_LEASE_TTL_MS`.

Verified:

```bash
cd services/ai-writing-agent
npm run test:unit -- test/unit/js/python/PythonDependencyRequestServiceTests.test.js test/unit/js/PythonDependencyControllerTests.test.js
npx eslint app/js/python/PythonDependencyRequestService.js config/settings.defaults.cjs test/unit/js/python/PythonDependencyRequestServiceTests.test.js
docker exec -i develop-ai-writing-agent-1 env -u NODE_OPTIONS node --input-type=module <resolver-lease-probe>
```

Results:

- Vitest: 2 files / 21 tests passed.
- ESLint: passed for resolver lease files and tests.
- Container resolver lease probe: active unexpired `resolving` request returned `status = resolving` with no resolver call; stale resolving request acquired a new lease expiring at `2026-06-24T00:15:00.000Z` and called the resolver once.

Not yet complete:

- A background reaper/metrics job for stale resolver leases is still useful operational hardening; this checkpoint prevents duplicate concurrent resolution and allows stale recovery on the next approval attempt.

### 2026-06-24 M8 Snapshot Integrity Checkpoint

Implemented:

- `SandboxEnvironmentStore.getSnapshot()` now exposes `readVerifiedFile(file)` for manifest-backed file reads.
- Snapshot restore verifies each file hash before returning content to runtime attachment.
- Snapshot restore also verifies recorded file size when present.
- `PythonRuntimeMountService` uses verified snapshot reads before writing approved environment files into the sandbox workspace.
- Tampered snapshots fail closed before any runtime environment files, manifests, or usage records are written.
- `.agent/python-envs` is now a reserved runtime path for command policy: `run_command` cannot use it as a workdir or pass it as an explicit command argument, blocking direct command-level mutation or inspection of copied approved environments.

Verified:

```bash
cd services/ai-writing-agent
npm run test:unit -- test/unit/js/python/SandboxEnvironmentStoreTests.test.js test/unit/js/python/PythonRuntimeMountServiceTests.test.js test/unit/js/python/PythonDependencyRequestServiceTests.test.js test/unit/js/skill/SkillRuntimeServiceTests.test.js
npx eslint app/js/python/SandboxEnvironmentStore.js app/js/python/PythonRuntimeMountService.js test/unit/js/python/SandboxEnvironmentStoreTests.test.js test/unit/js/python/PythonRuntimeMountServiceTests.test.js
docker exec -i develop-ai-writing-agent-1 env -u NODE_OPTIONS node --input-type=module <snapshot-integrity-probe>
npm run test:unit -- test/unit/js/sandbox/WorkspaceCommandServiceTests.test.js test/unit/js/tool/RunCommandToolTests.test.js test/unit/js/skill/SkillRuntimeServiceTests.test.js test/unit/js/python/PythonRuntimeMountServiceTests.test.js
npx eslint app/js/sandbox/SandboxEscapeGuard.js test/unit/js/sandbox/WorkspaceCommandServiceTests.test.js
docker exec -i develop-ai-writing-agent-1 env -u NODE_OPTIONS node --input-type=module <reserved-python-env-path-probe>
```

Results:

- Vitest: 4 files / 29 tests passed.
- Vitest reserved runtime path slice: 4 files / 27 tests passed.
- ESLint: passed for touched snapshot integrity files.
- ESLint reserved runtime path slice: passed for sandbox guard and command-service tests.
- Container probe: tampered `site-packages/pkg.py` returned `Python environment snapshot hash mismatch: site-packages/pkg.py`.
- Container probe: sandbox write count stayed `0`, proving the tampered snapshot failed before runtime attachment.
- Container reserved-path probe: direct workdir, Python inline write, and direct file argument access to `.agent/python-envs/...` all returned `SANDBOX_PATH_POLICY_DENIED` with `reserved-python-env-path`; sandbox run count stayed `0`.

Not yet complete:

- Local Docker snapshot files are now written to provider-managed storage and mounted read-only into the runtime sandbox. Providers without native runtime env storage fail closed for Python env attachment; the reserved-path guard remains a defense-in-depth command policy, not the primary immutability boundary.
- Manifest hash verification currently relies on per-file manifest entries from the approved snapshot. A full signed manifest or external transparency/audit record remains future hardening.

### 2026-06-24 M9 Backend Approval Loop Checkpoint

Implemented:

- `inspect_python_environment` persists discovered project dependency requests through `PythonDependencyRequestService`, while remaining read-only and not invoking `uv`.
- Admin approval now reads the persisted request, marks it resolving, runs `QuarantineUvWorker`, writes a `SandboxEnvironmentStore` snapshot, and updates the request with a generated `environmentId`, lock hash, resolver status, manifest hash, SBOM hash, `uvVersion`, policy decision, and approval audit fields.
- Approval no longer accepts a request-body `environmentId` bypass through the public controller path; resolver denial, resolver failure, and resolver/snapshot exceptions transition the request to `denied` or `failed` instead of publishing a snapshot.
- `SkillRuntimeService` now retries dependency-backed scripts by looking up an approved request by dependency fingerprint before failing closed, so an approved request can be used without reloading the skill registry.
- `PythonDependencyController.serializeRequest` exposes resolver/snapshot audit fields needed by an admin UI.

Verified:

```bash
cd services/ai-writing-agent
npm run test:unit -- test/unit/js/python/PythonDependencyRequestServiceTests.test.js test/unit/js/tool/InspectPythonEnvironmentToolTests.test.js test/unit/js/skill/SkillRuntimeServiceTests.test.js test/unit/js/PythonDependencyControllerTests.test.js
npx eslint app/js/python/PythonDependencyRequestService.js app/js/tool/inspect_python_environment.js app/js/skill/SkillRuntimeService.js app/js/PythonDependencyController.js test/unit/js/python/PythonDependencyRequestServiceTests.test.js test/unit/js/tool/InspectPythonEnvironmentToolTests.test.js test/unit/js/skill/SkillRuntimeServiceTests.test.js test/unit/js/PythonDependencyControllerTests.test.js
node --input-type=module <python-dependency-approve-no-deps-probe>
```

Results:

- Vitest backend loop slice: 6 files / 30 tests passed after independent verification fixes.
- ESLint: passed for touched backend loop files.
- Manual real `uv` no-deps approve probe: request became `approved`, generated `pyenv_project_manual-project_manualrequest`, and wrote a `uv.lock` snapshot hash.

Not yet complete:

- This slice proves the backend request/approve/retry loop, not full M9.
- `QuarantineUvWorker` still only produces lock artifacts for the snapshot; it does not yet build/export a full third-party package runtime environment.
- Admin-panel UI is component-browser verified, but not yet exercised through a full authenticated dev-stack browser session with live DB data.
- Review draft diff, Auto Accept CAS writeback, reload/resume diagnostics, project-owner approval, sandbox egress verification, and independent browser/live writeback verification remain open.

### 2026-06-24 M9 Admin Approval UI Checkpoint

Implemented:

- Added `GET /admin/dependency-approvals` in the web admin panel, guarded by `AuthorizationMiddleware.ensureUserIsSiteAdmin`.
- Added the admin Pug shell and React page entry for `DependencyApprovalsManager`.
- Added the admin API wrapper for:
  - `GET /api/ai/admin/python/dependency-requests`
  - `POST /api/ai/admin/python/dependency-requests/:requestId/approve`
  - `POST /api/ai/admin/python/dependency-requests/:requestId/deny`
- Added a browser-tested admin manager that lists dependency requests, filters by status, approves or denies pending requests with audit reasons, and displays policy findings, risk, environment id, resolver status, lock/manifest/SBOM hashes, `uv` version, and approval/deny audit fields.
- The UI uses the web `/api/ai/admin/...` proxy path only; it does not accept client-provided environment ids or expose raw resolver logs, package index credentials, or secret-bearing output.

Verified:

```bash
cd services/web
OVERLEAF_CONFIG=$(pwd)/config/settings.webpack.js npx cypress run --component --browser chromium --spec test/frontend/modules/admin-panel/components/dependency-approvals-manager.spec.tsx
npx vitest run test/unit/src/AdminPanel/AdminPanelController.test.mjs
npx eslint modules/admin-panel/frontend/js/api/ai-admin-api.ts modules/admin-panel/frontend/js/components/admin-nav.tsx modules/admin-panel/frontend/js/components/dependency-approvals-manager.tsx modules/admin-panel/frontend/js/pages/admin-dependency-approvals-page.tsx modules/admin-panel/app/src/AdminPanelController.mjs modules/admin-panel/app/src/AdminPanelRouter.mjs test/frontend/modules/admin-panel/components/dependency-approvals-manager.spec.tsx test/unit/src/AdminPanel/AdminPanelController.test.mjs
npm run type-check
```

Results:

- Cypress Chromium component browser: 3 tests passed.
- AdminPanelController Vitest: 14 tests passed.
- ESLint: passed for touched admin UI, admin route, and tests.
- TypeScript: `tsc --noEmit` passed.

Not yet complete:

- This is not a full authenticated dev-stack browser E2E with real persisted dependency requests.
- Project-owner approval remains out of scope for this admin-only slice.
- Full M9 still requires live AI panel flow, dependency request creation, admin approval, skill retry, draft diff, Auto Accept CAS writeback, reload/resume diagnostics, and independent browser/live writeback verification.

### 2026-06-24 M9 Runtime Snapshot Import Checkpoint

Implemented:

- `QuarantineUvWorker` now runs `uv sync --locked --no-install-project --link-mode copy` after locking project dependencies, and `uv sync --script <script> --locked --link-mode copy` for script dependencies.
- Runtime artifacts under `.venv/**/site-packages` are stored in the approved environment snapshot alongside lock artifacts.
- Snapshot manifests now include runtime metadata (`sitePackages`) so attachment can build a deterministic `PYTHONPATH`.
- `PythonRuntimeMountService` returns broker-generated runtime env vars for attached environments, and `SkillRuntimeService` forwards those env vars to `WorkspaceCommandService` while also setting `PYTHON_ENV_ROOT`.
- `SandboxEscapeGuard` allows `PYTHONPATH` only when every entry points inside `.agent/python-envs/pyenv_...`; arbitrary `PYTHONPATH`, `PATH`, loader, and package-manager injection remain denied.

Verified:

```bash
cd services/ai-writing-agent
npm run test:unit -- test/unit/js/python/QuarantineUvWorkerTests.test.js test/unit/js/python/SandboxEnvironmentStoreTests.test.js test/unit/js/python/PythonRuntimeMountServiceTests.test.js
npm run test:unit -- test/unit/js/sandbox/WorkspaceCommandServiceTests.test.js test/unit/js/skill/SkillRuntimeServiceTests.test.js test/unit/js/python/PythonDependencyRequestServiceTests.test.js
npm run test:unit -- test/unit/js/skill/SkillRuntimeServiceTests.test.js test/unit/js/sandbox/WorkspaceCommandServiceTests.test.js test/unit/js/python/PythonRuntimeMountServiceTests.test.js
npx eslint app/js/python/QuarantineUvWorker.js app/js/python/DependencyMetadata.js app/js/python/SandboxEnvironmentStore.js app/js/python/PythonRuntimeMountService.js app/js/python/PythonDependencyRequestService.js app/js/sandbox/SandboxEscapeGuard.js test/unit/js/python/QuarantineUvWorkerTests.test.js test/unit/js/python/SandboxEnvironmentStoreTests.test.js test/unit/js/python/PythonRuntimeMountServiceTests.test.js test/unit/js/sandbox/WorkspaceCommandServiceTests.test.js test/unit/js/skill/SkillRuntimeServiceTests.test.js
node --input-type=module <real-uv-runtime-artifact-probe>
node --input-type=module <real-docker-pythonpath-import-probe>
node --input-type=module <real-skill-runtime-approved-import-probe>
```

Results:

- Python runtime snapshot tests: 3 files / 8 tests passed.
- Sandbox/skill/request regression tests: 3 files / 27 tests passed.
- ESLint: passed for touched broker, mount, guard, and tests.
- Real `uv 0.8.22` probe resolved `typing-extensions==4.12.2`, produced `uv.lock`, collected 9 runtime files under `site-packages`, and reported `runtime.sitePackages = ["site-packages"]`.
- Real Docker sandbox probe attached `pyenv_runtime_smoke`, injected `.agent/python-envs/pyenv_runtime_smoke/site-packages` as `PYTHONPATH`, and `python3 -c "import typing_extensions"` printed `typing_extensions` with `python_environment.attached`, `command.started`, `command.output`, and `command.completed` events.
- Real `SkillRuntimeService` Docker probe attached `pyenv_skill_runtime_smoke`, forwarded broker `PYTHONPATH`, ran `check_import.py`, and printed `typing_extensions` with `skill.script.started`, `python_environment.attached`, command events, and `skill.script.completed`.

Not yet complete:

- Runtime snapshot restore is now a read-only provider mount for Local Docker. Non-local providers that cannot expose equivalent immutable runtime env mounts are explicitly fail-closed for dependency-backed Python skill scripts.
- Full M9 independent verification is complete.

### 2026-06-24 M8 Runtime Egress And Read-Only Env Mount Checkpoint

Implemented:

- `LocalDockerSandboxProvider` creates a provider-managed `runtime-python-envs` directory beside each writable workspace.
- Local Docker sessions mount that directory read-only at `/workspace/.agent/python-envs`, while keeping `/workspace` writable for normal project files.
- Local Docker sessions expose `writeRuntimeEnvironmentFile(environmentId, path, content)` so the broker can populate approved env files from outside the runtime container without making the mount writable to scripts.
- `PythonRuntimeMountService` now requires provider-managed immutable runtime env storage and fails closed when the sandbox session does not expose it.
- Sandbox sessions now advertise `capabilities.immutableRuntimeEnvironmentMount`; Local Docker reports `true`, E2B reports `false` until it has a provider-managed host-writable/runtime-read-only env storage contract.
- Runtime status now exposes `sandboxCapabilities.immutableRuntimeEnvironmentMount`, and unsupported providers return structured `PYTHON_ENV_IMMUTABLE_MOUNT_UNSUPPORTED` tool errors instead of unclassified internal failures.
- Runtime sandbox network policy now defaults to `deny` in both settings defaults and `RuntimeConfigManager`; explicit `AI_SANDBOX_NETWORK_POLICY` remains the override for controlled development runs.

Verified:

```bash
cd services/ai-writing-agent
npm run test:unit -- test/unit/js/RuntimeConfigManagerTests.test.js test/unit/js/sandbox/LocalDockerSandboxProvider.test.js test/unit/js/python/PythonRuntimeMountServiceTests.test.js
npm run test:unit -- test/unit/js/python test/unit/js/sandbox test/unit/js/skill test/unit/js/tool test/unit/js/RuntimeConfigManagerTests.test.js
npx eslint app/js/sandbox/LocalDockerSandboxProvider.js app/js/python/PythonRuntimeMountService.js app/js/RuntimeConfigManager.js test/unit/js/sandbox/LocalDockerSandboxProvider.test.js test/unit/js/python/PythonRuntimeMountServiceTests.test.js test/unit/js/RuntimeConfigManagerTests.test.js
node --input-type=module <local-docker-readonly-env-and-network-probe>
npm run test:unit -- test/unit/js/python/PythonRuntimeMountServiceTests.test.js test/unit/js/tool/RunSkillScriptToolTests.test.js test/unit/js/sandbox/LocalDockerSandboxProvider.test.js test/unit/js/sandbox/E2BSandboxProviderTests.test.js test/unit/js/RuntimeConfigManagerTests.test.js
npx eslint app/js/python/PythonRuntimeMountService.js app/js/sandbox/SandboxProvider.js app/js/sandbox/LocalDockerSandboxProvider.js app/js/sandbox/E2BSandboxProvider.js app/js/RuntimeConfigManager.js test/unit/js/python/PythonRuntimeMountServiceTests.test.js test/unit/js/tool/RunSkillScriptToolTests.test.js test/unit/js/RuntimeConfigManagerTests.test.js
node --check app/js/python/PythonRuntimeMountService.js app/js/sandbox/SandboxProvider.js app/js/sandbox/LocalDockerSandboxProvider.js app/js/sandbox/E2BSandboxProvider.js app/js/RuntimeConfigManager.js
```

Results:

- Focused Vitest: 3 files / 39 tests passed.
- Regression Vitest: 42 files / 349 tests passed.
- ESLint: passed for touched provider, mount, runtime config, and tests.
- Real Docker sandbox probe attached `pyenv_probe`, read `.agent/python-envs/pyenv_probe/site-packages/pkg.py` successfully, and failed container-side overwrite with `OSError: [Errno 30] Read-only file system`.
- Real Docker sandbox probe confirmed default runtime egress deny: `socket.create_connection(("1.1.1.1", 443), 2)` failed with `OSError: [Errno 101] Network is unreachable`.
- Provider capability follow-up Vitest: 5 files / 55 tests passed.
- Provider capability follow-up ESLint and Node syntax checks passed.
- Independent verifier `019ef96b-74fa-7522-98aa-94dbbde20769` found no P0/P1 blockers for the Local Docker default path.
- The verifier's P2 findings were remediated: providers without immutable runtime env mount support now fail closed, and `services/ai-writing-agent/CLAUDE.md` no longer recommends `development-permissive` networking by default.

Provider scope decision:

- The approved dependency path is complete for Local Docker, where a provider-managed directory is mounted read-only into `/workspace/.agent/python-envs`.
- E2B and any future non-local providers are not allowed to run dependency-backed Python skill scripts until they provide the same security property: broker/host can write approved snapshots, but agent commands cannot mutate or replace them. Best-effort chmod or ordinary remote file writes are not accepted as a security boundary.

Remaining follow-up scope:

- Restricted broker resolver egress runs in a Docker network namespace; the later package-index proxy checkpoint adds an internal proxy-network smoke for the approved index path.
- Non-local sandbox providers such as E2B remain unsupported for dependency-backed Python skill scripts until they can provide immutable runtime env mounts.

### 2026-06-24 M8 Docker-Isolated Broker Runner Checkpoint

Implemented:

- Added `DockerUvBrokerRunner` so `QuarantineUvWorker` can invoke `uv` through a dedicated broker container instead of a process-local spawn.
- The restricted broker policy maps to Docker `--network none`; `package-index-proxy` now requires an explicit approved Docker network name before any broker container is launched.
- Broker container executions bind-mount only the temporary quarantine workspace at `/broker-workspace`, run as the host uid/gid to avoid root-owned cache artifacts, and map worker-controlled `HOME`/`UV_CACHE_DIR` paths into the container workspace.
- `uv --version` detection runs in the same quarantine workspace as the resolving request, so no broker invocation bind-mounts the host `/tmp` root.
- `DockerUvBrokerRunner` also enforces the quarantine workspace and safe env allowlist itself, so direct runner callers cannot bind-mount arbitrary host paths or forward secret-bearing index environment variables.
- `PythonDependencyRequestService` now creates a default Docker broker runner from `aiAssistant.pythonDependencyBroker` settings.
- Added `services/ai-writing-agent/broker/Dockerfile`, a minimal Python 3.12 + pinned `uv 0.8.22` image, and a build-only dev-compose service that produces `resink-uv-broker:dev`.
- Added broker config keys:
  - `AI_PYTHON_DEPENDENCY_BROKER_DOCKER_IMAGE`
  - `AI_PYTHON_DEPENDENCY_BROKER_PROXY_NETWORK`
  - `AI_PYTHON_DEPENDENCY_BROKER_PROXY_INDEX_URL`

Verified:

```bash
cd develop
docker compose --profile build-only build ai-python-dependency-broker
docker compose --profile build-only config --quiet

cd services/ai-writing-agent
npm run test:unit -- test/unit/js/python
npx eslint app/js/python test/unit/js/python
docker run --rm --network none resink-uv-broker:dev uv --version
node --input-type=module <docker-broker-runner-network-and-resolution-probe>
```

Results:

- Broker image build: produced `resink-uv-broker:dev`.
- Compose config validation: passed.
- Python broker Vitest: 11 files / 53 tests passed.
- ESLint: passed for Python broker files and tests.
- `docker run --rm --network none resink-uv-broker:dev uv --version` returned `uv 0.8.22`.
- Real Docker broker runner probe:
  - `uv --version` succeeded inside the broker container.
  - `python net.py` with `socket.create_connection(("1.1.1.1", 443), 2)` failed with `OSError: [Errno 101] Network is unreachable`.
  - `QuarantineUvWorker` resolved a PEP 723 no-dependency script through the Docker broker runner, returning `status = resolved`, `uvVersion = uv 0.8.22`, `scripts/no_deps.py.lock`, and runtime `site-packages` artifacts.
  - Direct runner calls with `cwd = /tmp` failed with `BROKER_WORKSPACE_DENIED`.
- Independent verifier `019ef97a-906b-7991-80c2-fc9bb4fdb189` found no P0 issues and confirmed restricted `--network none`, explicit proxy-network gating, shell-free argv execution, and host uid/gid execution.
- The verifier's P1 finding was remediated: version detection no longer bind-mounts `os.tmpdir()` and now uses the per-request quarantine workspace.

Not yet complete:

- The later package-index proxy checkpoint adds the actual approved proxy-network egress verification.
- Browser/live-model independent verification remains open for full M9 acceptance.
- Non-local providers still need read-only approved-env parity.

### 2026-06-24 M8 Package-Index Proxy Egress Checkpoint

Implemented:

- Added broker-owned package-index proxy URL configuration via `AI_PYTHON_DEPENDENCY_BROKER_PROXY_INDEX_URL`.
- `QuarantineUvWorker` now fails closed for `package-index-proxy` unless the configured proxy URL is an HTTP(S) PEP 503 simple-index URL without credentials.
- `QuarantineUvWorker` still strips caller/process package-index variables in the restricted path; for `package-index-proxy` it injects only the configured broker-owned `UV_INDEX_URL`.
- `DockerUvBrokerRunner` enforces the same proxy URL rules at the Docker runner boundary, so direct runner callers cannot use credentialed URLs or arbitrary package-index env forwarding.
- `DockerUvBrokerRunner` continues to require an explicit approved Docker network for `package-index-proxy`.
- Added `test/manual/python-broker-proxy-network-smoke-test.mjs`, which creates a Docker `--internal` proxy network, runs a minimal simple-index proxy container, and proves the broker container can reach only that proxy path while public PyPI egress fails.
- Independent verifier `019ef991-890e-7b82-8798-0f49d2787576` found three proxy-boundary issues, all remediated in the follow-up hardening patch:
  - proxy URLs with query strings or fragments are now denied, preventing token material in `UV_INDEX_URL`;
  - proxy URLs must use the internal `pypi-proxy` alias and the Docker network must use the dedicated `resink-broker-proxy-*` namespace, preventing `bridge` plus public PyPI configuration;
  - quarantine workspaces now use a restricted safe-character path regex, preventing comma-bearing Docker `--mount` option confusion.
- The manual proxy-network smoke now also runs `QuarantineUvWorker.resolve()` with `uv lock` through the Docker broker runner, not only a raw `urllib` reachability probe.

Verified:

```bash
cd services/ai-writing-agent
node --check app/js/python/QuarantineUvWorker.js
node --check app/js/python/DockerUvBrokerRunner.js
node --check app/js/python/PythonDependencyRequestService.js
node --check test/manual/python-broker-proxy-network-smoke-test.mjs
npm run test:unit -- test/unit/js/python/DockerUvBrokerRunnerTests.test.js test/unit/js/python/QuarantineUvWorkerTests.test.js test/unit/js/python/PythonDependencyRequestServiceTests.test.js
npm run test:unit -- test/unit/js/python test/unit/js/sandbox test/unit/js/skill test/unit/js/tool test/unit/js/RuntimeConfigManagerTests.test.js
npx eslint app/js/python test/unit/js/python test/manual/python-broker-proxy-network-smoke-test.mjs
node test/manual/python-broker-proxy-network-smoke-test.mjs
```

Results:

- Focused broker Vitest: 3 files / 31 tests passed.
- AI service regression Vitest: 43 files / 362 tests passed.
- ESLint: passed for Python broker files, Python broker tests, and the manual proxy-network smoke script.
- Manual Docker proxy-network smoke:
  - Broker image: `resink-uv-broker:dev`.
  - Docker network: generated `resink-broker-proxy-*` with `--internal`.
  - Broker container reached `http://pypi-proxy:8080/simple` and printed `proxy reachable`.
  - Broker container direct `https://pypi.org/simple` probe failed with `URLError`, proving public package-index egress was denied on the approved proxy network.
  - `QuarantineUvWorker` completed `uv lock` through `package-index-proxy`, returning `resolved uv 0.8.22`.
- Follow-up hardening Vitest after independent review: 3 files / 36 tests passed.
- Follow-up AI service regression Vitest: 43 files / 367 tests passed.

Not yet complete:

- Non-local providers still need read-only approved-env parity before Python dependency-backed skill scripts can attach approved environments outside the Local Docker provider.
- Browser/live-model independent verification remains open for full M9 acceptance.

### 2026-06-24 M4 Snapshot Cache Cleanup Checkpoint

Implemented:

- `SandboxEnvironmentStore` can now describe, list, and remove local Python environment snapshots by reading each snapshot manifest and measuring actual on-disk bytes.
- Store cleanup supports:
  - `olderThanMs` TTL cleanup.
  - `maxTotalBytes` budget cleanup.
  - deterministic oldest-first eviction.
  - `keepEnvironmentIds` protection.
  - ignoring non-`pyenv_...` files/directories in the store root.
- `PythonDependencyRequestService.cleanupEnvironmentSnapshots()` builds a keep-list from approved dependency requests with non-null `environmentId`, then delegates cleanup to `SandboxEnvironmentStore`. This prevents cleanup from deleting the snapshots still referenced by approved broker requests.

Verified:

```bash
cd services/ai-writing-agent
npm run test:unit -- test/unit/js/python/SandboxEnvironmentStoreTests.test.js test/unit/js/python/PythonDependencyRequestServiceTests.test.js test/unit/js/python/PythonRuntimeMountServiceTests.test.js
npx eslint app/js/python/SandboxEnvironmentStore.js app/js/python/PythonDependencyRequestService.js test/unit/js/python/SandboxEnvironmentStoreTests.test.js test/unit/js/python/PythonDependencyRequestServiceTests.test.js

cd develop
docker compose -f docker-compose.yml -f docker-compose.dev.yml exec -T ai-writing-agent node --input-type=module <snapshot-gc-probe>
```

Results:

- Python snapshot cleanup suite passed: 3 files / 16 tests.
- Focused ESLint passed for the store, request service, and tests.
- Real AI container GC probe created two temporary snapshots:
  - `pyenv_gc_old_1782297153992`
  - `pyenv_gc_keep_1782297153992`
- The probe inserted an approved dependency request pointing at `pyenv_gc_keep_1782297153992`, ran `cleanupEnvironmentSnapshots({ olderThanMs: 3600000 })`, and confirmed:
  - unreferenced old snapshot was removed with `reason = expired`.
  - approved request snapshot was kept.
  - temporary DB request and kept snapshot were removed after the probe.

Not yet complete:

- Runtime snapshot restore is read-only mounted for Local Docker; non-local providers still need provider-level parity.
- No automatic scheduler/admin endpoint has been wired yet; the cleanup primitive is ready for startup/manual cleanup integration.

### 2026-06-24 M9 Dev-Stack Admin Approval Checkpoint

Implemented:

- The AI Writing Agent Docker image now ships a pinned `uv 0.8.22` binary alongside Docker CLI support, so the dependency broker can resolve approved requests inside the deployed dev service container.
- The broker image installs `uv` during image build and keeps normal runtime package-manager execution blocked by `WorkspaceCommandService`/`SandboxEscapeGuard`; `uv` is available to broker code, not exposed as a free-form agent tool.
- The earlier dev-stack approval failure (`resolverError.code = UV_MISSING`, message `uv binary not found: uv`) was fixed by rebuilding and restarting `develop-ai-writing-agent-1` from the updated image.

Verified:

```bash
cd develop
docker compose -f docker-compose.yml -f docker-compose.dev.yml build ai-writing-agent
docker compose -f docker-compose.yml -f docker-compose.dev.yml up --no-deps -d ai-writing-agent
docker compose -f docker-compose.yml -f docker-compose.dev.yml exec -T ai-writing-agent uv --version
curl -sS http://127.0.0.1:43060/status
```

Results:

- AI image build passed and produced `develop-ai-writing-agent`.
- Restarted `develop-ai-writing-agent-1` from the rebuilt image.
- `uv --version` inside the AI container returned `uv 0.8.22`.
- `curl http://127.0.0.1:43060/status` returned `{"status":"ok"}`.
- `docker ps` from inside the AI container listed the dev stack containers, confirming broker-side Docker access remained available.

Authenticated browser evidence:

- Logged into the dev web UI at `http://127.0.0.1:18080/login` as the local admin user.
- Opened `http://127.0.0.1:18080/admin/dependency-approvals` through the deployed admin route.
- Verified the page rendered `Python Dependency Approvals`, the admin navigation entry, the pending filter, and a persisted request from the live AI MongoDB.
- Clicked the page's approve action for request `6a3ba83dcd523375b77ca21f`.
- The proxied approval response returned:
  - `status = approved`
  - `resolverStatus = resolved`
  - `environmentId = pyenv_project_m9-admin-ui-1782294589004_31b961aeaedf711e756cf148`
  - `lockHash = sha256:53e4660347551d59fe04c0b05b97a7930bc7c653e077dc1270b42bc4127e7e20`
  - `manifestHash = sha256:8553d24c9aeecf8d49b639e7d2934a6c8437be6f07eb5483eb9f65fc539ca027`
  - `sbomHash = sha256:ba788b9b7338abdc69a43bb6130ce5cec62534446dfad5e1d5368a64df242f4e`
  - `uvVersion = uv 0.8.22`
- Screenshot evidence was captured at `/tmp/dependency-approvals-approved.png`.

Runtime artifact evidence:

```bash
cd develop
docker compose -f docker-compose.yml -f docker-compose.dev.yml exec -T ai-writing-agent sh -lc 'PYTHONPATH=/tmp/resink-python-env-store/pyenv_project_m9-admin-ui-1782294589004_31b961aeaedf711e756cf148/site-packages python3 - <<'"'"'PY'"'"'
from typing_extensions import TypedDict
class Probe(TypedDict):
    ok: bool
print(Probe(ok=True))
PY'
```

Result:

```text
{'ok': True}
```

Not yet complete:

- This checkpoint proves the deployed admin approval path and executable approved snapshot.
- Full M9 still requires live AI panel request creation, live skill retry through the deployed editor path, Review draft diff, Auto Accept CAS writeback, reload/resume diagnostics, denied bypass browser evidence, and independent verification.

### 2026-06-24 M9 Dependency-Backed Skill Retry Checkpoint

Implemented:

- Added `dependency-smoke` as a real directory skill package with:
  - `SKILL.md` activation instructions.
  - `skill.json` Python dependency metadata declaring `typing-extensions==4.12.2`.
  - `scripts/dependency_probe.py`, which imports `typing_extensions.TypedDict`, writes `dependency-smoke-output.txt`, and prints `dependency-smoke-ok`.
- `SkillRuntimeService` now persists a pending skill dependency request before failing closed with `PYTHON_ENV_NOT_APPROVED`. The error payload includes the persisted `dependencyRequestId` plus the dependency fingerprint, so the admin UI can approve the request created by an attempted `run_skill_script`.
- `QuarantineUvWorker` now builds script-mode runtime snapshots with:
  - `uv export --script <script> --format requirements-txt --output-file requirements.txt`
  - `uv venv .venv`
  - `uv pip install --python .venv/bin/python -r requirements.txt`
  This fixes the earlier script-mode gap where `uv sync --script` produced a lockfile but no `.venv/**/site-packages` snapshot.
- `PythonDependencyRequestService.findApprovedByFingerprint()` now confirms the approved snapshot still exists before returning an approved environment. If the DB request survives an AI container restart but the local `/tmp/resink-python-env-store` snapshot is gone, the runtime fails closed back to a pending request instead of attempting a broken attach.

Verified:

```bash
cd services/ai-writing-agent
npm run test:unit -- test/unit/js/python/PythonDependencyRequestServiceTests.test.js test/unit/js/python/QuarantineUvWorkerTests.test.js test/unit/js/skill/SkillRuntimeServiceTests.test.js test/unit/js/skill/SkillRegistryTests.test.js test/unit/js/python/SkillDependencyResolverTests.test.js
npx eslint app/js/python/PythonDependencyRequestService.js app/js/python/QuarantineUvWorker.js app/js/skill/SkillRuntimeService.js test/unit/js/python/PythonDependencyRequestServiceTests.test.js test/unit/js/python/QuarantineUvWorkerTests.test.js test/unit/js/skill/SkillRuntimeServiceTests.test.js

cd develop
docker compose -f docker-compose.yml -f docker-compose.dev.yml build ai-writing-agent
docker compose -f docker-compose.yml -f docker-compose.dev.yml up --no-deps -d ai-writing-agent
docker compose -f docker-compose.yml -f docker-compose.dev.yml exec -T ai-writing-agent uv --version
```

Results:

- Focused unit suite passed: 5 files / 48 tests.
- Focused ESLint passed for broker, request service, skill runtime, and tests.
- Rebuilt and restarted `develop-ai-writing-agent-1`; `uv --version` returned `uv 0.8.22`.
- The deployed AI container loaded `dependency-smoke` with `python.required = true`, script `dependency_probe.py`, package `typing-extensions==4.12.2`, and fingerprint `sha256:b5633d00b7f556509509d49e3d2f5f78db22a65abb02f0d61ea42ca0ecf95806`.
- First `run_skill_script` attempt failed closed with:
  - `code = PYTHON_ENV_NOT_APPROVED`
  - persisted request `6a3baaf9cd523375b77ca221`
  - fingerprint `sha256:b5633d00b7f556509509d49e3d2f5f78db22a65abb02f0d61ea42ca0ecf95806`
- Approval of request `6a3baaf9cd523375b77ca221` produced:
  - `status = approved`
  - `resolverStatus = resolved`
  - `environmentId = pyenv_skill_dependency-smoke_b5633d00b7f556509509d49e`
  - `runtime.sitePackages = ["site-packages"]`
  - 10 snapshot files, including `site-packages/typing_extensions.py`
- Approved `dependency-smoke/dependency_probe.py` ran successfully through `SkillRuntimeService` with event order:
  - `skill.script.started`
  - `python_environment.attached`
  - `command.started`
  - `command.output`
  - `command.completed`
  - `skill.script.completed`
- The script stdout and workspace marker were both `dependency-smoke-ok`.

Not yet complete:

- Snapshot storage is still local `/tmp/resink-python-env-store`; restart-safe durable store configuration and cache GC remain open hardening items.
- Full M9 still requires the same flow through the deployed browser AI panel, Auto Accept CAS writeback, reload/resume diagnostics, denied bypass browser evidence, and independent verification.

### 2026-06-24 M9 Live Browser Auto Accept Checkpoint

Implemented:

- `run_skill_script` policy-denial output now includes `Dependency request id`, `Dependency fingerprint`, and an explicit instruction to approve through Dependency Approvals before retrying. This makes browser-visible failures actionable for both users and the model.

Verified:

```bash
cd services/ai-writing-agent
npm run test:unit -- test/unit/js/tool/RunSkillScriptToolTests.test.js test/unit/js/skill/SkillRuntimeServiceTests.test.js test/unit/js/python/PythonDependencyRequestServiceTests.test.js
npx eslint app/js/tool/run_skill_script.js test/unit/js/tool/RunSkillScriptToolTests.test.js

cd develop
docker compose -f docker-compose.yml -f docker-compose.dev.yml build ai-writing-agent
docker compose -f docker-compose.yml -f docker-compose.dev.yml up --no-deps -d ai-writing-agent
```

Results:

- Focused unit suite passed: 3 files / 20 tests.
- Focused ESLint passed for `run_skill_script` and its test.
- Rebuilt and restarted `develop-ai-writing-agent-1`.

Live browser evidence:

- Authenticated Playwright opened `http://127.0.0.1:18080/project/6a355fe027c10dcad8f097bb`.
- The AI Assistant panel was opened from the real editor UI, Auto Accept was enabled through the `Toggle auto-accept` button, and session `6a3bacb63c9ae06366f3d71f` was used.
- First browser prompt activated `dependency-smoke` and called `run_skill_script`; it failed closed with `PYTHON_ENV_NOT_APPROVED`.
- Mongo confirmed the real browser turn persisted pending request `6a3bacbacd523375b77ca224` for project `6a355fe027c10dcad8f097bb`, skill `dependency-smoke`, fingerprint `sha256:b5633d00b7f556509509d49e3d2f5f78db22a65abb02f0d61ea42ca0ecf95806`.
- Authenticated Playwright opened `/admin/dependency-approvals` and approved `6a3bacbacd523375b77ca224` through the deployed admin UI.
- The approval response returned `status = approved`, `resolverStatus = resolved`, `environmentId = pyenv_skill_dependency-smoke_b5633d00b7f556509509d49e`, `uvVersion = uv 0.8.22`, lock/manifest/SBOM hashes, and `requestedNetworkPolicy = none`.
- A second browser prompt retried `dependency-smoke`, observed `dependency-smoke-ok`, and asked the model to replace the exact `main.tex` content with marker `dependency-smoke-browser-writeback-1782295885886`.
- AI service logs show the live model path executed:
  - `activate_skill`
  - `read_document`
  - `run_skill_script`
  - `edit_document`
- Auto Accept CAS writeback applied change `6a3bad7a00afef3cdc8c223e`; `DocumentAdapter` logged `baseVersion = 40`, `currentVersion = 40`, `Edit applied successfully`, and DocumentUpdater advanced `main.tex` to version 41.
- Browser reload showed `dependency-smoke-browser-writeback-1782295885886` in the editor body.
- Direct DocumentUpdater read through `DocumentAdapter.getDocumentContent()` confirmed version 41 contained the marker.
- Cleanup used the same DocumentUpdater/DocumentAdapter CAS path to replace the marker with `此处填写摘要。`; DocumentUpdater advanced to version 42 and content was restored.

Artifacts:

- `/tmp/dependency-smoke-first-browser.png`
- `/tmp/dependency-smoke-browser-admin-approved.png`
- `/tmp/dependency-smoke-browser-retry-writeback.png`
- `/tmp/dependency-smoke-browser-reload-marker.png`
- `/tmp/dependency-smoke-browser-reload-diagnostics.png`
- `/tmp/dependency-denial-browser.png`

Not yet complete:

- Live M9 still needs durable snapshot/cache cleanup hardening and independent verification.

### 2026-06-24 M9 Denied Bypass And Reload Diagnostics Checkpoint

Implemented:

- `run_command` now includes policy `Error code` and `Reason` in the LLM-visible tool error text, not only in structured `data.events`.
- Package-manager denials for `run_command` remain backed by `WorkspaceCommandService` and `SandboxEscapeGuard`; this change only makes the existing structured denial visible to the model and browser transcript.
- Stale M6/M8 smoke draft changes on project `6a355fe027c10dcad8f097bb` were rejected through `AgentChangeSetService.updateDraftStatus()` plus mirrored session pending-change status updates. The cleanup was limited to the four confirmed archived smoke changes:
  - `6a371f5a4c5ec907461820ca`
  - `6a3725d53bc15adcdc0b6cde`
  - `6a3726cdd3a5edb6c6f8b664`
  - `6a372718d3a5edb6c6f8b66a`

Verified:

```bash
cd services/ai-writing-agent
npm run test:unit -- test/unit/js/tool/RunCommandToolTests.test.js
npx eslint app/js/tool/run_command.js test/unit/js/tool/RunCommandToolTests.test.js

cd develop
docker compose -f docker-compose.yml -f docker-compose.dev.yml build ai-writing-agent
docker compose -f docker-compose.yml -f docker-compose.dev.yml up --no-deps -d ai-writing-agent
curl -sS http://127.0.0.1:43060/status
```

Results:

- Focused unit suite passed: 1 file / 3 tests.
- Focused ESLint passed for `run_command` and its test.
- Rebuilt and restarted `develop-ai-writing-agent-1`; `/status` returned `{"status":"ok"}`.
- Browser reload diagnostics after cleanup reported:
  - `hasSessionTitle = true`
  - `hasDependencySmoke = true`
  - `hasRunSkillScript = true`
  - `hasDependencyOk = true`
  - `noPendingChanges = true`
  - `restoredEditorClean = true`
- Authenticated Playwright browser prompt asked the live model to run exactly:
  - `["python3","-m","pip","install","typing-extensions==4.12.2"]`
- AI service logs for the browser request show the real product path:
  - `POST /api/ai/sessions/6a3bacb63c9ae06366f3d71f/messages`
  - `toolName = run_command`
  - `success = false`
  - `toolCalls = 1`
- Mongo `aiAgentToolCalls` confirmed the latest tool call `6a3bb0c7cd523375b77ca234` used that exact command and failed with:
  - `Error code: PACKAGE_MANAGER_DENIED`
  - `Reason: python-module-package-manager`
  - `Python package installation must go through the dependency broker and approved environment snapshots.`
- Mongo `aiMessages` confirmed the browser-visible assistant response reported:
  - `Error code = PACKAGE_MANAGER_DENIED`
  - `Reason = python-module-package-manager`
- Cleanup check for project `6a355fe027c10dcad8f097bb` reported:
  - pending Python dependency requests: `0`
  - pending draft changes on the current smoke project: `0`

Notes:

- The webpack dev overlay had to be removed during Playwright diagnostics because the development overlay iframe can intercept clicks after unrelated compile/log-panel 500s. Webpack itself had compiled successfully; the overlay did not block the AI backend path.
- Other historical pending test data remains in Mongo on unrelated projects/sessions; it was not changed because it was outside this broker verification scope.
- A new independent verifier could not be spawned at this point because the subagent thread limit had already been reached. Earlier read-only explorer verification informed the browser path and cleanup approach; final independent verification remains an explicit open M9 item.

### 2026-06-24 M9 Independent Browser/Live-Model Smoke Checkpoint

Verified:

- Dev stack was running with `develop-web-1`, `develop-webpack-1`, `develop-ai-writing-agent-1`, and Mongo healthy.
- A dedicated local smoke admin user `agent-smoke@example.com` was reset in the dev database for browser verification only.
- Authenticated Playwright opened `http://127.0.0.1:18080/project/6a390bf87a13c32e536c279c` as project owner `6a390b9d8d2e0a85cefdf0de`.
- The real editor rendered the AI Assistant rail and opened the AI panel.
- Browser network traffic through the deployed web proxy returned `200` for:
  - `/api/ai/runtime/status`
  - `/api/ai/model-slots`
  - `/api/ai/model-slots/default`
  - `/api/ai/sessions?projectId=6a390bf87a13c32e536c279c`
  - `/api/ai/sessions/6a3929d42752856d0c78b7cf?limit=200`
- Playwright sent the browser prompt `Reply with exactly: browser-live-model-smoke-1782304230364` from the AI panel.
- AI service logs showed the real browser request path:
  - `Starting agent loop` for session `6a3929d42752856d0c78b7cf`, project `6a390bf87a13c32e536c279c`;
  - `Agent turn starting`;
  - `Agent loop completed`;
  - `POST /api/ai/sessions/6a3929d42752856d0c78b7cf/messages` returned `200`.
- Mongo `aiMessages` confirmed both sides of the live-model exchange:
  - user message: `Reply with exactly: browser-live-model-smoke-1782304230364`;
  - assistant message: `browser-live-model-smoke-1782304230364`.
- Screenshot evidence was captured at `/tmp/browser-live-model-smoke-1782304230364.png`.

Also verified outside the browser:

```bash
cd services/ai-writing-agent
MONGO_CONNECTION_STRING='mongodb://127.0.0.1:37017/sharelatex?directConnection=true' node test/manual/agent-loop-v2-text-smoke-test.mjs
MONGO_CONNECTION_STRING='mongodb://127.0.0.1:37017/sharelatex?directConnection=true' node test/manual/agent-loop-v2-command-smoke-test.mjs
```

Results:

- Live model text smoke returned `AgentLoopV2 text smoke ok.`
- Live model command smoke called `run_command`, printed `agent-command-smoke-ok`, and emitted `command.started`, `command.output`, and `command.completed`.

Not yet complete:

- This is an independent browser/live-model smoke, not a full independent re-run of the dependency-backed skill request/approve/retry plus Auto Accept writeback path.

### 2026-06-24 M9 Dev Mount And Persistent Env Store Checkpoint

Fixes from the independent dependency-smoke browser re-run:

- Split broker resolver workspace paths into:
  - `AI_PYTHON_DEPENDENCY_BROKER_TEMP_ROOT` for the AI service container path;
  - `AI_PYTHON_DEPENDENCY_BROKER_HOST_TEMP_ROOT` for the host path passed to Docker bind mounts.
- Fixed `develop/docker-compose.dev.yml` sandbox host-root mapping from the compose working directory's accidental `develop/services/...` path to the actual repo service path via `${PWD}/../services/ai-writing-agent/.sandboxes`.
- Added `AI_PYTHON_ENVIRONMENT_STORE_ROOT` and mounted `services/ai-writing-agent/.python-env-store` into the AI service so approved Python environment snapshots survive AI service restarts and can be found by both approval and runtime attachment code.
- Added `.broker-workspaces/` and `.python-env-store/` to `services/ai-writing-agent/.gitignore`.
- Cleared stale failed resolver state on successful re-approval so approved requests do not retain old `resolverError` metadata.

Verification:

```bash
cd services/ai-writing-agent
node --check app/js/python/DockerUvBrokerRunner.js app/js/python/QuarantineUvWorker.js app/js/python/PythonDependencyRequestService.js app/js/python/PythonRuntimeMountService.js
npm run test:unit -- test/unit/js/python/DockerUvBrokerRunnerTests.test.js test/unit/js/python/QuarantineUvWorkerTests.test.js test/unit/js/python/PythonDependencyRequestServiceTests.test.js test/unit/js/python/PythonRuntimeMountServiceTests.test.js test/unit/js/skill/SkillRuntimeServiceTests.test.js test/unit/js/tool/RunSkillScriptToolTests.test.js
npx eslint app/js/python/DockerUvBrokerRunner.js app/js/python/QuarantineUvWorker.js app/js/python/PythonDependencyRequestService.js app/js/python/PythonRuntimeMountService.js test/unit/js/python/DockerUvBrokerRunnerTests.test.js test/unit/js/python/QuarantineUvWorkerTests.test.js test/unit/js/python/PythonDependencyRequestServiceTests.test.js
```

Results:

- Focused unit suite passed: 6 files, 55 tests.
- ESLint passed for the touched Python broker/runtime files and tests.
- Direct deployed resolver probe in the AI service container resolved `typing-extensions==4.12.2` through `package-index-proxy`, returned `uv 0.8.22`, and produced `scripts/dependency_probe.py.lock` plus `site-packages/typing_extensions.py`.
- Broker proxy logs showed only internal proxy requests for `/simple/typing-extensions/` and the wheel artifact; public package-index egress remained denied in the manual proxy smoke.
- Re-approving request `6a3bced2cd523375b77ca237` wrote persistent snapshot `pyenv_skill_dependency-smoke_b5633d00b7f556509509d49e` under `.python-env-store`, with `manifest.json`, `lockHash`, `manifestHash`, `sbomHash`, and `uvVersion: uv 0.8.22`.

Authenticated browser/live-model evidence:

- Project: `6a390bf87a13c32e536c279c`.
- Session: `6a3929d42752856d0c78b7cf`.
- Final browser prompt marker: `dependency-smoke-independent-final2-1782306578709`.
- AI service logs showed:
  - `activate_skill` success;
  - `run_skill_script` success;
  - agent loop completed and `POST /api/ai/sessions/6a3929d42752856d0c78b7cf/messages` returned `200`.
- Mongo `aiMessages` confirmed assistant sequence `16` reported:

```text
Skill script: dependency-smoke/dependency_probe.py
Runtime: python3
Sandbox path: .skills/dependency-smoke/scripts/dependency_probe.py
Exit code: 0
stdout:
dependency-smoke-ok
```

- Mongo `aiPythonEnvironmentUsages` recorded attachment of `pyenv_skill_dependency-smoke_b5633d00b7f556509509d49e` for `dependency-smoke`, script `scripts/dependency_probe.py`, at `2026-06-24T13:09:45.126Z`.
- Docker inspect confirmed the fresh sandbox mounted the real repo host path:
  - `/home/cjc/vibe-writing/services/ai-writing-agent/.sandboxes/workspace-a406b56d-3355-4c68-9746-4ad8aea4cecf/workspace -> /workspace`;
  - `/home/cjc/vibe-writing/services/ai-writing-agent/.sandboxes/workspace-a406b56d-3355-4c68-9746-4ad8aea4cecf/runtime-python-envs -> /workspace/.agent/python-envs`.
- Screenshot evidence: `/tmp/dependency-smoke-independent-final2-1782306578709.png`.

Stale workspace follow-up:

- The failed intermediate run after a manual sandbox container deletion exposed that `resumeSession` could retain a stale `containerName`.
- The follow-up fix makes `LocalDockerSandboxProvider.resumeSession()` verify the Docker container with `docker inspect`.
- If the container is missing, `PersistentWorkspaceManager.ensureWorkspace()` now retires the stale workspace, clears the session workspace fields, and creates a fresh workspace instead of reusing a dead container reference.
- Independent verifier `019ef9c7-5dad-7572-b9eb-7d5c51d77ad8` then found that an existing stale container with obsolete mounts could still pass the existence check.
- The second follow-up fix validates Docker inspect mount metadata as well: `/workspace` must map to the current Docker-visible workspace path, and `/workspace/.agent/python-envs` must map to the current runtime env path as a read-only mount.
- Unit coverage: `LocalDockerSandboxProvider.test.js` rejects persisted sessions whose Docker container is missing or whose existing container has stale mounts, and `PersistentWorkspaceManagerTests.test.js` verifies stale reusable workspaces are retired and recreated.

Independent full browser re-run:

- Independent verifier `019ef9d3-50d8-7fc3-b597-84b388bd6dfc` used Playwright against `http://127.0.0.1:18080`, opened project `6a390bf87a13c32e536c279c`, and drove the AI Assistant UI to activate `dependency-smoke` and execute `dependency_probe.py`.
- Session `6a3bdce9cd0cae4d0184d61f`, assistant message `seq=2`, and `run_skill_script` call `call_00_CWs9Bq2jqfcz1NXwmp1U0764` / command `a250dd1a-a0d8-49d3-82e0-4b1daef78c6c` all showed `dependency-smoke-ok` with exit code `0`.
- `aiPythonEnvironmentUsages` recorded usage `6a3bdcedcd0cae4d0184d622` for environment `pyenv_skill_dependency-smoke_b5633d00b7f556509509d49e`.
- Docker inspect for `overleaf-ai-sandbox-workspace-d61b8f82-0e45-4937-8ffb-3c8876aae1ff` showed `/workspace` mounted `RW=true` and `/workspace/.agent/python-envs` mounted separately with `RW=false`; container mountinfo also reported `ro`.
- The verifier attempted to write into the attached runtime env and received `Read-only file system`, while normal workspace output remained writable under `/workspace`.
- The verifier noted `127.0.0.1:18080` as the working browser entrypoint; `localhost:80` was unavailable in this environment. A compile endpoint returned 500 during the browser run, but it was unrelated to the dependency-smoke AI flow.

## 12. M0: Baseline Audit And Threat Model

### Objective

Map the current sandbox command, skill runtime, Python availability, package manager access, and network policy before adding dependency broker code.

### Implementation Tasks

- Audit:
  - `WorkspaceCommandService`
  - `WorkspaceScriptService`
  - `SkillPackageRegistry`
  - `SkillRuntimeService`
  - `SandboxEscapeGuard`
  - local Docker and E2B sandbox providers
  - sandbox image/Dockerfile
  - command denylist and network policy
  - existing skill directories and scripts
- Confirm where Python and `uv` are available in local dev, sandbox image, and CI.
- Identify every path where an agent can currently invoke:
  - `pip`
  - `pip3`
  - `python -m pip`
  - `uv add`
  - `uv pip install`
  - `uv tool install`
  - `poetry add`
  - `conda install`
  - `apt-get`
  - `npm install`
- Document the threat model:
  - malicious package
  - dependency confusion
  - sdist build execution
  - private index credential leak
  - runtime egress exfiltration
  - project-level malicious `pyproject.toml`
  - PEP 723 hidden dependency metadata
  - cross-project environment reuse
  - cache poisoning
  - unbounded native package build

### Acceptance Criteria

- Current command/skill/Python behavior is documented in this file or a linked implementation note.
- High-risk paths have concrete file references.
- No implementation code is changed before the audit is complete.

### Verification

```bash
cd services/ai-writing-agent
npm run test:unit -- test/unit/js/sandbox test/unit/js/skill test/unit/js/tool
npx eslint app/js/sandbox app/js/skill app/js/tool test/unit/js
```

### E2E Evidence

- Browser AI panel can run a harmless Python command, such as `python3 --version`, only through the sandbox.
- A package-manager command probe is captured so M2 can prove denial behavior changes.

## 13. M1: Dependency Metadata Schema And Discovery

### Objective

Teach the platform to discover Python dependency requirements without installing anything.

### Implementation Tasks

- Add normalized dependency metadata types:
  - skill Python environment descriptor
  - script dependency descriptor
  - project dependency descriptor
  - dependency request DTO
- Extend `SkillPackageRegistry` to read optional:
  - `skill.json`
  - `pyproject.toml`
  - `uv.lock`
  - script PEP 723 metadata
- Add `SkillDependencyResolver`.
- Add `ProjectDependencyResolver` for sandbox/project files.
- Validate:
  - skill paths do not escape skill directory
  - script paths are declared
  - lockfile matches declared project file when possible
  - inline script dependencies are visible to the broker
  - unsupported dependency sources are recorded as findings, not ignored
- Add fixtures for:
  - approved built-in skill env
  - missing lockfile
  - PEP 723 single script
  - malicious direct URL
  - private index declaration
  - path escape attempt

### Acceptance Criteria

- Startup can list skills without installing dependencies.
- Activating a skill reports whether a Python environment is required.
- Dependency metadata changes produce a new normalized request fingerprint.
- Invalid metadata is skipped safely with diagnostics.

### Verification

```bash
cd services/ai-writing-agent
npm run test:unit -- test/unit/js/skill test/unit/js/python
npx eslint app/js/skill app/js/python test/unit/js/skill test/unit/js/python
```

### E2E Evidence

- Browser/live model activates a skill with declared Python metadata.
- UI diagnostics show an environment status, but no packages are installed.

## 14. M2: Policy Engine And Package-Manager Command Denial

### Objective

Create the policy layer and prevent normal runtime commands from bypassing it.

### Implementation Tasks

- Add `DependencyPolicyEngine`.
- Add policy config defaults:
  - trusted indexes
  - denied commands
  - allowed source kinds
  - max package count
  - max wheel size
  - native build policy
  - license policy placeholder
  - vulnerability severity thresholds
  - runtime network policy
- Extend command guard to deny package-manager commands in product profiles.
- Keep admin/test override explicit and audited if needed.
- Emit `python_environment.runtime_denied` when package install commands are blocked.
- Ensure subagents inherit package-manager denial unless parent policy explicitly grants a broker/admin tool.

### Acceptance Criteria

- Normal `run_command` cannot run Python package installers.
- Skill scripts cannot shell out to package installers unless policy explicitly allows a broker-owned setup phase.
- Denials are visible as safe command events.
- Existing harmless commands still work.

### Verification

```bash
cd services/ai-writing-agent
npm run test:unit -- test/unit/js/sandbox test/unit/js/tool test/unit/js/python
npx eslint app/js/sandbox app/js/tool app/js/python test/unit/js
```

### E2E Evidence

- Browser/live model attempts `python -m pip install cowsay` and receives a clear denial.
- Browser/live model can still run `python3 --version` and an approved built-in Python script.

## 15. M3: Quarantine `uv` Resolver Worker

### Objective

Resolve dependencies with `uv` in a separate controlled worker, not in the user runtime sandbox.

### Implementation Tasks

- Add `QuarantineUvWorker`.
- Worker responsibilities:
  - create isolated temp workspace
  - copy only dependency metadata
  - run `uv lock`, `uv lock --script`, or `uv export` as appropriate
  - enforce approved index configuration
  - run with restricted environment variables
  - redact logs
  - capture lockfiles, manifests, hashes, and policy findings
- Support initial modes:
  - built-in skill project env
  - PEP 723 script env
  - project `pyproject.toml` + `uv.lock` validation
- Deny:
  - unapproved indexes
  - unsafe index strategies
  - direct URLs
  - VCS deps
  - editable deps
  - source builds unless explicitly approved
- Add timeout, output limit, package count limit, and artifact size limit.

### Acceptance Criteria

- Broker can produce a pending/approved/denied resolution result without touching project sandbox state.
- `uv` logs never include credentials.
- Missing `uv` produces a clear dependency error.
- Resolver outputs are deterministic for unchanged inputs.

### Verification

```bash
cd services/ai-writing-agent
npm run test:unit -- test/unit/js/python
npx eslint app/js/python test/unit/js/python
```

### E2E Evidence

- Admin-only/manual script resolves a small fixture skill with `uv`.
- Denied fixture with direct URL or unsafe index is rejected before install.

## 16. M4: Environment Snapshot Store And Sandbox Attachment

### Objective

Make approved Python environments reusable by runtime sandboxes without re-resolving dependencies during each agent turn.

### Implementation Tasks

- Add `SandboxEnvironmentStore`.
- Choose storage strategy for local dev:
  - tar snapshot of `.venv`
  - Docker/OCI layer
  - named volume snapshot
  - provider-specific template for E2B/cloud later
- Add `PythonRuntimeMountService`.
- Restore approved env into sandbox under a controlled path:

```text
/workspace/.agent/python-envs/<environmentId>/
```

- Prefer read-only mount/restore where possible.
- Add cleanup:
  - per-session detach
  - TTL for unused snapshots
  - orphan cleanup
  - max disk usage
- Add cross-project isolation:
  - project envs cannot be reused across projects unless explicitly global
  - skill envs can be shared by content hash and skill version

### Acceptance Criteria

- Approved environment can be attached to a sandbox without network package install.
- Runtime command can execute Python with that environment.
- Snapshot cache reuse is keyed by lock/environment hash.
- Cleanup removes temporary runtime mounts without deleting approved cache incorrectly.

### Verification

```bash
cd services/ai-writing-agent
npm run test:unit -- test/unit/js/python test/unit/js/sandbox
node test/manual/sandbox-smoke-test.mjs
npx eslint app/js/python app/js/sandbox test/unit/js
```

### E2E Evidence

- Browser/live model runs a fixture skill script using an approved env.
- Network/package egress remains denied in the project runtime sandbox.

## 17. M5: `run_skill_script` Integration

### Objective

Make skill scripts automatically request and attach approved Python environments.

### Implementation Tasks

- Update `SkillRuntimeService`:
  - check script runtime descriptor
  - ask broker for approved environment
  - attach environment to sandbox
  - run script with env-specific interpreter
  - record usage
  - detach/cleanup
- Update `run_skill_script`:
  - fail closed with `PYTHON_ENV_NOT_APPROVED`
  - return dependency request id when applicable
  - stream `python_environment.attached`
  - include env provenance in command events
- Update subagent policy:
  - child agents may use approved skill envs only if parent allows skill runtime
  - child agents cannot request new dependency approvals unless parent/toolset allows it
- Ensure script-produced workspace modifications flow into Live Agent Workspace draft changes.

### Acceptance Criteria

- Approved skill script runs without model-visible installation commands.
- Missing env becomes a dependency request, not an install attempt.
- Script output, artifacts, and draft changes preserve skill/env provenance.
- Subagents cannot escalate package policy.

### Verification

```bash
cd services/ai-writing-agent
npm run test:unit -- test/unit/js/skill test/unit/js/tool test/unit/js/python test/unit/js/agent
npx eslint app/js/skill app/js/tool app/js/python app/js/agent test/unit/js
```

### E2E Evidence

- Browser/live model activates a skill, runs an approved Python script, and creates a draft change.
- Reload restores command, skill, and Python env diagnostics.
- A delegated subagent can use the approved env only when parent policy allows it.

## 18. M6: Project-Level Python Environment Requests

### Objective

Support project-provided Python scripts without letting projects auto-install arbitrary dependencies.

### Implementation Tasks

- Detect project Python metadata during workspace preparation or before script execution.
- Add project dependency request flow:
  - locked project env
  - missing lockfile
  - PEP 723 script
  - policy-denied metadata
- Add project-owner approval checks.
- Store project env snapshots scoped to project id and lock hash.
- Add conflict behavior:
  - if project `uv.lock` changes, old env becomes stale
  - if unapproved env is required, script execution fails closed
- Add UI diagnostics for project env status.

### Acceptance Criteria

- Existing project `uv.lock` can be validated and used if policy allows it.
- Missing or changed lockfile creates a pending request.
- Project metadata cannot override platform indexes or runtime egress policy without approval.
- Project env snapshots do not leak across projects.

### Verification

```bash
cd services/ai-writing-agent
npm run test:unit -- test/unit/js/python test/unit/js/sandbox test/unit/js/tool
npx eslint app/js/python app/js/sandbox app/js/tool test/unit/js
```

### E2E Evidence

- Browser/live model runs a project Python helper when its locked env is approved.
- Another project cannot reuse the env unless allowed by global policy.
- A project with malicious PEP 723 metadata is denied and reported safely.

## 19. M7: Admin/Project-Owner Approval UI And APIs

### Objective

Make dependency requests actionable without asking normal users to reason about package security.

### Implementation Tasks

- Add backend APIs for dependency request list/detail/approve/deny.
- Add admin-only policy endpoints if needed.
- Add project-owner scoped approval for low-risk project envs if product policy allows it.
- Add web UI:
  - pending dependency requests
  - package list
  - risk findings
  - source indexes
  - lock hash
  - env status
  - approve/deny action
- Keep normal AI panel concise.
- Add audit log entries for decisions.

### Acceptance Criteria

- Admin can approve or deny a dependency request.
- User-facing AI flow resumes after approval without re-prompting for package install.
- Denied requests remain denied until metadata changes or admin reopens them.
- UI and APIs redact secrets.

### Verification

```bash
cd services/ai-writing-agent
npm run test:unit -- test/unit/js/python test/unit/js/AgentController
npx eslint app/js/python app/js/AgentController.js test/unit/js

cd ../web
npm run type-check
npx eslint frontend/js/features/ai-assistant app/src/Features/AIAssistant
```

### E2E Evidence

- Playwright admin flow approves a fixture dependency request.
- Browser/live model retries the skill script and succeeds.
- Ordinary non-admin user cannot approve high-risk dependency requests.

## 20. M8: Security Hardening, SBOM, Audit, And Egress

### Objective

Prove dependency handling is safe enough for a self-hosted/SaaS-style product boundary.

### Implementation Tasks

- Add SBOM generation or pluggable SBOM adapter.
- Add vulnerability audit integration.
- Add malware advisory check where supported by current `uv`/OSV tooling.
- Add environment manifest hash verification before attach.
- Add package artifact hash verification.
- Add egress tests:
  - broker can reach only configured package/advisory endpoints
  - runtime sandbox cannot reach package indexes
- Add secret redaction tests for:
  - index URL credentials
  - env vars
  - command logs
  - Mongo records
  - SSE events
- Add cache poisoning tests:
  - wrong lock hash
  - tampered environment snapshot
  - stale lock
  - cross-project restore attempt
- Add resource limit tests:
  - oversized wheels
  - package count limit
  - install timeout
  - output overflow
  - disk quota

### Acceptance Criteria

- Dependency broker fails closed on policy and integrity failures.
- Runtime package manager commands remain blocked.
- Approved snapshots are hash-verified before use.
- Security evidence is recorded in the milestone checklist.

### Verification

```bash
cd services/ai-writing-agent
npm run test:unit -- test/unit/js/python test/unit/js/sandbox test/unit/js/tool test/unit/js/security
node test/manual/sandbox-limits-smoke-test.mjs
npx eslint app/js/python app/js/sandbox app/js/tool test/unit/js
```

### E2E Evidence

- Independent verification subagent probes package install bypasses.
- Independent verification subagent probes runtime network/package-index access.
- Browser diagnostics show safe dependency findings without secrets.

## 21. M9: Full E2E Acceptance And Cleanup

### Objective

Prove the end-to-end product path and remove unsafe transitional behavior.

### Implementation Tasks

- Run full dev stack.
- Run browser E2E with live model:
  - built-in Tier 0 Python script
  - approved built-in skill env
  - missing env dependency request
  - admin approval
  - retry succeeds
  - project locked env
  - denied malicious dependency
  - subagent skill script
  - reload/resume diagnostics
  - Review draft change
  - Auto Accept writeback
- Delete or lock down any transitional package-install escape hatches.
- Update docs:
  - `CLAUDE.md`
  - sandbox command/skill runtime docs
  - environment/deployment docs
  - admin runbook
- Confirm cleanup:
  - no orphan sandbox containers
  - no unbounded env caches
  - no active smoke sessions
  - no pending draft residue
  - no tracked secrets

### Acceptance Criteria

- Normal agent profiles cannot directly install packages.
- Skills can use third-party Python packages through approved snapshots.
- Project-level Python dependencies have a controlled request/approval path.
- Runtime evidence covers browser, live model, sandbox, dependency broker, and writeback.
- Docs clearly state the supported model.

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

Required:

- Dev stack deployed from `develop/`.
- Playwright browser flow through real Overleaf editor.
- Live `deepseek-v4-flash` or current approved dev model through deployed app path.
- `run_skill_script` with approved Python env.
- Package install bypass denied in browser-visible flow.
- Dependency request approval flow.
- Review draft diff visible.
- Auto Accept CAS writeback visible in canonical Overleaf document.
- Reload/resume restores Python env diagnostics.
- Independent subagent verification for dependency policy and sandbox network.

## 22. Subagent Strategy

Use subagents for independent workstreams:

- **Policy/security worker**
  - Owns `DependencyPolicyEngine`, denied source policy, package-manager denial, redaction, and bypass tests.

- **Resolver worker**
  - Owns `QuarantineUvWorker`, lock/export behavior, metadata parsing, and resolver tests.

- **Sandbox/env worker**
  - Owns `SandboxEnvironmentStore`, runtime attachment, cleanup, and provider-specific behavior.

- **Skill integration worker**
  - Owns `SkillDependencyResolver`, `SkillRuntimeService`, `run_skill_script`, and subagent policy integration.

- **Frontend/API worker**
  - Owns dependency request APIs, admin/project-owner UI, diagnostics, and reload behavior.

- **Verification subagents**
  - Browser/live-model E2E.
  - Package install bypass and egress probes.
  - Cross-project/cache poisoning checks.
  - Writeback/draft-change checks.

Main session responsibilities:

- Keep milestones coherent.
- Review and integrate subagent patches.
- Prevent conflicting file ownership.
- Run final verification.
- Commit after each completed milestone.

## 23. Commit Discipline

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

- Do not mix unverified or cross-milestone work into the same commit.
- Do not commit `.env`, package index credentials, lockfiles containing private URLs with credentials, screenshots with secrets, or raw resolver logs.
- If a milestone is docs-only, state that runtime tests were not run and why.
- If a runtime milestone affects browser/user behavior, unit/lint/type checks are not enough.

## 24. Definition Of Done

This migration is complete when:

- `uv` is available in the sandbox/broker story and documented as the only supported Python dependency resolver.
- Normal product agents cannot execute package managers directly.
- Built-in skill scripts can declare Python dependencies and run through approved environment snapshots.
- Project-level Python dependencies have a controlled request/approval path.
- Dependency resolution occurs outside normal project runtime sandboxes.
- Approved snapshots are locked, hash-verified, audited, and reusable.
- Runtime sandboxes do not need package-index egress for approved env execution.
- Admin/project-owner UI can approve/deny dependency requests under policy.
- E2E evidence proves skill script execution, denied bypasses, approval flow, draft changes, Auto Accept writeback, reload/resume, and cleanup.
- Docs and runbooks make clear that package trust is a platform decision, not an LLM decision.

## 25. One-Shot `/goal` Prompt

```text
/goal Implement the UV Python Dependency Broker architecture described in services/ai-writing-agent/doc/uv-python-dependency-broker-development-plan.md. Continue through every milestone until the Definition of Done is satisfied. Use implementation subagents for separable workstreams and independent verification subagents for browser E2E, live-model, dependency-policy, package-install-bypass, sandbox-egress, cross-project isolation, draft-change, and Auto Accept writeback checks. Use uv as the only Python dependency resolver, but do not expose raw package installation as a normal agent command. Do not mark a runtime milestone complete with only unit/lint/type checks. Commit after every completed milestone using Conventional Commits with motivation, main changes, verification commands, E2E/security evidence, and skipped-check reasons. Keep secrets, package-index credentials, raw resolver logs, and private URLs out of tracked files.
```

## 26. First Implementation Checklist

Before coding:

1. Read this document fully.
2. Read `sandbox-command-skill-runtime-development-plan.md`.
3. Read `live-agent-workspace-development-plan.md`.
4. Inspect current sandbox command/skill implementation.
5. Run `git status --short` and preserve unrelated changes.
6. Confirm local `uv --version`.
7. Confirm sandbox image Python/uv state.
8. Dispatch M0 audit and security subagents.

First code milestone:

1. Add dependency metadata types and fixtures.
2. Add read-only metadata discovery.
3. Add package-manager denial tests before enabling any broker install path.
4. Keep all install/resolve behavior behind admin/internal APIs until M3+ policy is in place.
