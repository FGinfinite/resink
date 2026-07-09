import { ObjectId, db as defaultDb } from '../mongodb.js'
import { normalizeAgentTaskSpec } from './AgentTaskSpec.js'

const TEAM_STATUSES = new Set(['queued', 'running', 'completed', 'degraded', 'failed', 'cancelled'])
const TEAM_MODES = new Set(['workflow-graph', 'handoff', 'subagent-tool', 'background'])
const TASK_STATUSES = new Set(['queued', 'running', 'completed', 'failed', 'cancelled', 'timeout'])
const TASK_MODES = new Set(['tool', 'handoff', 'background', 'workflow-node', 'reducer', 'critic'])
const SENSITIVE_KEY_RE = /(?:prompt|hiddenPrompt|systemPrompt|apiKey|token|secret|password|credential)/i
const SECRET_VALUE_RE = /\b(?:apiKey|token|secret|password|credential)\s*=\s*[^\s,;]+/gi

export class AgentTaskStore {
  constructor(options = {}) {
    this.db = options.db || defaultDb
    this.now = options.now || (() => new Date())
  }

  async createTeamRun(input = {}) {
    const at = this.now()
    const doc = {
      _id: input._id || new ObjectId(),
      projectId: requireString(input.projectId, 'projectId'),
      userId: requireString(input.userId, 'userId'),
      rootSessionId: normalizeObjectId(input.rootSessionId, 'rootSessionId'),
      rootChangeSetId: input.rootChangeSetId
        ? normalizeObjectId(input.rootChangeSetId, 'rootChangeSetId')
        : null,
      workflowType: redactString(input.workflowType || 'custom'),
      status: normalizeEnum(input.status || 'queued', TEAM_STATUSES, 'status'),
      mode: normalizeEnum(input.mode || 'subagent-tool', TEAM_MODES, 'mode'),
      startedBy: input.startedBy || 'model',
      policySummary: sanitizeStructuredValue(input.policySummary || {}),
      budgetSummary: sanitizeStructuredValue(input.budgetSummary || {}),
      startedAt: at,
      updatedAt: at,
      completedAt: null,
    }
    await this.db.aiAgentTeams.insertOne(doc)
    return doc
  }

  async createTask(input = {}) {
    const at = this.now()
    const doc = {
      _id: input._id || new ObjectId(),
      teamId: normalizeObjectId(input.teamId, 'teamId'),
      parentTaskId: input.parentTaskId
        ? normalizeObjectId(input.parentTaskId, 'parentTaskId')
        : null,
      rootSessionId: normalizeObjectId(input.rootSessionId, 'rootSessionId'),
      childSessionId: input.childSessionId
        ? normalizeObjectId(input.childSessionId, 'childSessionId')
        : null,
      toolCallId: input.toolCallId || null,
      agentName: requireString(input.agentName, 'agentName'),
      agentVersion: input.agentVersion || '1.0.0',
      mode: normalizeEnum(input.mode || 'tool', TASK_MODES, 'mode'),
      status: normalizeEnum(input.status || 'queued', TASK_STATUSES, 'status'),
      objective: redactString(requireString(input.objective, 'objective')),
      acceptanceCriteria: normalizeStringArray(input.acceptanceCriteria).map(redactString),
      input: sanitizeStructuredValue(input.input || {}),
      outputSchema: sanitizeStructuredValue(input.outputSchema || { type: 'object' }),
      contextPackId: input.contextPackId
        ? normalizeObjectId(input.contextPackId, 'contextPackId')
        : null,
      policy: sanitizeStructuredValue(input.policy || {}),
      dependencies: normalizeObjectIdArray(input.dependencies),
      priority: normalizeNonNegativeInteger(input.priority, 0),
      timeoutMs: normalizeNonNegativeInteger(input.timeoutMs, 120000),
      retryPolicy: sanitizeStructuredValue(input.retryPolicy || { maxAttempts: 1, backoffMs: 0 }),
      resultId: null,
      error: null,
      startedAt: null,
      completedAt: null,
      createdAt: at,
      updatedAt: at,
    }
    await this.db.aiAgentTasks.insertOne(doc)
    return doc
  }

