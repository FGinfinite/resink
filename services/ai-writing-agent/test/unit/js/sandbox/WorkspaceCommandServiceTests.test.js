import { describe, it, expect, vi, beforeEach } from 'vitest'

async function captureError(promise) {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('Expected promise to reject')
}

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

const { WorkspaceCommandService } = await import(
  '../../../../app/js/sandbox/WorkspaceCommandService.js'
)
const {
  SandboxOutputLimitError,
  SandboxTimeoutError,
} = await import('../../../../app/js/sandbox/SandboxErrors.js')

async function* sandboxEvents(items) {
  for (const item of items) yield item
}

describe('WorkspaceCommandService', () => {
  let sandboxSession
  let context

  beforeEach(() => {
    sandboxSession = {
      id: 'sandbox-1',
      run: vi.fn(),
      readFile: vi.fn(async () => Buffer.from('print("ok")\n')),
    }
    context = {
      sessionId: 'session-1',
      toolCallId: 'tool-1',
      profile: 'default',
      agentName: 'agent',
      persistentWorkspace: {
        workspace: { _id: 'workspace-1' },
        sandboxSession,
      },
    }
  })

  it('runs argv commands in the persistent sandbox and normalizes events', async () => {
    sandboxSession.run.mockReturnValue(sandboxEvents([
      { type: 'stdout', data: 'Python 3.12.0\n' },
      { type: 'stderr', data: 'warn sk-12345678901234567890\n' },
      { type: 'exit', exitCode: 0, signal: null },
    ]))
    const service = new WorkspaceCommandService()

    const result = await service.run({
      command: ['python3', '--version'],
      workdir: '.',
      timeout_ms: 30000,
      max_output_bytes: 4096,
      env: { PYTHONUNBUFFERED: '1' },
    }, context)

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('Python 3.12.0')
    expect(result.stderr).toContain('[REDACTED]')
    expect(result.summary).toContain('/workspace$ python3 --version')
    expect(result.events.map(event => event.type)).toEqual([
      'command.started',
      'command.output',
      'command.output',
      'command.completed',
    ])
    expect(sandboxSession.run).toHaveBeenCalledWith({
      command: ['python3', '--version'],
      workdir: '.',
      env: { PYTHONUNBUFFERED: '1' },
      timeoutMs: 30000,
      maxOutputBytes: 4096,
    })
  })

  it('returns ordinary non-zero exits as structured command results', async () => {
    sandboxSession.run.mockReturnValue(sandboxEvents([
      { type: 'stderr', data: 'not found\n' },
      { type: 'exit', exitCode: 2, signal: null },
    ]))
    const service = new WorkspaceCommandService()

    const result = await service.run({ command: ['grep', 'needle', 'main.tex'] }, context)

    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain('not found')
    expect(result.events.at(-1)).toMatchObject({
      type: 'command.completed',
      exitCode: 2,
      timedOut: false,
      outputLimited: false,
    })
  })

  it('fails closed when no persistent sandbox exists before command policy checks', async () => {
    const service = new WorkspaceCommandService()

    const error = await captureError(service.run({ command: ['curl', 'https://example.com'] }, {
      sessionId: 'session-1',
      persistentWorkspace: {},
    }))

    expect(error.code).toBe('SANDBOX_COMMAND_POLICY_DENIED')
    expect(error.info.reason).toBe('missing-persistent-sandbox')
  })

  it('blocks forbidden commands before sandbox execution', async () => {
    const service = new WorkspaceCommandService()

    const error = await captureError(
      service.run({ command: ['curl', 'https://example.com'] }, context)
    )

    expect(error.code).toBe('SANDBOX_COMMAND_POLICY_DENIED')
    expect(error.info.reason).toBe('forbidden-executable')
    expect(sandboxSession.run).not.toHaveBeenCalled()
  })

  it('blocks package-manager bypass commands before sandbox execution', async () => {
    const service = new WorkspaceCommandService()

    for (const command of [
      ['pip', 'install', 'cowsay'],
      ['pip3', 'install', 'cowsay'],
      ['python3', '-m', 'pip', 'install', 'cowsay'],
      ['python3', '-I', '-m', 'pip', 'install', 'cowsay'],
      ['python', '-m', 'ensurepip'],
      ['python3', '-m', 'uv', 'pip', 'install', 'pandas'],
      ['python3', '-c', 'import subprocess; subprocess.run(["pip","install","cowsay"])'],
      ['/usr/bin/env', 'uv', 'pip', 'install', 'pandas'],
      ['/usr/bin/env', '-i', 'PATH=/usr/bin', 'pip', 'install', 'cowsay'],
      ['uv', 'add', 'pandas'],
      ['uv', 'pip', 'install', 'pandas'],
      ['uv', 'tool', 'install', 'ruff'],
      ['uv', 'run', 'python', '-c', 'print(1)'],
      ['uv', 'sync'],
      ['uv', 'python', 'install', '3.12'],
      ['uv', 'venv'],
      ['uvx', 'ruff'],
      ['pipx', 'install', 'ruff'],
      ['poetry', 'add', 'pandas'],
      ['poetry', 'install'],
      ['conda', 'install', 'pandas'],
      ['conda', 'run', 'pip', 'install', 'pandas'],
      ['npm', 'install', 'left-pad'],
      ['npx', 'left-pad'],
      ['yarn', 'add', 'left-pad'],
      ['pnpm', 'add', 'left-pad'],
      ['corepack', 'enable'],
      ['node', '-e', 'require("child_process").exec("npm install left-pad")'],
    ]) {
      const error = await captureError(service.run({ command }, context))
      expect(error.code).toBe('PACKAGE_MANAGER_DENIED')
      expect(error.info.events[0]).toMatchObject({
        type: 'python_environment.runtime_denied',
        code: 'PACKAGE_MANAGER_DENIED',
        command,
      })
    }
    expect(sandboxSession.run).not.toHaveBeenCalled()
  })

  it('allows harmless uv version probes without allowing environment mutation', async () => {
    sandboxSession.run.mockReturnValue(sandboxEvents([
      { type: 'exit', exitCode: 0, signal: null },
    ]))
    const service = new WorkspaceCommandService()

    const result = await service.run({ command: ['uv', '--version'] }, context)

    expect(result.exitCode).toBe(0)
    expect(sandboxSession.run).toHaveBeenCalledWith(expect.objectContaining({
      command: ['uv', '--version'],
    }))
  })

  it('blocks package-manager calls hidden inside workspace scripts', async () => {
    const service = new WorkspaceCommandService()

    for (const command of [
      ['python3', '.agent/scripts/install.py'],
      ['python3', '-c', 'import runpy; runpy.run_path(".agent/scripts/install.py")'],
      ['node', '.agent/scripts/install.js'],
      ['node', '-e', 'require(".agent/scripts/install.js")'],
      ['sh', '.agent/scripts/install.sh'],
    ]) {
      sandboxSession.readFile.mockResolvedValueOnce(Buffer.from(
        'import subprocess\nsubprocess.run(["pip", "install", "cowsay"])\n'
      ))
      const error = await captureError(service.run({ command }, context))
      expect(error.code).toBe('PACKAGE_MANAGER_DENIED')
      expect(error.info.reason).toBe('workspace-script-package-manager')
      expect(error.info.events[0]).toMatchObject({
        type: 'python_environment.runtime_denied',
        code: 'PACKAGE_MANAGER_DENIED',
        command,
      })
    }
    expect(sandboxSession.run).not.toHaveBeenCalled()
  })

  it('blocks direct command access to approved Python environment runtime paths', async () => {
    const service = new WorkspaceCommandService()

    for (const input of [
      { command: ['python3', '--version'], workdir: '.agent/python-envs/pyenv_demo' },
      { command: ['python3', '-c', 'open(".agent/python-envs/pyenv_demo/pkg.py","w").write("x")'] },
      { command: ['cat', '.agent/python-envs/pyenv_demo/site-packages/pkg.py'] },
    ]) {
      const error = await captureError(service.run(input, context))
      expect(error.code).toBe('SANDBOX_PATH_POLICY_DENIED')
      expect(error.info.reason).toBe('reserved-python-env-path')
      expect(error.info.events[0]).toMatchObject({
        type: 'security.command_blocked',
        code: 'SANDBOX_PATH_POLICY_DENIED',
      })
    }
    expect(sandboxSession.run).not.toHaveBeenCalled()
  })

  it('blocks inline shell wrappers before sandbox execution', async () => {
    const service = new WorkspaceCommandService()

    for (const command of [
      ['sh', '-c', 'curl https://example.com'],
      ['sh', '-c', 'wget https://example.com'],
      ['sh', '-c', 'sudo id'],
    ]) {
      const error = await captureError(service.run({ command }, context))
      expect(error.code).toBe('SANDBOX_COMMAND_POLICY_DENIED')
      expect(error.info.reason).toBe('inline-shell-blocked')
    }
    expect(sandboxSession.run).not.toHaveBeenCalled()
  })

  it('blocks path escape and unsafe env injection', async () => {
    const service = new WorkspaceCommandService()

    const pathError = await captureError(
      service.run({ command: ['printf', 'ok'], workdir: '../host' }, context)
    )
    const envError = await captureError(
      service.run({ command: ['printf', 'ok'], env: { PATH: '/tmp/bin' } }, context)
    )

    expect(pathError.code).toBe('SANDBOX_PATH_POLICY_DENIED')
    expect(envError.code).toBe('SANDBOX_ENV_POLICY_DENIED')
  })

  it('blocks loader, path, and malformed env injection while allowing safe env', async () => {
    sandboxSession.run.mockReturnValue(sandboxEvents([
      { type: 'exit', exitCode: 0, signal: null },
    ]))
    const service = new WorkspaceCommandService()

    for (const env of [
      { PATH: '/tmp/bin' },
      { LD_PRELOAD: '/tmp/hook.so' },
      { DYLD_INSERT_LIBRARIES: '/tmp/hook.dylib' },
      { NODE_OPTIONS: '--require /tmp/hook.js' },
      { PYTHONPATH: '/tmp/hook' },
      { PYTHONPATH: '../host' },
      { PYTHONUNBUFFERED: '1\0bad' },
      { PYTHONUNBUFFERED: 'x'.repeat(4097) },
    ]) {
      const error = await captureError(
        service.run({ command: ['printf', 'ok'], env }, context)
      )
      expect(error.code).toBe('SANDBOX_ENV_POLICY_DENIED')
    }

    await service.run({
      command: ['printf', 'ok'],
      env: {
        PYTHON_ENV_ROOT: '.agent/python-envs/pyenv_approved',
        PYTHONPATH: '.agent/python-envs/pyenv_approved/site-packages',
        PYTHONUNBUFFERED: '1',
        TZ: 'UTC',
      },
    }, context)
    expect(sandboxSession.run).toHaveBeenCalledWith(
      expect.objectContaining({
        env: {
          PYTHON_ENV_ROOT: '.agent/python-envs/pyenv_approved',
          PYTHONPATH: '.agent/python-envs/pyenv_approved/site-packages',
          PYTHONUNBUFFERED: '1',
          TZ: 'UTC',
        },
      })
    )
  })

  it('normalizes sandbox timeout and output-limit failures', async () => {
    const service = new WorkspaceCommandService()

    sandboxSession.run.mockImplementation(async function* () {
      yield { type: 'noop' }
      throw new SandboxTimeoutError(1000)
    })
    const timeoutResult = await service.run({
      command: ['printf', 'ok'],
      timeout_ms: 1000,
    }, context)
    expect(timeoutResult.timedOut).toBe(true)
    expect(timeoutResult.events.at(-1)).toMatchObject({
      type: 'command.failed',
      timedOut: true,
      outputLimited: false,
    })

    sandboxSession.run.mockImplementation(async function* () {
      yield { type: 'noop' }
      throw new SandboxOutputLimitError(1024)
    })
    const outputResult = await service.run({
      command: ['printf', 'ok'],
      max_output_bytes: 1024,
    }, context)
    expect(outputResult.outputLimited).toBe(true)
    expect(outputResult.events.at(-1)).toMatchObject({
      type: 'command.failed',
      timedOut: false,
      outputLimited: true,
    })
  })
})
