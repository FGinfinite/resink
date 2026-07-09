import { z } from 'zod'

import { Tool, ToolResult } from './Tool.js'
import { AgentHandoffManager } from '../agent-team/AgentHandoffManager.js'

const handoffToAgentSchema = z.object({
  capabilityName: z.enum(['compile-fixer', 'citation-assistant', 'writing-editor']),
  objective: z.string(),
  acceptanceCriteria: z.array(z.string()).optional().default([]),
  input: z.object({}).passthrough().optional().default({}),
  policy: z.object({}).passthrough().optional().default({}),
  timeoutMs: z.number().int().min(1000).max(3600000).optional(),
})

const returnFromHandoffSchema = z.object({
  teamId: z.string(),
  taskId: z.string(),
  reason: z.enum(['completed', 'cancelled', 'timeout', 'policy-denial', 'specialist-return']).default('completed'),
  summary: z.string().optional(),
})

export class HandoffToAgentTool extends Tool {
  constructor(options = {}) {
    super({
      name: 'handoff_to_agent',
      description:
        'Temporarily hand active control to a specialist agent such as compile-fixer, citation-assistant, or writing-editor under the current policy.',
      parameters: handoffToAgentSchema,
    })
    this.handoffManager =
      options.handoffManager || new AgentHandoffManager(options)
  }

  async execute(args, context = {}) {
    try {
      const result = await this.handoffManager.handoffToAgent({
        ...args,
        sessionId: context.sessionId,
        rootSessionId: context.rootSessionId || context.sessionId,
        projectId: context.projectId,
        userId: context.userId,
        toolCallId: context.toolCallId || null,
        parentPolicy: buildParentPolicy(context),
      })
      return ToolResult.success(formatHandoffOutput(result), result)
    } catch (error) {
      return ToolResult.error(`Failed to hand off to agent: ${error.message}`)
    }
  }
}

export class ReturnFromHandoffTool extends Tool {
  constructor(options = {}) {
    super({
      name: 'return_from_handoff',
      description:
        'Return control from an active specialist handoff back to the root agent.',
      parameters: returnFromHandoffSchema,
    })
    this.handoffManager =
      options.handoffManager || new AgentHandoffManager(options)
  }

  async execute(args, context = {}) {
    try {
      const result = await this.handoffManager.returnFromHandoff({
        ...args,
        sessionId: context.sessionId,
        rootSessionId: context.rootSessionId || context.sessionId,
        projectId: context.projectId,
        userId: context.userId,
      })
      return ToolResult.success(formatReturnOutput(result), result)
    } catch (error) {
      return ToolResult.error(`Failed to return from handoff: ${error.message}`)
    }
  }
}

function buildParentPolicy(context = {}) {
  const allowedToolNames = Array.isArray(context.allowedToolNames)
    ? context.allowedToolNames
    : []
  return {
    tools: allowedToolNames,
    fileGlobs: ['**/*'],
    writeGlobs: context.autoAccept ? ['**/*'] : ['**/*.tex', '**/*.bib'],
    network: 'deny',
    pythonEnvironments: [],
    modelTiers: ['standard'],
    maxDepth: Number.isSafeInteger(context.currentDepth)
      ? Math.max(0, 1 - context.currentDepth)
      : 1,
    maxParallelTasks: 1,
    maxToolCalls: 12,
    allowSpawn: false,
    allowHandoff: true,
  }
}

function formatHandoffOutput(result) {
  return [
    `Handoff active: ${result.capabilityName}`,
    `Team ID: ${result.teamId}`,
    `Task ID: ${result.taskId}`,
    `Child session: ${result.childSessionId}`,
  ].join('\n')
}

function formatReturnOutput(result) {
  return [
    `Handoff returned: ${result.reason}`,
    `Team ID: ${result.teamId}`,
    `Task ID: ${result.taskId}`,
  ].join('\n')
}

export default HandoffToAgentTool