  async createTaskFromSpec({ teamId, rootSessionId, parentTaskId = null, spec }) {
    const normalized = normalizeAgentTaskSpec(spec)
    return this.createTask({
      teamId,
      parentTaskId,
      rootSessionId,
      agentName: normalized.capabilityName,
      agentVersion: normalized.capabilityVersion || '1.0.0',
      mode: normalized.mode,
      objective: normalized.objective,
      acceptanceCriteria: normalized.acceptanceCriteria,
      input: normalized.input,
      outputSchema: normalized.outputSchema,
      policy: normalized.policy,
      dependencies: normalized.dependencies,
      priority: normalized.priority,
      timeoutMs: normalized.timeoutMs || undefined,
      retryPolicy: normalized.retryPolicy,
    })
  }

  async createRetryTask({ sourceTask, parentTaskId, reason = 'user-retry' }) {
    if (!sourceTask) throw new Error('sourceTask is required')
    const retryTask = await this.createTask({
      teamId: sourceTask.teamId,
      parentTaskId: parentTaskId || sourceTask._id,
      rootSessionId: sourceTask.rootSessionId,
      agentName: sourceTask.agentName,
      agentVersion: sourceTask.agentVersion || '1.0.0',
      mode: sourceTask.mode || 'tool',
      status: 'queued',
      objective: sourceTask.objective,
      acceptanceCriteria: sourceTask.acceptanceCriteria || [],
      input: sourceTask.input || {},
      outputSchema: sourceTask.outputSchema || { type: 'object' },
      contextPackId: null,
      policy: sourceTask.policy || {},
      dependencies: sourceTask.dependencies || [],
      priority: sourceTask.priority || 0,
      timeoutMs: sourceTask.timeoutMs || undefined,
      retryPolicy: sourceTask.retryPolicy || { maxAttempts: 1, backoffMs: 0 },
      error: null,
    })
    await this.recordEvent({
      teamId: sourceTask.teamId,
      taskId: sourceTask._id,
      sessionId: sourceTask.rootSessionId,
      type: 'agent_task.retry_queued',
      payload: {
        retryTaskId: retryTask._id.toString(),
        reason: redactString(reason),
      },
    })
    return retryTask
  }

  async createContextPack(input = {}) {
    const at = this.now()
    const doc = {
      _id: input._id || new ObjectId(),
      teamId: normalizeObjectId(input.teamId, 'teamId'),
      taskId: normalizeObjectId(input.taskId, 'taskId'),
      projectId: requireString(input.projectId, 'projectId'),
      sessionId: normalizeObjectId(input.sessionId, 'sessionId'),
      activeChangeSetId: input.activeChangeSetId || null,
      userRequestSummary: input.userRequestSummary || null,
      parentHistorySummary: input.parentHistorySummary || null,
      projectInstructions: input.projectInstructions || null,
      memories: Array.isArray(input.memories) ? input.memories : [],
      sessionSummary: input.sessionSummary || null,
      recalledContext: Array.isArray(input.recalledContext)
        ? input.recalledContext
        : [],
      files: Array.isArray(input.files) ? input.files : [],
      artifacts: Array.isArray(input.artifacts) ? input.artifacts : [],
      priorFindings: Array.isArray(input.priorFindings) ? input.priorFindings : [],
      diagnostics: input.diagnostics || {},
      tokenBudget: normalizeNonNegativeInteger(input.tokenBudget, 0),
      sourceCounts: input.sourceCounts || {},
      createdAt: at,
    }
    await this.db.aiAgentContextPacks.insertOne(doc)
    return doc
  }

  async attachContextPack({ taskId, contextPackId }) {
    return this.db.aiAgentTasks.updateOne(
      { _id: normalizeObjectId(taskId, 'taskId') },
      {
        $set: {
          contextPackId: normalizeObjectId(contextPackId, 'contextPackId'),
          updatedAt: this.now(),
        },
      }
    )
  }

