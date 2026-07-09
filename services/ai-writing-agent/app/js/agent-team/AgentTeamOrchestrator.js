import { AgentCapabilityRegistry } from './AgentCapabilityRegistry.js'
import { BUILT_IN_AGENT_CAPABILITIES } from './capabilities/builtInCapabilities.js'
import { AgentPolicyEngine } from './AgentPolicyEngine.js'
import { AgentTaskStore } from './AgentTaskStore.js'
import { AgentContextPackBuilder } from './AgentContextPackBuilder.js'
import { AgentTeamChildRunner } from './AgentTeamChildRunner.js'
import { AgentGraphRunner } from './AgentGraphRunner.js'
import { createDeepReviewGraph } from './workflows/deepReviewWorkflow.js'
import { normalizeAgentTaskResult } from './AgentTaskResult.js'
import { AgentResultReducer } from './AgentResultReducer.js'

export class AgentTeamOrchestrator {
  constructor(options = {}) {
    this.store = options.store || new AgentTaskStore()
    this.baseDefinitions = options.definitions || BUILT_IN_AGENT_CAPABILITIES
    this.skillRegistry = options.skillRegistry || null
    this.capabilityRegistry = options.capabilityRegistry || new AgentCapabilityRegistry({
      definitions: this.baseDefinitions,
      skillRegistry: this.skillRegistry,
    })
    this.policyEngine = options.policyEngine || new AgentPolicyEngine()
    this.contextPackBuilder = options.contextPackBuilder || new AgentContextPackBuilder()
    this.agentController = options.agentController
    this.childRunner = options.childRunner || new AgentTeamChildRunner({
      parentToolRegistry: options.parentToolRegistry,
      agentController: options.agentController,
    })
    this.graphRunner = options.graphRunner || null
    this.resultReducer = options.resultReducer || new AgentResultReducer()
  }

  async startAgentTask(input = {}) {
    const registry = await this.ensureCapabilityRegistry(input)
    const capability = registry.get(input.taskSpec?.capabilityName)
    if (!capability) {
      throw new Error(`Unknown agent capability: ${input.taskSpec?.capabilityName}`)
    }
    const policy = this.policyEngine.computeChildPolicy({
      parentPolicy: input.parentPolicy,
      capabilityPolicy: capability.defaultPolicy,
      taskPolicy: normalizeTaskPolicy(input.taskSpec.policy),
    })
    const requestedToolNames = input.taskSpec.policy?.tools || capability.defaultPolicy?.tools || []
    const allowedToolNames = policy.tools

    const team = await this.store.createTeamRun({
      projectId: input.projectId,
      userId: input.userId,
      rootSessionId: input.rootSessionId || input.sessionId,
      rootChangeSetId: input.activeChangeSetId || null,
      workflowType: 'custom',
      mode: 'subagent-tool',
      startedBy: 'model',
      policySummary: summarizePolicy(policy),
    })
    await this.store.recordEvent({
      teamId: team._id,
      sessionId: input.rootSessionId || input.sessionId,
      type: 'agent_team.started',
      payload: {
        mode: team.mode,
        workflowType: team.workflowType,
      },
    })
    await input.onTeamStarted?.(serializeStartedTeamEvent(team, input))

    const taskResult = await this.runTaskInTeam({
      ...input,
      team,
      capability,
      policy,
      requestedToolNames,
      sessionId: input.sessionId,
      rootSessionId: input.rootSessionId || input.sessionId,
    })
    await this.store.recordEvent({
      teamId: team._id,
      sessionId: input.rootSessionId || input.sessionId,
      type: 'agent_team.completed',
      payload: {
        taskCount: 1,
        status: taskResult.status,
      },
    })
    await this.store.completeTeamRun?.({
      teamId: team._id,
      projectId: input.projectId,
      userId: input.userId,
      status: taskResult.status === 'completed' ? 'completed' : 'failed',
    })

    return {
      teamId: team._id.toString(),
      taskId: taskResult.taskId,
      childSessionId: taskResult.childSessionId,
      status: taskResult.status,
      capabilityName: capability.name,
      allowedToolNames,
      result: taskResult.result,
      events: [
        { type: 'agent_team.started' },
        ...taskResult.events,
        { type: 'agent_team.completed' },
      ],
    }
  }

