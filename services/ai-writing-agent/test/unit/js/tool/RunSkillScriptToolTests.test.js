import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@overleaf/logger', () => ({
  default: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    log: vi.fn(),
  },
}))

vi.mock('@overleaf/o-error', () => {
  class OError extends Error {
    constructor(message, info) {
      super(message)
      this.name = this.constructor.name
      this.info = info
    }
  }
  return { default: OError }
})

const { RunSkillScriptTool } = await import(
  '../../../../app/js/tool/run_skill_script.js'
)
const { SandboxPolicyError } = await import(
  '../../../../app/js/sandbox/SandboxErrors.js'
)

describe('RunSkillScriptTool', () => {
  let skillRuntime
  let context

  beforeEach(() => {
    skillRuntime = { runScript: vi.fn() }
    context = { sessionId: 'session-1', toolCallId: 'tool-1' }
  })

  it('returns readable output and structured skill script metadata', async () => {
    skillRuntime.runScript.mockResolvedValue({
      skillName: 'latex-polish',
      script: 'polish_pass.py',
      path: '.skills/latex-polish/scripts/polish_pass.py',
      runtime: 'python3',
      command: { commandId: 'cmd-1' },
      stdout: 'ok\n',
      stderr: '',
      exitCode: 0,
      timedOut: false,
      outputLimited: false,
      provenance: { source: 'local-package', packageName: 'latex-polish' },
      events: [{ type: 'skill.script.completed', commandId: 'cmd-1' }],
    })
    const tool = new RunSkillScriptTool({ skillRuntime })

    const result = await tool.execute({
      skill: 'latex-polish',
      script: 'polish_pass.py',
      args: ['main.tex'],
    }, context)

    expect(result.success).toBe(true)
    expect(result.output).toContain('Skill script: latex-polish/polish_pass.py')
    expect(result.output).toContain('Exit code: 0')
    expect(result.data).toMatchObject({
      skillName: 'latex-polish',
      script: 'polish_pass.py',
      commandId: 'cmd-1',
      stdout: 'ok\n',
      events: [{ type: 'skill.script.completed', commandId: 'cmd-1' }],
    })
  })

  it('turns policy denials into deterministic security events', async () => {
    skillRuntime.runScript.mockRejectedValue(new SandboxPolicyError('blocked', {
      code: 'SANDBOX_COMMAND_POLICY_DENIED',
      reason: 'undeclared-skill-script',
    }))
    const tool = new RunSkillScriptTool({ skillRuntime })

    const result = await tool.execute({ skill: 'latex-polish', script: '../escape.py' }, context)

    expect(result.success).toBe(false)
    expect(result.output).toContain('Skill script blocked by sandbox policy')
    expect(result.data).toMatchObject({
      code: 'SANDBOX_COMMAND_POLICY_DENIED',
      reason: 'undeclared-skill-script',
    })
    expect(result.data.events[0]).toMatchObject({
      type: 'security.command_blocked',
      toolCallId: 'tool-1',
      reason: 'undeclared-skill-script',
    })
  })

  it('includes dependency request details when a Python skill env is not approved', async () => {
    skillRuntime.runScript.mockRejectedValue(new SandboxPolicyError(
      'The script requires an approved Python environment before execution.',
      {
        code: 'PYTHON_ENV_NOT_APPROVED',
        reason: 'python-env-not-approved',
        dependencyRequestId: 'request-123',
        fingerprint: 'sha256:request',
      }
    ))
    const tool = new RunSkillScriptTool({ skillRuntime })

    const result = await tool.execute({
      skill: 'dependency-smoke',
      script: 'dependency_probe.py',
    }, context)

    expect(result.success).toBe(false)
    expect(result.output).toContain('Dependency request id: request-123')
    expect(result.output).toContain('Dependency fingerprint: sha256:request')
    expect(result.output).toContain('Approve this request in Dependency Approvals')
    expect(result.data).toMatchObject({
      code: 'PYTHON_ENV_NOT_APPROVED',
      reason: 'python-env-not-approved',
    })
  })

  it('returns a deterministic error when the sandbox provider cannot attach immutable Python envs', async () => {
    skillRuntime.runScript.mockRejectedValue(new SandboxPolicyError(
      'Sandbox provider does not support immutable Python environment mounts for .agent/python-envs/pyenv_e2b',
      {
        code: 'PYTHON_ENV_IMMUTABLE_MOUNT_UNSUPPORTED',
        reason: 'immutable-runtime-env-mount-unsupported',
        targetRoot: '.agent/python-envs/pyenv_e2b',
      }
    ))
    const tool = new RunSkillScriptTool({ skillRuntime })

    const result = await tool.execute({
      skill: 'dependency-smoke',
      script: 'dependency_probe.py',
    }, context)

    expect(result.success).toBe(false)
    expect(result.output).toContain('immutable Python environment mounts')
    expect(result.data).toMatchObject({
      code: 'PYTHON_ENV_IMMUTABLE_MOUNT_UNSUPPORTED',
      reason: 'immutable-runtime-env-mount-unsupported',
    })
  })
})
