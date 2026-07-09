import { describe, expect, it, vi } from 'vitest'
import { ObjectId } from 'mongodb'

const { AgentTeamRunService } = await import(
  '../../../../app/js/agent-team/AgentTeamRunService.js'
)

function createStore(options = {}) {
  const rootSessionId = new ObjectId()
  const otherSessionId = new ObjectId()
  const teamId = new ObjectId()
  const taskId = new ObjectId()
  const retryTaskId = new ObjectId()
  const session = {
    _id: rootSessionId,
    projectId: 'project-1',
  }
  const team = {
    _id: teamId,
    projectId: 'project-1',
    userId: 'user-1',
    rootSessionId,
    workflowType: 'deep-review',
    status: 'running',
    mode: 'workflow-graph',
    startedBy: 'model',
    policySummary: { maxParallelTasks: 3 },
    budgetSummary: { timeoutMs: 120000 },
    startedAt: new Date('2026-06-24T12:00:00.000Z'),
    updatedAt: new Date('2026-06-24T12:00:05.000Z'),
    completedAt: null,
  }
  const task = {
    _id: taskId,
    teamId,
    parentTaskId: null,
    rootSessionId,
    childSessionId: new ObjectId(),
    agentName: 'content-reviewer',
    agentVersion: '1.0.0',
    mode: 'workflow-node',
    status: 'failed',
    objective: 'Find unsupported claims',
    acceptanceCriteria: ['Every major finding has evidence'],
    input: { files: ['main.tex'] },
    outputSchema: { type: 'object' },
    policy: { tools: ['read_document'] },
    dependencies: [],
    priority: 2,
    timeoutMs: 30000,
    retryPolicy: { maxAttempts: 2 },
    resultId: new ObjectId(),
    error: { message: 'model timeout' },
    startedAt: new Date('2026-06-24T12:00:01.000Z'),
    completedAt: new Date('2026-06-24T12:00:04.000Z'),
    createdAt: new Date('2026-06-24T12:00:00.000Z'),
    updatedAt: new Date('2026-06-24T12:00:04.000Z'),
  }
  const result = {
    _id: task.resultId,
    taskId,
    teamId,
    status: 'failed',
    summary: 'Reviewer timed out',
    findings: [{ severity: 'major', title: 'Unsupported claim' }],
    artifacts: [{ type: 'note', title: 'Trace' }],
    proposedEdits: [],
    evidenceRefs: [],
    unresolvedQuestions: [],
    confidence: 0.4,
    nextActions: [],
    usage: { tokens: 1000 },
    createdAt: new Date('2026-06-24T12:00:04.000Z'),
  }
  const event = {
    _id: new ObjectId(),
    teamId,
    taskId,
    sessionId: rootSessionId,
    type: 'draft_change.created',
    payload: { taskId: taskId.toString() },
    createdAt: new Date('2026-06-24T12:00:03.000Z'),
  }
  const loaded = {
    team,
    tasks: [task],
    contextPacks: [],
    results: [result],
    events: [event],
  }
  const store = {
    listTeamRuns: vi.fn(async () => [team]),
    loadTeamRun: vi.fn(async ({ teamId: requestedTeamId }) => {
      if (requestedTeamId.toString() !== teamId.toString()) return null
      return loaded
    }),
    archiveTeamRun: vi.fn(async () => ({ matchedCount: 1, modifiedCount: 1 })),
    cancelActiveTasks: vi.fn(async () => ({ matchedCount: 0, modifiedCount: 0 })),
    markTeamRunning: vi.fn(async () => ({ matchedCount: 1, modifiedCount: 1 })),
    recordEvent: vi.fn(async input => ({
      _id: new ObjectId(),
      ...input,
      createdAt: new Date('2026-06-24T12:00:06.000Z'),
    })),
    cleanupStuckTeamRuns: vi.fn(async () => ({
      teams: [team],
      childSessionIds: [task.childSessionId],
      cancelledTaskCount: 1,
      archivedTeamCount: 1,
    })),
    createRetryTask: vi.fn(async ({ sourceTask, parentTaskId }) => ({
      _id: retryTaskId,
      teamId: sourceTask.teamId,
      parentTaskId,
      rootSessionId: sourceTask.rootSessionId,
      agentName: sourceTask.agentName,
      agentVersion: sourceTask.agentVersion,
      mode: sourceTask.mode,
      objective: sourceTask.objective,
      acceptanceCriteria: sourceTask.acceptanceCriteria,
      input: sourceTask.input,
      outputSchema: sourceTask.outputSchema,
      policy: sourceTask.policy,
      dependencies: sourceTask.dependencies,
      priority: sourceTask.priority,
      timeoutMs: sourceTask.timeoutMs,
      retryPolicy: sourceTask.retryPolicy,
      status: 'queued',
      resultId: null,
      error: null,
      createdAt: new Date('2026-06-24T12:00:06.000Z'),
      updatedAt: new Date('2026-06-24T12:00:06.000Z'),
    })),
  }
  const sessionsCollection = {
    updateOne: vi.fn(async () => ({ matchedCount: 1, modifiedCount: 1 })),
    updateMany: vi.fn(async () => ({ matchedCount: 1, modifiedCount: 1 })),
  }
  const stopSessionIds = vi.fn(async () => [task.childSessionId.toString()])
  return {
    service: new AgentTeamRunService({
      store,
      sessionsCollection,
      stopSessionIds,
      retryTaskRunner: options.retryTaskRunner,
    }),
    store,
    sessionsCollection,
    stopSessionIds,
    session,
    otherSession: { _id: otherSessionId, projectId: 'project-1' },
    teamId,
    taskId,
    childSessionId: task.childSessionId,
  }
}