  async startAgentTeam(input = {}) {
    if (input.workflowType !== 'deep-review') {
      throw new Error(`Unsupported agent team workflow: ${input.workflowType}`)
    }
    const team = await this.store.createTeamRun({
      projectId: input.projectId,
      userId: input.userId,
      rootSessionId: input.rootSessionId || input.sessionId,
      rootChangeSetId: input.activeChangeSetId || null,
      workflowType: 'deep-review',
      mode: 'workflow-graph',
      startedBy: 'model',
      policySummary: summarizePolicy(input.parentPolicy || {}),
    })
    await this.store.recordEvent({
      teamId: team._id,
      sessionId: input.rootSessionId || input.sessionId,
      type: 'agent_team.started',
      payload: {
        mode: team.mode,
        workflowType: team.workflowType,
      },
    })
    await input.onTeamStarted?.(serializeStartedTeamEvent(team, input))
    const graphResult = await this.runWorkflowGraph({
      ...input,
      team,
      graph: createDeepReviewGraph({
        userRequest: input.userRequest,
        targetVenue: input.targetVenue,
        files: input.files,
      }),
      sessionId: input.sessionId,
      rootSessionId: input.rootSessionId || input.sessionId,
    })
    const finalSummary =
      graphResult.results?.critic?.result?.summary ||
      graphResult.results?.reducer?.result?.summary ||
      'Deep Review workflow completed.'
    await this.store.recordEvent({
      teamId: team._id,
      sessionId: input.rootSessionId || input.sessionId,
      type: 'agent_team.completed',
      payload: {
        workflowType: 'deep-review',
        status: graphResult.status,
      },
    })
    await this.store.completeTeamRun?.({
      teamId: team._id,
      projectId: input.projectId,
      userId: input.userId,
      status: graphResult.status,
    })
    return {
      teamId: team._id.toString(),
      workflowType: 'deep-review',
      status: graphResult.status,
      result: {
        summary: finalSummary,
        graph: graphResult,
      },
      events: graphResult.events || [],
    }
  }