  async markTaskRunning({ taskId, childSessionId, toolCallId }) {
    return this.db.aiAgentTasks.updateOne(
      { _id: normalizeObjectId(taskId, 'taskId') },
      {
        $set: {
          status: 'running',
          childSessionId: childSessionId
            ? normalizeObjectId(childSessionId, 'childSessionId')
            : null,
          toolCallId: toolCallId || null,
          startedAt: this.now(),
          updatedAt: this.now(),
        },
      }
    )
  }

  async completeTask({ taskId, teamId, result = {}, usage = {} }) {
    const at = this.now()
    const normalizedTaskId = normalizeObjectId(taskId, 'taskId')
    const existingTask = await this.db.aiAgentTasks.findOne({
      _id: normalizedTaskId,
      teamId: normalizeObjectId(teamId, 'teamId'),
    })
    if (!existingTask || existingTask.status === 'cancelled') {
      return null
    }
    const resultDoc = {
      _id: new ObjectId(),
      taskId: normalizedTaskId,
      teamId: normalizeObjectId(teamId, 'teamId'),
      status: result.status || 'completed',
      summary: redactString(result.summary || ''),
      findings: sanitizeStructuredArray(result.findings),
      proposedEdits: sanitizeStructuredArray(result.proposedEdits),
      artifacts: sanitizeStructuredArray(result.artifacts),
      evidenceRefs: sanitizeStructuredArray(result.evidenceRefs),
      unresolvedQuestions: Array.isArray(result.unresolvedQuestions)
        ? result.unresolvedQuestions.map(redactString)
        : [],
      confidence: result.confidence ?? null,
      nextActions: sanitizeStructuredArray(result.nextActions),
      usage: sanitizeStructuredValue(usage),
      createdAt: at,
    }
    await this.db.aiAgentTaskResults.insertOne(resultDoc)
    await this.db.aiAgentTasks.updateOne(
      { _id: resultDoc.taskId },
      {
        $set: {
          status: 'completed',
          resultId: resultDoc._id,
          completedAt: at,
          updatedAt: at,
        },
      }
    )
    return resultDoc
  }

  async failTask({ taskId, teamId, error, status = 'failed', result = {}, usage = {} }) {
    const at = this.now()
    const normalizedTaskId = normalizeObjectId(taskId, 'taskId')
    const normalizedTeamId = normalizeObjectId(teamId, 'teamId')
    const terminalStatus = status === 'timeout' ? 'timeout' : 'failed'
    const existingTask = await this.db.aiAgentTasks.findOne({
      _id: normalizedTaskId,
      teamId: normalizedTeamId,
    })
    if (!existingTask || existingTask.status === 'cancelled') {
      return null
    }
    const resultDoc = {
      _id: new ObjectId(),
      taskId: normalizedTaskId,
      teamId: normalizedTeamId,
      status: terminalStatus,
      summary: redactString(result.summary || sanitizeErrorMessage(error)),
      findings: sanitizeStructuredArray(result.findings),
      proposedEdits: sanitizeStructuredArray(result.proposedEdits),
      artifacts: sanitizeStructuredArray(result.artifacts),
      evidenceRefs: sanitizeStructuredArray(result.evidenceRefs),
      unresolvedQuestions: Array.isArray(result.unresolvedQuestions)
        ? result.unresolvedQuestions.map(redactString)
        : [],
      confidence: result.confidence ?? null,
      nextActions: sanitizeStructuredArray(result.nextActions),
      usage: sanitizeStructuredValue(usage),
      createdAt: at,
    }
    await this.db.aiAgentTaskResults.insertOne(resultDoc)
    await this.db.aiAgentTasks.updateOne(
      { _id: normalizedTaskId },
      {
        $set: {
          status: terminalStatus,
          resultId: resultDoc._id,
          error: sanitizeTaskError(error),
          completedAt: at,
          updatedAt: at,
        },
      }
    )
    return resultDoc
  }

  async completeTeamRun({ teamId, projectId, userId, status = 'completed' }) {
    const normalizedStatus = normalizeEnum(status, TEAM_STATUSES, 'status')
    return this.db.aiAgentTeams.updateOne(
      {
        _id: normalizeObjectId(teamId, 'teamId'),
        projectId: requireString(projectId, 'projectId'),
        userId: requireString(userId, 'userId'),
      },
      {
        $set: {
          status: normalizedStatus,
          completedAt: this.now(),
          updatedAt: this.now(),
        },
      }
    )
  }

