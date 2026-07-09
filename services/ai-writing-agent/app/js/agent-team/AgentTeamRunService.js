import { ObjectId } from '../mongodb.js'
import { AgentTaskStore } from './AgentTaskStore.js'

const ACTIVE_TASK_STATUSES = new Set(['queued', 'running'])
const RETRYABLE_TASK_STATUSES = new Set(['failed', 'cancelled', 'timeout'])

export class AgentTeamRunService {
  constructor(options = {}) {
    this.store = options.store || new AgentTaskStore(options)
    this.sessionsCollection = options.sessionsCollection || options.db?.aiSessions || null
    this.stopSessionIds = options.stopSessionIds || null
    this.retryTaskRunner = options.retryTaskRunner || null
  }

  async listTeamRuns({ session, userId, status }) {
    const teams = await this.store.listTeamRuns({
      projectId: session.projectId,
      userId,
      rootSessionId: session._id,
      status,
    })
    return teams.map(team => serializeTeamSummary(team))
  }

  async getTeamRun({ session, userId, teamId }) {
    const loaded = await this.store.loadTeamRun({
      teamId,
      projectId: session.projectId,
      userId,
    })
    if (!loaded || loaded.team.rootSessionId.toString() !== session._id.toString()) {
      return null
    }
    return serializeTeamRun(loaded)
  }

  async cancelTeamRun({ session, userId, teamId, reason = 'user-cancelled' }) {
    const loaded = await this.store.loadTeamRun({
      teamId,
      projectId: session.projectId,
      userId,
    })
    if (!loaded || loaded.team.rootSessionId.toString() !== session._id.toString()) {
      return null
    }
    await this.store.cancelActiveTasks({
      teamId,
      reason,
    })
    await this.store.archiveTeamRun({
      teamId,
      projectId: session.projectId,
      userId,
      reason,
    })
    await this.store.recordEvent({
      teamId,
      sessionId: session._id,
      type: 'agent_team.cancelled',
      payload: { reason },
    })
    if (this.sessionsCollection) {
      await this.sessionsCollection.updateOne(
        {
          _id: session._id,
          projectId: session.projectId,
          userId,
          'activeHandoff.teamId': teamId.toString(),
        },
        {
          $unset: { activeHandoff: '' },
          $set: { updatedAt: new Date() },
        }
      )
    }
    return this.getTeamRun({ session, userId, teamId })
  }

  async retryTask({ session, userId, teamId, taskId }) {
    const loaded = await this.store.loadTeamRun({
      teamId,
      projectId: session.projectId,
      userId,
    })
    if (!loaded || loaded.team.rootSessionId.toString() !== session._id.toString()) {
      return null
    }
    const task = loaded.tasks.find(item => item._id.toString() === taskId.toString())
    if (!task) {
      const error = new Error('Task not found')
      error.statusCode = 404
      throw error
    }
    if (!RETRYABLE_TASK_STATUSES.has(task.status)) {
      const error = new Error('Only failed, cancelled, or timed-out tasks can be retried')
      error.statusCode = 409
      throw error
    }
    const retryTask = await this.store.createRetryTask({
      sourceTask: task,
      parentTaskId: task._id,
      reason: 'user-retry',
    })
    await this.store.markTeamRunning({
      teamId,
      projectId: session.projectId,
      userId,
    })
    if (typeof this.retryTaskRunner === 'function') {
      try {
        await this.retryTaskRunner({
          session,
          userId,
          team: loaded.team,
          sourceTask: task,
          retryTask,
          loaded,
        })
      } catch (error) {
        await this.store.recordEvent({
          teamId,
          sessionId: session._id,
          taskId: retryTask._id,
          type: 'agent_task.retry_queued',
          payload: {
            sourceTaskId: task._id.toString(),
            retryTaskId: retryTask._id.toString(),
            runnerError: error.message,
          },
        })
      }
    } else {
      await this.store.recordEvent({
        teamId,
        sessionId: session._id,
        taskId: retryTask._id,
        type: 'agent_task.retry_queued',
        payload: {
          sourceTaskId: task._id.toString(),
          retryTaskId: retryTask._id.toString(),
          runnerError: 'Task retry runner is not available',
        },
      })
    }
    const refreshed = await this.getTeamRun({ session, userId, teamId })
    return {
      task: serializeTask(retryTask, new Map(), new Map()),
      teamRun: refreshed,
    }
  }

  async cleanupStuckTeamRuns({ cutoff, reason = 'stuck-team-cleanup' }) {
    const cutoffDate = normalizeDate(cutoff, 'cutoff')
    const cleanup = await this.store.cleanupStuckTeamRuns({ cutoff: cutoffDate, reason })
    for (const team of cleanup.teams || []) {
      await this.store.recordEvent({
        teamId: team._id,
        sessionId: team.rootSessionId,
        type: 'agent_team.cleaned_up',
        payload: {
          reason,
          cutoff: cutoffDate.toISOString(),
        },
      })
    }
    if (this.sessionsCollection && cleanup.teams?.length) {
      const rootSessionIds = cleanup.teams.map(team => team.rootSessionId)
      await this.sessionsCollection.updateMany(
        {
          _id: { $in: rootSessionIds },
          'activeHandoff.teamId': {
            $in: cleanup.teams.map(team => team._id.toString()),
          },
        },
        {
          $unset: { activeHandoff: '' },
          $set: { updatedAt: new Date() },
        }
      )
      if (cleanup.childSessionIds?.length) {
        await this.stopSessionIds?.(cleanup.childSessionIds)
        await this.sessionsCollection.updateMany(
          {
            _id: { $in: cleanup.childSessionIds },
          },
          {
            $set: {
              'activeTurn.status': 'stopped',
              'activeTurn.reason': reason,
              'activeTurn.stoppedAt': new Date(),
              updatedAt: new Date(),
            },
            $unset: { _streamingInterrupted: '' },
          }
        )
      }
    }
    return {
      cleanedTeamCount: cleanup.teams?.length || 0,
      cancelledTaskCount: cleanup.cancelledTaskCount || 0,
      archivedTeamCount: cleanup.archivedTeamCount || 0,
    }
  }
}

