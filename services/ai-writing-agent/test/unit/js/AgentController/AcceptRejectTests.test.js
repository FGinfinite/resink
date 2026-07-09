import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ObjectId } from 'mongodb'

// Mock dependencies
vi.mock('@overleaf/logger', () => ({
  default: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

vi.mock('@overleaf/promise-utils', () => ({
  expressify: (fn) => fn,
}))

vi.mock('@overleaf/settings', () => ({
  default: {
    apis: {
      documentUpdater: { url: 'http://doc-updater:3003' },
      web: { url: 'http://web:3000' },
    },
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

// Mock mongodb
const mockDb = {
  aiSessions: {
    findOne: vi.fn(),
    find: vi.fn(),
    updateOne: vi.fn(),
    updateMany: vi.fn(),
    insertOne: vi.fn(),
  },
  aiMessages: {
    find: vi.fn(),
  },
  aiAgentToolCalls: {
    find: vi.fn(),
    findOne: vi.fn(),
    updateOne: vi.fn(),
  },
  aiAgentChangeSets: {
    find: vi.fn(),
  },
  aiAgentDraftChanges: {
    find: vi.fn(),
    findOneAndUpdate: vi.fn(),
  },
  aiAgentApplyOperations: {
    insertOne: vi.fn(),
  },
  aiSandboxArtifacts: {
    findOne: vi.fn(),
    find: vi.fn(),
  },
  aiAgentWorkspaces: {
    findOne: vi.fn(),
  },
}
const mockAllocateSeq = vi.fn()

vi.mock('../../../../app/js/mongodb.js', () => ({
  ObjectId,
  db: mockDb,
  allocateSeq: mockAllocateSeq,
}))

// Mock DocumentAdapter
const mockApplyEdit = vi.fn()

vi.mock('../../../../app/js/adapter/DocumentAdapter.js', () => ({
  DocumentAdapter: class {
    applyEdit = mockApplyEdit
  },
  EditMatchError: class EditMatchError extends Error {
    constructor(message, info) {
      super(message)
      this.name = 'EditMatchError'
      this.info = info
    }
  },
  RebaseConflictError: class RebaseConflictError extends Error {
    constructor(message, info) {
      super(message)
      this.name = 'RebaseConflictError'
      this.info = info
    }
  },
  VersionConflictError: class VersionConflictError extends Error {
    constructor(message, info) {
      super(message)
      this.name = 'VersionConflictError'
      this.info = info
    }
  },
}))

// Mock other adapters
vi.mock('../../../../app/js/adapter/LLMAdapter.js', () => ({
  LLMAdapter: class {},
}))

vi.mock('../../../../app/js/adapter/ProjectAdapter.js', () => ({
  ProjectAdapter: class {},
}))

vi.mock('../../../../app/js/agent/AgentLoop.js', () => ({
  AgentLoop: class {},
}))

vi.mock('../../../../app/js/agent/ContextManager.js', () => ({
  ContextManager: class {},
}))

vi.mock('../../../../app/js/tool/ToolRegistry.js', () => ({
  ToolRegistry: class {
    register() {}
  },
}))

vi.mock('../../../../app/js/tool/read.js', () => ({
  ReadDocumentTool: class {},
}))

vi.mock('../../../../app/js/tool/edit.js', () => ({
  EditDocumentTool: class {},
}))

vi.mock('../../../../app/js/tool/list.js', () => ({
  ListFilesTool: class {},
}))

vi.mock('../../../../app/js/tool/compile_latex.js', () => ({
  CompileLatexTool: class {},
}))

const AgentController = await import('../../../../app/js/AgentController.js')

const USER_ID = '111111111111111111111111'
const PROJECT_ID = '222222222222222222222222'
const DOC_ID = '333333333333333333333333'

function allowProjectAccess() {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      body: { cancel: vi.fn() },
    })
  )
}

function createCursor(items = []) {
  return {
    sort: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    toArray: vi.fn().mockResolvedValue(items),
  }
}

describe('AgentController.getSession', () => {
  const sessionId = new ObjectId().toString()

  beforeEach(() => {
    vi.clearAllMocks()
    allowProjectAccess()
    mockDb.aiMessages.find.mockReturnValue(createCursor([]))
    mockDb.aiAgentToolCalls.find.mockReturnValue(createCursor([]))
    mockDb.aiAgentChangeSets.find.mockReturnValue(createCursor([]))
    mockDb.aiAgentDraftChanges.find.mockReturnValue(createCursor([]))
    mockDb.aiSandboxArtifacts.find.mockReturnValue(createCursor([]))
    mockDb.aiAgentWorkspaces.findOne.mockResolvedValue(null)
  })

  it('hydrates pending workspace changes, artifacts, and drift metadata', async () => {
    const sessionObjectId = new ObjectId(sessionId)
    mockDb.aiSessions.findOne.mockResolvedValue({
      _id: sessionObjectId,
      projectId: PROJECT_ID,
      userId: USER_ID,
      status: 'active',
      workspaceId: 'workspace-1',
      workspaceStatus: 'pending-review',
      pendingChanges: [
        {
          id: 'change-1',
          projectId: PROJECT_ID,
          type: 'edit',
          path: '/main.tex',
          status: 'pending',
        },
      ],
      changeHistory: [],
      _nextSeq: 2,
      createdAt: new Date('2026-06-20T00:00:00.000Z'),
      updatedAt: new Date('2026-06-20T00:00:00.000Z'),
    })
    mockDb.aiMessages.find.mockReturnValue(createCursor([]))
    mockDb.aiAgentWorkspaces.findOne.mockResolvedValue({
      _id: 'workspace-1',
      status: 'ready',
      lastDrift: {
        hasDrift: true,
        changes: [{ type: 'version-mismatch', path: '/main.tex' }],
      },
      updatedAt: new Date('2026-06-20T00:01:00.000Z'),
    })
    mockDb.aiSandboxArtifacts.find.mockReturnValue(
      createCursor([
        {
          _id: 'artifact-1',
          path: 'output.pdf',
          size: 2048,
          createdAt: new Date('2026-06-20T00:02:00.000Z'),
        },
      ])
    )
    const res = {
      json: vi.fn(),
      status: vi.fn().mockReturnThis(),
    }

    await AgentController.default.getSession(
      {
        params: { sessionId },
        query: {},
        headers: { 'x-user-id': USER_ID },
      },
      res
    )

    expect(res.json).toHaveBeenCalledWith({
      session: expect.objectContaining({
        id: sessionId,
        workspaceId: 'workspace-1',
        workspaceStatus: 'ready',
        pendingChanges: [
          expect.objectContaining({ id: 'change-1', status: 'pending' }),
        ],
        changeSets: [],
        artifacts: [{ id: 'artifact-1', path: 'output.pdf', size: 2048 }],
        workspaceDrift: expect.objectContaining({ hasDrift: true }),
      }),
    })
  })
})

describe('AgentController.reconcileInterruptedTurns', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('marks running active turns as interrupted after restart', async () => {
    mockDb.aiSessions.updateMany.mockResolvedValue({ modifiedCount: 2 })

    await AgentController.default.reconcileInterruptedTurns()

    expect(mockDb.aiSessions.updateMany).toHaveBeenCalledWith(
      { 'activeTurn.status': 'running' },
      {
        $set: expect.objectContaining({
          'activeTurn.status': 'interrupted_after_restart',
          'activeTurn.reason': 'service_restart',
          _streamingInterrupted: true,
          updatedAt: expect.any(Date),
        }),
      }
    )
  })
})

describe('AgentController.stopSession', () => {
  const sessionId = new ObjectId().toString()

  beforeEach(() => {
    vi.clearAllMocks()
    allowProjectAccess()
    mockDb.aiSessions.find.mockReturnValue(createCursor([]))
    mockDb.aiSessions.updateOne.mockResolvedValue({ modifiedCount: 1, matchedCount: 1 })
    mockDb.aiSessions.updateMany.mockResolvedValue({ modifiedCount: 0, matchedCount: 0 })
    mockDb.aiAgentDraftChanges.findOneAndUpdate.mockResolvedValue(null)
  })

  it('persists stopped state even when no loop is active', async () => {
    mockDb.aiSessions.findOne.mockResolvedValue({
      _id: new ObjectId(sessionId),
      projectId: PROJECT_ID,
      userId: USER_ID,
      status: 'active',
    })
    const res = {
      json: vi.fn(),
      status: vi.fn().mockReturnThis(),
    }

    await AgentController.default.stopSession(
      {
        params: { sessionId },
        headers: { 'x-user-id': USER_ID },
      },
      res
    )

    expect(mockDb.aiSessions.updateOne).toHaveBeenCalledWith(
      { _id: expect.any(ObjectId) },
      {
        $set: expect.objectContaining({
          'activeTurn.status': 'stopped',
          'activeTurn.reason': 'user_stop',
          updatedAt: expect.any(Date),
        }),
        $unset: { _streamingInterrupted: '' },
      }
    )
    expect(mockDb.aiSessions.updateMany).not.toHaveBeenCalled()
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      message: 'No active agent loop',
    })
  })
})

describe('AgentController.acceptChange', () => {
  let mockReq
  let mockRes
  const sessionId = new ObjectId().toString()
  const changeId = 'change-123'

  beforeEach(() => {
    vi.clearAllMocks()
    allowProjectAccess()

    mockReq = {
      params: { sessionId, changeId },
      body: { userId: USER_ID },
      headers: { 'x-user-id': USER_ID },
    }

    mockRes = {
      json: vi.fn(),
      status: vi.fn().mockReturnThis(),
    }

    mockDb.aiSessions.updateOne.mockResolvedValue({ modifiedCount: 1, matchedCount: 1 })
  })

  it('applies change and updates status', async () => {
    const draftChangeId = new ObjectId().toString()
    const changeSetId = new ObjectId().toString()
    const session = {
      _id: new ObjectId(sessionId),
      projectId: PROJECT_ID,
      userId: USER_ID,
      status: 'active',
      pendingChanges: [
        {
          id: draftChangeId,
          projectId: PROJECT_ID,
          docId: DOC_ID,
          baseVersion: 5,
          position: { start: 0, end: 5 },
          oldText: 'Hello',
          newText: 'Hi',
          status: 'pending',
          changeSetId,
        },
      ],
    }
    mockReq.params.changeId = draftChangeId

    mockDb.aiSessions.findOne.mockResolvedValue(session)
    mockApplyEdit.mockResolvedValue({
      success: true,
      newVersion: 6,
      wasRebased: false,
    })

    await AgentController.default.acceptChange(mockReq, mockRes)

    expect(mockApplyEdit).toHaveBeenCalledWith(
      expect.objectContaining({ id: draftChangeId }),
      { userId: USER_ID }
    )

    expect(mockDb.aiSessions.updateOne).toHaveBeenCalled()
    expect(mockDb.aiAgentDraftChanges.findOneAndUpdate).toHaveBeenCalledWith(
      {
        _id: new ObjectId(draftChangeId),
        sessionId: session._id,
        projectId: PROJECT_ID,
        userId: USER_ID,
      },
      {
        $set: expect.objectContaining({
          status: 'accepted',
          appliedVersion: 6,
          wasRebased: false,
        }),
      },
      { returnDocument: 'after' }
    )
    expect(mockRes.json).toHaveBeenCalledWith({
      success: true,
      change: expect.objectContaining({
        status: 'accepted',
        appliedVersion: 6,
        wasRebased: false,
      }),
    })
  })

  it('returns wasRebased flag when change was rebased', async () => {
    const session = {
      _id: new ObjectId(sessionId),
      projectId: PROJECT_ID,
      userId: USER_ID,
      status: 'active',
      pendingChanges: [
        {
          id: changeId,
          status: 'pending',
          projectId: PROJECT_ID,
          docId: DOC_ID,
          baseVersion: 5,
          position: { start: 0, end: 5 },
          oldText: 'Hello',
          newText: 'Hi',
        },
      ],
    }

    mockDb.aiSessions.findOne.mockResolvedValue(session)
    mockApplyEdit.mockResolvedValue({
      success: true,
      newVersion: 10,
      wasRebased: true,
    })

    await AgentController.default.acceptChange(mockReq, mockRes)

    expect(mockRes.json).toHaveBeenCalledWith({
      success: true,
      change: expect.objectContaining({
        wasRebased: true,
      }),
    })
  })

  it('returns 409 on rebase conflict', async () => {
    const { RebaseConflictError } = await import(
      '../../../../app/js/adapter/DocumentAdapter.js'
    )

    const draftChangeId = new ObjectId().toString()
    const changeSetId = new ObjectId().toString()
    const session = {
      _id: new ObjectId(sessionId),
      projectId: PROJECT_ID,
      userId: USER_ID,
      status: 'active',
      pendingChanges: [
        {
          id: draftChangeId,
          status: 'pending',
          projectId: PROJECT_ID,
          docId: DOC_ID,
          baseVersion: 5,
          position: { start: 0, end: 5 },
          oldText: 'Hello',
          newText: 'Hi',
          changeSetId,
        },
      ],
    }
    mockReq.params.changeId = draftChangeId

    mockDb.aiSessions.findOne.mockResolvedValue(session)
    mockApplyEdit.mockRejectedValue(
      new RebaseConflictError('Text changed', { conflictType: 'TEXT_CHANGED' })
    )

    await AgentController.default.acceptChange(mockReq, mockRes)

    expect(mockRes.status).toHaveBeenCalledWith(409)
    expect(mockRes.json).toHaveBeenCalledWith({
      success: false,
      error: 'REBASE_CONFLICT',
      message: 'Text changed',
      conflictType: 'TEXT_CHANGED',
      change: expect.objectContaining({
        id: draftChangeId,
        status: 'conflict',
        conflictType: 'TEXT_CHANGED',
        conflictMessage: 'Text changed',
      }),
      suggestion: expect.any(String),
    })
    expect(mockDb.aiAgentDraftChanges.findOneAndUpdate).toHaveBeenCalledWith(
      {
        _id: new ObjectId(draftChangeId),
        sessionId: session._id,
        projectId: PROJECT_ID,
        userId: USER_ID,
      },
      {
        $set: expect.objectContaining({
          status: 'conflict',
          conflictType: 'TEXT_CHANGED',
          conflictMessage: 'Text changed',
        }),
      },
      { returnDocument: 'after' }
    )
  })

  it('stores LIVE_CONTENT_CHANGED conflict type on rebase conflict', async () => {
    const { RebaseConflictError } = await import(
      '../../../../app/js/adapter/DocumentAdapter.js'
    )

    const session = {
      _id: new ObjectId(sessionId),
      projectId: PROJECT_ID,
      userId: USER_ID,
      status: 'active',
      pendingChanges: [
        {
          id: changeId,
          status: 'pending',
          projectId: PROJECT_ID,
          docId: DOC_ID,
          baseVersion: 5,
          position: { start: 0, end: 5 },
          oldText: 'Hello',
          newText: 'Hi',
          liveConflictBase: {
            baseVersion: 5,
            oldSha256: 'old-hash',
            path: '/main.tex',
          },
        },
      ],
    }

    mockDb.aiSessions.findOne.mockResolvedValue(session)
    mockApplyEdit.mockRejectedValue(
      new RebaseConflictError('Cannot apply edit: LIVE_CONTENT_CHANGED', {
        conflictType: 'LIVE_CONTENT_CHANGED',
      })
    )

    await AgentController.default.acceptChange(mockReq, mockRes)

    expect(mockDb.aiSessions.updateOne).toHaveBeenNthCalledWith(
      2,
      { _id: session._id, 'pendingChanges.id': changeId },
      expect.objectContaining({
        $set: expect.objectContaining({
          'pendingChanges.$.status': 'conflict',
          'pendingChanges.$.conflictType': 'LIVE_CONTENT_CHANGED',
          'pendingChanges.$.conflictMessage': 'Cannot apply edit: LIVE_CONTENT_CHANGED',
        }),
      })
    )
    expect(mockRes.status).toHaveBeenCalledWith(409)
    expect(mockRes.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'REBASE_CONFLICT',
        conflictType: 'LIVE_CONTENT_CHANGED',
      })
    )
  })

  it('returns 409 on EditMatchError', async () => {
    const { EditMatchError } = await import(
      '../../../../app/js/adapter/DocumentAdapter.js'
    )

    const session = {
      _id: new ObjectId(sessionId),
      projectId: PROJECT_ID,
      userId: USER_ID,
      status: 'active',
      pendingChanges: [
        {
          id: changeId,
          status: 'pending',
          projectId: PROJECT_ID,
          docId: DOC_ID,
          baseVersion: 5,
          position: { start: 0, end: 5 },
          oldText: 'Hello',
          newText: 'Hi',
        },
      ],
    }

    mockDb.aiSessions.findOne.mockResolvedValue(session)
    mockApplyEdit.mockRejectedValue(new EditMatchError('Content mismatch'))

    await AgentController.default.acceptChange(mockReq, mockRes)

    expect(mockRes.status).toHaveBeenCalledWith(409)
  })

  it('rejects already accepted change', async () => {
    const session = {
      _id: new ObjectId(sessionId),
      projectId: PROJECT_ID,
      userId: USER_ID,
      status: 'active',
      pendingChanges: [
        {
          id: changeId,
          status: 'accepted', // Already accepted
        },
      ],
    }

    mockDb.aiSessions.findOne.mockResolvedValue(session)

    try {
      await AgentController.default.acceptChange(mockReq, mockRes)
      expect.unreachable('Should have thrown')
    } catch (error) {
      expect(error.message).toMatch(/already accepted/)
    }
  })

  it('throws ChangeNotFoundError for missing change', async () => {
    const session = {
      _id: new ObjectId(sessionId),
      projectId: PROJECT_ID,
      userId: USER_ID,
      status: 'active',
      pendingChanges: [],
    }

    mockDb.aiSessions.findOne.mockResolvedValue(session)

    try {
      await AgentController.default.acceptChange(mockReq, mockRes)
      expect.unreachable('Should have thrown')
    } catch (error) {
      expect(error.message).toMatch(/not found/)
    }
  })
})