  async recordEvent(input = {}) {
    const doc = {
      _id: input._id || new ObjectId(),
      teamId: normalizeObjectId(input.teamId, 'teamId'),
      taskId: input.taskId ? normalizeObjectId(input.taskId, 'taskId') : null,
      sessionId: input.sessionId ? normalizeObjectId(input.sessionId, 'sessionId') : null,
      type: requireString(input.type, 'type'),
      payload: sanitizeStructuredValue(input.payload || {}),
      createdAt: this.now(),
    }
    await this.db.aiAgentTeamEvents.insertOne(doc)
    return doc
  }

  async loadTeamRun({ teamId, projectId, userId }) {
    const team = await this.db.aiAgentTeams.findOne({
      _id: normalizeObjectId(teamId, 'teamId'),
      projectId,
      userId,
    })
    if (!team) return null
    const tasks = await this.db.aiAgentTasks
      .find({ teamId: team._id })
      .sort({ createdAt: 1 })
      .toArray()
    const contextPacks = await this.db.aiAgentContextPacks
      .find({ teamId: team._id })
      .sort({ createdAt: 1 })
      .toArray()
    const results = await this.db.aiAgentTaskResults
      .find({ teamId: team._id })
      .sort({ createdAt: 1 })
      .toArray()
    const events = await this.db.aiAgentTeamEvents
      .find({ teamId: team._id })
      .sort({ createdAt: 1 })
      .toArray()
    return { team, tasks, contextPacks, results, events }
  }

  async listTeamRuns({ projectId, userId, rootSessionId, status }) {
    const filter = {
      projectId: requireString(projectId, 'projectId'),
      userId: requireString(userId, 'userId'),
    }
    if (rootSessionId) {
      filter.rootSessionId = normalizeObjectId(rootSessionId, 'rootSessionId')
    }
    if (status) {
      filter.status = normalizeEnum(status, TEAM_STATUSES, 'status')
    }
    return this.db.aiAgentTeams
      .find(filter)
      .sort({ updatedAt: -1 })
      .toArray()
  }

  async markTeamRunning({ teamId, projectId, userId }) {
    return this.db.aiAgentTeams.updateOne(
      {
        _id: normalizeObjectId(teamId, 'teamId'),
        projectId: requireString(projectId, 'projectId'),
        userId: requireString(userId, 'userId'),
      },
      {
        $set: {
          status: 'running',
          archiveReason: null,
          completedAt: null,
          updatedAt: this.now(),
        },
      }
    )
  }

  async cancelActiveTasks({ teamId, reason = 'cancelled' }) {
    return this.db.aiAgentTasks.updateMany(
      {
        teamId: normalizeObjectId(teamId, 'teamId'),
        status: { $in: ['queued', 'running'] },
      },
      {
        $set: {
          status: 'cancelled',
          error: { reason: redactString(reason) },
          completedAt: this.now(),
          updatedAt: this.now(),
        },
      }
    )
  }

  async archiveTeamRun({ teamId, projectId, userId, reason = 'archived' }) {
    return this.db.aiAgentTeams.updateOne(
      {
        _id: normalizeObjectId(teamId, 'teamId'),
        projectId: requireString(projectId, 'projectId'),
        userId: requireString(userId, 'userId'),
      },
      {
        $set: {
          status: 'cancelled',
          archiveReason: reason,
          completedAt: this.now(),
          updatedAt: this.now(),
        },
      }
    )
  }