describe('AgentTeamRunService', () => {
  it('lists and serializes reloadable team runs with task counters', async () => {
    const { service, session } = createStore()

    const summaries = await service.listTeamRuns({ session, userId: 'user-1' })
    const run = await service.getTeamRun({
      session,
      userId: 'user-1',
      teamId: summaries[0].id,
    })

    expect(summaries[0]).toMatchObject({
      workflowType: 'deep-review',
      status: 'running',
      mode: 'workflow-graph',
    })
    expect(run.tasks[0]).toMatchObject({
      agentName: 'content-reviewer',
      findingCount: 1,
      artifactCount: 1,
      draftChangeCount: 1,
      retryable: true,
    })
    expect(run.diagnostics).toMatchObject({
      taskCount: 1,
      resultCount: 1,
      eventTypes: { 'draft_change.created': 1 },
    })
  })

  it('rejects team runs that belong to a different root session', async () => {
    const { service, otherSession, teamId } = createStore()

    const run = await service.getTeamRun({
      session: otherSession,
      userId: 'user-1',
      teamId,
    })

    expect(run).toBeNull()
  })

  it('cancels a team run and records a frontend-visible event', async () => {
    const { service, store, sessionsCollection, session, teamId } = createStore()

    await service.cancelTeamRun({
      session,
      userId: 'user-1',
      teamId,
      reason: 'user-cancelled',
    })

    expect(store.cancelActiveTasks).toHaveBeenCalledWith({
      teamId,
      reason: 'user-cancelled',
    })
    expect(store.archiveTeamRun).toHaveBeenCalledWith({
      teamId,
      projectId: 'project-1',
      userId: 'user-1',
      reason: 'user-cancelled',
    })
    expect(store.recordEvent).toHaveBeenCalledWith({
      teamId,
      sessionId: session._id,
      type: 'agent_team.cancelled',
      payload: { reason: 'user-cancelled' },
    })
    expect(sessionsCollection.updateOne).toHaveBeenCalledWith(
      {
        _id: session._id,
        projectId: 'project-1',
        userId: 'user-1',
        'activeHandoff.teamId': teamId.toString(),
      },
      {
        $unset: { activeHandoff: '' },
        $set: { updatedAt: expect.any(Date) },
      }
    )
  })

  it('runs the retry task through the injected retry runner', async () => {
    const retryTaskRunner = vi.fn(async () => {})
    const { service, store, session, teamId, taskId } = createStore({ retryTaskRunner })

    const result = await service.retryTask({
      session,
      userId: 'user-1',
      teamId,
      taskId,
    })

    expect(store.createRetryTask).toHaveBeenCalledWith({
      sourceTask: expect.objectContaining({ _id: taskId }),
      parentTaskId: taskId,
      reason: 'user-retry',
    })
    expect(store.markTeamRunning).toHaveBeenCalledWith({
      teamId,
      projectId: 'project-1',
      userId: 'user-1',
    })
    expect(retryTaskRunner).toHaveBeenCalledWith(expect.objectContaining({
      session,
      userId: 'user-1',
      sourceTask: expect.objectContaining({ _id: taskId }),
      retryTask: expect.objectContaining({ parentTaskId: taskId }),
    }))
    expect(result).toMatchObject({
      task: {
        id: expect.any(String),
        parentTaskId: taskId.toString(),
        status: 'queued',
        retryable: false,
      },
      teamRun: {
        team: { id: teamId.toString() },
      },
    })
  })

  it('queues task retry when no retry runner is available', async () => {
    const { service, store, session, teamId, taskId } = createStore()

    const result = await service.retryTask({
      session,
      userId: 'user-1',
      teamId,
      taskId,
    })

    expect(store.createRetryTask).toHaveBeenCalled()
    expect(store.markTeamRunning).toHaveBeenCalled()
    expect(store.recordEvent).toHaveBeenCalledWith(expect.objectContaining({
      teamId,
      sessionId: session._id,
      taskId: expect.any(ObjectId),
      type: 'agent_task.retry_queued',
      payload: expect.objectContaining({
        sourceTaskId: taskId.toString(),
        runnerError: 'Task retry runner is not available',
      }),
    }))
    expect(result).toMatchObject({
      task: {
        parentTaskId: taskId.toString(),
        status: 'queued',
      },
      teamRun: {
        team: { id: teamId.toString() },
      },
    })
  })

  it('rejects task retry for active tasks', async () => {
    const { service, store, session, teamId, taskId } = createStore()
    const loaded = await store.loadTeamRun({ teamId })
    loaded.tasks[0].status = 'running'

    let thrown
    try {
      await service.retryTask({
        session,
        userId: 'user-1',
        teamId,
        taskId,
      })
    } catch (error) {
      thrown = error
    }

    expect(thrown).toMatchObject({
      statusCode: 409,
      message: 'Only failed, cancelled, or timed-out tasks can be retried',
    })
    expect(store.markTeamRunning).not.toHaveBeenCalled()
    expect(store.createRetryTask).not.toHaveBeenCalled()
  })

  it('cleans up stuck running teams and clears active handoff residue', async () => {
    const {
      service,
      store,
      sessionsCollection,
      stopSessionIds,
      session,
      teamId,
      childSessionId,
    } = createStore()
    const cutoff = new Date('2026-06-24T12:05:00.000Z')

    const result = await service.cleanupStuckTeamRuns({
      cutoff,
      reason: 'timeout-cleanup',
    })

    expect(store.cleanupStuckTeamRuns).toHaveBeenCalledWith({
      cutoff,
      reason: 'timeout-cleanup',
    })
    expect(store.recordEvent).toHaveBeenCalledWith({
      teamId,
      sessionId: expect.any(ObjectId),
      type: 'agent_team.cleaned_up',
      payload: {
        reason: 'timeout-cleanup',
        cutoff: cutoff.toISOString(),
      },
    })
    expect(sessionsCollection.updateMany).toHaveBeenNthCalledWith(
      1,
      {
        _id: { $in: [session._id] },
        'activeHandoff.teamId': { $in: [teamId.toString()] },
      },
      {
        $unset: { activeHandoff: '' },
        $set: { updatedAt: expect.any(Date) },
      }
    )
    expect(sessionsCollection.updateMany).toHaveBeenNthCalledWith(
      2,
      {
        _id: { $in: [childSessionId] },
      },
      {
        $set: {
          'activeTurn.status': 'stopped',
          'activeTurn.reason': 'timeout-cleanup',
          'activeTurn.stoppedAt': expect.any(Date),
          updatedAt: expect.any(Date),
        },
        $unset: { _streamingInterrupted: '' },
      }
    )
    expect(stopSessionIds).toHaveBeenCalledWith([childSessionId])
    expect(result).toMatchObject({
      cleanedTeamCount: 1,
      cancelledTaskCount: 1,
      archivedTeamCount: 1,
    })
  })
})