describe('AgentController.rejectChange', () => {
  let mockReq
  let mockRes
  const sessionId = new ObjectId().toString()
  const changeId = 'change-456'

  beforeEach(() => {
    vi.clearAllMocks()
    allowProjectAccess()

    mockReq = {
      params: { sessionId, changeId },
      body: {},
      headers: { 'x-user-id': USER_ID },
    }

    mockRes = {
      json: vi.fn(),
      status: vi.fn().mockReturnThis(),
    }

    mockDb.aiSessions.updateOne.mockResolvedValue({ modifiedCount: 1, matchedCount: 1 })
    mockDb.aiAgentDraftChanges.findOneAndUpdate.mockResolvedValue(null)
  })

  it('marks change as rejected', async () => {
    const draftChangeId = new ObjectId().toString()
    const changeSetId = new ObjectId().toString()
    const session = {
      _id: new ObjectId(sessionId),
      projectId: PROJECT_ID,
      userId: USER_ID,
      status: 'active',
      pendingChanges: [
        {
          id: draftChangeId,
          status: 'pending',
          changeSetId,
        },
      ],
    }
    mockReq.params.changeId = draftChangeId

    mockDb.aiSessions.findOne.mockResolvedValue(session)

    await AgentController.default.rejectChange(mockReq, mockRes)

    expect(mockDb.aiSessions.updateOne).toHaveBeenCalled()
    expect(mockDb.aiAgentDraftChanges.findOneAndUpdate).toHaveBeenCalledWith(
      {
        _id: new ObjectId(draftChangeId),
        sessionId: session._id,
        projectId: PROJECT_ID,
        userId: USER_ID,
      },
      {
        $set: expect.objectContaining({
          status: 'rejected',
        }),
      },
      { returnDocument: 'after' }
    )
    expect(mockRes.json).toHaveBeenCalledWith({
      success: true,
      change: expect.objectContaining({
        status: 'rejected',
      }),
    })
  })

  it('accepts optional reason', async () => {
    mockReq.body = { reason: 'Not what I wanted' }

    const session = {
      _id: new ObjectId(sessionId),
      projectId: PROJECT_ID,
      userId: USER_ID,
      status: 'active',
      pendingChanges: [
        {
          id: changeId,
          status: 'pending',
        },
      ],
    }

    mockDb.aiSessions.findOne.mockResolvedValue(session)

    await AgentController.default.rejectChange(mockReq, mockRes)

    expect(mockRes.json).toHaveBeenCalledWith({
      success: true,
      change: expect.objectContaining({
        rejectReason: 'Not what I wanted',
      }),
    })
  })

  it('allows rejecting conflict status changes', async () => {
    const session = {
      _id: new ObjectId(sessionId),
      projectId: PROJECT_ID,
      userId: USER_ID,
      status: 'active',
      pendingChanges: [
        {
          id: changeId,
          status: 'conflict', // Can reject conflict changes
        },
      ],
    }

    mockDb.aiSessions.findOne.mockResolvedValue(session)

    await AgentController.default.rejectChange(mockReq, mockRes)

    expect(mockRes.json).toHaveBeenCalledWith({
      success: true,
      change: expect.objectContaining({
        status: 'rejected',
      }),
    })
  })

  it('rejects already accepted change', async () => {
    const session = {
      _id: new ObjectId(sessionId),
      projectId: PROJECT_ID,
      userId: USER_ID,
      status: 'active',
      pendingChanges: [
        {
          id: changeId,
          status: 'accepted',
        },
      ],
    }

    mockDb.aiSessions.findOne.mockResolvedValue(session)

    try {
      await AgentController.default.rejectChange(mockReq, mockRes)
      expect.unreachable('Should have thrown')
    } catch (error) {
      expect(error.message).toMatch(/Cannot reject/)
    }
  })
})

