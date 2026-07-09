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

const { SkillRuntimeService } = await import(
  '../../../../app/js/skill/SkillRuntimeService.js'
)

function buildContext() {
  return {
    sessionId: 'session-1',
    toolCallId: 'tool-1',
    persistentWorkspace: {
      workspace: { _id: 'workspace-1' },
      sandboxSession: {
        id: 'sandbox-1',
        writeFile: vi.fn(),
      },
    },
  }
}

describe('SkillRuntimeService', () => {
  let skillRegistry
  let commandService
  let pythonRuntimeMount
  let requestService
  let context

  beforeEach(() => {
    skillRegistry = {
      readScript: vi.fn(),
    }
    commandService = {
      run: vi.fn(),
    }
    pythonRuntimeMount = {
      attach: vi.fn(),
    }
    requestService = {
      findApprovedByFingerprint: vi.fn(async () => null),
      upsertFromDependencyRequest: vi.fn(async () => null),
    }
    context = buildContext()
  })

  it('projects a declared script into .skills and executes through WorkspaceCommandService', async () => {
    skillRegistry.readScript.mockResolvedValue({
      skillName: 'latex-polish',
      name: 'polish_pass.py',
      relativePath: 'scripts/polish_pass.py',
      runtime: 'python3',
      python: { required: false, status: 'none' },
      content: 'print("ok")\n',
      provenance: {
        source: 'local-package',
        packageName: 'latex-polish',
        relativePath: 'scripts/polish_pass.py',
      },
    })
    commandService.run.mockResolvedValue({
      commandId: 'cmd-1',
      stdout: 'ok\n',
      stderr: '',
      exitCode: 0,
      timedOut: false,
      outputLimited: false,
      events: [{ type: 'command.completed', commandId: 'cmd-1' }],
    })
    const service = new SkillRuntimeService({ skillRegistry, commandService, pythonRuntimeMount, requestService })

    const result = await service.runScript({
      skill: 'latex-polish',
      script: 'polish_pass.py',
      args: ['main.tex'],
      timeout_ms: 30000,
      max_output_bytes: 4096,
    }, context)

    expect(context.persistentWorkspace.sandboxSession.writeFile).toHaveBeenCalledWith(
      '.skills/latex-polish/scripts/polish_pass.py',
      'print("ok")\n'
    )
    expect(commandService.run).toHaveBeenCalledWith({
      command: ['python3', '.skills/latex-polish/scripts/polish_pass.py', 'main.tex'],
      workdir: '.',
      timeout_ms: 30000,
      max_output_bytes: 4096,
      env: {},
    }, context)
    expect(result).toMatchObject({
      skillName: 'latex-polish',
      script: 'polish_pass.py',
      path: '.skills/latex-polish/scripts/polish_pass.py',
      runtime: 'python3',
      stdout: 'ok\n',
      exitCode: 0,
    })
    expect(result.events.map(event => event.type)).toEqual([
      'skill.script.started',
      'command.completed',
      'skill.script.completed',
    ])
  })

  it('fails closed when a Python script requires an unapproved dependency environment', async () => {
    requestService.upsertFromDependencyRequest.mockResolvedValue({
      _id: { toString: () => 'persisted-request-1' },
    })
    skillRegistry.readScript.mockResolvedValue({
      skillName: 'latex-polish',
      name: 'polish_pass.py',
      relativePath: 'scripts/polish_pass.py',
      runtime: 'python3',
      python: {
        required: true,
        status: 'missing',
        dependencyRequest: { fingerprint: 'sha256:request' },
        policyFindings: [{
          code: 'DIRECT_URL_DEPENDENCY',
          severity: 'high',
          message: 'Direct URL dependencies require broker policy review.',
        }],
      },
      content: 'print("ok")\n',
    })
    const service = new SkillRuntimeService({ skillRegistry, commandService, pythonRuntimeMount, requestService })

    const error = await captureError(
      service.runScript({ skill: 'latex-polish', script: 'polish_pass.py' }, context)
    )

    expect(error.code).toBe('PYTHON_ENV_NOT_APPROVED')
    expect(error.info.reason).toBe('python-env-not-approved')
    expect(error.info.dependencyRequestId).toBe('persisted-request-1')
    expect(error.info.fingerprint).toBe('sha256:request')
    expect(requestService.upsertFromDependencyRequest).toHaveBeenCalledWith({
      projectId: null,
      sessionId: 'session-1',
      userId: null,
      dependencyRequest: {
        fingerprint: 'sha256:request',
        scope: 'skill',
        skillName: 'latex-polish',
        scriptPath: 'scripts/polish_pass.py',
      },
      status: 'pending',
      riskTier: null,
    })
    expect(context.persistentWorkspace.sandboxSession.writeFile).not.toHaveBeenCalled()
    expect(commandService.run).not.toHaveBeenCalled()
  })

  it('attaches an approved Python environment before running a dependency-backed script', async () => {
    skillRegistry.readScript.mockResolvedValue({
      skillName: 'latex-polish',
      name: 'polish_pass.py',
      relativePath: 'scripts/polish_pass.py',
      runtime: 'python3',
      python: {
        required: true,
        status: 'approved',
        environmentId: 'pyenv_approved',
      },
      content: 'print("ok")\n',
      provenance: { source: 'local-package', packageName: 'latex-polish' },
    })
    commandService.run.mockResolvedValue({
      commandId: 'cmd-1',
      stdout: 'ok\n',
      stderr: '',
      exitCode: 0,
      timedOut: false,
      outputLimited: false,
      events: [{ type: 'command.completed', commandId: 'cmd-1' }],
    })
    pythonRuntimeMount.attach.mockResolvedValue({
      environmentId: 'pyenv_approved',
      targetRoot: '.agent/python-envs/pyenv_approved',
      env: { PYTHONPATH: '.agent/python-envs/pyenv_approved/site-packages' },
      events: [{ type: 'python_environment.attached', environmentId: 'pyenv_approved' }],
    })
    const service = new SkillRuntimeService({ skillRegistry, commandService, pythonRuntimeMount, requestService })

    const result = await service.runScript({
      skill: 'latex-polish',
      script: 'polish_pass.py',
    }, context)

    expect(result.exitCode).toBe(0)
    expect(pythonRuntimeMount.attach).toHaveBeenCalledWith({
      environmentId: 'pyenv_approved',
      skillName: 'latex-polish',
      scriptPath: 'scripts/polish_pass.py',
    }, context)
    expect(commandService.run).toHaveBeenCalledWith(expect.objectContaining({
      command: ['python3', '.skills/latex-polish/scripts/polish_pass.py'],
      env: {
        PYTHONPATH: '.agent/python-envs/pyenv_approved/site-packages',
        PYTHON_ENV_ROOT: '.agent/python-envs/pyenv_approved',
      },
    }), context)
    expect(result.events.map(event => event.type)).toEqual([
      'skill.script.started',
      'python_environment.attached',
      'command.completed',
      'skill.script.completed',
    ])
  })

  it('looks up an approved request by fingerprint before rejecting a dependency-backed script', async () => {
    skillRegistry.readScript.mockResolvedValue({
      skillName: 'latex-polish',
      name: 'polish_pass.py',
      relativePath: 'scripts/polish_pass.py',
      runtime: 'python3',
      python: {
        required: true,
        status: 'missing',
        dependencyRequest: { fingerprint: 'sha256:request' },
      },
      content: 'print("ok")\n',
      provenance: { source: 'local-package', packageName: 'latex-polish' },
    })
    commandService.run.mockResolvedValue({
      commandId: 'cmd-1',
      stdout: 'ok\n',
      stderr: '',
      exitCode: 0,
      timedOut: false,
      outputLimited: false,
      events: [{ type: 'command.completed', commandId: 'cmd-1' }],
    })
    pythonRuntimeMount.attach.mockResolvedValue({
      environmentId: 'pyenv_approved',
      targetRoot: '.agent/python-envs/pyenv_approved',
      env: { PYTHONPATH: '.agent/python-envs/pyenv_approved/site-packages' },
      events: [{ type: 'python_environment.attached', environmentId: 'pyenv_approved' }],
    })
    const requestService = {
      findApprovedByFingerprint: vi.fn(async () => ({
        _id: 'request-1',
        status: 'approved',
        environmentId: 'pyenv_approved',
      })),
    }
    const service = new SkillRuntimeService({
      skillRegistry,
      commandService,
      pythonRuntimeMount,
      requestService,
    })

    const result = await service.runScript({
      skill: 'latex-polish',
      script: 'polish_pass.py',
    }, context)

    expect(requestService.findApprovedByFingerprint).toHaveBeenCalledWith(
      'sha256:request',
      { projectId: undefined, skillName: 'latex-polish' }
    )
    expect(result.exitCode).toBe(0)
    expect(pythonRuntimeMount.attach).toHaveBeenCalledWith({
      environmentId: 'pyenv_approved',
      skillName: 'latex-polish',
      scriptPath: 'scripts/polish_pass.py',
    }, context)
  })

  it('rejects undeclared scripts before writing to the sandbox', async () => {
    skillRegistry.readScript.mockResolvedValue(undefined)
    const service = new SkillRuntimeService({ skillRegistry, commandService, pythonRuntimeMount, requestService })

    const error = await captureError(
      service.runScript({ skill: 'latex-polish', script: '../escape.py' }, context)
    )

    expect(error.code).toBe('SANDBOX_COMMAND_POLICY_DENIED')
    expect(error.info.reason).toBe('undeclared-skill-script')
    expect(context.persistentWorkspace.sandboxSession.writeFile).not.toHaveBeenCalled()
    expect(commandService.run).not.toHaveBeenCalled()
  })

  it('fails closed when no persistent sandbox exists', async () => {
    const service = new SkillRuntimeService({ skillRegistry, commandService, pythonRuntimeMount, requestService })

    const error = await captureError(
      service.runScript({ skill: 'latex-polish', script: 'polish_pass.py' }, {
        sessionId: 'session-1',
        persistentWorkspace: {},
      })
    )

    expect(error.code).toBe('SANDBOX_COMMAND_POLICY_DENIED')
    expect(error.info.reason).toBe('missing-persistent-sandbox')
    expect(skillRegistry.readScript).not.toHaveBeenCalled()
  })

  it('rejects malicious script metadata before writing to the sandbox', async () => {
    skillRegistry.readScript.mockResolvedValue({
      skillName: '../latex-polish',
      name: 'polish_pass.py',
      relativePath: 'scripts/polish_pass.py',
      runtime: 'python3',
      python: { required: false, status: 'none' },
      content: 'print("ok")\n',
    })
    const service = new SkillRuntimeService({ skillRegistry, commandService, pythonRuntimeMount, requestService })

    const error = await captureError(
      service.runScript({ skill: 'latex-polish', script: 'polish_pass.py' }, context)
    )

    expect(error.code).toBe('SANDBOX_PATH_POLICY_DENIED')
    expect(error.info.reason).toBe('invalid-skill-script-path')
    expect(context.persistentWorkspace.sandboxSession.writeFile).not.toHaveBeenCalled()
    expect(commandService.run).not.toHaveBeenCalled()
  })

  it('rejects unsupported script runtimes before writing to the sandbox', async () => {
    skillRegistry.readScript.mockResolvedValue({
      skillName: 'latex-polish',
      name: 'unknown.bin',
      relativePath: 'scripts/unknown.bin',
      runtime: null,
      content: 'binary',
    })
    const service = new SkillRuntimeService({ skillRegistry, commandService, pythonRuntimeMount, requestService })

    const error = await captureError(
      service.runScript({ skill: 'latex-polish', script: 'unknown.bin' }, context)
    )

    expect(error.code).toBe('SANDBOX_COMMAND_POLICY_DENIED')
    expect(error.info.reason).toBe('unsupported-skill-script-runtime')
    expect(context.persistentWorkspace.sandboxSession.writeFile).not.toHaveBeenCalled()
    expect(commandService.run).not.toHaveBeenCalled()
  })

  it('propagates command policy denials without writing canonical files', async () => {
    skillRegistry.readScript.mockResolvedValue({
      skillName: 'latex-polish',
      name: 'polish_pass.py',
      relativePath: 'scripts/polish_pass.py',
      runtime: 'python3',
      python: { required: false, status: 'none' },
      content: 'print("ok")\n',
    })
    commandService.run.mockRejectedValue(Object.assign(
      new Error('blocked env'),
      {
        code: 'SANDBOX_ENV_POLICY_DENIED',
        info: { reason: 'forbidden-env' },
      }
    ))
    const service = new SkillRuntimeService({ skillRegistry, commandService, pythonRuntimeMount, requestService })

    const error = await captureError(
      service.runScript({
        skill: 'latex-polish',
        script: 'polish_pass.py',
        env: { NODE_OPTIONS: '--require /tmp/hook.js' },
      }, context)
    )

    expect(error.code).toBe('SANDBOX_ENV_POLICY_DENIED')
    expect(context.persistentWorkspace.sandboxSession.writeFile).toHaveBeenCalledWith(
      '.skills/latex-polish/scripts/polish_pass.py',
      'print("ok")\n'
    )
  })
})
