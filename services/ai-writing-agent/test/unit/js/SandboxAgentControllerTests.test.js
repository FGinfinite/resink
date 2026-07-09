import { describe, expect, it, vi } from 'vitest'
import { SandboxAgentController } from '../../../app/js/SandboxAgentController.js'
import { SandboxSessionDisabledError } from '../../../app/js/sandbox/SandboxSessionManager.js'

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

vi.mock('@overleaf/logger', () => ({
  default: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}))

vi.mock('@overleaf/o-error', () => ({
  default: class OError extends Error {},
}))

vi.mock('@overleaf/config-system', () => ({
  default: {
    ConfigManager: class {},
    definitionsByService: {},
  },
}))

vi.mock('@overleaf/promise-utils', () => ({
  expressify: (fn) => fn,
}))

async function* events(items) {
  for (const item of items) {
    yield item
  }
}

async function* eventsWithError(error) {
  for await (const event of []) {
    yield event
  }
  throw error
}

function createJsonResponse() {
  return {
    statusCode: null,
    body: null,
    status: vi.fn(function (code) {
      this.statusCode = code
      return this
    }),
    json: vi.fn(function (body) {
      this.body = body
      return this
    }),
    setHeader: vi.fn(function () {
      return this
    }),
    send: vi.fn(function (body) {
      this.body = body
      return this
    }),
  }
}

