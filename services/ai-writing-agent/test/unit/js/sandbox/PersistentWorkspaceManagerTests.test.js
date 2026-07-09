import { describe, expect, it, vi } from 'vitest'
import {
  SandboxNotFoundError,
} from '../../../../app/js/sandbox/SandboxErrors.js'
import {
  PersistentWorkspaceDriftError,
  PersistentWorkspaceManager,
} from '../../../../app/js/sandbox/PersistentWorkspaceManager.js'

vi.mock('@overleaf/logger', () => ({
  default: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}))

vi.mock('@overleaf/settings', () => ({
  default: {
    mongo: { url: 'mongodb://127.0.0.1/test', options: {} },
  },
}))

vi.mock('@overleaf/metrics', () => ({
  default: { mongodb: { monitor: vi.fn() } },
}))

vi.mock('@overleaf/mongo-utils', () => ({
  ObjectId: class ObjectId {
    constructor(value) {
      this.value = value
    }
  },
  db: {},
  waitForDb: vi.fn(),
}))

vi.mock('mongodb', () => ({
  ObjectId: class ObjectId {
    constructor(value) {
      this.value = value
    }

    toString() {
      return this.value
    }
  },
  MongoClient: class MongoClient {
    db() {
      return { collection: vi.fn(() => ({})) }
    }
  },
}))

vi.mock('@overleaf/config-system', () => ({
  default: {
    ConfigManager: class {},
    definitionsByService: {},
  },
}))

const SESSION_ID = '0123456789abcdef01234567'
const PROJECT_ID = 'abcdef0123456789abcdef01'
const USER_ID = 'fedcba9876543210fedcba98'

function runtimeConfig(overrides = {}) {
  return {
    sandboxEnabled: true,
    agentLoopV2Enabled: false,
    sandbox: {
      provider: 'local-docker',
      workspaceTtlMs: 60_000,
      ...overrides.sandbox,
    },
    ...overrides,
  }
}

function createCollection(seed = []) {
  const docs = [...seed]
  return {
    docs,
    insertOne: vi.fn(async doc => {
      docs.push({ ...doc })
      return { insertedId: doc._id }
    }),
    updateOne: vi.fn(async (filter, update) => {
      const doc = docs.find(candidate => matches(candidate, filter))
      if (!doc) return { matchedCount: 0, modifiedCount: 0 }
      Object.assign(doc, update.$set || {})
      for (const key of Object.keys(update.$unset || {})) {
        delete doc[key]
      }
      return { matchedCount: 1, modifiedCount: 1 }
    }),
    findOne: vi.fn(async filter => docs.find(doc => matches(doc, filter)) || null),
    find: vi.fn(filter => ({
      toArray: async () => docs.filter(doc => matches(doc, filter)),
    })),
  }
}

function matches(doc, filter) {
  return Object.entries(filter || {}).every(([key, expected]) => {
    const actual = doc[key]
    if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
      if ('$in' in expected) return expected.$in.includes(actual)
      if ('$nin' in expected) return !expected.$nin.includes(actual)
      if ('$gt' in expected) return actual > expected.$gt
      if ('$lte' in expected) return actual <= expected.$lte
    }
    if (actual?.value || expected?.value) {
      return (actual?.value || actual) === (expected?.value || expected)
    }
    return actual === expected
  })
}

async function captureError(promise) {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('Expected promise to reject')
}

