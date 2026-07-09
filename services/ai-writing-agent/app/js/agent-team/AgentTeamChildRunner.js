import logger from '@overleaf/logger'
import settings from '@overleaf/settings'

import { createAgentLoopForSession } from '../agent/AgentLoopFactory.js'
import { ContextManager } from '../agent/ContextManager.js'
import { ToolRegistry } from '../tool/ToolRegistry.js'
import { buildToolRegistry } from '../tool/ToolPool.js'
import { ToolResult } from '../tool/Tool.js'
import { AgentCapabilityPromptLoader } from './AgentCapabilityPromptLoader.js'

const NON_INTERACTIVE_RULES = `\n\nImportant rules:\n- You are running in non-interactive mode: do not ask the user questions, use the available context to complete the task.\n- Only use tools when you need to retrieve information or make modifications.\n- When the task is complete, provide the final result text directly (do not call tools), then stop.`

const CHILD_AGENT_TOOL_BLACKLIST = new Set([
  'start_agent_task',
  'activate_skill',
])

export class AgentTeamChildRunner {
  constructor(options = {}) {
    this.parentToolRegistry = options.parentToolRegistry || null
    this.buildToolRegistry = options.buildToolRegistry || buildToolRegistry
    this.promptLoader = options.promptLoader || new AgentCapabilityPromptLoader()
    this.agentController = options.agentController || null
  }

