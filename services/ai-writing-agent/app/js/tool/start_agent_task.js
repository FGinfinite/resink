import { z } from 'zod'
import { Tool, ToolResult } from './Tool.js'
import { AgentTeamOrchestrator } from '../agent-team/AgentTeamOrchestrator.js'
import { acquireDelegationBudget } from './agent_team_budget.js'

const jsonObjectSchema = z.preprocess(value => {
  if (typeof value !== 'string') return value
  const trimmed = value.trim()
  if (!trimmed.startsWith('{')) return value
  try {
    return JSON.parse(trimmed)
  } catch {
    return value
  }
}, z.object({}).passthrough().refine(
  value => value && typeof value === 'object' && !Array.isArray(value),
  'must be an object'
))

const taskInputSchema = jsonObjectSchema.default({})
const outputObjectSchema = jsonObjectSchema.default({ type: 'object' })
const contextPolicySchema = z.object({
  includeParentHistory: z.boolean().optional(),
  includeProjectInstructions: z.boolean().optional(),
  includeMemories: z.boolean().optional(),
  includeSessionSummary: z.boolean().optional(),
  includeRecalledContext: z.boolean().optional(),
  includeActiveChangeSet: z.boolean().optional(),
  defaultFileMode: z.enum(['full', 'excerpt', 'summary', 'metadata']).optional(),
  maxContextTokens: z.number().int().positive().optional(),
  maxMemories: z.number().int().positive().optional(),
  maxMemoryChars: z.number().int().positive().optional(),
  maxSessionSummaryChars: z.number().int().positive().optional(),
  maxRecallItems: z.number().int().positive().optional(),
  maxRecallChars: z.number().int().positive().optional(),
}).passthrough().default({})
const policySchema = z.object({
  tools: z.array(z.string()).optional(),
  fileGlobs: z.array(z.string()).optional(),
  writeGlobs: z.array(z.string()).optional(),
  network: z.enum(['deny', 'package-index-proxy', 'allow']).optional(),
  pythonEnvironments: z.array(z.string()).optional(),
  modelTiers: z.array(z.string()).optional(),
  maxDepth: z.number().int().min(0).optional(),
  maxParallelTasks: z.number().int().positive().optional(),
  maxToolCalls: z.number().int().positive().optional(),
  allowSpawn: z.boolean().optional(),
  allowHandoff: z.boolean().optional(),
}).passthrough().default({})

const startAgentTaskSchema = z.object({
  capabilityName: z.string(),
  capabilityVersion: z.string().optional(),
  mode: z.enum(['tool', 'handoff', 'background', 'workflow-node', 'reducer', 'critic']).default('tool'),
  objective: z.string(),
  acceptanceCriteria: z.array(z.string()).min(1),
  input: taskInputSchema,
  outputSchema: outputObjectSchema,
  contextPolicy: contextPolicySchema,
  policy: policySchema,
  dependencies: z.array(z.string()).optional().default([]),
  priority: z.number().int().min(0).optional().default(0),
  timeoutMs: z.number().int().min(1000).max(3600000).optional(),
  retryPolicy: jsonObjectSchema.optional().default({ maxAttempts: 1, backoffMs: 0 }),
})

export class StartAgentTaskTool extends Tool {
  constructor(options = {}) {
    super({
      name: 'start_agent_task',
      description:
        'Start one structured bounded child agent task through Agent Team Runtime. ' +
        'Start one structured bounded agent task. Provide objective, acceptance criteria, output schema, context policy, and policy constraints.',
      parameters: startAgentTaskSchema,
    })
    this.orchestrator = options.orchestrator || new AgentTeamOrchestrator(options)
  }

  toOpenAIFormat() {
    return {
      type: 'function',
      function: {
        name: this.name,
        description: this.description,
        parameters: START_AGENT_TASK_JSON_SCHEMA,
      },
    }
  }