function createManager(options = {}) {
  const sandboxSession = options.sandboxSession || {
    id: 'workspace-1',
    workspacePath: '/tmp/workspace-1',
  }
  const provider = options.provider || {
    createSession: vi.fn().mockResolvedValue(sandboxSession),
    resumeSession: vi.fn().mockResolvedValue(sandboxSession),
    destroySession: vi.fn().mockResolvedValue(undefined),
  }
  const manifest = options.manifest || {
    version: 1,
    projectId: PROJECT_ID,
    files: [
      {
        path: '/main.tex',
        workspacePath: 'main.tex',
        entityType: 'doc',
        entityId: 'doc-1',
        baseVersion: 7,
        sha256: 'base',
      },
    ],
  }
  const exporter = options.exporter || {
    exportProject: vi.fn().mockResolvedValue(manifest),
  }
  const projectAdapter = options.projectAdapter || {
    getEntities: vi.fn().mockResolvedValue({
      docs: [{ id: 'doc-1', path: '/main.tex', name: 'main.tex' }],
      files: [],
    }),
  }
  const documentAdapter = options.documentAdapter || {
    getDocumentContent: vi.fn().mockResolvedValue({
      content: 'hello',
      version: 7,
    }),
  }
  const workspacesCollection =
    options.workspacesCollection || createCollection()
  const sessionsCollection = options.sessionsCollection || createCollection([
    { _id: SESSION_ID },
  ])
  const now = options.now || vi.fn(() => new Date('2026-06-20T00:00:00.000Z'))
  const manager = new PersistentWorkspaceManager({
    getRuntimeConfig: () => runtimeConfig(),
    provider,
    exporter,
    projectAdapter,
    documentAdapter,
    workspacesCollection,
    sessionsCollection,
    generateWorkspaceId: () => 'workspace-1',
    now,
  })
  return {
    manager,
    provider,
    exporter,
    projectAdapter,
    documentAdapter,
    workspacesCollection,
    sessionsCollection,
  }
}

