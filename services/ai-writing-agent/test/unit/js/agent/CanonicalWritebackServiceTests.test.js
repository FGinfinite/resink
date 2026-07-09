import { describe, it, expect, vi, beforeEach } from 'vitest'

const changeSetService = {
  toPendingChange: vi.fn(),
  recordApplyOperation: vi.fn(),
  updateDraftStatus: vi.fn(),
  markMirroredPendingChangeStatus: vi.fn(),
}

const documentAdapter = {
  applyEdit: vi.fn(),
}

const { CanonicalWritebackService } = await import(
  '../../../../app/js/agent/CanonicalWritebackService.js'
)
const { VersionConflictError } = await import(
  '../../../../app/js/adapter/DocumentAdapter.js'
)

describe('CanonicalWritebackService', () => {
  let service
  const change = {
    _id: { toString: () => 'change-1' },
    changeSetId: { toString: () => 'change-set-1' },
    sessionId: { toString: () => 'session-1' },
    projectId: 'project-1',
    userId: 'owner-1',
    path: '/main.tex',
  }

  beforeEach(() => {
    vi.clearAllMocks()
    changeSetService.toPendingChange.mockReturnValue({
      id: 'change-1',
      projectId: 'project-1',
      docId: 'doc-1',
      oldText: 'old',
      newText: 'new',
      status: 'pending',
    })
    changeSetService.updateDraftStatus.mockImplementation(async input => ({
      ...change,
      status: input.status,
      appliedVersion: input.appliedVersion,
      conflictType: input.conflictType,
      conflictMessage: input.conflictMessage,
    }))
    changeSetService.recordApplyOperation.mockResolvedValue({})
    changeSetService.markMirroredPendingChangeStatus.mockResolvedValue({
      modifiedCount: 1,
    })
    documentAdapter.applyEdit.mockResolvedValue({
      success: true,
      newVersion: 42,
      wasRebased: false,
    })
    service = new CanonicalWritebackService({
      documentAdapter,
      changeSetService,
    })
  })

  it('applies a draft change through DocumentAdapter and records accepted state', async () => {
    const result = await service.applyDraftChange({
      change,
      userId: 'user-1',
    })

    expect(documentAdapter.applyEdit).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'change-1' }),
      { userId: 'user-1' }
    )
    expect(changeSetService.updateDraftStatus).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'applying' })
    )
    expect(changeSetService.updateDraftStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'accepted',
        appliedVersion: 42,
        wasRebased: false,
      })
    )
    expect(changeSetService.markMirroredPendingChangeStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'accepted',
        appliedVersion: 42,
      })
    )
    expect(changeSetService.recordApplyOperation).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'started' })
    )
    expect(changeSetService.recordApplyOperation).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'succeeded', appliedVersion: 42 })
    )
    expect(result.events.map(event => event.type)).toEqual([
      'canonical_change.applied',
      'draft_change.accepted',
    ])
  })

  it('marks version conflicts as draft conflicts without throwing', async () => {
    documentAdapter.applyEdit.mockRejectedValue(
      new VersionConflictError('version changed', {
        conflictType: 'VERSION_MISMATCH',
      })
    )

    const result = await service.applyDraftChange({
      change,
      userId: 'user-1',
    })

    expect(result.status).toBe('conflict')
    expect(changeSetService.updateDraftStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'conflict',
        conflictType: 'VERSION_MISMATCH',
        conflictMessage: 'version changed',
      })
    )
    expect(changeSetService.recordApplyOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'conflict',
        errorCode: 'VERSION_MISMATCH',
      })
    )
    expect(result.events).toHaveLength(1)
    expect(result.events[0]).toMatchObject({
      type: 'draft_change.conflict',
      conflictType: 'VERSION_MISMATCH',
    })
  })
})
