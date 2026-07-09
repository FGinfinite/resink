import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockChangeSetService = {
  createChangeSet: vi.fn(),
  createDraftChange: vi.fn(),
}

const { LiveDraftChangeBridge } = await import(
  '../../../../app/js/agent/LiveDraftChangeBridge.js'
)

describe('LiveDraftChangeBridge', () => {
  let bridge

  beforeEach(() => {
    mockChangeSetService.createChangeSet.mockReset().mockResolvedValue({
      _id: { toString: () => 'change-set-1' },
      turnId: 'turn-1',
    })
    mockChangeSetService.createDraftChange.mockReset().mockResolvedValue({
      _id: { toString: () => 'change-1' },
      changeSetId: { toString: () => 'change-set-1' },
      sessionId: { toString: () => 'session-1' },
      projectId: 'project-1',
      userId: 'user-1',
      type: 'edit',
      source: 'agent-loop-v2',
      path: '/main.tex',
      docId: 'doc-1',
      baseVersion: 7,
      position: {
        start: 6,
        end: 9,
        startLineColumn: { line: 1, column: 7 },
        endLineColumn: { line: 1, column: 10 },
      },
      oldText: 'old',
      newText: 'new',
      status: 'pending',
      createdAt: new Date('2026-06-21T00:00:00.000Z'),
      updatedAt: new Date('2026-06-21T00:00:00.000Z'),
      provenance: { agentName: 'writer', toolName: 'edit_document' },
    })
    bridge = new LiveDraftChangeBridge({
      changeSetService: mockChangeSetService,
    })
  })

  it('creates a change set once and returns a normalized draft_change.created event', async () => {
    const sessionState = {
      turnId: 'turn-1',
    }
    const context = {
      sessionId: 'session-1',
      projectId: 'project-1',
      userId: 'user-1',
      toolCallId: 'tool-1',
      profile: 'default',
      agentName: 'writer',
      model: 'deepseek-v4-flash',
      currentDocId: 'doc-1',
      rootSessionId: 'session-1',
      agentTeam: {
        teamId: 'team-1',
        taskId: 'task-1',
        capabilityName: 'writing-editor',
      },
    }

    const result = await bridge.createDraftChange({
      context,
      sessionState,
      docPath: '/main.tex',
      workspacePath: 'main.tex',
      content: 'hello old world',
      newContent: 'hello new world',
      matchedText: 'old',
      newText: 'new',
      baseVersion: 7,
      docId: 'doc-1',
    })

    expect(mockChangeSetService.createChangeSet).toHaveBeenCalledWith({
      sessionId: 'session-1',
      projectId: 'project-1',
      userId: 'user-1',
      turnId: 'turn-1',
      mode: 'review',
    })
    expect(mockChangeSetService.createDraftChange).toHaveBeenCalledWith(
      expect.objectContaining({
        changeSetId: { toString: expect.any(Function) },
        sessionId: 'session-1',
        projectId: 'project-1',
        userId: 'user-1',
        toolCallId: 'tool-1',
        path: '/main.tex',
        docId: 'doc-1',
        baseVersion: 7,
        position: {
          start: 6,
          end: 9,
          startLineColumn: { line: 1, column: 7 },
          endLineColumn: { line: 1, column: 10 },
        },
        oldText: 'old',
        newText: 'new',
        mirrorToSessionPendingChanges: true,
        provenance: {
          agentName: 'writer',
          toolName: 'edit_document',
          model: 'deepseek-v4-flash',
          profile: 'default',
          teamId: 'team-1',
          taskId: 'task-1',
          capabilityName: 'writing-editor',
        },
      })
    )
    expect(result.event).toMatchObject({
      type: 'draft_change.created',
      changeSetId: 'change-set-1',
      changeId: 'change-1',
      path: '/main.tex',
      workspacePath: 'main.tex',
      draftChange: {
        id: 'change-1',
        path: '/main.tex',
        status: 'pending',
      },
    })
    expect(sessionState.activeChangeSet).toBe(result.changeSet)
  })

  it('reuses the active turn change set for subsequent draft changes', async () => {
    const activeChangeSet = { _id: { toString: () => 'change-set-existing' } }
    const sessionState = {
      turnId: 'turn-1',
      activeChangeSet,
    }

    await bridge.createDraftChange({
      context: {
        sessionId: 'session-1',
        projectId: 'project-1',
        userId: 'user-1',
      },
      sessionState,
      docPath: '/main.tex',
      workspacePath: 'main.tex',
      content: 'old',
      newContent: 'new',
      matchedText: 'old',
      newText: 'new',
    })

    expect(mockChangeSetService.createChangeSet).not.toHaveBeenCalled()
    expect(mockChangeSetService.createDraftChange).toHaveBeenCalledWith(
      expect.objectContaining({
        changeSetId: activeChangeSet._id,
      })
    )
  })

  it('aggregates child-session draft changes into the root active change set', async () => {
    const activeChangeSet = { _id: { toString: () => 'root-change-set' } }
    const sessionState = {
      turnId: 'turn-1',
      activeChangeSet,
    }

    await bridge.createDraftChange({
      context: {
        sessionId: 'child-session-1',
        rootSessionId: 'root-session-1',
        projectId: 'project-1',
        userId: 'user-1',
        agentName: 'reviewer',
        agentTeam: {
          teamId: 'team-child',
          taskId: 'task-child',
          capabilityName: 'content-reviewer',
        },
      },
      sessionState,
      docPath: '/main.tex',
      workspacePath: 'main.tex',
      content: 'old',
      newContent: 'new',
      matchedText: 'old',
      newText: 'new',
    })

    expect(mockChangeSetService.createChangeSet).not.toHaveBeenCalled()
    expect(mockChangeSetService.createDraftChange).toHaveBeenCalledWith(
      expect.objectContaining({
        changeSetId: activeChangeSet._id,
        sessionId: 'root-session-1',
        parentSessionId: 'root-session-1',
        childSessionId: 'child-session-1',
        provenance: expect.objectContaining({
          agentName: 'reviewer',
          toolName: 'edit_document',
          teamId: 'team-child',
          taskId: 'task-child',
          capabilityName: 'content-reviewer',
        }),
      })
    )
  })

  it('creates a root change set for the first child-session draft change', async () => {
    const sessionState = {
      turnId: 'turn-1',
    }

    const result = await bridge.createDraftChange({
      context: {
        sessionId: 'child-session-1',
        rootSessionId: 'root-session-1',
        projectId: 'project-1',
        userId: 'user-1',
        toolCallId: 'tool-child-1',
        agentName: 'reviewer',
      },
      sessionState,
      docPath: '/main.tex',
      workspacePath: 'main.tex',
      content: 'old',
      newContent: 'new',
      matchedText: 'old',
      newText: 'new',
    })

    expect(mockChangeSetService.createChangeSet).toHaveBeenCalledWith({
      sessionId: 'root-session-1',
      projectId: 'project-1',
      userId: 'user-1',
      turnId: 'turn-1',
      mode: 'review',
    })
    expect(mockChangeSetService.createDraftChange).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'root-session-1',
        parentSessionId: 'root-session-1',
        childSessionId: 'child-session-1',
        toolCallId: 'tool-child-1',
      })
    )
    expect(sessionState.activeChangeSet).toBe(result.changeSet)
  })

  it('applies auto-accept draft changes and appends writeback events', async () => {
    const canonicalWritebackService = {
      applyDraftChange: vi.fn().mockResolvedValue({
        status: 'accepted',
        draftChange: {
          _id: { toString: () => 'change-1' },
          changeSetId: { toString: () => 'change-set-1' },
          sessionId: { toString: () => 'session-1' },
          projectId: 'project-1',
          userId: 'user-1',
          type: 'edit',
          source: 'agent-loop-v2',
          path: '/main.tex',
          docId: 'doc-1',
          status: 'accepted',
          createdAt: new Date('2026-06-21T00:00:00.000Z'),
          updatedAt: new Date('2026-06-21T00:00:01.000Z'),
          appliedAt: new Date('2026-06-21T00:00:01.000Z'),
        },
        events: [
          {
            type: 'canonical_change.applied',
            changeId: 'change-1',
            changeSetId: 'change-set-1',
            appliedVersion: 13,
          },
          {
            type: 'draft_change.accepted',
            changeId: 'change-1',
            changeSetId: 'change-set-1',
          },
        ],
      }),
    }
    bridge = new LiveDraftChangeBridge({
      changeSetService: mockChangeSetService,
      canonicalWritebackService,
    })

    const result = await bridge.createDraftChange({
      context: {
        sessionId: 'session-1',
        projectId: 'project-1',
        userId: 'user-1',
        currentDocId: 'doc-1',
        rootSessionId: 'session-1',
        autoAccept: true,
      },
      sessionState: { turnId: 'turn-1' },
      docPath: '/main.tex',
      workspacePath: 'main.tex',
      content: 'hello old world',
      newContent: 'hello new world',
      matchedText: 'old',
      newText: 'new',
      baseVersion: 7,
      docId: 'doc-1',
    })

    expect(mockChangeSetService.createChangeSet).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'auto' })
    )
    expect(canonicalWritebackService.applyDraftChange).toHaveBeenCalledWith({
      change: expect.objectContaining({ path: '/main.tex' }),
      userId: 'user-1',
    })
    expect(result.events.map(event => event.type)).toEqual([
      'draft_change.created',
      'canonical_change.applying',
      'canonical_change.applied',
      'draft_change.accepted',
    ])
    expect(result.finalDraftChange).toMatchObject({
      id: 'change-1',
      status: 'accepted',
    })
  })
})
