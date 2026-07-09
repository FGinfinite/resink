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

const { RunCommandTool } = await import(
  '../../../../app/js/tool/run_command.js'
)
const { SandboxPolicyError } = await import(
  '../../../../app/js/sandbox/SandboxErrors.js'
)

describe('RunCommandTool', () => {
  let commandService
  let context

  beforeEach(() => {
    commandService = { run: vi.fn() }
    context = {
      sessionId: 'session-1',
      toolCallId: 'tool-1',
      persistentWorkspace: {
        sandboxSession: { id: 'sandbox-1' },
      },
    }
  })

  it('returns readable output and structured command metadata', async () => {
    commandService.run.mockResolvedValue({
      commandId: 'cmd-1',
      summary: '/workspace$ python3 --version',
      exitCode: 0,
      signal: null,
      stdout: 'Python 3.12.0\n',
      stderr: '',
      timedOut: false,
      outputLimited: false,
      events: [{ type: 'command.completed', commandId: 'cmd-1' }],
    })
    const tool = new RunCommandTool({ commandService })

    const result = await tool.execute({ command: ['python3', '--version'] }, context)

    expect(result.success).toBe(true)
    expect(result.output).toContain('/workspace$ python3 --version')
    expect(result.output).toContain('Exit code: 0')
    expect(result.output).toContain('Python 3.12.0')
    expect(result.data).toMatchObject({
      commandId: 'cmd-1',
      exitCode: 0,
      stdout: 'Python 3.12.0\n',
      events: [{ type: 'command.completed', commandId: 'cmd-1' }],
    })
  })

  it('turns sandbox policy denials into deterministic security events', async () => {
    commandService.run.mockRejectedValue(new SandboxPolicyError('blocked', {
      code: 'SANDBOX_COMMAND_POLICY_DENIED',
      reason: 'forbidden-executable',
    }))
    const tool = new RunCommandTool({ commandService })

    const result = await tool.execute({ command: ['curl', 'https://example.com'] }, context)

    expect(result.success).toBe(false)
    expect(result.output).toContain('Command blocked by sandbox policy')
    expect(result.data).toMatchObject({
      code: 'SANDBOX_COMMAND_POLICY_DENIED',
      reason: 'forbidden-executable',
    })
    expect(result.data.events[0]).toMatchObject({
      type: 'security.command_blocked',
      reason: 'forbidden-executable',
      toolCallId: 'tool-1',
    })
  })

  it('preserves package-manager denial events from the command service', async () => {
    commandService.run.mockRejectedValue(new SandboxPolicyError('blocked', {
      code: 'PACKAGE_MANAGER_DENIED',
      reason: 'python-module-package-manager',
      events: [{
        type: 'python_environment.runtime_denied',
        code: 'PACKAGE_MANAGER_DENIED',
        reason: 'python-module-package-manager',
        command: ['python3', '-m', 'pip', 'install', 'cowsay'],
      }],
    }))
    const tool = new RunCommandTool({ commandService })

    const result = await tool.execute({
      command: ['python3', '-m', 'pip', 'install', 'cowsay'],
    }, context)

    expect(result.success).toBe(false)
    expect(result.output).toContain('Error code: PACKAGE_MANAGER_DENIED')
    expect(result.output).toContain('Reason: python-module-package-manager')
    expect(result.output).toContain('dependency broker')
    expect(result.data).toMatchObject({
      code: 'PACKAGE_MANAGER_DENIED',
      reason: 'python-module-package-manager',
    })
    expect(result.data.events[0]).toMatchObject({
      type: 'python_environment.runtime_denied',
      command: ['python3', '-m', 'pip', 'install', 'cowsay'],
    })
  })
})