describe('AgentController.getSessionArtifact', () => {
  const sessionId = new ObjectId().toString()

  beforeEach(() => {
    vi.clearAllMocks()
    allowProjectAccess()
  })

  function response() {
    return {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
      setHeader: vi.fn().mockReturnThis(),
      send: vi.fn().mockReturnThis(),
    }
  }

  it('downloads an artifact only for the owning session user', async () => {
    const sessionObjectId = new ObjectId(sessionId)
    mockDb.aiSessions.findOne.mockResolvedValue({
      _id: sessionObjectId,
      projectId: PROJECT_ID,
      userId: USER_ID,
      status: 'active',
    })
    mockDb.aiSandboxArtifacts.findOne.mockResolvedValue({
      _id: 'artifact-1',
      sessionId: sessionObjectId.toString(),
      path: 'main.pdf',
      content: Buffer.from('%PDF-test'),
    })
    const res = response()

    await AgentController.default.getSessionArtifact(
      {
        params: { sessionId, artifactId: 'artifact-1' },
        headers: { 'x-user-id': USER_ID },
      },
      res
    )

    expect(mockDb.aiSandboxArtifacts.findOne).toHaveBeenCalledWith({
      _id: 'artifact-1',
      sessionId: sessionObjectId.toString(),
      $or: [
        { expiresAt: { $exists: false } },
        { expiresAt: { $gt: expect.any(Date) } },
      ],
    })
    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'application/pdf')
    expect(res.setHeader).toHaveBeenCalledWith(
      'Content-Disposition',
      'attachment; filename="main.pdf"'
    )
    expect(res.send).toHaveBeenCalledWith(Buffer.from('%PDF-test'))
  })

  it('rejects artifact downloads by another user', async () => {
    mockDb.aiSessions.findOne.mockResolvedValue({
      _id: new ObjectId(sessionId),
      projectId: PROJECT_ID,
      userId: USER_ID,
      status: 'active',
    })
    const res = response()

    await AgentController.default.getSessionArtifact(
      {
        params: { sessionId, artifactId: 'artifact-1' },
        headers: { 'x-user-id': '999999999999999999999999' },
      },
      res
    )

    expect(res.status).toHaveBeenCalledWith(403)
    expect(mockDb.aiSandboxArtifacts.findOne).not.toHaveBeenCalled()
  })

  it('returns 404 for expired or missing artifacts', async () => {
    mockDb.aiSessions.findOne.mockResolvedValue({
      _id: new ObjectId(sessionId),
      projectId: PROJECT_ID,
      userId: USER_ID,
      status: 'active',
    })
    mockDb.aiSandboxArtifacts.findOne.mockResolvedValue(null)
    const res = response()

    await AgentController.default.getSessionArtifact(
      {
        params: { sessionId, artifactId: 'artifact-1' },
        headers: { 'x-user-id': USER_ID },
      },
      res
    )

    expect(res.status).toHaveBeenCalledWith(404)
    expect(res.json).toHaveBeenCalledWith({ error: 'Artifact not found' })
  })
})