  async runTaskInTeam(input = {}) {
    const registry = await this.ensureCapabilityRegistry()
    const taskSpec = input.taskSpec || taskSpecFromTask(input.task)
    const capability = input.capability || registry.get(taskSpec?.capabilityName)
    if (!capability) {
      throw new Error(`Unknown agent capability: ${taskSpec?.capabilityName}`)
    }
    const policy = input.policy || this.policyEngine.computeChildPolicy({
      parentPolicy: input.parentPolicy,
      capabilityPolicy: capability.defaultPolicy,
      taskPolicy: normalizeTaskPolicy(taskSpec.policy),
    })
    const requestedToolNames =
      input.requestedToolNames ||
      taskSpec.policy?.tools ||
      capability.defaultPolicy?.tools ||
      []
    const allowedToolNames = input.allowedToolNames || policy.tools
    const team = input.team

    const task = input.task || await this.store.createTaskFromSpec({
        teamId: team._id,
        rootSessionId: input.rootSessionId || input.sessionId,
        spec: {
          ...taskSpec,
          capabilityVersion: taskSpec.capabilityVersion || capability.version,
          policy,
          outputSchema: taskSpec.outputSchema || capability.outputSchema,
        },
      })
    const contextPackPayload = await this.contextPackBuilder.build({
      teamId: team._id.toString(),
      taskId: task._id.toString(),
      projectId: input.projectId,
      sessionId: input.rootSessionId || input.sessionId,
      activeChangeSetId: input.activeChangeSetId || null,
      userRequest: taskSpec.input?.userRequest || taskSpec.objective,
      parentHistorySummary: input.parentHistorySummary || null,
      projectInstructions: input.projectInstructions || null,
      memories: input.memories || [],
      sessionSummary: input.sessionSummary || null,
      recalledContext: input.recalledContext || [],
      files: taskSpec.input?.files || [],
      artifacts: input.artifacts || [],
      priorFindings: input.priorFindings || [],
      diagnostics: input.diagnostics || {},
      tokenBudget: taskSpec.contextPolicy?.maxContextTokens || 12000,
      contextPolicy: {
        ...(capability.contextPolicy || {}),
        ...(taskSpec.contextPolicy || {}),
      },
    })
    await this.store.recordEvent({
      teamId: team._id,
      taskId: task._id,
      sessionId: input.rootSessionId || input.sessionId,
      type: 'agent_task.queued',
      payload: {
        capabilityName: capability.name,
        objective: task.objective,
        contextSourceCounts: contextPackPayload.sourceCounts || {},
      },
    })
    const contextPack = await this.store.createContextPack({
      ...contextPackPayload,
      teamId: team._id,
      taskId: task._id,
      sessionId: input.rootSessionId || input.sessionId,
    })
    await this.store.attachContextPack({
      taskId: task._id,
      contextPackId: contextPack._id,
    })

    const childSession = await this.createChildSession({
      parentId: input.sessionId,
      projectId: input.projectId,
      userId: input.userId,
      agentName: capability.name,
      requestedToolNames,
      allowedToolNames,
    })
    await this.store.markTaskRunning({
      taskId: task._id,
      childSessionId: childSession._id,
      toolCallId: input.toolCallId || null,
    })
    await this.store.recordEvent({
      teamId: team._id,
      taskId: task._id,
      sessionId: input.rootSessionId || input.sessionId,
      type: 'agent_task.started',
      payload: {
        childSessionId: childSession._id.toString(),
        allowedToolNames,
      },
    })

    let childResult
    try {
      childResult = await this.runChildTask({
        team,
        task,
        capability,
        contextPack,
        childSession,
        allowedToolNames,
        policy,
        parentContext: input,
      })
    } catch (error) {
      const resultDoc = await this.store.failTask?.({
        teamId: team._id,
        taskId: task._id,
        error,
        result: {
          summary: error.message || 'Child agent failed.',
        },
      })
      await this.store.recordEvent({
        teamId: team._id,
        taskId: task._id,
        sessionId: input.rootSessionId || input.sessionId,
        type: 'agent_task.failed',
        payload: {
          error: sanitizeError(error),
          resultId: resultDoc?._id?.toString?.() || null,
        },
      })
      return {
        taskId: task._id.toString(),
        childSessionId: childSession._id.toString(),
        status: 'failed',
        capabilityName: capability.name,
        allowedToolNames,
        result: resultDoc
          ? {
              id: resultDoc._id.toString(),
              summary: resultDoc.summary,
              findings: resultDoc.findings,
              proposedEdits: resultDoc.proposedEdits,
              artifacts: resultDoc.artifacts,
              evidenceRefs: resultDoc.evidenceRefs,
              confidence: resultDoc.confidence,
            }
          : null,
        error: sanitizeError(error),
        events: [
          { type: 'agent_task.queued' },
          { type: 'agent_task.started' },
          { type: 'agent_task.failed' },
        ],
      }
    }
    const progressEvents = Array.isArray(childResult.events)
      ? childResult.events
      : []
    for (const event of progressEvents) {
      await this.store.recordEvent({
        teamId: team._id,
        taskId: task._id,
        sessionId: input.rootSessionId || input.sessionId,
        type: event.type,
        payload: event.payload || {},
      })
    }
    const childStatus = normalizeChildStatus(childResult.status)
    const resultPayload = {
      status: childStatus,
      summary: childResult.summary || '',
      findings: childResult.findings || [],
      proposedEdits: childResult.proposedEdits || [],
      artifacts: childResult.artifacts || [],
      evidenceRefs: childResult.evidenceRefs || [],
      unresolvedQuestions: childResult.unresolvedQuestions || [],
      confidence: childResult.confidence ?? null,
      nextActions: childResult.nextActions || [],
    }
    if (childStatus !== 'completed') {
      return this.persistFailedTaskResult({
        input,
        team,
        task,
        childSession,
        childStatus,
        capability,
        allowedToolNames,
        progressEvents,
        resultPayload,
        usage: childResult.usage || {},
        error: childResult.summary || `${capability.name} returned ${childStatus}`,
      })
    }
    let normalizedResult
    try {
      normalizedResult = normalizeAgentTaskResult(resultPayload)
    } catch (error) {
      return this.persistFailedTaskResult({
        input,
        team,
        task,
        childSession,
        childStatus: 'failed',
        capability,
        allowedToolNames,
        progressEvents,
        resultPayload: {
          ...resultPayload,
          status: 'failed',
          summary: error.message || resultPayload.summary,
          findings: [],
        },
        usage: childResult.usage || {},
        error,
      })
    }
    const resultDoc = await this.store.completeTask({
      teamId: team._id,
      taskId: task._id,
      result: normalizedResult,
      usage: childResult.usage || {},
    })
    if (!resultDoc) {
      await this.store.recordEvent({
        teamId: team._id,
        taskId: task._id,
        sessionId: input.rootSessionId || input.sessionId,
        type: 'agent_task.cancelled',
        payload: {
          reason: 'task was cancelled before completion was persisted',
        },
      })
      return {
        taskId: task._id.toString(),
        childSessionId: childSession._id.toString(),
        status: 'cancelled',
        capabilityName: capability.name,
        allowedToolNames,
        result: null,
        events: [
          { type: 'agent_task.queued' },
          { type: 'agent_task.started' },
          ...progressEvents.map(event => ({ type: event.type })),
          { type: 'agent_task.cancelled' },
        ],
      }
    }
    await this.store.recordEvent({
      teamId: team._id,
      taskId: task._id,
      sessionId: input.rootSessionId || input.sessionId,
      type: 'agent_task.completed',
      payload: {
        resultId: resultDoc._id.toString(),
        summary: resultDoc.summary,
      },
    })

    return {
      taskId: task._id.toString(),
      childSessionId: childSession._id.toString(),
      status: 'completed',
      capabilityName: capability.name,
      allowedToolNames,
      result: {
        id: resultDoc._id.toString(),
        summary: resultDoc.summary,
        findings: resultDoc.findings,
        proposedEdits: resultDoc.proposedEdits,
        artifacts: resultDoc.artifacts,
        evidenceRefs: resultDoc.evidenceRefs,
        confidence: resultDoc.confidence,
      },
      events: [
        { type: 'agent_task.queued' },
        { type: 'agent_task.started' },
        ...progressEvents.map(event => ({ type: event.type })),
        { type: 'agent_task.completed' },
      ],
    }
  }

