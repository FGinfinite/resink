import { z } from 'zod'
import logger from '@overleaf/logger'
import settings from '@overleaf/settings'
import { Tool, ToolResult } from './Tool.js'
import { AgentLoop } from '../agent/AgentLoop.js'
import { ContextManager } from '../agent/ContextManager.js'
import { buildToolRegistry } from './ToolPool.js'
import AgentController from '../AgentController.js'

const NON_INTERACTIVE_RULES = `\n\nImportant rules:\n- You are running in non-interactive mode: do not ask the user questions, use the available context to complete the task.\n- Only use tools when you need to retrieve information or make modifications.\n- When the task is complete, provide the final result text directly (do not call tools), then stop.`

const delegateTaskSchema = z.object({
  task: z
    .string()
    .describe('Detailed description and expected output format of the sub-task'),
  agent: z
    .string()
    .describe('Sub-agent type name (specified by the skill instructions)'),
})

/**
 * Tool for delegating sub-tasks to specialized sub-agents.
 * Sub-agents run in their own AgentLoop with independent child sessions.
 * Events are streamed back via AsyncGenerator (yield) for real-time progress.
 * Multiple delegate_task calls in the same turn execute sequentially.
 */
export class DelegateTaskTool extends Tool {
  constructor(agentTypeRegistry) {
    super({
      name: 'delegate_task',
      description:
        'Delegate a sub-task to a specialized sub-agent for execution. The sub-agent has its own conversation loop and can read documents and use tools across multiple turns. ' +
        'The skill instructions loaded via activate_skill will tell you the available sub-agent types. ' +
        'Multiple delegate_task calls in the same turn execute sequentially.',
      parameters: delegateTaskSchema,
    })
    this.agentTypeRegistry = agentTypeRegistry
  }

