# Historical Sandbox-v0 Runtime Deprecation Plan

This historical plan records the post-sandbox compatibility boundary before the Hermes-style AgentLoopV2 migration. The current product direction is AgentLoopV2 by default; sandbox-v0, OpenCode, Codex CLI, and Pi-style runtimes are explicit fallback tools only.

## Runtime Defaults

- New development deployments use `AI_RUNTIME_MODE=auto`.
- `auto` resolves to AgentLoopV2 when `AI_AGENT_LOOP_V2_API_BASE` or `OPENAI_API_BASE` and `AI_AGENT_LOOP_V2_MODEL` or `OPENAI_MODEL` are configured.
- `AI_RUNTIME_MODE=legacy` keeps the existing direct `AgentLoop` route available for emergency rollback.
- `AI_RUNTIME_MODE=sandbox-v0` forces the external CLI fallback path and returns clear configuration errors if dependencies are missing.
- `AI_AGENT_LOOP_V2_ENABLED=false` disables AgentLoopV2 auto-selection and allows sandbox-v0 fallback selection when configured.

## Replaced Legacy Responsibilities

Sandbox-backed workflows now cover:

- Full project snapshot export into an isolated workspace.
- LaTeX compilation and PDF/text inspection through sandbox tools.
- Runtime-neutral profiles for compile fixing, paper review, and citation audit.
- Explicit fallback CLI runtimes through adapters, currently OpenCode and Codex CLI.
- Artifact collection, diff collection, pending changes, accept/reject, and stop.

Legacy components to freeze unless required for compatibility:

- Bespoke `AgentLoop` tool growth for generic shell/PDF/LaTeX inspection.
- Custom parser additions that can run inside sandbox profiles.
- New direct document mutation paths that bypass pending changes.

## Removal Gates

Do not remove legacy code until all gates pass:

- Each removed capability has an equivalent sandbox profile or runtime path.
- Unit tests cover the sandbox equivalent.
- Manual verification covers at least one normal LaTeX edit, one compile-fix run, one artifact-producing run, and one conflict/reject flow.
- Admin docs include provider, runtime adapter, credential, network, and fallback configuration.
- Public sync guards still exclude development-only docs and secrets.

## Compatibility Window

Legacy routes remain:

- `POST /sessions/:id/messages`
- `POST /sessions/:id/stop`
- legacy pending change accept/reject routes

Sandbox routes are fallback paths:

- `POST /sandbox/sessions`
- `POST /sandbox/sessions/:sandboxSessionId/stop`
- artifact download
- sandbox pending change accept/reject

## Verification

Required before deleting legacy implementation:

```bash
cd services/ai-writing-agent
npm run test:unit
npm run test:acceptance
npx eslint .
node test/manual/sandbox-smoke-test.mjs
node test/manual/sandbox-latex-smoke-test.mjs
node test/manual/sandbox-limits-smoke-test.mjs
node test/manual/opencode-runtime-smoke-test.mjs

cd ../web
npm run type-check
npm run lint
```