  async persistFailedTaskResult({
    input,
    team,
    task,
    childSession,
    childStatus,
    capability,
    allowedToolNames,
    progressEvents = [],
    resultPayload,
    usage,
    error,
  }) {
    const resultDoc = await this.store.failTask?.({
      teamId: team._id,
      taskId: task._id,
      status: childStatus,
      error,
      result: resultPayload,
      usage,
    })
    await this.store.recordEvent({
      teamId: team._id,
      taskId: task._id,
      sessionId: input.rootSessionId || input.sessionId,
      type: childStatus === 'timeout' ? 'agent_task.timeout' : 'agent_task.failed',
      payload: {
        resultId: resultDoc?._id?.toString?.() || null,
        summary: resultDoc?.summary || resultPayload.summary || '',
      },
    })
    return {
      taskId: task._id.toString(),
      childSessionId: childSession._id.toString(),
      status: childStatus,
      capabilityName: capability.name,
      allowedToolNames,
      result: resultDoc
        ? {
            id: resultDoc._id.toString(),
            summary: resultDoc.summary,
            findings: resultDoc.findings,
            proposedEdits: resultDoc.proposedEdits,
            artifacts: resultDoc.artifacts,
            evidenceRefs: resultDoc.evidenceRefs,
            confidence: resultDoc.confidence,
          }
        : null,
      error: sanitizeError(error),
      events: [
        { type: 'agent_task.queued' },
        { type: 'agent_task.started' },
        ...progressEvents.map(event => ({ type: event.type })),
        { type: childStatus === 'timeout' ? 'agent_task.timeout' : 'agent_task.failed' },
      ],
    }
  }

