import { describe, expect, it, beforeEach, vi } from 'vitest'
import { ObjectId } from 'mongodb'

const { AgentTaskStore } = await import(
  '../../../../app/js/agent-team/AgentTaskStore.js'
)

function createCursor(items) {
  return {
    items: [...items],
    sort(sortSpec) {
      const [[field, direction]] = Object.entries(sortSpec)
      this.items.sort((a, b) => {
        const av = a[field]?.getTime?.() || a[field] || 0
        const bv = b[field]?.getTime?.() || b[field] || 0
        return direction < 0 ? bv - av : av - bv
      })
      return this
    },
    async toArray() {
      return this.items
    },
  }
}

function matches(doc, filter) {
  return Object.entries(filter).every(([key, expected]) => {
    const actual = doc[key]
    if (expected && typeof expected === 'object' && '$in' in expected) {
      return expected.$in.some(value => sameValue(actual, value))
    }
    if (expected && typeof expected === 'object' && '$lte' in expected) {
      return compareValues(actual, expected.$lte) <= 0
    }
    if (expected && typeof expected === 'object' && '$gt' in expected) {
      return compareValues(actual, expected.$gt) > 0
    }
    return sameValue(actual, expected)
  })
}

function sameValue(actual, expected) {
  return actual?.toString?.() === expected?.toString?.() || actual === expected
}

function compareValues(actual, expected) {
  const left = actual?.getTime?.() ?? actual
  const right = expected?.getTime?.() ?? expected
  if (left === right) return 0
  return left < right ? -1 : 1
}

