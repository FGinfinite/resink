import {
  EditMatchError,
  RebaseConflictError,
  VersionConflictError,
} from '../adapter/DocumentAdapter.js'
import { serializeDraftChange } from './AgentChangeSetService.js'

function isConflictError(error) {
  return (
    error instanceof RebaseConflictError ||
    error instanceof VersionConflictError ||
    error instanceof EditMatchError
  )
}

function conflictType(error) {
  return error.info?.conflictType || error.name || 'UNKNOWN'
}

export class CanonicalWritebackService {
  constructor({ documentAdapter, changeSetService }) {
    this.documentAdapter = documentAdapter
    this.changeSetService = changeSetService
  }

  async applyDraftChange({ change, userId }) {
    if (!change) throw new Error('change is required')
    if (!userId) throw new Error('userId is required')

    await this.changeSetService.recordApplyOperation({
      changeId: change._id,
      changeSetId: change.changeSetId,
      sessionId: change.sessionId,
      projectId: change.projectId,
      userId,
      status: 'started',
    })
    await this.changeSetService.updateDraftStatus({
      changeId: change._id,
      sessionId: change.sessionId,
      projectId: change.projectId,
      userId: change.userId,
      status: 'applying',
    })

    try {
      const result = await this.documentAdapter.applyEdit(
        this.changeSetService.toPendingChange(change),
        { userId }
      )
      const accepted = await this.changeSetService.updateDraftStatus({
        changeId: change._id,
        sessionId: change.sessionId,
        projectId: change.projectId,
        userId: change.userId,
        status: 'accepted',
        appliedVersion: result.newVersion,
        wasRebased: result.wasRebased,
      })
      await this.changeSetService.recordApplyOperation({
        changeId: change._id,
        changeSetId: change.changeSetId,
        sessionId: change.sessionId,
        projectId: change.projectId,
        userId,
        status: 'succeeded',
        finishedAt: new Date(),
        appliedVersion: result.newVersion,
      })
      await this.changeSetService.markMirroredPendingChangeStatus({
        changeId: change._id,
        sessionId: change.sessionId,
        projectId: change.projectId,
        userId: change.userId,
        status: 'accepted',
        appliedVersion: result.newVersion,
        wasRebased: result.wasRebased,
      })
      return {
        status: 'accepted',
        draftChange: accepted,
        events: [
          {
            type: 'canonical_change.applied',
            changeId: change._id.toString(),
            changeSetId: change.changeSetId.toString(),
            appliedVersion: result.newVersion,
            wasRebased: result.wasRebased,
          },
          {
            type: 'draft_change.accepted',
            changeId: change._id.toString(),
            changeSetId: change.changeSetId.toString(),
            draftChange: serializeDraftChange(accepted),
          },
        ],
        result,
      }
    } catch (error) {
      if (!isConflictError(error)) {
        await this.changeSetService.recordApplyOperation({
          changeId: change._id,
          changeSetId: change.changeSetId,
          sessionId: change.sessionId,
          projectId: change.projectId,
          userId,
          status: 'failed',
          finishedAt: new Date(),
          errorCode: error.name || 'ERROR',
          errorMessage: error.message,
        })
        throw error
      }

      const conflicted = await this.changeSetService.updateDraftStatus({
        changeId: change._id,
        sessionId: change.sessionId,
        projectId: change.projectId,
        userId: change.userId,
        status: 'conflict',
        conflictType: conflictType(error),
        conflictMessage: error.message,
      })
      await this.changeSetService.recordApplyOperation({
        changeId: change._id,
        changeSetId: change.changeSetId,
        sessionId: change.sessionId,
        projectId: change.projectId,
        userId,
        status: 'conflict',
        finishedAt: new Date(),
        errorCode: conflictType(error),
        errorMessage: error.message,
      })
      await this.changeSetService.markMirroredPendingChangeStatus({
        changeId: change._id,
        sessionId: change.sessionId,
        projectId: change.projectId,
        userId: change.userId,
        status: 'conflict',
        conflictType: conflictType(error),
        conflictMessage: error.message,
      })
      return {
        status: 'conflict',
        draftChange: conflicted,
        events: [
          {
            type: 'draft_change.conflict',
            changeId: change._id.toString(),
            changeSetId: change.changeSetId.toString(),
            conflictType: conflictType(error),
            message: error.message,
            draftChange: serializeDraftChange(conflicted),
          },
        ],
      }
    }
  }
}

export default CanonicalWritebackService
