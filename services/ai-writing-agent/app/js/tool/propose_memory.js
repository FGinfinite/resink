import { z } from 'zod'
import { Tool, ToolResult } from './Tool.js'
import { MemorySuggestionService } from '../agent-context/MemorySuggestionService.js'

const MAX_PROPOSED_MEMORY_CHARS = 2000

const proposeMemorySchema = z.object({
  proposedContent: z
    .string()
    .min(1)
    .max(MAX_PROPOSED_MEMORY_CHARS)
    .describe('Concise durable preference or fact to ask the user to save.'),
  scope: z
    .enum(['global', 'project'])
    .default('global')
    .describe('Use global for user-wide preferences, project for this Overleaf project.'),
  reason: z
    .string()
    .min(1)
    .max(1000)
    .describe('Why this should be proposed as a durable memory.'),
})

export class ProposeMemoryTool extends Tool {
  constructor(options = {}) {
    super({
      name: 'propose_memory',
      description: `Propose a durable user memory for explicit user confirmation.
Use this only when the user states a stable preference, workflow rule, or project convention worth remembering.
This creates a pending suggestion; it does not save a memory until the user accepts it.`,
      parameters: proposeMemorySchema,
    })
    this.suggestionService =
      options.suggestionService || new MemorySuggestionService()
  }

  async execute(args, context = {}) {
    if ((context.currentDepth || 0) > 0 || context.parentId) {
      return ToolResult.error(
        'Memory proposal blocked: child agents cannot propose durable memories.',
        { code: 'MEMORY_PROPOSAL_POLICY_DENIED' }
      )
    }
    if (!context.userId || !context.sessionId) {
      return ToolResult.error(
        'Memory proposal requires a user-owned root session.',
        { code: 'MEMORY_PROPOSAL_CONTEXT_REQUIRED' }
      )
    }
    if (args.scope === 'project' && !context.projectId) {
      return ToolResult.error(
        'Project-scoped memory proposal requires a project id.',
        { code: 'MEMORY_PROPOSAL_PROJECT_REQUIRED' }
      )
    }

    const suggestion = await this.suggestionService.createSuggestion({
      userId: context.userId,
      projectId: args.scope === 'project' ? context.projectId : null,
      sessionId: context.sessionId,
      messageId: context.messageId || null,
      proposedContent: args.proposedContent,
      scope: args.scope,
      reason: args.reason,
    })

    return ToolResult.success(
      'Created a pending memory suggestion for user review.',
      {
        suggestionId: suggestion._id?.toString?.() || suggestion._id,
        scope: suggestion.scope,
        proposedContent: suggestion.proposedContent,
        reason: suggestion.reason,
        expiresAt: suggestion.expiresAt,
      }
    )
  }
}

export default ProposeMemoryTool