describe('AgentTaskStore', () => {
  let teams
  let tasks
  let contextPacks
  let results
  let events
  let store

  beforeEach(() => {
    teams = []
    tasks = []
    contextPacks = []
    results = []
    events = []
    const db = {
      aiAgentTeams: collection(teams),
      aiAgentTasks: collection(tasks),
      aiAgentContextPacks: collection(contextPacks),
      aiAgentTaskResults: collection(results),
      aiAgentTeamEvents: collection(events),
    }
    store = new AgentTaskStore({
      db,
      now: () => new Date('2026-06-24T12:00:00.000Z'),
    })
  })

  it('creates reloadable team runs, structured tasks, context packs, and events', async () => {
    const rootSessionId = new ObjectId()
    const team = await store.createTeamRun({
      projectId: 'project-1',
      userId: 'user-1',
      rootSessionId,
      workflowType: 'deep-review',
      mode: 'workflow-graph',
      startedBy: 'user',
      policySummary: { maxParallelTasks: 3 },
    })
    const task = await store.createTask({
      teamId: team._id,
      rootSessionId,
      agentName: 'content-reviewer',
      agentVersion: '1.0.0',
      mode: 'workflow-node',
      objective: 'Find unsupported claims',
      acceptanceCriteria: ['Every finding has evidence'],
      input: { files: ['main.tex'] },
      outputSchema: { type: 'object' },
      contextPackId: null,
      policy: { tools: ['read_document'] },
      dependencies: [],
      priority: 2,
      timeoutMs: 120000,
      retryPolicy: { maxAttempts: 1, backoffMs: 0 },
    })
    const contextPack = await store.createContextPack({
      teamId: team._id,
      taskId: task._id,
      projectId: 'project-1',
      sessionId: rootSessionId,
      userRequestSummary: 'Deep review this paper',
      projectInstructions: {
        path: 'AGENTS.md',
        content: 'No praise-only findings',
        refId: 'doc-instructions',
      },
      files: [{ path: 'main.tex', mode: 'excerpt', reason: 'primary file' }],
      tokenBudget: 12000,
    })
    await store.attachContextPack({
      taskId: task._id,
      contextPackId: contextPack._id,
    })
    await store.recordEvent({
      teamId: team._id,
      taskId: task._id,
      sessionId: rootSessionId,
      type: 'agent_task.queued',
      payload: { objective: task.objective },
    })

    const loaded = await store.loadTeamRun({
      teamId: team._id,
      projectId: 'project-1',
      userId: 'user-1',
    })

    expect(loaded.team).toMatchObject({
      projectId: 'project-1',
      userId: 'user-1',
      status: 'queued',
      workflowType: 'deep-review',
    })
    expect(loaded.tasks).toHaveLength(1)
    expect(loaded.tasks[0]).toMatchObject({
      status: 'queued',
      objective: 'Find unsupported claims',
      contextPackId: contextPack._id,
    })
    expect(loaded.contextPacks[0]).toMatchObject({
      userRequestSummary: 'Deep review this paper',
      files: [{ path: 'main.tex', mode: 'excerpt', reason: 'primary file' }],
    })
    expect(loaded.events[0]).toMatchObject({
      type: 'agent_task.queued',
      payload: { objective: task.objective },
    })
  })

  it('reloads workflow graph progress from persisted events and node results', async () => {
    const rootSessionId = new ObjectId()
    const team = await store.createTeamRun({
      projectId: 'project-1',
      userId: 'user-1',
      rootSessionId,
      workflowType: 'deep-review',
      mode: 'workflow-graph',
      startedBy: 'model',
    })
    const reviewer = await store.createTask({
      teamId: team._id,
      rootSessionId,
      agentName: 'content-reviewer',
      mode: 'workflow-node',
      objective: 'Review content',
      outputSchema: { type: 'object' },
    })
    const reducer = await store.createTask({
      teamId: team._id,
      rootSessionId,
      agentName: 'deep-review-reducer',
      mode: 'reducer',
      objective: 'Reduce reviewer findings',
      outputSchema: { type: 'object' },
    })
    await store.recordEvent({
      teamId: team._id,
      sessionId: rootSessionId,
      type: 'agent_graph.node_completed',
      payload: { nodeId: 'reviewers', nodeKind: 'parallel' },
    })
    await store.completeTask({
      taskId: reviewer._id,
      teamId: team._id,
      result: { status: 'completed', summary: 'Reviewer done' },
    })
    await store.completeTask({
      taskId: reducer._id,
      teamId: team._id,
      result: { status: 'completed', summary: 'Reduced report' },
    })

    const loaded = await store.loadTeamRun({
      teamId: team._id,
      projectId: 'project-1',
      userId: 'user-1',
    })

    expect(loaded.team).toMatchObject({
      workflowType: 'deep-review',
      mode: 'workflow-graph',
    })
    expect(loaded.tasks.map(task => task.mode)).toEqual([
      'workflow-node',
      'reducer',
    ])
    expect(loaded.results.map(result => result.summary)).toEqual([
      'Reviewer done',
      'Reduced report',
    ])
    expect(loaded.events[0]).toMatchObject({
      type: 'agent_graph.node_completed',
      payload: { nodeId: 'reviewers', nodeKind: 'parallel' },
    })
  })

  it('updates task lifecycle and stores structured results', async () => {
    const team = await store.createTeamRun({
      projectId: 'project-1',
      userId: 'user-1',
      rootSessionId: new ObjectId(),
      workflowType: 'custom',
      mode: 'subagent-tool',
      startedBy: 'model',
    })
    const task = await store.createTask({
      teamId: team._id,
      rootSessionId: team.rootSessionId,
      agentName: 'quality-checker',
      agentVersion: '1.0.0',
      mode: 'tool',
      objective: 'Check references',
      outputSchema: { type: 'object' },
      policy: { tools: ['read_document'] },
    })

    await store.markTaskRunning({
      taskId: task._id,
      childSessionId: new ObjectId(),
      toolCallId: 'call-1',
    })
    const result = await store.completeTask({
      taskId: task._id,
      teamId: team._id,
      result: {
        status: 'completed',
        summary: 'One issue',
        findings: [{ severity: 'major', title: 'Missing evidence' }],
        evidenceRefs: [{ path: 'main.tex', reason: 'claim location' }],
        confidence: 0.8,
      },
      usage: { toolCalls: 1 },
    })

    expect(tasks[0]).toMatchObject({
      status: 'completed',
      toolCallId: 'call-1',
      resultId: result._id,
    })
    expect(results[0]).toMatchObject({
      taskId: task._id,
      teamId: team._id,
      summary: 'One issue',
      findings: [{ severity: 'major', title: 'Missing evidence' }],
      usage: { toolCalls: 1 },
    })
  })

  it('redacts sensitive task, event, and result persistence fields', async () => {
    const team = await store.createTeamRun({
      projectId: 'project-1',
      userId: 'user-1',
      rootSessionId: new ObjectId(),
      workflowType: 'custom',
      mode: 'subagent-tool',
      startedBy: 'model',
    })
    const task = await store.createTask({
      teamId: team._id,
      rootSessionId: team.rootSessionId,
      agentName: 'content-reviewer',
      objective: 'Review apiKey=secret-value',
      input: {
        userRequest: 'Review token=secret-value',
        apiKey: 'secret-value',
        nested: { password: 'secret-value', text: 'credential=secret-value' },
      },
      policy: { tools: ['read_document'], token: 'secret-value' },
    })
    await store.recordEvent({
      teamId: team._id,
      taskId: task._id,
      sessionId: team.rootSessionId,
      type: 'agent_task.progress',
      payload: {
        step: 'apiKey=secret-value',
        credential: 'secret-value',
      },
    })
    await store.completeTask({
      taskId: task._id,
      teamId: team._id,
      result: {
        summary: 'summary token=secret-value',
        findings: [{ title: 'apiKey=secret-value', secret: 'secret-value' }],
        unresolvedQuestions: ['password=secret-value'],
      },
      usage: { token: 'secret-value', toolCalls: 1 },
    })

    const serialized = JSON.stringify({ tasks, events, results })
    expect(serialized).not.toContain('secret-value')
    expect(serialized).toContain('[REDACTED]')
    expect(tasks[0].input).not.toHaveProperty('apiKey')
    expect(tasks[0].input.nested).not.toHaveProperty('password')
    expect(tasks[0].policy).not.toHaveProperty('token')
    expect(events[0].payload).not.toHaveProperty('credential')
    expect(results[0].findings[0]).not.toHaveProperty('secret')
    expect(results[0].usage).not.toHaveProperty('token')
  })

  it('creates tasks from normalized task specs and can list/archive team runs', async () => {
    const rootSessionId = new ObjectId()
    const team = await store.createTeamRun({
      projectId: 'project-1',
      userId: 'user-1',
      rootSessionId,
      workflowType: 'citation-audit',
      mode: 'subagent-tool',
      startedBy: 'model',
    })

    const task = await store.createTaskFromSpec({
      teamId: team._id,
      rootSessionId,
      spec: {
        capabilityName: 'citation-assistant',
        capabilityVersion: '1.0.0',
        mode: 'tool',
        objective: 'Find duplicate bibliography entries.',
        acceptanceCriteria: ['Return structured duplicate findings'],
        input: { files: ['main.bib'] },
        outputSchema: { type: 'object' },
        policy: { tools: ['bib_manage'] },
        priority: 3,
        timeoutMs: 30000,
      },
    })

    expect(task).toMatchObject({
      agentName: 'citation-assistant',
      agentVersion: '1.0.0',
      objective: 'Find duplicate bibliography entries.',
      acceptanceCriteria: ['Return structured duplicate findings'],
      priority: 3,
    })

    const listed = await store.listTeamRuns({
      projectId: 'project-1',
      userId: 'user-1',
      rootSessionId,
    })
    expect(listed.map(item => item._id.toString())).toEqual([
      team._id.toString(),
    ])

    await store.archiveTeamRun({
      teamId: team._id,
      projectId: 'project-1',
      userId: 'user-1',
      reason: 'superseded',
    })

    expect(teams[0]).toMatchObject({
      status: 'cancelled',
      archiveReason: 'superseded',
    })
    expect(tasks[0]).toMatchObject({
      teamId: team._id,
      agentName: 'citation-assistant',
    })
  })

  it('marks active team tasks cancelled and resets team state for retry', async () => {
    const rootSessionId = new ObjectId()
    const team = await store.createTeamRun({
      projectId: 'project-1',
      userId: 'user-1',
      rootSessionId,
      workflowType: 'deep-review',
      mode: 'workflow-graph',
      status: 'running',
    })
    const runningTask = await store.createTask({
      teamId: team._id,
      rootSessionId,
      agentName: 'content-reviewer',
      mode: 'workflow-node',
      status: 'running',
      objective: 'Review content',
      outputSchema: { type: 'object' },
    })
    const completedTask = await store.createTask({
      teamId: team._id,
      rootSessionId,
      agentName: 'quality-checker',
      mode: 'workflow-node',
      status: 'completed',
      objective: 'Check quality',
      outputSchema: { type: 'object' },
    })

    await store.cancelActiveTasks({
      teamId: team._id,
      reason: 'user-cancelled',
    })

    expect(tasks.find(task => task._id === runningTask._id)).toMatchObject({
      status: 'cancelled',
      error: { reason: 'user-cancelled' },
    })
    expect(tasks.find(task => task._id === completedTask._id)).toMatchObject({
      status: 'completed',
    })

    await store.markTeamRunning({
      teamId: team._id,
      projectId: 'project-1',
      userId: 'user-1',
    })

    expect(teams[0]).toMatchObject({
      status: 'running',
      archiveReason: null,
      completedAt: null,
    })
  })

  it('queues a retry task from a failed task and records retry provenance', async () => {
    const rootSessionId = new ObjectId()
    const team = await store.createTeamRun({
      projectId: 'project-1',
      userId: 'user-1',
      rootSessionId,
      workflowType: 'deep-review',
      mode: 'workflow-graph',
      status: 'running',
    })
    const failedTask = await store.createTask({
      teamId: team._id,
      rootSessionId,
      agentName: 'content-reviewer',
      agentVersion: '1.0.0',
      mode: 'workflow-node',
      status: 'failed',
      objective: 'Review content',
      acceptanceCriteria: ['Return structured findings'],
      input: { files: [{ path: 'main.tex' }] },
      outputSchema: { type: 'object' },
      policy: { tools: ['read_document'] },
      dependencies: [],
      priority: 2,
      timeoutMs: 30000,
      retryPolicy: { maxAttempts: 2, backoffMs: 0 },
    })
    failedTask.resultId = new ObjectId()
    failedTask.error = { message: 'model timeout' }

    const retryTask = await store.createRetryTask({
      sourceTask: failedTask,
      parentTaskId: failedTask._id,
      reason: 'user-retry token=secret-value',
    })

    expect(retryTask).toMatchObject({
      teamId: team._id,
      parentTaskId: failedTask._id,
      rootSessionId,
      agentName: 'content-reviewer',
      mode: 'workflow-node',
      status: 'queued',
      resultId: null,
      error: null,
      policy: { tools: ['read_document'] },
      retryPolicy: { maxAttempts: 2, backoffMs: 0 },
    })
    expect(events[0]).toMatchObject({
      teamId: team._id,
      taskId: failedTask._id,
      sessionId: rootSessionId,
      type: 'agent_task.retry_queued',
      payload: {
        retryTaskId: retryTask._id.toString(),
        reason: 'user-retry [REDACTED]',
      },
    })
  })

  it('does not persist a completion result after an active task is cancelled', async () => {
    const rootSessionId = new ObjectId()
    const team = await store.createTeamRun({
      projectId: 'project-1',
      userId: 'user-1',
      rootSessionId,
      workflowType: 'deep-review',
      mode: 'workflow-graph',
      status: 'running',
    })
    const task = await store.createTask({
      teamId: team._id,
      rootSessionId,
      agentName: 'content-reviewer',
      mode: 'workflow-node',
      status: 'running',
      objective: 'Review content',
      outputSchema: { type: 'object' },
    })

    await store.cancelActiveTasks({
      teamId: team._id,
      reason: 'user-cancelled',
    })
    const result = await store.completeTask({
      taskId: task._id,
      teamId: team._id,
      result: { status: 'completed', summary: 'Late child result' },
    })

    expect(result).toBeNull()
    expect(results).toHaveLength(0)
    expect(tasks[0]).toMatchObject({
      status: 'cancelled',
      resultId: null,
      error: { reason: 'user-cancelled' },
    })
  })

  it('cleans up only stale queued and running team runs', async () => {
    const staleRootSessionId = new ObjectId()
    const activeRootSessionId = new ObjectId()
    const completedRootSessionId = new ObjectId()
    const staleChildSessionId = new ObjectId()
    const staleTeam = await store.createTeamRun({
      projectId: 'project-1',
      userId: 'user-1',
      rootSessionId: staleRootSessionId,
      workflowType: 'deep-review',
      mode: 'workflow-graph',
      status: 'running',
    })
    const activeTeam = await store.createTeamRun({
      projectId: 'project-1',
      userId: 'user-1',
      rootSessionId: activeRootSessionId,
      workflowType: 'deep-review',
      mode: 'workflow-graph',
      status: 'running',
    })
    const completedTeam = await store.createTeamRun({
      projectId: 'project-1',
      userId: 'user-1',
      rootSessionId: completedRootSessionId,
      workflowType: 'deep-review',
      mode: 'workflow-graph',
      status: 'completed',
    })
    teams.find(team => team._id === staleTeam._id).updatedAt = new Date('2026-06-24T11:30:00.000Z')
    teams.find(team => team._id === activeTeam._id).updatedAt = new Date('2026-06-24T11:30:00.000Z')
    teams.find(team => team._id === completedTeam._id).updatedAt = new Date('2026-06-24T11:00:00.000Z')

    const staleRunningTask = await store.createTask({
      teamId: staleTeam._id,
      rootSessionId: staleRootSessionId,
      childSessionId: staleChildSessionId,
      agentName: 'content-reviewer',
      mode: 'workflow-node',
      status: 'running',
      objective: 'Review content',
      outputSchema: { type: 'object' },
    })
    const staleCompletedTask = await store.createTask({
      teamId: staleTeam._id,
      rootSessionId: staleRootSessionId,
      agentName: 'quality-checker',
      mode: 'workflow-node',
      status: 'completed',
      objective: 'Check quality',
      outputSchema: { type: 'object' },
    })
    const activeHeartbeatTask = await store.createTask({
      teamId: activeTeam._id,
      rootSessionId: activeRootSessionId,
      agentName: 'content-reviewer',
      mode: 'workflow-node',
      status: 'running',
      objective: 'Review active content',
      outputSchema: { type: 'object' },
    })
    tasks.find(task => task._id === staleRunningTask._id).updatedAt = new Date('2026-06-24T11:35:00.000Z')
    tasks.find(task => task._id === activeHeartbeatTask._id).updatedAt = new Date('2026-06-24T11:59:00.000Z')
    await store.createTask({
      teamId: completedTeam._id,
      rootSessionId: completedRootSessionId,
      agentName: 'content-reviewer',
      mode: 'workflow-node',
      status: 'running',
      objective: 'Review completed team residue',
      outputSchema: { type: 'object' },
    })

    const cleanup = await store.cleanupStuckTeamRuns({
      cutoff: new Date('2026-06-24T11:45:00.000Z'),
      reason: 'timeout token=secret-value',
    })

    expect(cleanup.teams.map(team => team._id.toString())).toEqual([
      staleTeam._id.toString(),
    ])
    expect(cleanup.childSessionIds.map(id => id.toString())).toEqual([
      staleChildSessionId.toString(),
    ])
    expect(cleanup).toMatchObject({
      cancelledTaskCount: 1,
      archivedTeamCount: 1,
    })
    expect(teams.find(team => team._id === staleTeam._id)).toMatchObject({
      status: 'cancelled',
      archiveReason: 'timeout [REDACTED]',
      completedAt: new Date('2026-06-24T12:00:00.000Z'),
    })
    expect(tasks.find(task => task._id === staleRunningTask._id)).toMatchObject({
      status: 'cancelled',
      error: { reason: 'timeout [REDACTED]' },
      completedAt: new Date('2026-06-24T12:00:00.000Z'),
    })
    expect(tasks.find(task => task._id === staleCompletedTask._id)).toMatchObject({
      status: 'completed',
    })
    expect(teams.find(team => team._id === activeTeam._id)).toMatchObject({
      status: 'running',
    })
    expect(tasks.find(task => task._id === activeHeartbeatTask._id)).toMatchObject({
      status: 'running',
    })
    expect(teams.find(team => team._id === completedTeam._id)).toMatchObject({
      status: 'completed',
    })
  })
})

function collection(items) {
  return {
    insertOne: vi.fn(async doc => {
      items.push(doc)
      return { insertedId: doc._id }
    }),
    findOne: vi.fn(async filter =>
      items.find(item => matches(item, filter)) || null
    ),
    find: vi.fn(filter =>
      createCursor(items.filter(item => matches(item, filter)))
    ),
    updateOne: vi.fn(async (filter, update) => {
      const item = items.find(doc => matches(doc, filter))
      if (!item) return { matchedCount: 0, modifiedCount: 0 }
      Object.assign(item, update.$set || {})
      for (const key of Object.keys(update.$unset || {})) {
        delete item[key]
      }
      return { matchedCount: 1, modifiedCount: 1 }
    }),
    updateMany: vi.fn(async (filter, update) => {
      const matched = items.filter(doc => matches(doc, filter))
      for (const item of matched) {
        Object.assign(item, update.$set || {})
        for (const key of Object.keys(update.$unset || {})) {
          delete item[key]
        }
      }
      return { matchedCount: matched.length, modifiedCount: matched.length }
    }),
  }
}