  async cleanupStuckTeamRuns({ cutoff, reason = 'stuck-team-cleanup' }) {
    const cutoffDate = normalizeDate(cutoff, 'cutoff')
    const at = this.now()
    const teams = await this.db.aiAgentTeams
      .find({
        status: { $in: ['queued', 'running'] },
        updatedAt: { $lte: cutoffDate },
      })
      .toArray()
    if (teams.length === 0) {
      return { teams: [], childSessionIds: [], cancelledTaskCount: 0, archivedTeamCount: 0 }
    }
    const candidateTeamIds = teams.map(team => team._id)
    const freshActiveTasks = await this.db.aiAgentTasks
      .find({
        teamId: { $in: candidateTeamIds },
        status: { $in: ['queued', 'running'] },
        updatedAt: { $gt: cutoffDate },
      })
      .toArray()
    const freshTeamIds = new Set(freshActiveTasks.map(task => task.teamId.toString()))
    const staleTeams = teams.filter(team => !freshTeamIds.has(team._id.toString()))
    if (staleTeams.length === 0) {
      return { teams: [], childSessionIds: [], cancelledTaskCount: 0, archivedTeamCount: 0 }
    }
    const teamIds = staleTeams.map(team => team._id)
    const staleActiveTasks = await this.db.aiAgentTasks
      .find({
        teamId: { $in: teamIds },
        status: { $in: ['queued', 'running'] },
      })
      .toArray()
    const childSessionIds = staleActiveTasks
      .map(task => task.childSessionId)
      .filter(Boolean)
    const taskResult = await this.db.aiAgentTasks.updateMany(
      {
        teamId: { $in: teamIds },
        status: { $in: ['queued', 'running'] },
      },
      {
        $set: {
          status: 'cancelled',
          error: { reason: redactString(reason) },
          completedAt: at,
          updatedAt: at,
        },
      }
    )
    const teamResult = await this.db.aiAgentTeams.updateMany(
      {
        _id: { $in: teamIds },
      },
      {
        $set: {
          status: 'cancelled',
          archiveReason: redactString(reason),
          completedAt: at,
          updatedAt: at,
        },
      }
    )
    return {
      teams: staleTeams,
      childSessionIds,
      cancelledTaskCount: taskResult.modifiedCount || 0,
      archivedTeamCount: teamResult.modifiedCount || 0,
    }
  }
}

function normalizeObjectId(value, field) {
  if (value instanceof ObjectId) return value
  if (typeof value === 'string' && ObjectId.isValid(value)) return new ObjectId(value)
  throw new Error(`${field} must be a valid ObjectId`)
}

function normalizeObjectIdArray(values = []) {
  return Array.isArray(values)
    ? values.map((value, index) => normalizeObjectId(value, `dependencies[${index}]`))
    : []
}

function requireString(value, field) {
  if (typeof value === 'string' && value.trim()) return value.trim()
  throw new Error(`${field} is required`)
}

function normalizeStringArray(values = []) {
  return Array.isArray(values)
    ? values.filter(value => typeof value === 'string' && value.trim()).map(value => value.trim())
    : []
}

function normalizeEnum(value, allowed, field) {
  if (allowed.has(value)) return value
  throw new Error(`Invalid ${field}: ${value}`)
}

function normalizeNonNegativeInteger(value, fallback) {
  const numeric = Number(value)
  return Number.isSafeInteger(numeric) && numeric >= 0 ? numeric : fallback
}

function normalizeDate(value, field) {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) {
    throw new Error(`${field} must be a valid date`)
  }
  return date
}

function sanitizeStructuredArray(values = []) {
  return Array.isArray(values) ? values.map(sanitizeStructuredValue) : []
}

function sanitizeStructuredValue(value) {
  if (Array.isArray(value)) return value.map(sanitizeStructuredValue)
  if (value && typeof value === 'object') {
    const output = {}
    for (const [key, nested] of Object.entries(value)) {
      if (SENSITIVE_KEY_RE.test(key)) continue
      output[key] = sanitizeStructuredValue(nested)
    }
    return output
  }
  if (typeof value === 'string') return redactString(value)
  return value
}

function redactString(value) {
  return String(value || '').replace(SECRET_VALUE_RE, '[REDACTED]')
}

function sanitizeErrorMessage(error) {
  return String(error?.message || error || 'Unknown error').slice(0, 1000)
}

function sanitizeTaskError(error) {
  if (error && typeof error === 'object') {
    return sanitizeStructuredValue({
      message: sanitizeErrorMessage(error),
      code: typeof error.code === 'string' ? error.code : undefined,
      status: typeof error.status === 'string' ? error.status : undefined,
    })
  }
  return { message: sanitizeErrorMessage(error) }
}

export default AgentTaskStore