describe('PersistentWorkspaceManager', () => {
  it('creates a reusable workspace without destroying it after export', async () => {
    const { manager, provider, exporter, workspacesCollection, sessionsCollection } =
      createManager()

    const result = await manager.ensureWorkspace({
      sessionId: SESSION_ID,
      projectId: PROJECT_ID,
      userId: USER_ID,
    })

    expect(result.created).toBe(true)
    expect(result.workspace._id).toBe('workspace-1')
    expect(provider.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'workspace-1',
        projectId: PROJECT_ID,
        userId: USER_ID,
      })
    )
    expect(provider.destroySession).not.toHaveBeenCalled()
    expect(exporter.exportProject).toHaveBeenCalledWith(
      PROJECT_ID,
      '/tmp/workspace-1',
      expect.objectContaining({ userId: USER_ID, sessionId: SESSION_ID })
    )
    expect(workspacesCollection.docs[0]).toMatchObject({
      _id: 'workspace-1',
      status: 'ready',
      workspacePath: '/tmp/workspace-1',
    })
    expect(sessionsCollection.updateOne).toHaveBeenCalledWith(
      { _id: expect.objectContaining({ value: SESSION_ID }) },
      expect.objectContaining({
        $set: expect.objectContaining({
          workspaceId: 'workspace-1',
          workspaceStatus: 'ready',
        }),
      })
    )
  })

  it('resumes an existing workspace and reports no drift when versions match', async () => {
    const workspacesCollection = createCollection([
      {
        _id: 'workspace-1',
        sessionId: SESSION_ID,
        projectId: PROJECT_ID,
        userId: USER_ID,
        status: 'ready',
        providerSessionId: 'workspace-1',
        workspacePath: '/tmp/workspace-1',
        manifest: {
          files: [
            {
              path: '/main.tex',
              entityType: 'doc',
              entityId: 'doc-1',
              baseVersion: 7,
            },
          ],
        },
        expiresAt: new Date('2026-06-20T00:10:00.000Z'),
      },
    ])
    const { manager, provider, exporter } = createManager({
      workspacesCollection,
    })

    const result = await manager.ensureWorkspace({
      sessionId: SESSION_ID,
      projectId: PROJECT_ID,
      userId: USER_ID,
    })

    expect(result.created).toBe(false)
    expect(result.drift).toEqual({ hasDrift: false, changes: [] })
    expect(workspacesCollection.findOne).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      projectId: PROJECT_ID,
      userId: USER_ID,
      status: { $in: ['active', 'ready'] },
      expiresAt: { $gt: new Date('2026-06-20T00:00:00.000Z') },
    })
    expect(provider.resumeSession).toHaveBeenCalledWith('workspace-1', {
      workspacePath: '/tmp/workspace-1',
      containerName: undefined,
      providerSessionId: 'workspace-1',
    })
    expect(exporter.exportProject).not.toHaveBeenCalled()
  })

  it('retires stale reusable workspaces and creates a fresh one when resume fails', async () => {
    const workspacesCollection = createCollection([
      {
        _id: 'workspace-stale',
        sessionId: SESSION_ID,
        projectId: PROJECT_ID,
        userId: USER_ID,
        status: 'ready',
        providerSessionId: 'workspace-stale',
        workspacePath: '/tmp/workspace-stale',
        manifest: { files: [] },
        expiresAt: new Date('2026-06-20T00:10:00.000Z'),
      },
    ])
    const provider = {
      createSession: vi.fn().mockResolvedValue({
        id: 'workspace-1',
        workspacePath: '/tmp/workspace-1',
      }),
      resumeSession: vi.fn().mockRejectedValue(
        new SandboxNotFoundError('workspace-stale')
      ),
      destroySession: vi.fn().mockResolvedValue(undefined),
    }
    const { manager, exporter, sessionsCollection } = createManager({
      provider,
      workspacesCollection,
    })

    const result = await manager.ensureWorkspace({
      sessionId: SESSION_ID,
      projectId: PROJECT_ID,
      userId: USER_ID,
    })

    expect(result.created).toBe(true)
    expect(result.workspace._id).toBe('workspace-1')
    expect(provider.resumeSession).toHaveBeenCalledWith('workspace-stale', {
      workspacePath: '/tmp/workspace-stale',
      containerName: undefined,
      providerSessionId: 'workspace-stale',
    })
    expect(provider.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'workspace-1' })
    )
    expect(exporter.exportProject).toHaveBeenCalledWith(
      PROJECT_ID,
      '/tmp/workspace-1',
      expect.objectContaining({ userId: USER_ID, sessionId: SESSION_ID })
    )
    expect(workspacesCollection.docs.find(doc => doc._id === 'workspace-stale'))
      .toMatchObject({ status: 'expired' })
    expect(sessionsCollection.updateOne).toHaveBeenCalledWith(
      { _id: expect.objectContaining({ value: SESSION_ID }) },
      expect.objectContaining({
        $set: expect.objectContaining({ workspaceId: 'workspace-1' }),
      })
    )
  })

  it('throws a drift error when requested and document versions changed', async () => {
    const workspacesCollection = createCollection([
      {
        _id: 'workspace-1',
        sessionId: SESSION_ID,
        projectId: PROJECT_ID,
        userId: USER_ID,
        status: 'ready',
        providerSessionId: 'workspace-1',
        workspacePath: '/tmp/workspace-1',
        manifest: {
          files: [
            {
              path: '/main.tex',
              entityType: 'doc',
              entityId: 'doc-1',
              baseVersion: 7,
            },
          ],
        },
        expiresAt: new Date('2026-06-20T00:10:00.000Z'),
      },
    ])
    const documentAdapter = {
      getDocumentContent: vi.fn().mockResolvedValue({
        content: 'changed',
        version: 9,
      }),
    }
    const { manager } = createManager({
      workspacesCollection,
      documentAdapter,
    })

    let driftError = null
    try {
      await manager.ensureWorkspace({
        sessionId: SESSION_ID,
        projectId: PROJECT_ID,
        userId: USER_ID,
        failOnDrift: true,
      })
    } catch (error) {
      driftError = error
    }
    expect(driftError).toBeInstanceOf(PersistentWorkspaceDriftError)
  })

  it('marks expired workspaces and destroys provider sessions during cleanup', async () => {
    const workspacesCollection = createCollection([
      {
        _id: 'workspace-1',
        sessionId: SESSION_ID,
        projectId: PROJECT_ID,
        userId: USER_ID,
        status: 'ready',
        providerSessionId: 'workspace-1',
        workspacePath: '/tmp/workspace-1/workspace',
        containerName: 'overleaf-ai-sandbox-workspace-1',
        expiresAt: new Date('2026-06-19T23:59:00.000Z'),
      },
    ])
    const { manager, provider } = createManager({ workspacesCollection })

    const result = await manager.cleanupExpired()

    expect(result).toEqual({ removedWorkspaces: ['workspace-1'] })
    expect(provider.destroySession).toHaveBeenCalledWith('workspace-1', {
      workspacePath: '/tmp/workspace-1/workspace',
      containerName: 'overleaf-ai-sandbox-workspace-1',
      providerSessionId: 'workspace-1',
    })
    expect(workspacesCollection.docs[0].status).toBe('expired')
  })

  it('syncs workspace diff into ai session pending changes without applying canonical docs', async () => {
    const workspacesCollection = createCollection([
      {
        _id: 'workspace-1',
        sessionId: SESSION_ID,
        projectId: PROJECT_ID,
        userId: USER_ID,
        status: 'ready',
        providerSessionId: 'workspace-1',
        workspacePath: '/tmp/workspace-1',
        manifest: {
          version: 1,
          projectId: PROJECT_ID,
          files: [
            {
              path: '/main.tex',
              workspacePath: 'main.tex',
              entityType: 'doc',
              entityId: 'doc-1',
              baseVersion: 7,
              sha256: 'old',
            },
          ],
        },
        expiresAt: new Date('2026-06-20T00:10:00.000Z'),
      },
    ])
    const sessionsCollection = createCollection([
      {
        _id: { value: SESSION_ID },
        projectId: PROJECT_ID,
        userId: USER_ID,
        pendingChanges: [
          {
            id: 'existing-other-source',
            source: 'manual',
            workspaceId: 'workspace-1',
            status: 'pending',
          },
          {
            id: 'existing-same-workspace',
            source: 'persistent-workspace',
            workspaceId: 'workspace-1',
            status: 'pending',
          },
          {
            id: 'existing-other-workspace',
            source: 'persistent-workspace',
            workspaceId: 'workspace-2',
            status: 'pending',
          },
        ],
      },
    ])
    const diff = {
      projectId: PROJECT_ID,
      modified: [{ path: '/main.tex', oldText: 'Hello', newText: 'Hi' }],
      created: [],
      deleted: [],
      binaryChanged: [],
    }
    const diffCollector = {
      collect: vi.fn().mockResolvedValue(diff),
    }
    const pendingChanges = [{ id: 'change-1', type: 'edit', status: 'pending' }]
    const patchConverter = {
      convert: vi.fn().mockReturnValue(pendingChanges),
    }
    const { manager, provider } = createManager({
      workspacesCollection,
      sessionsCollection,
    })
    manager.diffCollector = diffCollector
    manager.patchConverter = patchConverter

    const result = await manager.syncPendingChanges({
      sessionId: SESSION_ID,
      projectId: PROJECT_ID,
      userId: USER_ID,
    })

    expect(provider.resumeSession).toHaveBeenCalledWith('workspace-1', {
      workspacePath: '/tmp/workspace-1',
      containerName: undefined,
      providerSessionId: 'workspace-1',
    })
    expect(diffCollector.collect).toHaveBeenCalledWith(
      '/tmp/workspace-1',
      workspacesCollection.docs[0].manifest
    )
    expect(patchConverter.convert).toHaveBeenCalledWith(
      diff,
      workspacesCollection.docs[0].manifest,
      { projectId: PROJECT_ID, source: 'persistent-workspace' }
    )
    expect(result.changeCount).toBe(1)
    expect(sessionsCollection.docs[0].pendingChanges).toEqual([
      {
        id: 'existing-other-source',
        source: 'manual',
        workspaceId: 'workspace-1',
        status: 'pending',
      },
      {
        id: 'existing-other-workspace',
        source: 'persistent-workspace',
        workspaceId: 'workspace-2',
        status: 'pending',
      },
      {
        id: 'change-1',
        type: 'edit',
        status: 'pending',
        source: 'persistent-workspace',
        workspaceId: 'workspace-1',
        sandboxSessionId: 'workspace-1',
      },
    ])
    expect(sessionsCollection.docs[0].workspaceStatus).toBe('pending-review')
    expect(workspacesCollection.docs[0].lastPendingChangeCount).toBe(1)
  })

  it('rejects injected workspaces that belong to another project or user', async () => {
    const maliciousWorkspace = {
      _id: 'workspace-other',
      sessionId: SESSION_ID,
      projectId: 'bbbbbbbbbbbbbbbbbbbbbbbb',
      userId: USER_ID,
      status: 'ready',
      providerSessionId: 'workspace-other',
      workspacePath: '/tmp/workspace-other',
      manifest: {
        version: 1,
        projectId: 'bbbbbbbbbbbbbbbbbbbbbbbb',
        files: [],
      },
    }
    const diffCollector = { collect: vi.fn() }
    const { manager, provider } = createManager()
    manager.diffCollector = diffCollector

    const error = await captureError(manager.syncPendingChanges({
      sessionId: SESSION_ID,
      projectId: PROJECT_ID,
      userId: USER_ID,
      workspace: maliciousWorkspace,
    }))

    expect(error.code).toBe('SANDBOX_INVALID_INPUT')
    expect(error.message).toContain('does not belong')
    expect(provider.resumeSession).not.toHaveBeenCalled()
    expect(diffCollector.collect).not.toHaveBeenCalled()
  })

  it('falls back to workspace id when cleaning legacy expired workspaces', async () => {
    const workspacesCollection = createCollection([
      {
        _id: 'workspace-legacy',
        sessionId: SESSION_ID,
        projectId: PROJECT_ID,
        userId: USER_ID,
        status: 'ready',
        workspacePath: '/tmp/workspace-legacy/workspace',
        expiresAt: new Date('2026-06-19T23:59:00.000Z'),
      },
    ])
    const { manager, provider } = createManager({ workspacesCollection })

    const result = await manager.cleanupExpired()

    expect(result).toEqual({ removedWorkspaces: ['workspace-legacy'] })
    expect(provider.destroySession).toHaveBeenCalledWith('workspace-legacy', {
      workspacePath: '/tmp/workspace-legacy/workspace',
      containerName: undefined,
      providerSessionId: undefined,
    })
    expect(workspacesCollection.docs[0].status).toBe('expired')
  })

  it('marks expired workspaces when cleanup provider cannot be created', async () => {
    const workspacesCollection = createCollection([
      {
        _id: 'workspace-unknown',
        sessionId: SESSION_ID,
        projectId: PROJECT_ID,
        userId: USER_ID,
        status: 'ready',
        provider: 'unknown-provider',
        providerSessionId: 'workspace-unknown',
        expiresAt: new Date('2026-06-19T23:59:00.000Z'),
      },
    ])
    const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn() }
    const manager = new PersistentWorkspaceManager({
      getRuntimeConfig: () => runtimeConfig(),
      provider: null,
      workspacesCollection,
      sessionsCollection: createCollection([{ _id: SESSION_ID }]),
      logger,
      now: vi.fn(() => new Date('2026-06-20T00:00:00.000Z')),
    })

    const result = await manager.cleanupExpired()

    expect(result).toEqual({ removedWorkspaces: ['workspace-unknown'] })
    expect(workspacesCollection.docs[0].status).toBe('expired')
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'workspace-unknown',
        provider: 'unknown-provider',
      }),
      'failed to create provider for expired persistent workspace cleanup'
    )
  })
})