  async runWorkflowGraph(input = {}) {
    const graphRunner = this.graphRunner || new AgentGraphRunner({
      store: this.store,
      taskRunner: nodeInput => this.runGraphTask({
        ...input,
        ...nodeInput,
      }),
    })
    return graphRunner.run({
      team: input.team,
      graph: input.graph,
      sessionId: input.rootSessionId || input.sessionId,
      context: input,
    })
  }

  async runGraphTask(input = {}) {
    if (input.node.kind === 'reducer') {
      return this.runReducerNode(input)
    }
    if (input.node.kind === 'critic') {
      return this.runCriticNode(input)
    }
    const taskSpec = {
      ...input.node.taskSpec,
      input: {
        ...(input.node.taskSpec?.input || {}),
        graphInputs: input.inputs || [],
      },
    }
    return this.runTaskInTeam({
      ...input,
      taskSpec,
    })
  }

  async runReducerNode(input = {}) {
    const reducerResult = this.resultReducer.reduce({
      reviewerResults: flattenGraphInputs(input.inputs),
    })
    return this.persistSyntheticGraphTask({
      ...input,
      result: reducerResult,
    })
  }

  async runCriticNode(input = {}) {
    const reducerResult = firstGraphResult(input.inputs)
    const criticResult = this.resultReducer.criticReview(reducerResult?.result || {
      summary: 'No reducer result was available.',
      findings: [],
    })
    const finalReport = this.resultReducer.renderFinalReport(criticResult)
    return this.persistSyntheticGraphTask({
      ...input,
      result: {
        ...criticResult,
        summary: finalReport,
        artifacts: [
          ...(criticResult.artifacts || []),
          {
            type: 'deep-review-report',
            title: 'Deep Review Report',
            content: finalReport,
          },
        ],
      },
    })
  }

  async persistSyntheticGraphTask(input = {}) {
    const taskSpec = {
      ...input.node.taskSpec,
      input: {
        ...(input.node.taskSpec?.input || {}),
        graphInputs: input.inputs || [],
      },
    }
    const task = await this.store.createTaskFromSpec({
      teamId: input.team._id,
      rootSessionId: input.rootSessionId || input.sessionId,
      spec: taskSpec,
    })
    await this.store.recordEvent({
      teamId: input.team._id,
      taskId: task._id,
      sessionId: input.rootSessionId || input.sessionId,
      type: 'agent_task.queued',
      payload: {
        capabilityName: task.agentName,
        objective: task.objective,
      },
    })
    await this.store.markTaskRunning({
      taskId: task._id,
      childSessionId: null,
      toolCallId: input.toolCallId || null,
    })
    await this.store.recordEvent({
      teamId: input.team._id,
      taskId: task._id,
      sessionId: input.rootSessionId || input.sessionId,
      type: 'agent_task.started',
      payload: {
        synthetic: true,
        nodeKind: input.node.kind,
      },
    })
    const normalizedResult = normalizeAgentTaskResult(input.result)
    const resultDoc = await this.store.completeTask({
      teamId: input.team._id,
      taskId: task._id,
      result: normalizedResult,
      usage: { synthetic: true },
    })
    if (!resultDoc) {
      await this.store.recordEvent({
        teamId: input.team._id,
        taskId: task._id,
        sessionId: input.rootSessionId || input.sessionId,
        type: 'agent_task.cancelled',
        payload: {
          reason: 'synthetic task was cancelled before completion was persisted',
        },
      })
      return {
        taskId: task._id.toString(),
        childSessionId: null,
        status: 'cancelled',
        capabilityName: task.agentName,
        allowedToolNames: [],
        result: null,
        events: [
          { type: 'agent_task.queued' },
          { type: 'agent_task.started' },
          { type: 'agent_task.cancelled' },
        ],
      }
    }
    await this.store.recordEvent({
      teamId: input.team._id,
      taskId: task._id,
      sessionId: input.rootSessionId || input.sessionId,
      type: 'agent_task.completed',
      payload: {
        resultId: resultDoc._id.toString(),
        summary: resultDoc.summary,
      },
    })
    return {
      taskId: task._id.toString(),
      childSessionId: null,
      status: 'completed',
      capabilityName: task.agentName,
      allowedToolNames: [],
      result: {
        id: resultDoc._id.toString(),
        summary: resultDoc.summary,
        findings: resultDoc.findings,
        proposedEdits: resultDoc.proposedEdits,
        artifacts: resultDoc.artifacts,
        evidenceRefs: resultDoc.evidenceRefs,
        confidence: resultDoc.confidence,
      },
      events: [
        { type: 'agent_task.queued' },
        { type: 'agent_task.started' },
        { type: 'agent_task.completed' },
      ],
    }
  }

