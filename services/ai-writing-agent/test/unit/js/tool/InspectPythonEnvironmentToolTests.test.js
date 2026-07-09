import { describe, expect, it, vi } from 'vitest'

const { InspectPythonEnvironmentTool } = await import(
  '../../../../app/js/tool/inspect_python_environment.js'
)

describe('InspectPythonEnvironmentTool', () => {
  it('reports locked project Python metadata without installing packages', async () => {
    const sandboxSession = {
      listFiles: vi.fn(async () => [
        { path: 'pyproject.toml', size: 54 },
        { path: 'uv.lock', size: 12 },
        { path: 'scripts/analyze.py', size: 80 },
        { path: 'main.tex', size: 10 },
      ]),
      readFile: vi.fn(async filePath => Buffer.from({
        'pyproject.toml': '[project]\ndependencies = ["pandas==2.2.3"]\n',
        'uv.lock': 'version = 1\n',
        'scripts/analyze.py': `# /// script
# dependencies = ["pypdf==5.0.0"]
# ///
`,
      }[filePath] || '')),
    }
    const tool = new InspectPythonEnvironmentTool({
      requestService: {
        upsertFromDependencyRequest: vi.fn(async input => ({
          _id: { toString: () => 'request-locked' },
          ...input.dependencyRequest,
          status: 'pending',
        })),
      },
    })

    const result = await tool.execute({ include_scripts: true }, {
      projectId: 'project-1',
      sessionId: 'session-1',
      persistentWorkspace: { sandboxSession },
    })

    expect(result.success).toBe(true)
    expect(result.output).toContain('Project Python environment status: locked')
    expect(result.data).toMatchObject({
      required: true,
      status: 'locked',
      packages: [
        expect.objectContaining({ name: 'pandas' }),
        expect.objectContaining({ name: 'pypdf' }),
      ],
      events: [
        expect.objectContaining({
          type: 'python_dependency.requested',
          scope: 'project',
          projectId: 'project-1',
        }),
      ],
    })
    expect(sandboxSession.readFile).toHaveBeenCalledWith('pyproject.toml')
    expect(sandboxSession.readFile).toHaveBeenCalledWith('uv.lock')
    expect(sandboxSession.readFile).toHaveBeenCalledWith('scripts/analyze.py')
  })

  it('persists discovered dependency requests for admin approval', async () => {
    const sandboxSession = {
      listFiles: vi.fn(async () => [{ path: 'pyproject.toml', size: 54 }]),
      readFile: vi.fn(async () => Buffer.from(
        '[project]\ndependencies = ["pandas==2.2.3"]\n'
      )),
    }
    const requestService = {
      upsertFromDependencyRequest: vi.fn(async input => ({
        _id: { toString: () => 'request-1' },
        ...input.dependencyRequest,
        status: 'pending',
      })),
    }
    const tool = new InspectPythonEnvironmentTool({ requestService })

    const result = await tool.execute({}, {
      projectId: 'project-1',
      sessionId: 'session-1',
      userId: 'user-1',
      persistentWorkspace: { sandboxSession },
    })

    expect(requestService.upsertFromDependencyRequest).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'project-1',
      sessionId: 'session-1',
      userId: 'user-1',
      dependencyRequest: expect.objectContaining({
        scope: 'project',
        requestedPackages: [expect.objectContaining({ name: 'pandas' })],
      }),
      riskTier: 'low',
    }))
    expect(result.data.persistedRequest).toMatchObject({
      id: 'request-1',
      status: 'pending',
    })
    expect(result.data.events[0]).toMatchObject({
      dependencyRequestId: 'request-1',
      fingerprint: expect.stringMatching(/^sha256:/),
    })
  })

  it('returns no requirement when no metadata exists', async () => {
    const tool = new InspectPythonEnvironmentTool()

    const result = await tool.execute({}, {
      sessionId: 'session-1',
      persistentWorkspace: {
        sandboxSession: {
          listFiles: vi.fn(async () => [{ path: 'main.tex', size: 10 }]),
        },
      },
    })

    expect(result.success).toBe(true)
    expect(result.output).toBe('No Python dependency metadata found in the sandbox workspace.')
    expect(result.data).toMatchObject({
      required: false,
      status: 'none',
      events: [],
    })
  })

  it('fails closed without a persistent sandbox', async () => {
    const tool = new InspectPythonEnvironmentTool()

    const result = await tool.execute({}, {
      sessionId: 'session-1',
      persistentWorkspace: {},
    })

    expect(result.success).toBe(false)
    expect(result.data).toMatchObject({
      code: 'SANDBOX_COMMAND_POLICY_DENIED',
      reason: 'missing-persistent-sandbox',
    })
  })
})