  async run(input = {}) {
    const {
      team,
      task,
      capability,
      contextPack,
      childSession,
      allowedToolNames,
      parentContext,
      policy,
    } = input

    const childSessionId = childSession._id.toString()
    const toolNames = filterChildToolNames(allowedToolNames)
    const subToolRegistry =
      buildScopedRegistry(this.parentToolRegistry, toolNames) ||
      this.buildToolRegistry(toolNames)
    const effectiveToolNames = subToolRegistry.getNames()

    const stopSignals = [
      parentContext.stopSignal,
      parentContext.toolAbortSignal,
      createTimeoutSignal(task.timeoutMs),
    ].filter(Boolean)
    const combinedStopSignal = stopSignals.length > 1
      ? AbortSignal.any(stopSignals)
      : stopSignals[0] || undefined

    const promptBody = await this.promptLoader.loadPrompt(capability)
    const reviewConfig = settings.review || {}
    const childLoop = createAgentLoopForSession(childSession, {
      sessionId: childSessionId,
      projectId: parentContext.projectId,
      llmAdapter: parentContext.adapters?.llm || parentContext.llmAdapter,
      toolRegistry: subToolRegistry,
      contextManager: new ContextManager(),
      adapters: parentContext.adapters,
      disablePersistence:
        parentContext.disablePersistence ||
        parentContext.adapters?.disablePersistence ||
        false,
      userId: parentContext.userId,
      currentDocId: parentContext.currentDocId,
      currentDocPath: parentContext.currentDocPath,
      confirmationChannel: parentContext.confirmationChannel || null,
      rootSessionId: parentContext.rootSessionId || parentContext.sessionId,
      maxTurns: capability.maxTurns || 5,
      maxToolCalls: policy.maxToolCalls || capability.defaultPolicy?.maxToolCalls || 8,
      temperature: reviewConfig.subAgentTemperature ?? undefined,
      maxTokens: reviewConfig.subAgentMaxTokens ?? undefined,
      stopSignal: combinedStopSignal,
      nudgeOnEmpty: true,
      runBudget: parentContext.runBudget || null,
      depth: (parentContext.currentDepth || 0) + 1,
      agentTeam: {
        teamId: team._id.toString(),
        taskId: task._id.toString(),
        capabilityName: capability.name,
      },
      baseContext: {
        autoAccept:
          parentContext.autoAccept === true ||
          parentContext.sessionState?.autoAccept === true,
        profile: parentContext.profile,
        agentName: capability.name,
        model: parentContext.model,
        fileGlobs: policy.fileGlobs || [],
        writeGlobs: policy.writeGlobs || [],
        agentTeamPolicy: policy,
      },
    })

    const childMessages = [
      { role: 'system', content: `${promptBody}${NON_INTERACTIVE_RULES}` },
      { role: 'user', content: buildChildUserMessage({ task, contextPack }) },
    ]
    const childSessionState = {
      readDocuments: new Map(),
      persistentWorkspace:
        parentContext.persistentWorkspace ||
        parentContext.sessionState?.persistentWorkspace ||
        null,
      turns: 0,
      toolCalls: 0,
      activeChangeSet: parentContext.sessionState?.activeChangeSet || null,
      autoAccept:
        parentContext.autoAccept === true ||
        parentContext.sessionState?.autoAccept === true,
    }
    const childChangeHistory = []
    const childContentBlocks = []
    const childToolContext = []
    const childToolBlocks = new Map()
    const childMessageStore = parentContext.agentMessageStore
    const childMessageId = `${childSessionId}:assistant`
    const events = [
      {
        type: 'agent_task.child_session_init',
        payload: {
          childSessionId,
          capabilityName: capability.name,
          requestedToolNames: allowedToolNames,
          allowedToolNames: effectiveToolNames,
        },
      },
    ]

    let finalContent = ''
    let allText = ''
    let currentTurnText = ''
    let childStopped = false
    let usage = { llmCalls: 0, toolCalls: 0 }

    try {
      for await (const event of childLoop._agentLoop(
        childMessages,
        subToolRegistry.getTools(),
        childSessionState,
        childChangeHistory
      )) {
        if (event.type === 'stopped') {
          childStopped = true
        } else if (event.type === 'text') {
          allText += event.content
          currentTurnText += event.content
          appendTextBlock(childContentBlocks, event.content)
        } else if (event.type === 'done') {
          finalContent = event.content || currentTurnText || allText
          usage = event.usage || usage
          if (isBudgetLimitContent(finalContent)) {
            await this.agentController?.updateSessionStatus?.(childSessionId, 'error')
            return {
              status: 'failed',
              summary: finalContent,
              findings: [],
              proposedEdits: [],
              artifacts: [],
              evidenceRefs: [],
              unresolvedQuestions: [],
              nextActions: [],
              confidence: null,
              usage,
              events: [
                ...events,
                {
                  type: 'agent_task.budget_exhausted',
                  payload: {
                    childSessionId,
                    capabilityName: capability.name,
                  },
                },
              ],
            }
          }
        } else if (event.type === 'tool_call') {
          usage.toolCalls += 1
          currentTurnText = ''
          const block = toolCallToContentBlock(event.toolCall, event.queued || false)
          childContentBlocks.push(block)
          childToolBlocks.set(event.toolCall.id, block)
          childToolContext.push(toolCallToContextMessage(event.toolCall))
          await childMessageStore?.startToolCall?.({
            sessionId: childSession._id,
            messageId: childMessageId,
            toolCall: event.toolCall,
            queued: event.queued || false,
          })
        } else if (event.type === 'tool_call_start') {
          await childMessageStore?.markToolCallRunning?.({
            sessionId: childSession._id,
            toolCallId: event.toolCallId,
          })
        } else if (event.type === 'tool_result') {
          const block = childToolBlocks.get(event.toolCallId)
          if (block) {
            block.entry.status = event.result?.success === false ? 'error' : 'completed'
            block.entry.result = {
              data: event.result?.data,
              error: event.result?.error,
            }
          }
          childToolContext.push(toolResultToContextMessage(event))
          await childMessageStore?.finishToolCall?.({
            sessionId: childSession._id,
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            result: event.result,
          })
        }

        if (isProgressEvent(event)) {
          events.push({
            type: 'agent_task.progress',
            payload: normalizeProgressEvent(event, childSessionId),
          })
        }
      }

      if (combinedStopSignal?._agentTeamTimeout === true && combinedStopSignal.aborted) {
        await this.agentController?.updateSessionStatus?.(childSessionId, 'stopped')
        return {
          status: 'timeout',
          summary: `Child agent "${capability.name}" timed out before completing.`,
          events,
          usage,
        }
      }

      if (childStopped || combinedStopSignal?.aborted || childLoop.stopRequested) {
        await this.agentController?.updateSessionStatus?.(childSessionId, 'stopped')
        return {
          status: 'failed',
          summary: `Child agent "${capability.name}" was stopped before completing.`,
          events,
          usage,
        }
      }

      if (!finalContent) {
        finalContent = currentTurnText || allText || '(Child agent returned no text)'
      }

      await childMessageStore?.saveSimpleTurn?.({
        sessionId: childSession._id,
        userContent: task.objective,
        assistantContent: finalContent,
        contentBlocks: childContentBlocks,
        toolContext: childToolContext,
      })
      await this.agentController?.updateSessionStatus?.(childSessionId, 'completed')

      return {
        status: 'completed',
        summary: finalContent,
        findings: [],
        proposedEdits: [],
        artifacts: [],
        evidenceRefs: [],
        unresolvedQuestions: [],
        nextActions: [],
        confidence: null,
        usage,
        events,
      }
    } catch (error) {
      logger.error(
        { err: error, capabilityName: capability.name, childSessionId },
        'Agent team child execution failed'
      )
      try {
        await this.agentController?.updateSessionStatus?.(childSessionId, 'error')
      } catch {
        // Best effort status update.
      }
      throw error
    }
  }
}

function filterChildToolNames(toolNames = []) {
  return Array.isArray(toolNames)
    ? toolNames.filter(name => typeof name === 'string' && !CHILD_AGENT_TOOL_BLACKLIST.has(name))
    : []
}

function createTimeoutSignal(timeoutMs) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) return null
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  timer.unref?.()
  Object.defineProperty(controller.signal, '_agentTeamTimeout', {
    value: true,
    enumerable: false,
  })
  return controller.signal
}

