import { describe, expect, it, vi } from 'vitest'

const { PythonRuntimeMountService } = await import(
  '../../../../app/js/python/PythonRuntimeMountService.js'
)

async function captureError(promise) {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('Expected promise to reject')
}

describe('PythonRuntimeMountService', () => {
  it('fails closed when the sandbox provider cannot mount immutable runtime envs', async () => {
    const environmentStore = {
      getSnapshot: vi.fn(async environmentId => ({
        manifest: {
          environmentId,
          scope: 'skill',
          skillName: 'table-analysis',
          files: [
            { path: 'bin/python', hash: 'sha256:python', size: 10 },
            { path: 'site-packages/pkg.py', hash: 'sha256:pkg', size: 8 },
          ],
          runtime: {
            sitePackages: ['site-packages'],
          },
        },
        readFile: vi.fn(async filePath => Buffer.from(`content:${filePath}`)),
      })),
    }
    const usageService = {
      recordAttached: vi.fn(async () => ({ _id: { toString: () => 'usage-1' } })),
    }
    const service = new PythonRuntimeMountService({
      environmentStore,
      usageService,
      now: () => new Date('2026-06-24T00:00:00.000Z'),
    })

    const writeFile = vi.fn()

    const error = await captureError(service.attach({
      environmentId: 'pyenv_table_analysis',
    }, {
      sessionId: 'session-1',
      turnId: 'turn-1',
      persistentWorkspace: {
        workspace: { _id: 'workspace-1' },
        sandboxSession: {
          id: 'sandbox-1',
          writeFile,
        },
      },
    }))

    expect(error.code).toBe('PYTHON_ENV_IMMUTABLE_MOUNT_UNSUPPORTED')
    expect(error.info.reason).toBe('immutable-runtime-env-mount-unsupported')
    expect(error.message).toContain('immutable Python environment mounts')
    expect(writeFile).not.toHaveBeenCalled()
    expect(usageService.recordAttached).not.toHaveBeenCalled()
  })

  it('uses provider-managed runtime environment storage when available', async () => {
    const environmentStore = {
      getSnapshot: vi.fn(async environmentId => ({
        manifest: {
          environmentId,
          files: [
            { path: 'site-packages/pkg.py', hash: 'sha256:pkg', size: 8 },
          ],
          runtime: { sitePackages: ['site-packages'] },
        },
        readVerifiedFile: vi.fn(async file => Buffer.from(`verified:${file.path}`)),
      })),
    }
    const usageService = {
      recordAttached: vi.fn(async () => ({ _id: { toString: () => 'usage-2' } })),
    }
    const writeFile = vi.fn()
    const writeRuntimeEnvironmentFile = vi.fn()
    const service = new PythonRuntimeMountService({
      environmentStore,
      usageService,
      now: () => new Date('2026-06-24T01:00:00.000Z'),
    })

    const result = await service.attach({
      environmentId: 'pyenv_readonly',
    }, {
      sessionId: 'session-2',
      persistentWorkspace: {
        workspace: { _id: 'workspace-2' },
        sandboxSession: {
          id: 'sandbox-2',
          capabilities: { immutableRuntimeEnvironmentMount: true },
          writeFile,
          writeRuntimeEnvironmentFile,
        },
      },
    })

    expect(result.targetRoot).toBe('.agent/python-envs/pyenv_readonly')
    expect(writeFile).not.toHaveBeenCalled()
    expect(writeRuntimeEnvironmentFile).toHaveBeenCalledTimes(2)
    expect(writeRuntimeEnvironmentFile).toHaveBeenNthCalledWith(
      1,
      'pyenv_readonly',
      'site-packages/pkg.py',
      Buffer.from('verified:site-packages/pkg.py')
    )
    expect(writeRuntimeEnvironmentFile.mock.calls[1][0]).toBe('pyenv_readonly')
    expect(writeRuntimeEnvironmentFile.mock.calls[1][1]).toBe('.resink-env-manifest.json')
    expect(String(writeRuntimeEnvironmentFile.mock.calls[1][2])).toContain(
      '"attachedAt": "2026-06-24T01:00:00.000Z"'
    )
  })

  it('does not trust provider runtime writers without the immutable mount capability', async () => {
    const writeRuntimeEnvironmentFile = vi.fn()
    const environmentStore = {
      getSnapshot: vi.fn(async environmentId => ({
        manifest: {
          environmentId,
          files: [{ path: 'site-packages/pkg.py', hash: 'sha256:pkg', size: 8 }],
          runtime: { sitePackages: ['site-packages'] },
        },
        readVerifiedFile: vi.fn(async file => Buffer.from(`verified:${file.path}`)),
      })),
    }
    const usageService = { recordAttached: vi.fn() }
    const service = new PythonRuntimeMountService({
      environmentStore,
      usageService,
    })

    const error = await captureError(service.attach({
      environmentId: 'pyenv_e2b',
    }, {
      sessionId: 'session-1',
      persistentWorkspace: {
        workspace: { _id: 'workspace-1' },
        sandboxSession: {
          id: 'sandbox-e2b',
          capabilities: { immutableRuntimeEnvironmentMount: false },
          writeRuntimeEnvironmentFile,
        },
      },
    }))

    expect(error.code).toBe('PYTHON_ENV_IMMUTABLE_MOUNT_UNSUPPORTED')
    expect(writeRuntimeEnvironmentFile).not.toHaveBeenCalled()
    expect(usageService.recordAttached).not.toHaveBeenCalled()
  })

  it('fails closed without a persistent sandbox workspace', async () => {
    const service = new PythonRuntimeMountService({
      environmentStore: { getSnapshot: vi.fn() },
      usageService: { recordAttached: vi.fn() },
    })

    const error = await captureError(service.attach({
      environmentId: 'pyenv_missing',
    }, {
      sessionId: 'session-1',
      persistentWorkspace: {},
    }))
    expect(error.message).toContain('persistent sandbox workspace')
  })

  it('fails closed before writing tampered snapshot files into the sandbox', async () => {
    const writeRuntimeEnvironmentFile = vi.fn()
    const environmentStore = {
      getSnapshot: vi.fn(async environmentId => ({
        manifest: {
          environmentId,
          files: [{ path: 'site-packages/pkg.py', hash: 'sha256:approved' }],
          runtime: { sitePackages: ['site-packages'] },
        },
        readVerifiedFile: vi.fn(async () => {
          throw new Error('Python environment snapshot hash mismatch: site-packages/pkg.py')
        }),
      })),
    }
    const usageService = { recordAttached: vi.fn() }
    const service = new PythonRuntimeMountService({
      environmentStore,
      usageService,
    })

    const error = await captureError(service.attach({
      environmentId: 'pyenv_tampered',
    }, {
      sessionId: 'session-1',
      persistentWorkspace: {
        workspace: { _id: 'workspace-1' },
        sandboxSession: {
          id: 'sandbox-1',
          capabilities: { immutableRuntimeEnvironmentMount: true },
          writeRuntimeEnvironmentFile,
        },
      },
    }))

    expect(error.message).toContain('snapshot hash mismatch')
    expect(writeRuntimeEnvironmentFile).not.toHaveBeenCalled()
    expect(usageService.recordAttached).not.toHaveBeenCalled()
  })
})
