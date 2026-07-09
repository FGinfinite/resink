import {
  AgentChangeSetService,
  serializeDraftChange,
} from './AgentChangeSetService.js'

function normalizeDocId(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function buildPosition({ content, matchedText }) {
  const start = content.indexOf(matchedText)
  if (start < 0) return null
  return { start, end: start + matchedText.length }
}

function lineColumn(content, offset) {
  const before = content.slice(0, offset)
  const lines = before.split('\n')
  return {
    line: lines.length,
    column: lines[lines.length - 1].length + 1,
  }
}

function enrichPosition(content, position) {
  if (!position) return null
  return {
    ...position,
    startLineColumn: lineColumn(content, position.start),
    endLineColumn: lineColumn(content, position.end),
  }
}

export class LiveDraftChangeBridge {
  constructor({ changeSetService, canonicalWritebackService, db, now } = {}) {
    this.changeSetService =
      changeSetService || new AgentChangeSetService({ db, now })
    this.canonicalWritebackService = canonicalWritebackService || null
  }

  async createDraftChange(input = {}) {
    const {
      context,
      sessionState,
      docPath,
      workspacePath,
      content,
      newContent,
      matchedText,
      newText,
      replaceAll = false,
    } = input
    const executionSessionId = context.sessionId
    const rootSessionId = context.rootSessionId || executionSessionId
    const sessionId =
      rootSessionId !== executionSessionId ? rootSessionId : executionSessionId
    const projectId = context.projectId
    const userId = context.userId
    if (!executionSessionId || !sessionId || !projectId || !userId) {
      return null
    }

    let changeSet = sessionState.activeChangeSet
    if (!changeSet) {
      changeSet = await this.changeSetService.createChangeSet({
        sessionId,
        projectId,
        userId,
        turnId: sessionState.turnId || null,
        mode: context.autoAccept ? 'auto' : 'review',
      })
      sessionState.activeChangeSet = changeSet
    }

    const position = replaceAll
      ? null
      : enrichPosition(content, buildPosition({ content, matchedText }))
    const draftChange = await this.changeSetService.createDraftChange({
      changeSetId: changeSet._id,
      sessionId,
      projectId,
      userId,
      turnId: sessionState.turnId || null,
      toolCallId: context.toolCallId || null,
      parentSessionId: rootSessionId !== executionSessionId ? rootSessionId : null,
      childSessionId: rootSessionId !== executionSessionId ? executionSessionId : null,
      type: 'edit',
      source: 'agent-loop-v2',
      path: docPath,
      docId: normalizeDocId(input.docId || context.currentDocId),
      entityId: normalizeDocId(input.entityId),
      baseVersion: input.baseVersion ?? null,
      position,
      oldText: matchedText,
      newText,
      newContent,
      status: 'pending',
      provenance: {
        agentName: context.agentName,
        toolName: 'edit_document',
        model: context.model,
        profile: context.profile,
        teamId: context.agentTeam?.teamId,
        taskId: context.agentTeam?.taskId,
        capabilityName: context.agentTeam?.capabilityName,
      },
      mirrorToSessionPendingChanges: true,
    })

    let finalDraftChange = draftChange
    const events = []
    const serializedDraft = serializeDraftChange(draftChange)
    events.push({
      type: 'draft_change.created',
      changeSetId: changeSet._id.toString(),
      changeId: draftChange._id.toString(),
      draftChange: serializedDraft,
      change: serializedDraft,
      path: docPath,
      workspacePath,
    })
    if (context.autoAccept && this.canonicalWritebackService) {
      events.push({
        type: 'canonical_change.applying',
        changeSetId: changeSet._id.toString(),
        changeId: draftChange._id.toString(),
        path: docPath,
      })
      const writeback = await this.canonicalWritebackService.applyDraftChange({
        change: draftChange,
        userId,
      })
      finalDraftChange = writeback.draftChange || draftChange
      events.push(...writeback.events)
    }
    const finalSerializedDraft = serializeDraftChange(finalDraftChange)
    return {
      changeSet,
      draftChange: finalDraftChange,
      event: events[0],
      events,
      finalDraftChange: finalSerializedDraft,
    }
  }
}

export default LiveDraftChangeBridge