  async ensureCapabilityRegistry(input = {}) {
    if (
      this.skillRegistry &&
      Array.isArray(input.activatedSkillNames) &&
      input.activatedSkillNames.length > 0
    ) {
      const scopedRegistry = new AgentCapabilityRegistry({
        definitions: this.baseDefinitions,
        skillRegistry: this.skillRegistry,
        activatedSkillNames: input.activatedSkillNames,
      })
      await scopedRegistry.loadAll()
      return scopedRegistry
    }
    if (this.capabilityRegistry.get?.('content-reviewer')) {
      return this.capabilityRegistry
    }
    if (typeof this.capabilityRegistry.loadAll === 'function') {
      await this.capabilityRegistry.loadAll()
    }
    return this.capabilityRegistry
  }

  async createChildSession(input) {
    if (!this.agentController?.createChildSession) {
      throw new Error('AgentTeamOrchestrator requires agentController.createChildSession')
    }
    return this.agentController.createChildSession(input)
  }

  async runChildTask(input) {
    if (typeof this.childRunner === 'function') {
      return this.childRunner(input)
    }
    return this.childRunner.run(input)
  }
}

function normalizeTaskPolicy(policy = {}) {
  const normalized = { ...policy }
  if (Array.isArray(normalized.tools)) {
    normalized.tools = normalized.tools.filter(Boolean)
  }
  return normalized
}

function summarizePolicy(policy) {
  return {
    tools: policy.tools,
    fileGlobs: policy.fileGlobs,
    writeGlobs: policy.writeGlobs,
    network: policy.network,
    maxDepth: policy.maxDepth,
    maxParallelTasks: policy.maxParallelTasks,
    maxToolCalls: policy.maxToolCalls,
    allowSpawn: policy.allowSpawn,
    allowHandoff: policy.allowHandoff,
  }
}

function serializeStartedTeamEvent(team, input = {}) {
  return {
    type: 'agent_team.started',
    teamId: team._id.toString(),
    workflowType: team.workflowType,
    mode: team.mode,
    status: team.status,
    sessionId:
      (input.rootSessionId || input.sessionId)?.toString?.() ||
      input.rootSessionId ||
      input.sessionId,
  }
}

function flattenGraphInputs(inputs = []) {
  const flattened = []
  for (const input of inputs) {
    const result = input.result
    if (Array.isArray(result?.results)) {
      for (const childResult of result.results) {
        flattened.push(childResult)
      }
    } else if (result) {
      flattened.push(result)
    }
  }
  return flattened
}

function firstGraphResult(inputs = []) {
  for (const input of inputs) {
    if (input.result) return input.result
  }
  return null
}

function normalizeChildStatus(status) {
  if (status === 'failed') return 'failed'
  if (status === 'timeout') return 'timeout'
  return 'completed'
}

function taskSpecFromTask(task) {
  if (!task) return null
  return {
    capabilityName: task.agentName,
    capabilityVersion: task.agentVersion,
    mode: task.mode,
    objective: task.objective,
    acceptanceCriteria: task.acceptanceCriteria || [],
    input: task.input || {},
    outputSchema: task.outputSchema || { type: 'object' },
    contextPolicy: {},
    policy: task.policy || {},
    dependencies: task.dependencies || [],
    priority: task.priority || 0,
    timeoutMs: task.timeoutMs || undefined,
    retryPolicy: task.retryPolicy || {},
  }
}

function sanitizeError(error) {
  return {
    message: String(error?.message || error || 'Unknown error').slice(0, 1000),
    code: typeof error?.code === 'string' ? error.code.slice(0, 100) : null,
  }
}

export default AgentTeamOrchestrator
