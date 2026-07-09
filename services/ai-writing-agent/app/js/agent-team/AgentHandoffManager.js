import { ObjectId, db as defaultDb } from '../mongodb.js'
import { AgentCapabilityRegistry } from './AgentCapabilityRegistry.js'
import { BUILT_IN_AGENT_CAPABILITIES } from './capabilities/builtInCapabilities.js'
import { AgentPolicyEngine, AgentPolicyError } from './AgentPolicyEngine.js'
import { AgentTaskStore } from './AgentTaskStore.js'

export class AgentHandoffManager {
  constructor(options = {}) {
    this.store = options.store || new AgentTaskStore()
    this.sessionsCollection = options.sessionsCollection || defaultDb.aiSessions
    this.capabilityRegistry = options.capabilityRegistry || new AgentCapabilityRegistry({
      definitions: BUILT_IN_AGENT_CAPABILITIES,
    })
    this.policyEngine = options.policyEngine || new AgentPolicyEngine()
    this.agentController = options.agentController || null
    this.now = options.now || (() => new Date())
  }

  async handoffToAgent(input = {}) {
    const capability = await this.getHandoffCapability(input.capabilityName)
    const rootSessionId = input.rootSessionId || input.sessionId
    const policy = this.policyEngine.computeChildPolicy({
      parentPolicy: input.parentPolicy,
      capabilityPolicy: capability.defaultPolicy,
      taskPolicy: {
        ...(input.policy || {}),
        allowHandoff: true,
      },
    })
    const requestedToolNames =
      input.policy?.tools || capability.defaultPolicy?.tools || []
    assertRequestedToolsAllowed(requestedToolNames, input.parentPolicy?.tools || [])
    const allowedToolNames = policy.tools
    const team = await this.store.createTeamRun({
      projectId: input.projectId,
      userId: input.userId,
      rootSessionId,
      workflowType: workflowTypeForCapability(capability.name),
      mode: 'handoff',
      startedBy: input.startedBy || 'model',
      policySummary: summarizePolicy(policy),
    })
    const task = await this.store.createTaskFromSpec({
      teamId: team._id,
      rootSessionId,
      spec: {
        capabilityName: capability.name,
        capabilityVersion: capability.version,
        mode: 'handoff',
        objective: input.objective || capability.description,
        acceptanceCriteria: input.acceptanceCriteria || [
          'Complete the specialist task or return control safely.',
        ],
        input: input.input || {},
        outputSchema: capability.outputSchema || { type: 'object' },
        contextPolicy: {
          ...(capability.contextPolicy || {}),
          ...(input.contextPolicy || {}),
        },
        policy,
        timeoutMs: input.timeoutMs || 120000,
      },
    })
    await this.store.recordEvent({
      teamId: team._id,
      taskId: task._id,
      sessionId: rootSessionId,
      type: 'agent_handoff.requested',
      payload: {
        capabilityName: capability.name,
        objective: task.objective,
      },
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
    const activeHandoff = {
      teamId: team._id.toString(),
      taskId: task._id.toString(),
      childSessionId: childSession._id.toString(),
      capabilityName: capability.name,
      status: 'active',
      startedAt: this.now(),
      allowedToolNames,
    }
    await this.sessionsCollection.updateOne(
      {
        _id: normalizeObjectId(rootSessionId, 'rootSessionId'),
        projectId: input.projectId,
        userId: input.userId,
      },
      {
        $set: {
          activeHandoff,
          updatedAt: this.now(),
        },
      }
    )
    await this.store.recordEvent({
      teamId: team._id,
      taskId: task._id,
      sessionId: rootSessionId,
      type: 'agent_handoff.accepted',
      payload: activeHandoff,
    })
    return {
      status: 'active',
      teamId: team._id.toString(),
      taskId: task._id.toString(),
      childSessionId: childSession._id.toString(),
      capabilityName: capability.name,
      allowedToolNames,
    }
  }

  async returnFromHandoff(input = {}) {
    const rootSessionId = input.rootSessionId || input.sessionId
    const teamId = normalizeObjectId(input.teamId, 'teamId')
    const taskId = normalizeObjectId(input.taskId, 'taskId')
    if (input.completeTask !== false) {
      try {
        await this.store.completeTask({
          teamId,
          taskId,
          result: {
            status: 'completed',
            summary: input.summary || `Handoff returned: ${input.reason || 'completed'}`,
            findings: [],
            proposedEdits: [],
            artifacts: [],
            evidenceRefs: [],
            unresolvedQuestions: [],
            confidence: null,
            nextActions: [],
          },
          usage: { handoffReturn: true },
        })
      } catch (error) {
        if (!input.allowMissingTask) throw error
      }
    }
    await this.sessionsCollection.updateOne(
      {
        _id: normalizeObjectId(rootSessionId, 'rootSessionId'),
        projectId: input.projectId,
        userId: input.userId,
      },
      {
        $unset: { activeHandoff: '' },
        $set: { updatedAt: this.now() },
      }
    )
    await this.store.recordEvent({
      teamId,
      taskId,
      sessionId: rootSessionId,
      type: 'agent_handoff.completed',
      payload: {
        reason: input.reason || 'completed',
        summary: input.summary || null,
      },
    })
    return {
      status: 'returned',
      teamId: teamId.toString(),
      taskId: taskId.toString(),
      reason: input.reason || 'completed',
    }
  }

  async getHandoffCapability(name) {
    if (typeof this.capabilityRegistry.loadAll === 'function') {
      await this.capabilityRegistry.loadAll()
    }
    const capability = this.capabilityRegistry.get(name)
    if (!capability) throw new Error(`Unknown handoff capability: ${name}`)
    if (capability.role !== 'handoff-specialist') {
      throw new Error(`Capability is not a handoff specialist: ${name}`)
    }
    return capability
  }

  async createChildSession(input) {
    if (!this.agentController?.createChildSession) {
      throw new Error('AgentHandoffManager requires agentController.createChildSession')
    }
    return this.agentController.createChildSession(input)
  }
}

function workflowTypeForCapability(name) {
  if (name === 'compile-fixer') return 'compile-fix'
  if (name === 'citation-assistant') return 'citation-audit'
  if (name === 'writing-editor') return 'writing-edit'
  return 'custom'
}

function normalizeObjectId(value, field) {
  if (value instanceof ObjectId) return value
  if (typeof value === 'string' && ObjectId.isValid(value)) return new ObjectId(value)
  throw new Error(`${field} must be a valid ObjectId`)
}

function summarizePolicy(policy) {
  return {
    tools: policy.tools,
    fileGlobs: policy.fileGlobs,
    writeGlobs: policy.writeGlobs,
    network: policy.network,
    maxToolCalls: policy.maxToolCalls,
    allowHandoff: policy.allowHandoff,
  }
}

function assertRequestedToolsAllowed(requestedTools, parentTools) {
  const allowed = new Set(parentTools)
  const denied = requestedTools.filter(tool => !allowed.has(tool))
  if (denied.length > 0) {
    throw new AgentPolicyError(
      `Handoff requested tools outside parent policy: ${denied.join(', ')}`,
      { deniedTools: denied }
    )
  }
}

export default AgentHandoffManager