  /**
   * Execute the delegate_task tool as an AsyncGenerator (streaming tool).
   * Yields sub-events from the child AgentLoop for real-time progress display.
   *
   * @param {object} args - Validated arguments
   * @param {object} context - Execution context
   * @returns {AsyncGenerator} - Yields sub-events, final yield is ToolResult with _isToolResult flag
   */
  async *execute({ task, agent: agentName }, context) {
    const agentType = this.agentTypeRegistry.get(agentName)
    if (!agentType) {
      const available = this.agentTypeRegistry
        .getAll()
        .map(a => a.name)
        .join(', ')
      const result = ToolResult.error(
        `Unknown agent type "${agentName}". Available: ${available || '(none)'}`
      )
      result._isToolResult = true
      yield result
      return
    }

    // RunBudget delegation check (atomic: check and consume in one step)
    const runBudget = context.runBudget
    if (runBudget) {
      if (!runBudget.tryConsumeDelegation(context.currentDepth || 0)) {
        const result = ToolResult.error(
          `Delegation limit reached (maxDepth=${runBudget.maxDepth}, delegations=${runBudget.delegations}/${runBudget.maxDelegations}). ` +
          'Please complete the remaining work directly without delegating to sub-agents.'
        )
        result._isToolResult = true
        yield result
        return
      }
    }

    logger.info(
      { agent: agentName, projectId: context.projectId },
      'Delegating task to sub-agent (streaming)'
    )

    // 1. Create child session
    let childSession
    try {
      childSession = await AgentController.createChildSession({
        parentId: context.sessionId,
        projectId: context.projectId,
        userId: context.userId,
        agentName,
      })
    } catch (error) {
      logger.error({ err: error, agent: agentName }, 'Failed to create child session')
      const result = ToolResult.error(`Failed to create child session: ${error.message}`, { fatal: true })
      result._isToolResult = true
      yield result
      return
    }

    const childSessionId = childSession._id.toString()

    // Emit metadata event so the frontend can associate this child session
    // with the running delegate_task tool call during streaming.
    yield { type: 'child_session_init', childSessionId, agentName }

    // 2. Build child tool registry
    const subToolRegistry = buildToolRegistry(agentType.tools)

    // 4. Create child AgentLoop
    // Combine parent stopSignal and per-tool abort signal so that either
    // a user-initiated stop OR a tool timeout will terminate the child loop.
    const stopSignals = [context.stopSignal, context.toolAbortSignal].filter(Boolean)
    const combinedStopSignal = stopSignals.length > 1
      ? AbortSignal.any(stopSignals)
      : stopSignals[0] || undefined

    const reviewConfig = settings.review || {}
    const childLoop = new AgentLoop({
      sessionId: childSessionId,
      projectId: context.projectId,
      llmAdapter: context.adapters?.llm || context.llmAdapter,
      toolRegistry: subToolRegistry,
      contextManager: new ContextManager(),
      adapters: context.adapters,
      userId: context.userId,
      // Share the confirmation channel so child edits can be confirmed via main session
      confirmationChannel: context.confirmationChannel || null,
      rootSessionId: context.rootSessionId || context.sessionId,
      maxTurns: agentType.maxTurns || 5,
      maxToolCalls: (agentType.maxTurns || 5) * 3,
      temperature: reviewConfig.subAgentTemperature ?? undefined,
      maxTokens: reviewConfig.subAgentMaxTokens ?? undefined,
      // Cascade parent stop signal — when parent stops, child stops too
      // Also cascade toolAbortSignal so tool timeout terminates the child
      stopSignal: combinedStopSignal,
      // Nudge sub-agent for final result if it returns empty text
      nudgeOnEmpty: true,
      // Shared RunBudget + depth increment
      runBudget: runBudget || null,
      depth: (context.currentDepth || 0) + 1,
    })

    // 5. Override context to use agent type's system prompt
    const systemPrompt = agentType.body + NON_INTERACTIVE_RULES

    // Build messages directly instead of using contextManager.buildMessages
    // since child session has no history to load
    const childMessages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: task },
    ]

    const tools = subToolRegistry.getTools()
    const childSessionState = { readDocuments: new Map(), turns: 0, toolCalls: 0 }
    const childChangeHistory = []

    try {
      let finalContent = ''
      let allText = ''           // Cumulative across all turns (never reset) — last-resort fallback
      let currentTurnText = ''   // Current turn only — preferred over allText

      // 6. Run child AgentLoop and yield events with childSessionId tag
      for await (const event of childLoop._agentLoop(childMessages, tools, childSessionState, childChangeHistory)) {
        if (event.type === 'text') {
          allText += event.content
          currentTurnText += event.content
        }

        // When the child loop emits 'done', prefer done.content (the final
        // LLM turn), then currentTurnText (last turn accumulated here),
        // then allText (everything the sub-agent ever said).
        if (event.type === 'done') {
          finalContent = event.content || currentTurnText || allText
        }

        // Reset per-turn accumulator when tool execution starts (new turn)
        if (event.type === 'tool_call') {
          currentTurnText = ''
        }

        // Tag events with the child session ID for frontend routing.
        // Preserve existing sessionId for nested delegate_task (grandchild sessions).
        yield { ...event, sessionId: event.sessionId || childSessionId }
      }

      // Fallback: if no 'done' event was received, use accumulated text
      if (!finalContent) {
        finalContent = currentTurnText || allText
      }

      // 7. Mark child session as completed
      await AgentController.updateSessionStatus(childSessionId, 'completed')

      const result = ToolResult.success(finalContent || '(Sub-agent returned no text)', {
        agent: agentName,
        childSessionId,
      })
      result._isToolResult = true
      yield result
    } catch (error) {
      logger.error(
        { err: error, agent: agentName, childSessionId },
        'Sub-agent execution failed'
      )

      // Mark child session as errored
      try {
        await AgentController.updateSessionStatus(childSessionId, 'error')
      } catch {
        // Best effort
      }

      const result = ToolResult.error(
        `Sub-agent "${agentName}" execution failed: ${error.message}`,
        { agent: agentName, childSessionId, fatal: true }
      )
      result._isToolResult = true
      yield result
    }
  }
}

export default DelegateTaskTool