function normalizeDate(value, field) {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) {
    throw new Error(`${field} must be a valid date`)
  }
  return date
}

export function serializeTeamRun(loaded) {
  const resultByTaskId = new Map(
    loaded.results.map(result => [result.taskId.toString(), result])
  )
  const draftCountByTaskId = countDraftChangesByTaskId(loaded.events)
  return {
    team: serializeTeamSummary(loaded.team),
    tasks: loaded.tasks.map(task =>
      serializeTask(task, resultByTaskId, draftCountByTaskId)
    ),
    results: loaded.results.map(serializeResult),
    events: loaded.events.map(serializeEvent),
    diagnostics: buildDiagnostics(loaded),
  }
}

export function serializeTeamSummary(team) {
  return {
    id: team._id.toString(),
    projectId: team.projectId,
    rootSessionId: team.rootSessionId.toString(),
    rootChangeSetId: team.rootChangeSetId?.toString?.() || null,
    workflowType: team.workflowType,
    status: team.status,
    mode: team.mode,
    startedBy: team.startedBy,
    policySummary: team.policySummary || {},
    budgetSummary: team.budgetSummary || {},
    archiveReason: team.archiveReason || null,
    startedAt: toMillis(team.startedAt),
    updatedAt: toMillis(team.updatedAt),
    completedAt: toMillis(team.completedAt),
  }
}

function serializeTask(task, resultByTaskId, draftCountByTaskId) {
  const result = resultByTaskId.get(task._id.toString())
  return {
    id: task._id.toString(),
    teamId: task.teamId.toString(),
    parentTaskId: task.parentTaskId?.toString?.() || null,
    rootSessionId: task.rootSessionId?.toString?.() || null,
    childSessionId: task.childSessionId?.toString?.() || null,
    agentName: task.agentName,
    agentVersion: task.agentVersion,
    mode: task.mode,
    status: task.status,
    objective: task.objective,
    acceptanceCriteria: task.acceptanceCriteria || [],
    policy: task.policy || {},
    priority: task.priority || 0,
    timeoutMs: task.timeoutMs || 0,
    retryPolicy: task.retryPolicy || {},
    resultId: task.resultId?.toString?.() || null,
    error: task.error || null,
    findingCount: Array.isArray(result?.findings) ? result.findings.length : 0,
    artifactCount: Array.isArray(result?.artifacts) ? result.artifacts.length : 0,
    draftChangeCount: draftCountByTaskId.get(task._id.toString()) || 0,
    retryable: RETRYABLE_TASK_STATUSES.has(task.status),
    cancellable: ACTIVE_TASK_STATUSES.has(task.status),
    startedAt: toMillis(task.startedAt),
    completedAt: toMillis(task.completedAt),
    createdAt: toMillis(task.createdAt),
    updatedAt: toMillis(task.updatedAt),
  }
}

function serializeResult(result) {
  return {
    id: result._id.toString(),
    taskId: result.taskId.toString(),
    teamId: result.teamId.toString(),
    status: result.status,
    summary: result.summary || '',
    findings: result.findings || [],
    proposedEdits: result.proposedEdits || [],
    artifacts: result.artifacts || [],
    evidenceRefs: result.evidenceRefs || [],
    unresolvedQuestions: result.unresolvedQuestions || [],
    confidence: result.confidence ?? null,
    nextActions: result.nextActions || [],
    usage: result.usage || {},
    createdAt: toMillis(result.createdAt),
  }
}

function serializeEvent(event) {
  return {
    id: event._id.toString(),
    teamId: event.teamId.toString(),
    taskId: event.taskId?.toString?.() || null,
    sessionId: event.sessionId?.toString?.() || null,
    type: event.type,
    payload: event.payload || {},
    createdAt: toMillis(event.createdAt),
  }
}

function countDraftChangesByTaskId(events) {
  const counts = new Map()
  for (const event of events) {
    if (event.type !== 'draft_change.created') continue
    const taskId =
      event.taskId?.toString?.() ||
      event.payload?.taskId ||
      event.payload?.provenance?.taskId
    if (!taskId) continue
    counts.set(taskId, (counts.get(taskId) || 0) + 1)
  }
  return counts
}

function buildDiagnostics(loaded) {
  const eventTypes = loaded.events.reduce((counts, event) => {
    counts[event.type] = (counts[event.type] || 0) + 1
    return counts
  }, {})
  return {
    eventTypes,
    taskCount: loaded.tasks.length,
    resultCount: loaded.results.length,
    contextPackCount: loaded.contextPacks.length,
  }
}

function toMillis(value) {
  return value?.getTime?.() || null
}

export function normalizeObjectIdString(value, field) {
  if (value instanceof ObjectId) return value.toString()
  if (typeof value === 'string' && ObjectId.isValid(value)) return value
  const error = new Error(`${field} must be a valid ObjectId`)
  error.statusCode = 400
  throw error
}

export default AgentTeamRunService