  async *execute(args, context = {}) {
    const budgetPermit = acquireDelegationBudget(
      context.runBudget,
      context.currentDepth,
      'Agent task'
    )
    if (!budgetPermit.allowed) {
      const toolResult = ToolResult.error(budgetPermit.message, {
        code: 'AGENT_BUDGET_EXHAUSTED',
        reason: budgetPermit.reason,
      })
      toolResult._isToolResult = true
      yield toolResult
      return
    }
    try {
      let resolveStarted
      const startedPromise = new Promise(resolve => {
        resolveStarted = resolve
      })
      const resultPromise = this.orchestrator.startAgentTask({
        sessionId: context.sessionId,
        rootSessionId: context.rootSessionId || context.sessionId,
        projectId: context.projectId,
        userId: context.userId,
        currentDocId: context.currentDocId,
        currentDocPath: context.currentDocPath,
        profile: context.profile,
        model: context.model,
        autoAccept: context.autoAccept === true,
        toolCallId: context.toolCallId || null,
        activeChangeSetId: getActiveChangeSetId(context.sessionState),
        parentPolicy: buildParentPolicy(context),
        taskSpec: args,
        adapters: context.adapters,
        llmAdapter: context.llmAdapter,
        sessionState: context.sessionState,
        activatedSkillNames: context.sessionState?.activatedSkills || [],
        persistentWorkspace: context.persistentWorkspace,
        agentMessageStore: context.agentMessageStore,
        confirmationChannel: context.confirmationChannel,
        stopSignal: context.stopSignal,
        toolAbortSignal: context.toolAbortSignal,
        runBudget: context.runBudget,
        currentDepth: context.currentDepth,
        disablePersistence: context.disablePersistence,
        onTeamStarted: event => resolveStarted(event),
      })
      const startedEvent = await Promise.race([
        startedPromise,
        resultPromise.then(() => null, error => {
          throw error
        }),
      ])
      if (startedEvent) yield startedEvent
      const result = await resultPromise
      const toolResult = ToolResult.success(formatAgentTaskOutput(result), {
        ...result,
      })
      toolResult._isToolResult = true
      yield toolResult
    } catch (error) {
      if (error.code === 'AGENT_POLICY_DENIED' || error.code === 'AGENT_TASK_SPEC_INVALID') {
        const toolResult = ToolResult.error(`Agent task blocked: ${error.message}`, {
          code: error.code,
          reason: error.info?.reason || null,
          info: error.info || {},
        })
        toolResult._isToolResult = true
        yield toolResult
        return
      }
      throw error
    } finally {
      budgetPermit.release()
    }
  }
}