describe('SandboxAgentController', () => {
  it('returns collected sandbox events for non-stream requests', async () => {
    const manager = {
      startSession: vi.fn(() =>
        events([
          { type: 'session_started', sessionId: 'session-1' },
          { type: 'done', sessionId: 'session-1' },
        ])
      ),
    }
    const controller = new SandboxAgentController({ manager })
    const res = createJsonResponse()

    await controller.startSession(
      {
        body: { projectId: '0123456789abcdef01234567', prompt: 'run' },
        headers: { 'x-user-id': 'abcdef0123456789abcdef01' },
      },
      res
    )

    expect(res.status).toHaveBeenCalledWith(201)
    expect(res.body.events.map((event) => event.type)).toEqual([
      'session_started',
      'done',
    ])
    expect(manager.startSession).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: '0123456789abcdef01234567',
        userId: 'abcdef0123456789abcdef01',
        prompt: 'run',
      })
    )
  })

  it('returns not-enabled when sandbox runtime mode is disabled', async () => {
    const manager = {
      startSession: vi.fn(() => eventsWithError(new SandboxSessionDisabledError())),
    }
    const controller = new SandboxAgentController({ manager })
    const res = createJsonResponse()

    await controller.startSession(
      {
        body: { projectId: '0123456789abcdef01234567' },
        headers: { 'x-user-id': 'abcdef0123456789abcdef01' },
      },
      res
    )

    expect(res.status).toHaveBeenCalledWith(409)
    expect(res.body).toEqual({
      error: 'Sandbox runtime is not enabled',
      code: 'SANDBOX_NOT_ENABLED',
    })
  })

  it('returns a safe error body for failed sandbox sessions', async () => {
    const error = new Error('secret stack detail')
    const manager = {
      startSession: vi.fn(() => eventsWithError(error)),
    }
    const logger = { warn: vi.fn() }
    const controller = new SandboxAgentController({ manager, logger })
    const res = createJsonResponse()

    await controller.startSession(
      {
        body: { projectId: '0123456789abcdef01234567' },
        headers: { 'x-user-id': 'abcdef0123456789abcdef01' },
      },
      res
    )

    expect(res.status).toHaveBeenCalledWith(500)
    expect(res.body).toEqual({
      error: 'Sandbox session failed',
      code: 'SANDBOX_SESSION_FAILED',
    })
    expect(JSON.stringify(res.body)).not.toContain('secret stack detail')
  })

  it('runs admin sandbox cleanup for expired workspaces and local Docker orphans', async () => {
    const cleanupExpired = vi.fn().mockResolvedValue({
      removedWorkspaces: ['workspace-1'],
    })
    const manualCleanup = vi.fn().mockResolvedValue({
      removedContainers: ['container-1'],
      removedWorkspaces: ['/tmp/workspace-1'],
    })
    const Provider = vi.fn(function LocalDockerSandboxProvider() {
      return { manualCleanup }
    })
    const controller = new SandboxAgentController({
      manager: {},
      workspaceManager: { cleanupExpired },
      LocalDockerSandboxProvider: Provider,
      getRuntimeConfig: () => ({
        sandboxEnabled: false,
        agentLoopV2Enabled: true,
        sandbox: {
          provider: 'local-docker',
          image: 'resink-ai-sandbox:dev',
          rootDir: '/tmp/ai-sandbox',
          commandTimeoutMs: 120000,
          maxOutputBytes: 2000000,
          maxArtifactBytes: 50000000,
          maxFileCount: 5000,
          networkPolicy: 'deny',
          memoryBytes: 536870912,
          memorySwapBytes: 536870912,
          cpuCount: 1,
          pidsLimit: 256,
        },
      }),
    })
    const res = createJsonResponse()

    await controller.cleanupSandbox(
      {
        body: { includeActive: true, removeWorkspaces: false },
        headers: { 'x-user-id': 'abcdef0123456789abcdef01' },
      },
      res
    )

    expect(cleanupExpired).toHaveBeenCalledWith({ includeActive: true })
    expect(Provider).toHaveBeenCalledWith(
      expect.objectContaining({
        image: 'resink-ai-sandbox:dev',
        rootDir: '/tmp/ai-sandbox',
        memoryBytes: 536870912,
        cpuCount: 1,
        pidsLimit: 256,
      })
    )
    expect(manualCleanup).toHaveBeenCalledWith({
      includeActive: true,
      removeWorkspaces: false,
    })
    expect(res.body).toMatchObject({
      includeActive: true,
      removeWorkspaces: false,
      expiredWorkspaces: { removedWorkspaces: ['workspace-1'] },
      orphanCleanup: {
        skipped: false,
        removedContainers: ['container-1'],
        removedWorkspaces: ['/tmp/workspace-1'],
      },
    })
  })

  it('accepts a sandbox text edit through the document adapter', async () => {
    const updateOne = vi.fn().mockResolvedValue({})
    const documentAdapter = {
      applyEdit: vi.fn().mockResolvedValue({
        newVersion: 8,
        wasRebased: false,
      }),
    }
    const change = {
      id: 'change-1',
      type: 'edit',
      status: 'pending',
      projectId: '0123456789abcdef01234567',
      docId: 'doc-1',
    }
    const controller = new SandboxAgentController({
      manager: {},
      documentAdapter,
      sessionsCollection: {
        findOne: vi.fn().mockResolvedValue({
          _id: 'sandbox-1',
          userId: 'abcdef0123456789abcdef01',
          pendingChanges: [change],
        }),
        updateOne,
      },
    })
    const res = createJsonResponse()

    await controller.acceptChange(
      {
        params: { sandboxSessionId: 'sandbox-1', changeId: 'change-1' },
        headers: { 'x-user-id': 'abcdef0123456789abcdef01' },
        body: {},
      },
      res
    )

    expect(documentAdapter.applyEdit).toHaveBeenCalledWith(change, {
      userId: 'abcdef0123456789abcdef01',
    })
    expect(updateOne).toHaveBeenCalledWith(
      {
        _id: 'sandbox-1',
        pendingChanges: { $elemMatch: { id: 'change-1' } },
      },
      expect.objectContaining({
        $set: expect.objectContaining({
          'pendingChanges.$.status': 'accepted',
          'pendingChanges.$.appliedVersion': 8,
        }),
      })
    )
    expect(res.body).toMatchObject({
      success: true,
      change: { id: 'change-1', status: 'accepted' },
    })
  })

  it('accepts a sandbox create change through project and document adapters', async () => {
    const updateOne = vi.fn().mockResolvedValue({})
    const documentAdapter = {
      _callSetDocAPI: vi.fn().mockResolvedValue({}),
    }
    const projectAdapter = {
      ensureFolderPath: vi.fn().mockResolvedValue({ folderId: 'folder-1' }),
      createDoc: vi.fn().mockResolvedValue({ _id: 'doc-created' }),
      deleteEntity: vi.fn(),
      clearCache: vi.fn(),
    }
    const change = {
      id: 'change-create',
      type: 'create',
      status: 'pending',
      projectId: '0123456789abcdef01234567',
      path: 'sections/new.tex',
      content: 'hello\nworld',
    }
    const controller = new SandboxAgentController({
      manager: {},
      documentAdapter,
      projectAdapter,
      sessionsCollection: {
        findOne: vi.fn().mockResolvedValue({
          _id: 'sandbox-1',
          userId: 'abcdef0123456789abcdef01',
          pendingChanges: [change],
        }),
        updateOne,
      },
    })
    const res = createJsonResponse()

    await controller.acceptChange(
      {
        params: { sandboxSessionId: 'sandbox-1', changeId: 'change-create' },
        headers: { 'x-user-id': 'abcdef0123456789abcdef01' },
        body: {},
      },
      res
    )

    expect(projectAdapter.ensureFolderPath).toHaveBeenCalledWith(
      '0123456789abcdef01234567',
      'sections',
      'abcdef0123456789abcdef01'
    )
    expect(projectAdapter.createDoc).toHaveBeenCalledWith(
      '0123456789abcdef01234567',
      'new.tex',
      'folder-1',
      'abcdef0123456789abcdef01'
    )
    expect(documentAdapter._callSetDocAPI).toHaveBeenCalledWith(
      '0123456789abcdef01234567',
      'doc-created',
      ['hello', 'world'],
      'abcdef0123456789abcdef01',
      0
    )
    expect(projectAdapter.clearCache).toHaveBeenCalledWith(
      '0123456789abcdef01234567'
    )
    expect(updateOne).toHaveBeenCalledWith(
      {
        _id: 'sandbox-1',
        pendingChanges: { $elemMatch: { id: 'change-create' } },
      },
      expect.objectContaining({
        $set: expect.objectContaining({
          'pendingChanges.$.status': 'accepted',
          'pendingChanges.$.appliedVersion': 1,
        }),
      })
    )
    expect(res.body).toMatchObject({
      success: true,
      change: { id: 'change-create', status: 'accepted' },
    })
  })

  it('rolls back a created document when initial content write fails', async () => {
    const documentAdapter = {
      _callSetDocAPI: vi.fn().mockRejectedValue(new Error('write failed')),
    }
    const projectAdapter = {
      createDoc: vi.fn().mockResolvedValue({ _id: 'doc-created' }),
      deleteEntity: vi.fn().mockResolvedValue({}),
      clearCache: vi.fn(),
    }
    const change = {
      id: 'change-create',
      type: 'create',
      status: 'pending',
      projectId: '0123456789abcdef01234567',
      path: 'new.tex',
      content: 'hello',
    }
    const controller = new SandboxAgentController({
      manager: {},
      documentAdapter,
      projectAdapter,
      sessionsCollection: {
        findOne: vi.fn().mockResolvedValue({
          _id: 'sandbox-1',
          userId: 'abcdef0123456789abcdef01',
          pendingChanges: [change],
        }),
        updateOne: vi.fn().mockResolvedValue({}),
      },
    })
    const res = createJsonResponse()

    await controller.acceptChange(
      {
        params: { sandboxSessionId: 'sandbox-1', changeId: 'change-create' },
        headers: { 'x-user-id': 'abcdef0123456789abcdef01' },
        body: {},
      },
      res
    )

    expect(projectAdapter.deleteEntity).toHaveBeenCalledWith(
      '0123456789abcdef01234567',
      'doc-created',
      'doc',
      'abcdef0123456789abcdef01'
    )
    expect(res.status).toHaveBeenCalledWith(409)
    expect(res.body.error).toBe('SANDBOX_CHANGE_CONFLICT')
  })

  it('accepts a sandbox delete change through the project adapter', async () => {
    const updateOne = vi.fn().mockResolvedValue({})
    const projectAdapter = {
      deleteEntity: vi.fn().mockResolvedValue({}),
      clearCache: vi.fn(),
    }
    const change = {
      id: 'change-delete',
      type: 'delete',
      status: 'pending',
      projectId: '0123456789abcdef01234567',
      entityId: 'doc-1',
      entityType: 'doc',
      path: 'old.tex',
    }
    const controller = new SandboxAgentController({
      manager: {},
      projectAdapter,
      sessionsCollection: {
        findOne: vi.fn().mockResolvedValue({
          _id: 'sandbox-1',
          userId: 'abcdef0123456789abcdef01',
          pendingChanges: [change],
        }),
        updateOne,
      },
    })
    const res = createJsonResponse()

    await controller.acceptChange(
      {
        params: { sandboxSessionId: 'sandbox-1', changeId: 'change-delete' },
        headers: { 'x-user-id': 'abcdef0123456789abcdef01' },
        body: {},
      },
      res
    )

    expect(projectAdapter.deleteEntity).toHaveBeenCalledWith(
      '0123456789abcdef01234567',
      'doc-1',
      'doc',
      'abcdef0123456789abcdef01'
    )
    expect(projectAdapter.clearCache).toHaveBeenCalledWith(
      '0123456789abcdef01234567'
    )
    expect(updateOne).toHaveBeenCalledWith(
      {
        _id: 'sandbox-1',
        pendingChanges: { $elemMatch: { id: 'change-delete' } },
      },
      expect.objectContaining({
        $set: expect.objectContaining({
          'pendingChanges.$.status': 'accepted',
          'pendingChanges.$.appliedVersion': 0,
        }),
      })
    )
    expect(res.body).toMatchObject({
      success: true,
      change: { id: 'change-delete', status: 'accepted' },
    })
  })

  it('does not auto-apply artifact-only sandbox changes', async () => {
    const controller = new SandboxAgentController({
      manager: {},
      sessionsCollection: {
        findOne: vi.fn().mockResolvedValue({
          _id: 'sandbox-1',
          userId: 'abcdef0123456789abcdef01',
          pendingChanges: [
            { id: 'change-1', type: 'artifact', status: 'pending' },
          ],
        }),
      },
    })
    const res = createJsonResponse()

    await controller.acceptChange(
      {
        params: { sandboxSessionId: 'sandbox-1', changeId: 'change-1' },
        headers: { 'x-user-id': 'abcdef0123456789abcdef01' },
        body: {},
      },
      res
    )

    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.body.error).toContain('Artifact-only')
  })

  it('rejects a sandbox pending change', async () => {
    const updateOne = vi.fn().mockResolvedValue({})
    const controller = new SandboxAgentController({
      manager: {},
      sessionsCollection: {
        findOne: vi.fn().mockResolvedValue({
          _id: 'sandbox-1',
          userId: 'abcdef0123456789abcdef01',
          pendingChanges: [{ id: 'change-1', type: 'edit', status: 'pending' }],
        }),
        updateOne,
      },
    })
    const res = createJsonResponse()

    await controller.rejectChange(
      {
        params: { sandboxSessionId: 'sandbox-1', changeId: 'change-1' },
        headers: { 'x-user-id': 'abcdef0123456789abcdef01' },
        body: { reason: 'not needed' },
      },
      res
    )

    expect(updateOne).toHaveBeenCalledWith(
      {
        _id: 'sandbox-1',
        pendingChanges: { $elemMatch: { id: 'change-1' } },
      },
      expect.objectContaining({
        $set: expect.objectContaining({
          'pendingChanges.$.status': 'rejected',
          'pendingChanges.$.rejectReason': 'not needed',
        }),
      })
    )
    expect(res.body).toMatchObject({
      success: true,
      change: { id: 'change-1', status: 'rejected' },
    })
  })

  it('stops an authorized sandbox session through the manager', async () => {
    const manager = {
      stopSession: vi.fn().mockResolvedValue({ stopped: true }),
    }
    const controller = new SandboxAgentController({
      manager,
      sessionsCollection: {
        findOne: vi.fn().mockResolvedValue({
          _id: 'sandbox-1',
          userId: 'abcdef0123456789abcdef01',
        }),
      },
    })
    const res = createJsonResponse()

    await controller.stopSession(
      {
        params: { sandboxSessionId: 'sandbox-1' },
        headers: { 'x-user-id': 'abcdef0123456789abcdef01' },
      },
      res
    )

    expect(manager.stopSession).toHaveBeenCalledWith(
      'sandbox-1',
      'abcdef0123456789abcdef01'
    )
    expect(res.body).toEqual({ success: true, stopped: true })
  })

  it('does not stop a sandbox session owned by another user', async () => {
    const manager = {
      stopSession: vi.fn(),
    }
    const controller = new SandboxAgentController({
      manager,
      sessionsCollection: {
        findOne: vi.fn().mockResolvedValue({
          _id: 'sandbox-1',
          userId: 'abcdef0123456789abcdef01',
        }),
      },
    })
    const res = createJsonResponse()

    await controller.stopSession(
      {
        params: { sandboxSessionId: 'sandbox-1' },
        headers: { 'x-user-id': '111111111111111111111111' },
      },
      res
    )

    expect(res.status).toHaveBeenCalledWith(403)
    expect(manager.stopSession).not.toHaveBeenCalled()
  })

  it('returns an authorized sandbox artifact without leaking other sessions', async () => {
    const controller = new SandboxAgentController({
      manager: {},
      sessionsCollection: {
        findOne: vi.fn().mockResolvedValue({
          _id: 'sandbox-1',
          userId: 'abcdef0123456789abcdef01',
        }),
      },
      artifactsCollection: {
        findOne: vi.fn().mockResolvedValue({
          _id: 'artifact-1',
          sessionId: 'sandbox-1',
          path: 'build/main.pdf',
          content: Buffer.from('pdf'),
        }),
      },
    })
    const res = createJsonResponse()

    await controller.getArtifact(
      {
        params: { sandboxSessionId: 'sandbox-1', artifactId: 'artifact-1' },
        headers: { 'x-user-id': 'abcdef0123456789abcdef01' },
      },
      res
    )

    expect(controller.artifactsCollection.findOne).toHaveBeenCalledWith({
      _id: 'artifact-1',
      sessionId: 'sandbox-1',
    })
    expect(res.setHeader).toHaveBeenCalledWith(
      'Content-Disposition',
      'attachment; filename="main.pdf"'
    )
    expect(res.body.toString()).toBe('pdf')
  })

  it('creates a persistent workspace through the workspace manager', async () => {
    const workspaceManager = {
      sessionsCollection: {
        findOne: vi.fn().mockResolvedValue({
          _id: '0123456789abcdef01234567',
          projectId: 'abcdef0123456789abcdef01',
          userId: 'abcdef0123456789abcdef01',
        }),
      },
      ensureWorkspace: vi.fn().mockResolvedValue({
        created: true,
        workspace: {
          _id: 'workspace-1',
          sessionId: '0123456789abcdef01234567',
          projectId: 'abcdef0123456789abcdef01',
          provider: 'local-docker',
          status: 'ready',
          workspacePath: '/tmp/workspace',
          providerSessionId: 'workspace-1',
          createdAt: new Date('2026-06-20T00:00:00.000Z'),
          updatedAt: new Date('2026-06-20T00:00:00.000Z'),
          lastUsedAt: new Date('2026-06-20T00:00:00.000Z'),
          expiresAt: new Date('2026-06-21T00:00:00.000Z'),
        },
        drift: { hasDrift: false, changes: [] },
      }),
    }
    const controller = new SandboxAgentController({
      manager: {},
      workspaceManager,
    })
    const res = createJsonResponse()

    await controller.createWorkspace(
      {
        body: {
          sessionId: '0123456789abcdef01234567',
          projectId: 'abcdef0123456789abcdef01',
        },
        headers: { 'x-user-id': 'abcdef0123456789abcdef01' },
      },
      res
    )

    expect(workspaceManager.ensureWorkspace).toHaveBeenCalledWith({
      sessionId: '0123456789abcdef01234567',
      projectId: 'abcdef0123456789abcdef01',
      userId: 'abcdef0123456789abcdef01',
      failOnDrift: false,
    })
    expect(res.status).toHaveBeenCalledWith(201)
    expect(res.body.workspace).toMatchObject({
      id: 'workspace-1',
      status: 'ready',
      provider: 'local-docker',
    })
    expect(res.body.workspace).not.toHaveProperty('workspacePath')
    expect(res.body.workspace).not.toHaveProperty('providerSessionId')
  })

  it('rejects persistent workspace creation for mismatched session owner', async () => {
    const workspaceManager = {
      sessionsCollection: {
        findOne: vi.fn().mockResolvedValue({
          _id: '0123456789abcdef01234567',
          projectId: 'abcdef0123456789abcdef01',
          userId: 'abcdef0123456789abcdef01',
        }),
      },
      ensureWorkspace: vi.fn(),
    }
    const controller = new SandboxAgentController({
      manager: {},
      workspaceManager,
    })
    const res = createJsonResponse()

    await controller.createWorkspace(
      {
        body: {
          sessionId: '0123456789abcdef01234567',
          projectId: 'abcdef0123456789abcdef01',
        },
        headers: { 'x-user-id': '111111111111111111111111' },
      },
      res
    )

    expect(res.status).toHaveBeenCalledWith(403)
    expect(workspaceManager.ensureWorkspace).not.toHaveBeenCalled()
  })

  it('rejects persistent workspace creation for mismatched project', async () => {
    const workspaceManager = {
      sessionsCollection: {
        findOne: vi.fn().mockResolvedValue({
          _id: '0123456789abcdef01234567',
          projectId: '222222222222222222222222',
          userId: 'abcdef0123456789abcdef01',
        }),
      },
      ensureWorkspace: vi.fn(),
    }
    const controller = new SandboxAgentController({
      manager: {},
      workspaceManager,
    })
    const res = createJsonResponse()

    await controller.createWorkspace(
      {
        body: {
          sessionId: '0123456789abcdef01234567',
          projectId: 'abcdef0123456789abcdef01',
        },
        headers: { 'x-user-id': 'abcdef0123456789abcdef01' },
      },
      res
    )

    expect(res.status).toHaveBeenCalledWith(409)
    expect(workspaceManager.ensureWorkspace).not.toHaveBeenCalled()
  })

  it('does not return a persistent workspace owned by another user', async () => {
    const controller = new SandboxAgentController({
      manager: {},
      workspacesCollection: {
        findOne: vi.fn().mockResolvedValue({
          _id: 'workspace-1',
          userId: 'abcdef0123456789abcdef01',
        }),
      },
    })
    const res = createJsonResponse()

    await controller.getWorkspace(
      {
        params: { workspaceId: 'workspace-1' },
        headers: { 'x-user-id': '111111111111111111111111' },
      },
      res
    )

    expect(res.status).toHaveBeenCalledWith(403)
  })
})
