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
    updateOne: vi.fn(),
    insertOne: vi.fn(),
  },
}

vi.mock('../../../../app/js/mongodb.js', () => ({
  ObjectId,
  db: mockDb,
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

const AgentController = await import('../../../../app/js/AgentController.js')

describe('AgentController.acceptChange', () => {
  let mockReq
  let mockRes
  const sessionId = new ObjectId().toString()
  const changeId = 'change-123'

  beforeEach(() => {
    vi.clearAllMocks()

    mockReq = {
      params: { sessionId, changeId },
      body: { userId: 'user-1' },
      headers: { 'x-user-id': 'user-1' },
    }

    mockRes = {
      json: vi.fn(),
      status: vi.fn().mockReturnThis(),
    }

    mockDb.aiSessions.updateOne.mockResolvedValue({ modifiedCount: 1, matchedCount: 1 })
  })

  it('applies change and updates status', async () => {
    const session = {
      _id: new ObjectId(sessionId),
      projectId: 'proj-1',
      userId: 'user-1',
      status: 'active',
      pendingChanges: [
        {
          id: changeId,
          projectId: 'proj-1',
          docId: 'doc-1',
          baseVersion: 5,
          position: { start: 0, end: 5 },
          oldText: 'Hello',
          newText: 'Hi',
          status: 'pending',
        },
      ],
    }

    mockDb.aiSessions.findOne.mockResolvedValue(session)
    mockApplyEdit.mockResolvedValue({
      success: true,
      newVersion: 6,
      wasRebased: false,
    })

    await AgentController.default.acceptChange(mockReq, mockRes)

    expect(mockApplyEdit).toHaveBeenCalledWith(
      expect.objectContaining({ id: changeId }),
      { userId: 'user-1' }
    )

    expect(mockDb.aiSessions.updateOne).toHaveBeenCalled()
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
      projectId: 'proj-1',
      userId: 'user-1',
      status: 'active',
      pendingChanges: [
        {
          id: changeId,
          status: 'pending',
          projectId: 'proj-1',
          docId: 'doc-1',
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

    const session = {
      _id: new ObjectId(sessionId),
      projectId: 'proj-1',
      userId: 'user-1',
      status: 'active',
      pendingChanges: [
        {
          id: changeId,
          status: 'pending',
          projectId: 'proj-1',
          docId: 'doc-1',
          baseVersion: 5,
          position: { start: 0, end: 5 },
          oldText: 'Hello',
          newText: 'Hi',
        },
      ],
    }

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
      suggestion: expect.any(String),
    })
  })

  it('returns 409 on EditMatchError', async () => {
    const { EditMatchError } = await import(
      '../../../../app/js/adapter/DocumentAdapter.js'
    )

    const session = {
      _id: new ObjectId(sessionId),
      projectId: 'proj-1',
      userId: 'user-1',
      status: 'active',
      pendingChanges: [
        {
          id: changeId,
          status: 'pending',
          projectId: 'proj-1',
          docId: 'doc-1',
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
      projectId: 'proj-1',
      userId: 'user-1',
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
      projectId: 'proj-1',
      userId: 'user-1',
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

    mockReq = {
      params: { sessionId, changeId },
      body: {},
      headers: { 'x-user-id': 'user-1' },
    }

    mockRes = {
      json: vi.fn(),
      status: vi.fn().mockReturnThis(),
    }

    mockDb.aiSessions.updateOne.mockResolvedValue({ modifiedCount: 1, matchedCount: 1 })
  })

  it('marks change as rejected', async () => {
    const session = {
      _id: new ObjectId(sessionId),
      projectId: 'proj-1',
      userId: 'user-1',
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

    expect(mockDb.aiSessions.updateOne).toHaveBeenCalled()
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
      projectId: 'proj-1',
      userId: 'user-1',
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
      projectId: 'proj-1',
      userId: 'user-1',
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
      projectId: 'proj-1',
      userId: 'user-1',
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