const START_AGENT_TASK_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['capabilityName', 'objective', 'acceptanceCriteria'],
  properties: {
    capabilityName: {
      type: 'string',
      description: 'Structured child agent capability name, for example content-reviewer, citation-assistant, compile-fixer, or writing-editor.',
    },
    capabilityVersion: {
      type: 'string',
      description: 'Optional semantic version. Omit unless a specific version is required.',
    },
    mode: {
      type: 'string',
      enum: ['tool', 'handoff', 'background', 'workflow-node', 'reducer', 'critic'],
      description: 'Use tool for a bounded child task.',
    },
    objective: {
      type: 'string',
      description: 'Concrete child task objective.',
    },
    acceptanceCriteria: {
      type: 'array',
      minItems: 1,
      items: { type: 'string' },
      description: 'Checklist the child result must satisfy.',
    },
    input: {
      type: 'object',
      additionalProperties: true,
      description: 'Structured input object. Use userRequest and optional files array; do not pass a JSON string.',
      properties: {
        userRequest: { type: 'string' },
        files: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: true,
            properties: {
              path: { type: 'string' },
              mode: { type: 'string', enum: ['full', 'excerpt', 'summary', 'metadata'] },
              content: { type: 'string' },
              reason: { type: 'string' },
            },
          },
        },
      },
    },
    outputSchema: {
      type: 'object',
      additionalProperties: true,
      description: 'JSON schema object for the child result. Use {"type":"object"} when no stricter schema is needed; do not pass a JSON string.',
      properties: {
        type: { type: 'string', enum: ['object'] },
      },
    },
    contextPolicy: {
      type: 'object',
      additionalProperties: true,
      description: 'Optional context policy object; omit unless special context selection is needed.',
      properties: {
        includeParentHistory: { type: 'boolean' },
        includeProjectInstructions: { type: 'boolean' },
        includeMemories: { type: 'boolean' },
        includeSessionSummary: { type: 'boolean' },
        includeRecalledContext: { type: 'boolean' },
        includeActiveChangeSet: { type: 'boolean' },
        defaultFileMode: { type: 'string', enum: ['full', 'excerpt', 'summary', 'metadata'] },
        maxContextTokens: { type: 'number' },
        maxMemories: { type: 'number' },
        maxMemoryChars: { type: 'number' },
        maxSessionSummaryChars: { type: 'number' },
        maxRecallItems: { type: 'number' },
        maxRecallChars: { type: 'number' },
      },
    },
    policy: {
      type: 'object',
      additionalProperties: true,
      description: 'Child policy constraints as an object. Omit fields to inherit capability defaults; do not pass a JSON string.',
      properties: {
        tools: { type: 'array', items: { type: 'string' } },
        fileGlobs: { type: 'array', items: { type: 'string' } },
        writeGlobs: { type: 'array', items: { type: 'string' } },
        network: { type: 'string', enum: ['deny', 'package-index-proxy', 'allow'] },
        pythonEnvironments: { type: 'array', items: { type: 'string' } },
        modelTiers: { type: 'array', items: { type: 'string' } },
        maxDepth: { type: 'number' },
        maxParallelTasks: { type: 'number' },
        maxToolCalls: { type: 'number' },
        allowSpawn: { type: 'boolean' },
        allowHandoff: { type: 'boolean' },
      },
    },
    dependencies: { type: 'array', items: { type: 'string' } },
    priority: { type: 'number' },
    timeoutMs: { type: 'number' },
    retryPolicy: {
      type: 'object',
      additionalProperties: true,
      properties: {
        maxAttempts: { type: 'number' },
        backoffMs: { type: 'number' },
      },
    },
  },
}

function getActiveChangeSetId(sessionState = {}) {
  const changeSet = sessionState.activeChangeSet
  return changeSet?.id || changeSet?._id?.toString?.() || changeSet?._id || null
}

function buildParentPolicy(context = {}) {
  const policy = {
    tools: Array.isArray(context.allowedToolNames)
      ? context.allowedToolNames
      : [],
    fileGlobs: context.agentTeamPolicy?.fileGlobs || ['**/*'],
    network: context.agentTeamPolicy?.network || 'deny',
    pythonEnvironments: context.agentTeamPolicy?.pythonEnvironments || [],
    modelTiers: context.agentTeamPolicy?.modelTiers || ['standard'],
    maxDepth: context.agentTeamPolicy?.maxDepth ?? 1,
    maxParallelTasks: context.agentTeamPolicy?.maxParallelTasks ?? 1,
    maxToolCalls: context.agentTeamPolicy?.maxToolCalls ?? 10,
    allowSpawn: context.agentTeamPolicy?.allowSpawn === true,
    allowHandoff: context.agentTeamPolicy?.allowHandoff === true,
  }
  if (
    context.agentTeamPolicy &&
    Object.prototype.hasOwnProperty.call(context.agentTeamPolicy, 'writeGlobs')
  ) {
    policy.writeGlobs = context.agentTeamPolicy.writeGlobs
  }
  return policy
}

function formatAgentTaskOutput(result) {
  const lines = [
    `Agent task completed: ${result.capabilityName}`,
    `Team: ${result.teamId}`,
    `Task: ${result.taskId}`,
    `Child session: ${result.childSessionId}`,
    `Allowed tools: ${result.allowedToolNames.join(', ') || '(none)'}`,
  ]
  if (result.result?.summary) {
    lines.push('', result.result.summary)
  }
  if (Array.isArray(result.result?.findings) && result.result.findings.length > 0) {
    lines.push('', `Findings: ${result.result.findings.length}`)
  }
  return lines.join('\n')
}

export default StartAgentTaskTool