function buildScopedRegistry(parentRegistry, allowedToolNames) {
  if (!parentRegistry) return null
  if (typeof parentRegistry.scoped === 'function') {
    return parentRegistry.scoped(allowedToolNames)
  }

  const registry = new ToolRegistry()
  for (const name of allowedToolNames) {
    const tool = parentRegistry.get?.(name)
    if (tool) registry.register(tool)
  }
  return registry
}

function buildChildUserMessage({ task, contextPack }) {
  const lines = [
    `Objective: ${task.objective}`,
    '',
    'Acceptance criteria:',
    ...task.acceptanceCriteria.map(item => `- ${item}`),
    '',
    `Team ID: ${contextPack.teamId?.toString?.() || contextPack.teamId}`,
    `Task ID: ${contextPack.taskId?.toString?.() || contextPack.taskId}`,
    `Active change set: ${contextPack.activeChangeSetId || '(none)'}`,
  ]

  if (contextPack.userRequestSummary) {
    lines.push('', `Parent request summary:\n${contextPack.userRequestSummary}`)
  }
  if (contextPack.projectInstructions?.content) {
    lines.push(
      '',
      `Project instructions (${contextPack.projectInstructions.path || 'AGENTS.md'}):`,
      contextPack.projectInstructions.content
    )
  }
  if (contextPack.memories?.length > 0) {
    lines.push('', 'Selected user memories:')
    for (const memory of contextPack.memories) {
      lines.push(`- [${memory.scope}] ${memory.content}`)
    }
  }
  if (contextPack.sessionSummary?.summary) {
    lines.push('', `Session summary:\n${contextPack.sessionSummary.summary}`)
  }
  if (contextPack.recalledContext?.length > 0) {
    lines.push('', 'Recalled context:')
    for (const item of contextPack.recalledContext) {
      lines.push(`- [${item.type}] ${item.content}`)
    }
  }
  if (contextPack.files?.length > 0) {
    lines.push('', 'Context files:')
    for (const file of contextPack.files) {
      lines.push(
        `\n### ${file.path} (${file.mode})`,
        file.content || `[contentRef: ${file.contentRef || 'none'}]`
      )
    }
  }
  if (contextPack.priorFindings?.length > 0) {
    lines.push('', `Prior findings:\n${JSON.stringify(contextPack.priorFindings, null, 2)}`)
  }
  if (contextPack.artifacts?.length > 0) {
    lines.push('', `Artifacts:\n${JSON.stringify(contextPack.artifacts, null, 2)}`)
  }
  return lines.join('\n')
}

function appendTextBlock(blocks, content) {
  const lastBlock = blocks[blocks.length - 1]
  if (lastBlock?.type === 'text') {
    lastBlock.content += content
  } else {
    blocks.push({ type: 'text', content })
  }
}

function toolCallToContextMessage(toolCall) {
  return {
    role: 'assistant',
    content: null,
    tool_calls: [{
      id: toolCall.id,
      type: 'function',
      function: {
        name: toolCall.function?.name,
        arguments: toolCall.function?.arguments,
      },
    }],
  }
}

function toolResultToContextMessage(event) {
  return {
    role: 'tool',
    tool_call_id: event.toolCallId,
    content: event.result?.output || JSON.stringify(event.result || {}),
  }
}

function toolCallToContentBlock(toolCall, queued = false) {
  let parsedArgs = {}
  try {
    parsedArgs = JSON.parse(toolCall.function?.arguments || '{}')
  } catch {
    // Keep malformed arguments inspectable through the raw persisted tool call.
  }
  return {
    type: 'tool_call',
    entry: {
      id: toolCall.id,
      tool: toolCall.function?.name || 'unknown',
      arguments: parsedArgs,
      status: queued ? 'queued' : 'running',
    },
  }
}

function isProgressEvent(event) {
  return [
    'text',
    'tool_call',
    'tool_call_start',
    'tool_result',
    'done',
    'stopped',
  ].includes(event.type)
}

function normalizeProgressEvent(event, childSessionId) {
  if (event.type === 'text') {
    return { childSessionId, kind: 'text', chars: event.content?.length || 0 }
  }
  if (event.type === 'tool_call') {
    return {
      childSessionId,
      kind: 'tool_call',
      toolName: event.toolCall?.function?.name || 'unknown',
      toolCallId: event.toolCall?.id || null,
    }
  }
  if (event.type === 'tool_result') {
    return {
      childSessionId,
      kind: 'tool_result',
      toolName: event.toolName || 'unknown',
      toolCallId: event.toolCallId || null,
      success: event.result?.success !== false,
    }
  }
  return { childSessionId, kind: event.type }
}

function isBudgetLimitContent(content = '') {
  return /\[?已达到(?:本次请求的\s*)?(?:LLM 调用|Token 预算|工具调用预算|工具调用上限|最大对话轮数|最大运行时间限制)/.test(
    String(content)
  )
}

export function toolResultFromChildRunnerResult(result) {
  if (result.status === 'failed') {
    return ToolResult.error(result.summary || 'Child agent failed', result)
  }
  return ToolResult.success(result.summary || 'Child agent completed', result)
}

export default AgentTeamChildRunner
