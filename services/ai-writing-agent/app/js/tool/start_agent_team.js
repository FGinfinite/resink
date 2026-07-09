import { z } from 'zod'

import { Tool, ToolResult } from './Tool.js'
import { AgentTeamOrchestrator } from '../agent-team/AgentTeamOrchestrator.js'
import { acquireDelegationBudget } from './agent_team_budget.js'

const fileInputSchema = z.object({
  path: z.string(),
  mode: z.enum(['full', 'excerpt', 'summary', 'metadata']).optional(),
  reason: z.string().optional(),
}).passthrough()

const startAgentTeamSchema = z.object({
  workflowType: z.enum(['deep-review']),
  userRequest: z.string().optional(),
  targetVenue: z.string().optional(),
  files: z.array(fileInputSchema).optional().default([]),
})

export class StartAgentTeamTool extends Tool {
  constructor(options = {}) {
    super({
      name: 'start_agent_team',
      description:
        'Start a deterministic agent-team workflow. Use workflowType="deep-review" for full-paper review with parallel reviewers, reducer, and critic.',
      parameters: startAgentTeamSchema,
    })
    this.orchestrator = options.orchestrator || new AgentTeamOrchestrator(options)
  }

  toOpenAIFormat() {
    return {
      type: 'function',
      function: {
        name: this.name,
        description: this.description,
        parameters: START_AGENT_TEAM_JSON_SCHEMA,
      },
    }
  }

  async *execute(args, context = {}) {
    const budgetPermit = acquireDelegationBudget(
      context.runBudget,
      context.currentDepth,
      'Agent team'
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
      extendTeamRunBudget(context.runBudget)
      let resolveStarted
      const startedPromise = new Promise(resolve => {
        resolveStarted = resolve
      })
      const resultPromise = this.orchestrator.startAgentTeam({
        workflowType: args.workflowType,
        userRequest: args.userRequest || context.userMessage || 'Run the workflow.',
        targetVenue: args.targetVenue || null,
        files: args.files || [],
        sessionId: context.sessionId,
        rootSessionId: context.rootSessionId || context.sessionId,
        projectId: context.projectId,
        userId: context.userId,
        activeChangeSetId: getActiveChangeSetId(context.sessionState),
        parentPolicy: buildParentPolicy(context),
        adapters: context.adapters,
        llmAdapter: context.llmAdapter,
        sessionState: context.sessionState,
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
      const toolResult = ToolResult.success(formatAgentTeamOutput(result), result)
      toolResult._isToolResult = true
      yield toolResult
    } catch (error) {
      const toolResult = ToolResult.error(
        `Failed to start agent team workflow: ${error.message}`
      )
      toolResult._isToolResult = true
      yield toolResult
    } finally {
      budgetPermit.release()
    }
  }
}

function extendTeamRunBudget(runBudget) {
  if (!runBudget) return
  runBudget.maxLLMCalls = Math.max(runBudget.maxLLMCalls || 0, 80)
  runBudget.maxToolCalls = Math.max(runBudget.maxToolCalls || 0, 160)
  runBudget.maxTotalTokens = Math.max(runBudget.maxTotalTokens || 0, 400_000)
}

const START_AGENT_TEAM_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['workflowType'],
  properties: {
    workflowType: {
      type: 'string',
      enum: ['deep-review'],
      description: 'Workflow to run. Use deep-review for full-paper review.',
    },
    userRequest: {
      type: 'string',
      description: 'User request or review instructions.',
    },
    targetVenue: {
      type: 'string',
      description: 'Optional target venue for review calibration.',
    },
    files: {
      type: 'array',
      description: 'Optional files to prioritize for context.',
      items: {
        type: 'object',
        additionalProperties: true,
        properties: {
          path: { type: 'string' },
          mode: {
            type: 'string',
            enum: ['full', 'excerpt', 'summary', 'metadata'],
          },
          reason: { type: 'string' },
        },
      },
    },
  },
}

function getActiveChangeSetId(sessionState = {}) {
  const changeSet = sessionState?.activeChangeSet
  return changeSet?.id || changeSet?._id?.toString?.() || changeSet?._id || null
}

function buildParentPolicy(context = {}) {
  const allowedToolNames = Array.isArray(context.allowedToolNames)
    ? context.allowedToolNames
    : null
  return {
    tools: allowedToolNames || [
      'read_document',
      'list_files',
      'search_project',
      'edit_document',
      'compile_latex',
      'run_command',
      'write_workspace_file',
    ],
    fileGlobs: ['**/*'],
    writeGlobs: context.autoAccept ? ['**/*'] : [],
    network: 'deny',
    pythonEnvironments: [],
    modelTiers: ['standard'],
    maxDepth: Number.isSafeInteger(context.currentDepth)
      ? Math.max(0, 1 - context.currentDepth)
      : 1,
    maxParallelTasks: 3,
    maxToolCalls: 24,
    allowSpawn: false,
    allowHandoff: false,
  }
}

function formatAgentTeamOutput(result) {
  return [
    `Agent team workflow completed: ${result.workflowType || 'workflow'}`,
    '',
    `Team ID: ${result.teamId}`,
    `Status: ${result.status}`,
    result.result?.summary ? `Summary: ${result.result.summary}` : '',
  ].filter(Boolean).join('\n')
}

export default StartAgentTeamTool
