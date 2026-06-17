import logger from '@overleaf/logger'
import settings from '@overleaf/settings'
import OError from '@overleaf/o-error'
import { db, ObjectId } from '../mongodb.js'
import { buildSystemPrompt } from '../prompt/system.js'
import { extractOutline, extractFileReferences } from '../util/outline.js'
import { getMemoryManager } from '../memory/MemoryManager.js'

export class AgentError extends OError {}
export class AgentMaxTurnsError extends AgentError {}
export class AgentMaxToolCallsError extends AgentError {}

/**
 * Sanitize tool error messages before sending to LLM/user.
 * Removes internal file paths, URLs, and stack trace frames,
 * redacts sensitive credentials/tokens, and limits output length
 * to prevent information leakage.
 */
const SENSITIVE_RE = /(?:authorization|api[_-]?key|token|secret|password|credential)[=:\s]+\S+/gi

function sanitizeToolError(error) {
  const msg = error.message || 'Unknown error'
  return msg
    .replace(/\/[\w\-/.]+/g, '[path]')
    .replace(/https?:\/\/[^\s]+/g, '[url]')
    .replace(/at\s+\S+\s+\(.*\)/g, '')
    .replace(SENSITIVE_RE, '[redacted]')
    .replace(/\n\s*\n/g, '\n')
    .trim()
    .slice(0, 500)
}

/**
 * Deterministic JSON stringify with sorted keys — used for doom-loop digests
 * so that key-order or whitespace differences do not bypass detection.
 */
function stableStringify(value, depth = 0, seen = new WeakSet()) {
  if (depth > 20) return '"[DepthLimit]"'
  if (Array.isArray(value)) {
    if (seen.has(value)) return '"[Circular]"'
    seen.add(value)
    return `[${value.map(v => stableStringify(v, depth + 1, seen)).join(',')}]`
  }
  if (value && typeof value === 'object') {
    if (seen.has(value)) return '"[Circular]"'
    seen.add(value)
    return `{${Object.keys(value)
      .sort()
      .map(key => `${JSON.stringify(key)}:${stableStringify(value[key], depth + 1, seen)}`)
      .join(',')}}`
  }
  return JSON.stringify(value === undefined ? null : value)
}

function normalizeToolArgs(rawArgs) {
  if (rawArgs == null) return ''
  if (typeof rawArgs !== 'string') return stableStringify(rawArgs)
  const trimmed = rawArgs.trim()
  try {
    return stableStringify(JSON.parse(trimmed))
  } catch {
    return trimmed
  }
}

const ESTIMATED_CHARS_PER_TOKEN = settings.agent?.estimatedCharsPerToken || 4

const MAX_SELECTION_REFERENCES = settings.aiAssistant?.maxSelectionReferences || 20

function estimateTokens(text) {
  if (!text) return 0
  return Math.ceil(text.length / ESTIMATED_CHARS_PER_TOKEN)
}

function normalizeUsage(usage) {
  if (!usage || typeof usage !== 'object') return null
  const completion = Number(usage.completion_tokens) || 0
  const prompt = Number(usage.prompt_tokens) || 0
  const total = Number(usage.total_tokens) || 0
  const derivedPrompt = prompt || (total && total >= completion ? total - completion : 0)
  if (!derivedPrompt && !completion) return null
  return { prompt_tokens: derivedPrompt, completion_tokens: completion }
}

function estimateUsage(messages, assistantContent) {
  // Strip base64 image data to avoid massive overestimation
  const stripped = JSON.stringify(messages, (key, val) => {
    if (key === 'url' && typeof val === 'string' && val.startsWith('data:image/')) {
      return '[image_data]'
    }
    return val
  })
  return {
    prompt_tokens: estimateTokens(stripped),
    completion_tokens: estimateTokens(assistantContent || ''),
  }
}

/**
 * AgentLoop implements the core agent conversation loop
 * It manages the interaction between user messages, LLM responses, and tool execution
 */
export class AgentLoop {
  /**
   * @param {object} options
   * @param {string} options.sessionId - Session ID
   * @param {string} options.projectId - Project ID
   * @param {object} options.llmAdapter - LLM adapter instance
   * @param {object} options.toolRegistry - Tool registry instance
   * @param {object} options.contextManager - Context manager instance
   * @param {object} options.adapters - Adapter instances for tools
   * @param {string} [options.currentDocId] - Currently open document ID
   * @param {string} [options.currentDocPath] - Currently open document path
   * @param {string} [options.userId] - Authenticated user ID
   */
  constructor(options) {
    this.sessionId = options.sessionId
    this.projectId = options.projectId
    this.llmAdapter = options.llmAdapter
    this.toolRegistry = options.toolRegistry
    this.contextManager = options.contextManager
    this.adapters = options.adapters

    // Current document context
    this.currentDocId = options.currentDocId || null
    this.currentDocPath = options.currentDocPath || null

    // User identity
    this.userId = options.userId || null

    // Synchronous confirmation channel (optional — null for review loops)
    this.confirmationChannel = options.confirmationChannel || null

    // Session tree: rootSessionId for event tagging
    this.rootSessionId = options.rootSessionId || null

    const agentConfig = settings.agent || {}
    this.maxTurns = options.maxTurns || agentConfig.maxTurns || 10
    this.maxToolCalls = options.maxToolCalls || agentConfig.maxToolCalls || 20
    this.toolTimeoutMs = agentConfig.toolTimeoutMs || 60_000

    // Per-instance LLM overrides (used by sub-agents with different parameters)
    this.temperature = options.temperature ?? null
    this.maxTokens = options.maxTokens ?? null

    // Nudge: when enabled, if the LLM ends with no tool calls and empty text,
    // send a follow-up prompt asking for final results instead of terminating.
    // Used by sub-agents that sometimes stop without producing output.
    this.nudgeOnEmpty = options.nudgeOnEmpty || false
    this._nudgeCount = 0

    // RunBudget: shared budget for limiting cost across parent and child agent loops
    this.runBudget = options.runBudget || null

    // Current delegation depth (0 = root, 1 = child, etc.)
    this.depth = options.depth || 0

    // Compaction configuration
    const compactionConfig = settings.compaction || {}
    this.compaction = {
      enabled: compactionConfig.enabled !== false,
      contextWindow: compactionConfig.contextWindow || 131072,
      threshold: compactionConfig.threshold || 0.7,
      summaryMaxTokens: compactionConfig.summaryMaxTokens || 2048,
    }

    // Stop mechanism: AbortSignal cascade for nested agent loops.
    // Each loop owns a _stopController; parent signal triggers child.stop()
    // automatically, propagating cancellation to arbitrary nesting depth.
    this._stopController = new AbortController()
    this._llmAbortController = null

    // Link to parent stop signal — enables cascading cancellation
    // through arbitrarily nested delegate_task calls
    this._parentStopSignal = options.stopSignal || null
    this._parentStopHandler = null
    if (this._parentStopSignal) {
      if (this._parentStopSignal.aborted) {
        this._stopController.abort()
      } else {
        this._parentStopHandler = () => this.stop()
        this._parentStopSignal.addEventListener(
          'abort',
          this._parentStopHandler,
          { once: true }
        )
      }
    }
  }

  /**
   * Request the agent loop to stop gracefully
   */
  stop() {
    if (!this._stopController.signal.aborted) {
      this._stopController.abort()
    }
    if (this._llmAbortController) {
      this._llmAbortController.abort()
    }
    // Abort all pending confirmations to prevent hanging after stop
    if (this.confirmationChannel) {
      this.confirmationChannel.abort()
    }
    logger.info({ sessionId: this.sessionId }, 'Agent loop stop requested')
  }

  /**
   * Remove the listener on the parent stop signal to avoid leaking memory
   * when this agent loop completes before the parent signal fires.
   */
  _detachParentStopSignal() {
    if (this._parentStopSignal && this._parentStopHandler) {
      this._parentStopSignal.removeEventListener('abort', this._parentStopHandler)
      this._parentStopHandler = null
    }
  }

  get stopRequested() {
    return this._stopController.signal.aborted
  }

  /**
   * Run the agent loop
   * @param {string} userMessage - User message
   * @param {object} context - Additional context (selection, cursor position, etc.)
   * @returns {AsyncGenerator} - Yields events as they occur
   */
  async *run(userMessage, context = {}) {
    const sessionState = {
      readDocuments: context._initialReadDocuments || new Map(),
      turns: 0,
      toolCalls: 0,
    }
    const changeHistory = []

    this._baseContext = { ...context }
    const enrichedContext = await this._enrichContext(context)

    // Pre-execute read_document for selection references so sessionState.readDocuments is populated
    const syntheticReadMessages = await this._executeSelectionReads(context, sessionState)
    enrichedContext._syntheticReadMessages = syntheticReadMessages

    const messages = await this.contextManager.buildMessages(
      this.sessionId,
      userMessage,
      enrichedContext
    )

    const tools = this.toolRegistry.getTools()

    logger.debug(
      {
        sessionId: this.sessionId,
        projectId: this.projectId,
        toolCount: tools.length,
      },
      'Starting agent loop'
    )

    yield* this._agentLoop(messages, tools, sessionState, changeHistory)
  }

  /**
   * Resume an interrupted agent loop
   * Rebuilds messages from history + _streamingContext and continues the loop
   * @param {object} context - Additional context
   * @returns {AsyncGenerator} - Yields events as they occur
   */
  async *resume(context = {}) {
    const sessionState = {
      readDocuments: context._initialReadDocuments || new Map(),
      turns: 0,
      toolCalls: 0,
    }
    const changeHistory = []

    this._baseContext = { ...context }
    const enrichedContext = await this._enrichContext(context)

    const messages = await this.contextManager.buildMessagesForResume(
      this.sessionId,
      enrichedContext
    )

    const tools = this.toolRegistry.getTools()

    logger.info(
      { sessionId: this.sessionId, messageCount: messages.length },
      'Resuming agent loop'
    )

    yield* this._agentLoop(messages, tools, sessionState, changeHistory)
  }

  /**
   * Core agent loop logic shared by run() and resume()
   * @param {Array} messages - Initial message array
   * @param {Array} tools - Available tools
   * @param {object} sessionState - Session state tracking
   * @param {Array} changeHistory - Accumulated change history
   * @returns {AsyncGenerator}
   */
  async *_agentLoop(messages, tools, sessionState, changeHistory) {
    // Doom loop detection
    const DOOM_LOOP_THRESHOLD = 3
    const recentToolCallDigests = []

    // Accumulated usage across turns
    const accumulatedUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }

    // In-memory message count for compaction check (avoids per-turn countDocuments)
    let inMemoryMsgCount = await db.aiMessages.countDocuments({ sessionId: new ObjectId(this.sessionId) })

    try {
    while (true) {
      sessionState.turns++
      const messagesLengthBeforeTurn = messages.length

      // Check if stop was requested
      if (this.stopRequested) {
        logger.info({ sessionId: this.sessionId, turn: sessionState.turns }, 'Agent loop stopped by user')
        yield {
          type: 'stopped',
          changeHistory,
          readDocuments: sessionState.readDocuments,
          usage: accumulatedUsage,
          runBudgetSummary: this.runBudget ? {
            llmCalls: this.runBudget.llmCalls,
            toolCalls: this.runBudget.toolCalls,
            delegations: this.runBudget.delegations,
            totalTokens: this.runBudget.totalTokens,
            wallTimeMs: this.runBudget.getElapsedWallTimeMs(),
          } : undefined,
        }
        break
      }

      // Check max turns — graceful degradation: let model summarize without tools
      if (sessionState.turns > this.maxTurns) {
        logger.warn(
          { sessionId: this.sessionId, maxTurns: this.maxTurns },
          'Max turns reached'
        )
        yield* this._summarizeAndFinish(messages, '已达到最大对话轮数', accumulatedUsage, changeHistory, sessionState)
        break
      }

      // Doom loop detection — check before making LLM call
      if (
        recentToolCallDigests.length >= DOOM_LOOP_THRESHOLD &&
        recentToolCallDigests.every(d => d === recentToolCallDigests[0])
      ) {
        logger.warn(
          { sessionId: this.sessionId, digest: recentToolCallDigests[0] },
          'Doom loop detected'
        )
        yield {
          type: 'text',
          content:
            '检测到重复操作，已自动终止。请尝试换一种方式描述您的需求。',
        }
        yield {
          type: 'done',
          content: '',
          changeHistory,
          readDocuments: sessionState.readDocuments,
          usage: accumulatedUsage,
          runBudgetSummary: this.runBudget ? {
            llmCalls: this.runBudget.llmCalls,
            toolCalls: this.runBudget.toolCalls,
            delegations: this.runBudget.delegations,
            totalTokens: this.runBudget.totalTokens,
            wallTimeMs: this.runBudget.getElapsedWallTimeMs(),
          } : undefined,
        }
        break
      }

      // RunBudget: LLM call count check (atomic)
      if (this.runBudget && !this.runBudget.tryConsumeLLMCall()) {
        logger.warn(
          { sessionId: this.sessionId, llmCalls: this.runBudget.llmCalls, max: this.runBudget.maxLLMCalls },
          'RunBudget: max LLM calls reached, entering summary mode'
        )
        yield* this._summarizeAndFinish(messages, '已达到本次请求的 LLM 调用上限', accumulatedUsage, changeHistory, sessionState)
        break
      }

      // RunBudget: token budget check (P2-12)
      if (this.runBudget && this.runBudget.isTokenBudgetExceeded()) {
        logger.warn(
          { sessionId: this.sessionId, tokens: this.runBudget.totalTokens, max: this.runBudget.maxTotalTokens },
          'RunBudget: token budget exceeded, entering summary mode'
        )
        yield* this._summarizeAndFinish(messages, '已达到本次请求的 Token 预算上限', accumulatedUsage, changeHistory, sessionState)
        break
      }

      logger.debug(
        { sessionId: this.sessionId, turn: sessionState.turns },
        'Agent turn starting'
      )

      try {
        // Use auto tool_choice — GLM-4.7 selects tools correctly in auto mode
        const toolChoice = 'auto'

        // Call LLM with streaming
        this._llmAbortController = new AbortController()

        const response = this.llmAdapter.chat({
          messages,
          tools,
          stream: true,
          toolChoice,
          signal: this._llmAbortController.signal,
          ...(this.temperature != null && { temperature: this.temperature }),
          ...(this.maxTokens != null && { maxTokens: this.maxTokens }),
        })

        let assistantContent = ''
        let finishReason = null
        let lastUsage = null
        const toolCallsInTurn = []

        // Process streaming response — stream text directly to user
        try {
        for await (const chunk of await response) {
          if (chunk.type === 'thinking') {
            yield { type: 'thinking', content: chunk.content }
          }

          if (chunk.type === 'text') {
            assistantContent += chunk.content
            yield { type: 'text', content: chunk.content }
          }

          if (chunk.type === 'tool_call') {
            toolCallsInTurn.push(chunk.toolCall)
          }

          if (chunk.type === 'done') {
            // Extract finish_reason from done event
            finishReason = chunk.finishReason || null
            lastUsage = chunk.usage || null
            // Store final tool calls state
            if (chunk.toolCalls && chunk.toolCalls.length > 0) {
              toolCallsInTurn.length = 0
              toolCallsInTurn.push(...chunk.toolCalls)
            }
          }
        }
        } finally {
          this._llmAbortController = null
        }

        // Update accumulated usage from this turn
        if (lastUsage) {
          if (lastUsage.prompt_tokens) {
            accumulatedUsage.prompt_tokens = lastUsage.prompt_tokens
          }
          accumulatedUsage.completion_tokens += lastUsage.completion_tokens || 0
          accumulatedUsage.total_tokens = accumulatedUsage.prompt_tokens + accumulatedUsage.completion_tokens
        }

        if (this.runBudget) {
          const normalized = normalizeUsage(lastUsage)
          const usageForBudget = normalized || estimateUsage(messages, assistantContent)
          if (!normalized) {
            logger.warn({ sessionId: this.sessionId }, 'LLM usage missing, using estimated tokens for budget')
          }
          this.runBudget.recordTokens(usageForBudget)
        }

        // Handle no tool calls — use finish_reason to decide termination
        if (toolCallsInTurn.length === 0) {
          // Nudge: if empty response and nudge is enabled, ask LLM for final result
          if (!assistantContent.trim() && this.nudgeOnEmpty && this._nudgeCount < 1) {
            this._nudgeCount++
            logger.info(
              { sessionId: this.sessionId, turn: sessionState.turns },
              'Empty response from sub-agent, nudging for final result'
            )
            messages.push({
              role: 'assistant',
              content: assistantContent || null,
            })
            messages.push({
              role: 'user',
              content: 'Please provide the final result now and stop calling tools.',
            })
            continue
          }

          if (finishReason && finishReason !== 'tool_calls') {
            // finish_reason=stop/length → model decided to end with pure text
            messages.push({
              role: 'assistant',
              content: assistantContent || null,
            })
            yield {
              type: 'done',
              content: assistantContent || '',
              changeHistory,
              readDocuments: sessionState.readDocuments,
              usage: accumulatedUsage,
              runBudgetSummary: this.runBudget ? {
                llmCalls: this.runBudget.llmCalls,
                toolCalls: this.runBudget.toolCalls,
                delegations: this.runBudget.delegations,
                totalTokens: this.runBudget.totalTokens,
                wallTimeMs: this.runBudget.getElapsedWallTimeMs(),
              } : undefined,
            }
            break
          }
          // finish_reason is null or 'tool_calls' but no actual tools → anomaly
          logger.warn(
            { sessionId: this.sessionId, turn: sessionState.turns, finishReason },
            'No tool calls and unexpected finish_reason'
          )
          if (assistantContent) {
            yield {
              type: 'done',
              content: assistantContent,
              changeHistory,
              readDocuments: sessionState.readDocuments,
              usage: accumulatedUsage,
              runBudgetSummary: this.runBudget ? {
                llmCalls: this.runBudget.llmCalls,
                toolCalls: this.runBudget.toolCalls,
                delegations: this.runBudget.delegations,
                totalTokens: this.runBudget.totalTokens,
                wallTimeMs: this.runBudget.getElapsedWallTimeMs(),
              } : undefined,
            }
          } else {
            yield {
              type: 'done',
              content: '',
              changeHistory,
              readDocuments: sessionState.readDocuments,
              usage: accumulatedUsage,
              runBudgetSummary: this.runBudget ? {
                llmCalls: this.runBudget.llmCalls,
                toolCalls: this.runBudget.toolCalls,
                delegations: this.runBudget.delegations,
                totalTokens: this.runBudget.totalTokens,
                wallTimeMs: this.runBudget.getElapsedWallTimeMs(),
              } : undefined,
            }
          }
          break
        }

        // Add assistant message with tool calls
        messages.push({
          role: 'assistant',
          content: assistantContent || null,
          tool_calls: toolCallsInTurn,
        })

        // Execute all tool calls and yield events via _executeBatchToolCalls
        sessionState.toolCalls += toolCallsInTurn.length

        // RunBudget: shared tool call budget check (atomic, across parent + child loops)
        if (this.runBudget) {
          if (!this.runBudget.tryConsumeToolCalls(toolCallsInTurn.length)) {
            logger.warn(
              { sessionId: this.sessionId, toolCalls: this.runBudget.toolCalls, batch: toolCallsInTurn.length, max: this.runBudget.maxToolCalls },
              'RunBudget: max tool calls reached, entering summary mode'
            )
            yield* this._summarizeAndFinish(messages, '已达到本次请求的工具调用预算上限', accumulatedUsage, changeHistory, sessionState)
            break
          }
        }

        if (sessionState.toolCalls > this.maxToolCalls) {
          logger.warn(
            { sessionId: this.sessionId, toolCalls: sessionState.toolCalls, max: this.maxToolCalls },
            'Max tool calls reached, entering summary mode'
          )
          yield* this._summarizeAndFinish(messages, '已达到工具调用上限，请总结目前为止的工作成果', accumulatedUsage, changeHistory, sessionState)
          break
        }

        // Execute all tool calls with batched confirmation —
        // all awaiting_confirmation events are yielded before blocking,
        // so the frontend can show multiple pending changes with navigation.
        yield* this._executeBatchToolCalls(toolCallsInTurn, sessionState, changeHistory, messages)

        // Increment in-memory message count by the actual number of messages added this turn
        // (includes assistant, tool results, image injection user messages, nudge messages, etc.)
        inMemoryMsgCount += (messages.length - messagesLengthBeforeTurn)

        // Compute doom loop digest after tool execution
        const turnDigest = toolCallsInTurn
          .map(tc => `${tc.function.name}:${normalizeToolArgs(tc.function.arguments)}`)
          .sort()
          .join('|')
        recentToolCallDigests.push(turnDigest)
        if (recentToolCallDigests.length > DOOM_LOOP_THRESHOLD)
          recentToolCallDigests.shift()

        // Compaction detection: check if context is approaching the limit
        if (this.contextManager.needsCompaction(lastUsage, this.compaction, inMemoryMsgCount)) {
          logger.info(
            { sessionId: this.sessionId, promptTokens: lastUsage.prompt_tokens },
            'Context compaction triggered'
          )
          yield { type: 'compaction_start' }

          try {
            const compactResult = await this.contextManager.compactHistory(
              this.sessionId,
              this.llmAdapter,
              this.compaction,
              { signal: this._stopController.signal }
            )

            if (compactResult.success) {
              // Accumulate compaction LLM usage
              if (compactResult.usage) {
                accumulatedUsage.completion_tokens += compactResult.usage.completion_tokens || 0
                accumulatedUsage.total_tokens = accumulatedUsage.prompt_tokens + accumulatedUsage.completion_tokens
              }

              const currentTurnMessages = messages.slice(messagesLengthBeforeTurn)
              const newHistory = await this.contextManager.getConversationHistory(this.sessionId)

              // Refresh promptSnapshot so the system prompt reflects current document state.
              // If refresh fails, fall back to the existing system prompt.
              let systemPromptMsg = messages[0]
              try {
                await db.aiSessions.updateOne(
                  { _id: new ObjectId(this.sessionId) },
                  { $unset: { promptSnapshot: '' } }
                )
                const refreshedContext = await this._enrichContext(this._baseContext)
                const newSystemPrompt = await buildSystemPrompt(refreshedContext)
                systemPromptMsg = { role: 'system', content: newSystemPrompt }
              } catch (refreshError) {
                logger.warn(
                  { err: refreshError, sessionId: this.sessionId },
                  'Prompt snapshot refresh failed during compaction, using existing system prompt'
                )
              }

              messages.length = 0
              messages.push(systemPromptMsg, ...newHistory, ...currentTurnMessages)

              // Reset in-memory message count to reflect the compacted state
              inMemoryMsgCount = messages.length

              yield { type: 'compaction_done', success: true }
              logger.info({ sessionId: this.sessionId }, 'Context compaction completed')
            } else {
              yield { type: 'compaction_done', success: false }
            }
          } catch (compactionError) {
            logger.error({ err: compactionError, sessionId: this.sessionId }, 'Context compaction failed')
            yield { type: 'compaction_done', success: false }
          }
        }
      } catch (error) {
        // Handle stop-induced AbortError
        if (this.stopRequested && error.name === 'AbortError') {
          logger.info({ sessionId: this.sessionId }, 'LLM stream aborted by stop request')
          yield {
            type: 'stopped',
            changeHistory,
            readDocuments: sessionState.readDocuments,
            usage: accumulatedUsage,
            runBudgetSummary: this.runBudget ? {
              llmCalls: this.runBudget.llmCalls,
              toolCalls: this.runBudget.toolCalls,
              delegations: this.runBudget.delegations,
              totalTokens: this.runBudget.totalTokens,
              wallTimeMs: this.runBudget.getElapsedWallTimeMs(),
            } : undefined,
          }
          break
        }

        // Emergency truncation on context overflow
        if (error.constructor?.name === 'LLMContextOverflowError') {
          logger.warn(
            { sessionId: this.sessionId, turn: sessionState.turns },
            'Context overflow detected, performing emergency truncation'
          )
          const truncated = this.contextManager.emergencyTruncate(messages)
          messages.length = 0
          messages.push(...truncated)

          yield { type: 'context_truncated' }

          sessionState.turns--
          continue
        }

        logger.error(
          { err: error, sessionId: this.sessionId },
          'Agent loop error'
        )

        const safeMessage = (error.status && error.status < 500)
          ? error.message
          : 'Internal error'

        yield {
          type: 'error',
          error: safeMessage,
          code: error.code || 'AGENT_ERROR',
        }

        throw error
      }
    }

    } finally {
      this._detachParentStopSignal()
    }

    logger.debug(
      {
        sessionId: this.sessionId,
        turns: sessionState.turns,
        toolCalls: sessionState.toolCalls,
        changeHistory: changeHistory.length,
      },
      'Agent loop completed'
    )
  }

  /**
   * Enter summary mode: send a system hint disabling tools, ask the LLM for a
   * final text-only reply, stream it to the caller, and yield a 'done' event.
   * @private
   */
  async *_summarizeAndFinish(messages, reason, accumulatedUsage, changeHistory, sessionState) {
    messages.push({
      role: 'user',
      content: `[系统提示] ${reason}，工具已禁用。请直接用文本提供最终回复。`,
    })

    let finalContent = ''

    // RunBudget: check if we can afford one more LLM call for the summary.
    // If the budget is already exhausted, skip the LLM call and use a fixed fallback.
    if (this.runBudget && !this.runBudget.tryConsumeLLMCall()) {
      logger.warn(
        { sessionId: this.sessionId, llmCalls: this.runBudget.llmCalls, max: this.runBudget.maxLLMCalls },
        'RunBudget exhausted in _summarizeAndFinish, skipping summary LLM call'
      )
      finalContent = `[${reason}]`
      yield {
        type: 'text',
        content: finalContent,
      }
      yield {
        type: 'done',
        content: finalContent,
        changeHistory,
        readDocuments: sessionState.readDocuments,
        usage: accumulatedUsage,
        runBudgetSummary: this.runBudget ? {
          llmCalls: this.runBudget.llmCalls,
          toolCalls: this.runBudget.toolCalls,
          delegations: this.runBudget.delegations,
          totalTokens: this.runBudget.totalTokens,
          wallTimeMs: this.runBudget.getElapsedWallTimeMs(),
        } : undefined,
      }
      return
    }

    try {
      // Use _llmAbortController so stop() can interrupt the summary call
      // Note: when runBudget exists, the LLM call was already consumed above
      // via tryConsumeLLMCall(); no extra recordLLMCall needed here.
      this._llmAbortController = new AbortController()

      const finalResponse = this.llmAdapter.chat({
        messages,
        tools: [],
        stream: true,
        signal: this._llmAbortController.signal,
        ...(this.temperature != null && { temperature: this.temperature }),
        ...(this.maxTokens != null && { maxTokens: this.maxTokens }),
      })

      let summaryUsage = null
      for await (const chunk of await finalResponse) {
        if (this.stopRequested) break
        if (chunk.type === 'text') {
          finalContent += chunk.content
          yield { type: 'text', content: chunk.content }
        }
        if (chunk.type === 'done') {
          summaryUsage = chunk.usage || null
        }
      }
      this._llmAbortController = null

      // Accumulate usage from summary call
      if (summaryUsage) {
        if (summaryUsage.prompt_tokens) {
          accumulatedUsage.prompt_tokens = summaryUsage.prompt_tokens
        }
        accumulatedUsage.completion_tokens += summaryUsage.completion_tokens || 0
        accumulatedUsage.total_tokens = accumulatedUsage.prompt_tokens + accumulatedUsage.completion_tokens
        if (this.runBudget) {
          this.runBudget.recordTokens(summaryUsage)
        }
      }
    } catch (error) {
      this._llmAbortController = null
      // If stop-induced, don't re-throw; just finalize with whatever we have
      if (!(this.stopRequested && error.name === 'AbortError')) {
        logger.error({ err: error, sessionId: this.sessionId }, 'Summary mode LLM call failed')
      }
      if (!finalContent) {
        finalContent = `[${reason}，但生成总结时出错]`
      }
    }

    yield {
      type: 'done',
      content: finalContent,
      changeHistory,
      readDocuments: sessionState.readDocuments,
      usage: accumulatedUsage,
      runBudgetSummary: this.runBudget ? {
        llmCalls: this.runBudget.llmCalls,
        toolCalls: this.runBudget.toolCalls,
        delegations: this.runBudget.delegations,
        totalTokens: this.runBudget.totalTokens,
        wallTimeMs: this.runBudget.getElapsedWallTimeMs(),
      } : undefined,
    }
  }

  /**
   * Execute a single tool call, yielding the tool_call event and any sub-events.
   * Does NOT handle confirmation flow or yield tool_result — the caller is
   * responsible for batching confirmations and emitting tool_result events.
   *
   * @param {object} toolCall - The tool call from the LLM
   * @param {object} sessionState - Session state tracking
   * @returns {AsyncGenerator} - Yields events; returns { result, pendingChange }
   */
  async *_executeToolCore(toolCall, sessionState, options = {}) {
    // 1. Yield tool_call event (or tool_call_start if pre-announced)
    if (!options.skipAnnounce) {
      yield { type: 'tool_call', toolCall }
    } else {
      yield { type: 'tool_call_start', toolCallId: toolCall.id }
    }

    // 2. Execute the tool
    const toolName = toolCall.function.name
    const tool = this.toolRegistry.get(toolName)

    let result

    if (!tool) {
      const available = this.toolRegistry.getNames().join(', ')
      result = {
        success: false,
        output: `Unknown tool "${toolName}". Available tools: ${available}. Please use one of these.`,
        error: 'UNKNOWN_TOOL',
      }
    } else {
      try {
        // Parse and validate arguments
        let args
        try {
          args = JSON.parse(toolCall.function.arguments)
        } catch (parseError) {
          result = {
            success: false,
            output: `Invalid JSON in arguments for "${toolName}". Please rewrite with valid JSON.\nError: ${parseError.message}`,
            error: 'INVALID_ARGUMENTS',
          }
        }

        if (!result) {
          let validated
          try {
            validated = tool.validateArgs(args)
          } catch (validationError) {
            const details = validationError.info?.errors
              ?.map(e => `  - ${e.path.join('.')}: ${e.message}`)
              .join('\n')
            result = {
              success: false,
              output: `Tool "${toolName}" arguments invalid. Please rewrite to satisfy the schema.\n${details || validationError.message}`,
              error: 'VALIDATION_ERROR',
            }
          }

          if (!result) {
            // Build tool execution context
            const toolAbortController = new AbortController()
            const toolTimeoutTimer = setTimeout(
              () => toolAbortController.abort(),
              this.toolTimeoutMs
            )

            // Connect stop signal to tool abort controller so that
            // stop() cancels any in-progress tool execution (M2 fix)
            const stopSignal = this._stopController.signal
            let onStopAbortTool
            if (!stopSignal.aborted) {
              onStopAbortTool = () => toolAbortController.abort()
              stopSignal.addEventListener('abort', onStopAbortTool, { once: true })
            } else {
              toolAbortController.abort()
            }

            const toolContext = {
              sessionId: this.sessionId,
              projectId: this.projectId,
              currentDocId: this.currentDocId,
              currentDocPath: this.currentDocPath,
              userId: this.userId,
              sessionState,
              adapters: this.adapters,
              // Extra context for streaming tools (delegate_task)
              confirmationChannel: this.confirmationChannel,
              rootSessionId: this.rootSessionId || this.sessionId,
              stopSignal: this._stopController.signal,
              // Per-tool abort signal for timeout enforcement
              toolAbortSignal: toolAbortController.signal,
              // RunBudget and depth for delegate_task
              runBudget: this.runBudget,
              currentDepth: this.depth,
            }

            try {
            const toolStartedAt = Date.now()
            const execResult = tool.execute(validated, toolContext)

            // 3. Check if the tool returns an AsyncGenerator (streaming tool)
            if (execResult && typeof execResult[Symbol.asyncIterator] === 'function') {
              // Streaming tool: use manual iteration + Promise.race to enforce
              // per-chunk timeout. A plain for-await-of cannot be interrupted
              // when the generator's next() promise never settles.
              let finalResult = null
              const iterator = execResult[Symbol.asyncIterator]()
              let streamDone = false
              while (!streamDone) {
                const remainingTimeout = this.toolTimeoutMs - (Date.now() - toolStartedAt)
                if (remainingTimeout <= 0) {
                  toolAbortController.abort()
                  iterator.return?.().catch(() => {})
                  logger.warn(
                    { sessionId: this.sessionId, toolName, elapsed: Date.now() - toolStartedAt, timeout: this.toolTimeoutMs },
                    'Streaming tool timed out'
                  )
                  result = {
                    success: false,
                    output: `Tool "${toolName}" timed out after ${Math.round(this.toolTimeoutMs / 1000)}s.`,
                    error: 'TOOL_TIMEOUT',
                  }
                  break
                }

                const nextPromise = iterator.next()
                let timeoutTimer
                const timeoutPromise = new Promise((_resolve, reject) => {
                  timeoutTimer = setTimeout(() => reject(new Error('Stream tool timeout')), remainingTimeout)
                })

                let iterResult
                try {
                  iterResult = await Promise.race([nextPromise, timeoutPromise])
                  clearTimeout(timeoutTimer)
                } catch (_timeoutErr) {
                  clearTimeout(timeoutTimer)
                  toolAbortController.abort()
                  iterator.return?.().catch(() => {})
                  logger.warn(
                    { sessionId: this.sessionId, toolName, elapsed: Date.now() - toolStartedAt, timeout: this.toolTimeoutMs },
                    'Streaming tool timed out (next() hung)'
                  )
                  result = {
                    success: false,
                    output: `Tool "${toolName}" timed out after ${Math.round(this.toolTimeoutMs / 1000)}s.`,
                    error: 'TOOL_TIMEOUT',
                  }
                  break
                }

                const { value: subEvent, done } = iterResult
                if (done) { streamDone = true; break }

                if (subEvent && subEvent._isToolResult) {
                  // Convention: the final yield from a streaming tool is the ToolResult
                  finalResult = subEvent
                } else {
                  // Yield sub-events (child session tool_call, tool_result, etc.)
                  // Tag child_session_init with the owning toolCallId so
                  // AgentController can persist the link in contentBlocks.
                  if (subEvent.type === 'child_session_init') {
                    subEvent.toolCallId = toolCall.id
                  }
                  yield subEvent
                }
              }
              if (!result) {
                result = finalResult || { success: true, output: '(streaming tool completed with no result)', data: null }
              }
            } else {
              // Normal tool: await the Promise with timeout
              let raceTimer
              const timeoutPromise = new Promise((_resolve, reject) => {
                raceTimer = setTimeout(() => {
                  // Abort the tool's underlying task before rejecting
                  toolAbortController.abort()
                  const err = new Error(`Tool "${toolName}" timed out after ${Math.round(this.toolTimeoutMs / 1000)}s.`)
                  err.code = 'TOOL_TIMEOUT'
                  reject(err)
                }, this.toolTimeoutMs)
              })
              try {
                result = await Promise.race([execResult, timeoutPromise])
              } finally {
                clearTimeout(raceTimer)
              }
            }

            logger.debug(
              {
                sessionId: this.sessionId,
                toolName,
                success: result.success,
              },
              'Tool executed'
            )
            } finally {
              clearTimeout(toolTimeoutTimer)
              // Clean up stop-to-tool abort listener to avoid leaks (M2 fix)
              if (onStopAbortTool && !stopSignal.aborted) {
                stopSignal.removeEventListener('abort', onStopAbortTool)
              }
            }
          }
        }
      } catch (error) {
        if (error.code === 'TOOL_TIMEOUT') {
          logger.warn({ toolName, timeout: this.toolTimeoutMs }, 'Tool execution timed out')
          result = {
            success: false,
            output: error.message,
            error: 'TOOL_TIMEOUT',
          }
        } else {
          logger.error({ err: error, toolName }, 'Tool execution failed')
          result = {
            success: false,
            output: `Tool execution failed: ${sanitizeToolError(error)}`,
            error: error.code || 'EXECUTION_ERROR',
          }
        }
      }
    }

    // Extract pending change — caller handles the confirmation flow
    const pendingChange = (result.data?.needsConfirmation && this.confirmationChannel)
      ? result.data.change
      : null

    return { result, pendingChange }
  }

  /**
   * Execute all tool calls in a turn with batched confirmation.
   *
   * When multiple tools need user confirmation (e.g. parallel edit_document
   * calls), all awaiting_confirmation events are yielded BEFORE blocking —
   * so the frontend receives them all at once and can show the navigation bar
   * with "1/N" counter and prev/next arrows.
   *
   * @param {Array} toolCallsInTurn - Tool calls from the LLM
   * @param {object} sessionState - Session state tracking
   * @param {Array} changeHistory - Accumulated change history
   * @param {Array} messages - Message array to append tool results to (mutated)
   * @returns {AsyncGenerator} - Yields events
   */
  async *_executeBatchToolCalls(toolCallsInTurn, sessionState, changeHistory, messages) {
    // Phase 0: Pre-announce tool calls so the frontend (and AgentController's
    // streaming-context counter) knows the full set of tools in this turn upfront.
    // When a streaming tool (delegate_task) is present and there are multiple
    // tools, we pre-announce ALL tools — not just delegate_tasks — because
    // tool_results are now emitted immediately in Phase 1, and the
    // AgentController flush check (toolResults.length === toolCalls.length)
    // would otherwise trigger prematurely.
    const hasStreamingTool = toolCallsInTurn.some(tc => tc.function.name === 'delegate_task')
    const preAnnouncedIds = new Set()

    if (hasStreamingTool && toolCallsInTurn.length >= 2) {
      for (const tc of toolCallsInTurn) {
        yield { type: 'tool_call', toolCall: tc, queued: true }
        preAnnouncedIds.add(tc.id)
      }
    }

    // Phase 1: Execute all tools, collect results (no confirmation blocking)
    const executions = []
    for (const tc of toolCallsInTurn) {
      // Skip remaining tools if stop was requested (avoids unnecessary
      // child session creation and LLM calls for delegate_task)
      if (this.stopRequested) {
        executions.push({
          tc,
          result: { success: false, output: 'Operation cancelled: conversation stopped by user.', error: 'STOPPED' },
          pendingChange: null,
          emitted: false,
        })
        continue
      }
      const skipAnnounce = preAnnouncedIds.has(tc.id)
      const { result, pendingChange } = yield* this._executeToolCore(tc, sessionState, { skipAnnounce })

      // For pre-announced tools without pending changes (streaming tools like
      // delegate_task in multi-tool turns), emit tool_result immediately so the
      // frontend sees the status update without waiting for all sibling tools
      // to finish. Only do this when pre-announced — otherwise the
      // AgentController's streaming-context flush check would trigger
      // prematurely for normal multi-tool turns.
      if (!pendingChange && preAnnouncedIds.has(tc.id)) {
        yield {
          type: 'tool_result',
          toolCallId: tc.id,
          toolName: tc.function.name,
          result,
        }

        const rawOutput =
          typeof result.output === 'string'
            ? result.output
            : JSON.stringify(result.output)
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: `<tool_output_data>\n${rawOutput}\n</tool_output_data>`,
        })

        // Image injection: if the tool returned image content and the model
        // supports images, add a synthetic user message with the image so
        // the LLM can see it (tool messages don't support image_url parts).
        if (result.data?._imageContent && this.adapters.llm?.supportsImage()) {
          const img = result.data._imageContent
          messages.push({
            role: 'user',
            content: [
              { type: 'text', text: `[Image from tool: ${img.filename}]` },
              {
                type: 'image_url',
                image_url: {
                  url: `data:${img.mimeType};base64,${img.base64Data}`,
                },
              },
            ],
          })
        }

        executions.push({ tc, result, pendingChange: null, emitted: true })
      } else {
        executions.push({ tc, result, pendingChange, emitted: false })
      }
    }

    // Phase 2: Batch confirmation for all pending changes
    const needingConfirmation = executions.filter(e => e.pendingChange)
    if (needingConfirmation.length > 0) {
      // Yield all awaiting_confirmation events at once —
      // the frontend adds them all to state.awaitingConfirmation,
      // enabling the PendingChangesList navigation bar.
      for (const { pendingChange } of needingConfirmation) {
        yield { type: 'awaiting_confirmation', change: pendingChange }
      }

      // Wait for all confirmations in parallel.
      // Each resolves independently when the user clicks accept/reject;
      // Promise.all collects them all before we proceed.
      if (this.runBudget) this.runBudget.pauseWallTime()
      let confirmations
      try {
        confirmations = await Promise.all(
          needingConfirmation.map(({ pendingChange }) =>
            this.confirmationChannel.waitForConfirmation(pendingChange.id)
          )
        )
      } finally {
        if (this.runBudget) this.runBudget.resumeWallTime()
      }

      // Process confirmations sequentially (apply changes in order
      // so version updates and rebasing work correctly)
      for (let i = 0; i < needingConfirmation.length; i++) {
        const { result, pendingChange } = needingConfirmation[i]
        const confirmation = confirmations[i]

        if (confirmation.action === 'accept') {
          try {
            const applyResult = await this._applyChange(pendingChange)

            // Update readDocuments so subsequent edits see the new version
            if (pendingChange.docId) {
              sessionState.readDocuments.set(`${pendingChange.projectId}:${pendingChange.docId}`, {
                version: applyResult.newVersion,
                readAt: Date.now(),
              })
            }

            // Replace tool output with concise result
            result.output = this._formatAppliedOutput(pendingChange, applyResult)
            result.data.status = 'accepted'
            result.data.appliedVersion = applyResult.newVersion

            changeHistory.push({ ...pendingChange, status: 'accepted' })
          } catch (applyError) {
            logger.warn({ changeId: pendingChange.id, err: applyError }, 'Change apply failed after acceptance')
            result.success = false
            result.output = `Edit could not be applied: ${applyError.message}. The document may have been modified by another user. Please read the document again and retry.`
            result.data.status = 'conflict'
            changeHistory.push({ ...pendingChange, status: 'conflict' })

            yield {
              type: 'change_conflict',
              changeId: pendingChange.id,
              conflictType: applyError.info?.conflictType || 'UNKNOWN',
              message: applyError.message,
            }
          }
        } else {
          // Replace tool output with concise rejection
          result.success = false
          result.output = `Edit rejected by user.${confirmation.reason ? ' Reason: ' + confirmation.reason : ''} Please consider the user's feedback and adjust your approach.`
          result.data.status = 'rejected'

          changeHistory.push({ ...pendingChange, status: 'rejected' })
        }

        yield { type: 'change_confirmed', changeId: pendingChange.id, action: confirmation.action }
      }
    }

    // Phase 3: Yield tool_result events and add tool messages
    // Skip tools already emitted in Phase 1 (those without pending changes).
    for (const { tc, result, emitted } of executions) {
      if (emitted) continue

      yield {
        type: 'tool_result',
        toolCallId: tc.id,
        toolName: tc.function.name,
        result,
      }

      const rawOutput =
        typeof result.output === 'string'
          ? result.output
          : JSON.stringify(result.output)
      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: `<tool_output_data>\n${rawOutput}\n</tool_output_data>`,
      })

      // Image injection: if the tool returned image content and the model
      // supports images, add a synthetic user message with the image so
      // the LLM can see it (tool messages don't support image_url parts).
      if (result.data?._imageContent && this.adapters.llm?.supportsImage()) {
        const img = result.data._imageContent
        messages.push({
          role: 'user',
          content: [
            { type: 'text', text: `[Image from tool: ${img.filename}]` },
            {
              type: 'image_url',
              image_url: {
                url: `data:${img.mimeType};base64,${img.base64Data}`,
              },
            },
          ],
        })
      }
    }
  }

  /**
   * Apply a confirmed change to the document/project.
   * Handles edit, create, and delete change types.
   * @param {object} change - The change to apply
   * @returns {Promise<{ success: boolean, newVersion: number, wasRebased: boolean }>}
   */
  async _applyChange(change) {
    const changeType = change.type || 'edit'
    switch (changeType) {
      case 'edit':
        return await this.adapters.document.applyEdit(change, {
          userId: this.userId,
        })
      case 'create':
        return await this._applyCreateChange(change)
      case 'delete':
        return await this._applyDeleteChange(change)
      default:
        throw new AgentError(`Unknown change type: ${changeType}`)
    }
  }

  /**
   * Apply a 'create' change: create file and write content.
   */
  async _applyCreateChange(change) {
    const { projectId, path: filePath, content } = change
    const pathModule = await import('node:path')
    const dirPath = pathModule.dirname(filePath)
    const fileName = pathModule.basename(filePath)

    let parentFolderId = null
    if (dirPath && dirPath !== '/' && dirPath !== '.') {
      const folderResult = await this.adapters.project.ensureFolderPath(
        projectId,
        dirPath,
        this.userId
      )
      parentFolderId = folderResult.folderId
    }

    const doc = await this.adapters.project.createDoc(
      projectId,
      fileName,
      parentFolderId,
      this.userId
    )

    if (content) {
      const lines = content.split('\n')
      await this.adapters.document._callSetDocAPI(
        projectId,
        doc._id,
        lines,
        this.userId,
        0
      )
    }

    this.adapters.project.clearCache(projectId)
    return { success: true, newVersion: 1, wasRebased: false }
  }

  /**
   * Apply a 'delete' change: delete entity from project.
   */
  async _applyDeleteChange(change) {
    const { projectId, entityId, entityType } = change

    await this.adapters.project.deleteEntity(
      projectId,
      entityId,
      entityType,
      this.userId
    )

    this.adapters.project.clearCache(projectId)
    return { success: true, newVersion: 0, wasRebased: false }
  }

  /**
   * Format the tool result output for an applied (accepted) change.
   */
  _formatAppliedOutput(change, applyResult) {
    const changeType = change.type || 'edit'
    const path = change.path || '(document)'
    switch (changeType) {
      case 'edit':
        return `Edit applied successfully to ${path} (version ${applyResult.newVersion}).`
      case 'create':
        return `File created successfully: ${path}.`
      case 'delete':
        return `File deleted successfully: ${path}.`
      default:
        return `Change applied successfully.`
    }
  }

  /**
   * Execute real read_document calls for selection references.
   * This populates sessionState.readDocuments so subsequent edit_document calls pass
   * the read-before-write check, and produces LLM messages showing the read results.
   *
   * Strategy: deduplicate by path (one full read per unique file to register version),
   * then build per-reference tool results focused on the selected line range.
   *
   * @param {object} context - Context containing references
   * @param {object} sessionState - Session state with readDocuments Map
   * @returns {Promise<Array>} Messages to inject into LLM conversation
   */
  async _executeSelectionReads(context, sessionState) {
    const selectionRefs = (context.references || []).filter(r => r.type === 'selection')
    if (selectionRefs.length === 0) return []

    const limitedRefs = selectionRefs.slice(0, MAX_SELECTION_REFERENCES)
    if (selectionRefs.length > MAX_SELECTION_REFERENCES) {
      logger.warn(
        { sessionId: this.sessionId, total: selectionRefs.length, kept: limitedRefs.length },
        'Selection references truncated'
      )
    }

    const readTool = this.toolRegistry.get('read_document')
    if (!readTool) return []

    // Build the tool execution context (same structure as _executeToolCore)
    const toolContext = {
      sessionId: this.sessionId,
      projectId: this.projectId,
      currentDocId: this.currentDocId,
      currentDocPath: this.currentDocPath,
      userId: this.userId,
      sessionState,
      adapters: this.adapters,
    }

    // Phase 1: Deduplicate by path — one full read per unique file.
    // This registers sessionState.readDocuments with the correct version.
    const readCache = new Map() // path -> { success, result }
    const uniquePaths = [...new Set(limitedRefs.map(r => r.path))]

    for (const path of uniquePaths) {
      try {
        const result = await readTool.execute({ path }, toolContext)
        readCache.set(path, { success: result.success !== false, result })
      } catch (error) {
        logger.warn(
          { err: error, path, sessionId: this.sessionId },
          'Failed to execute read_document for selection reference'
        )
        readCache.set(path, { success: false, result: null })
      }
    }

    // Phase 2: Build per-reference messages focused on the selected line range.
    const toolCalls = []
    const toolResults = []

    for (let i = 0; i < limitedRefs.length; i++) {
      const ref = limitedRefs[i]
      const cached = readCache.get(ref.path)
      if (!cached || !cached.success) continue

      const toolCallId = `ref-sel-${i}`
      const startLine = ref.startLine || 1
      const endLine = ref.endLine || startLine

      // Build focused output: use selectionText if available (it's the exact
      // content the user selected), falling back to the full read result.
      const MAX_SELECTION_CHARS = settings.aiAssistant?.maxSelectionChars || 16000
      let content
      if (ref.selectionText) {
        const selText = ref.selectionText.length > MAX_SELECTION_CHARS
          ? ref.selectionText.slice(0, MAX_SELECTION_CHARS) + '\n[...selection truncated]'
          : ref.selectionText
        const filePath = ref.path.startsWith('/') ? ref.path : `/${ref.path}`
        const lines = selText.split('\n')
        const padWidth = String(endLine).length
        const numbered = lines
          .map((line, idx) => `${String(startLine + idx).padStart(padWidth, '0')}| ${line}`)
          .join('\n')
        content =
          `Document: ${filePath} (lines ${startLine}-${endLine}):\n\n` +
          numbered +
          `\n\n(Showing lines ${startLine}-${endLine} of user-selected content)`
      } else {
        content = typeof cached.result.output === 'string'
          ? cached.result.output
          : JSON.stringify(cached.result.output)
      }

      toolCalls.push({
        id: toolCallId,
        type: 'function',
        function: {
          name: 'read_document',
          arguments: JSON.stringify({ path: ref.path }),
        },
      })

      toolResults.push({
        role: 'tool',
        tool_call_id: toolCallId,
        content,
      })
    }

    if (toolCalls.length === 0) return []

    return [
      { role: 'assistant', content: null, tool_calls: toolCalls },
      ...toolResults,
    ]
  }

  /**
   * Enrich context with project environment info and document outline.
   * Uses a session-level promptSnapshot to ensure prefix stability across LLM requests.
   * Non-critical: failures are logged and silently ignored.
   */
  async _enrichContext(context) {
    const enriched = { ...context }
    const rootDocId = context.rootDocId

    if (!rootDocId || !this.adapters) return enriched

    try {
      // Check for existing promptSnapshot (frozen at session start)
      const session = await db.aiSessions.findOne(
        { _id: new ObjectId(this.sessionId) },
        { projection: { promptSnapshot: 1 } }
      )

      if (session?.promptSnapshot) {
        // Use snapshot — skip live parsing to preserve prefix stability
        const snap = session.promptSnapshot
        if (snap.projectName) enriched.projectName = snap.projectName
        if (snap.rootDocPath) enriched.rootDocPath = snap.rootDocPath
        if (snap.documentOutline) enriched.documentOutline = snap.documentOutline
        if (snap.fileReferences) enriched.fileReferences = snap.fileReferences
        if (snap.projectRules) enriched.projectRules = snap.projectRules
        return enriched
      }

      // No snapshot (first request) — resolve live and persist
      const rootDocPath = await this.adapters.project.resolveDocIdToPath(
        this.projectId,
        rootDocId
      )
      if (rootDocPath) {
        enriched.rootDocPath = rootDocPath
      }

      // Get document content
      const { content } = await this.adapters.document.getDocumentContent(
        this.projectId,
        rootDocId
      )

      // Extract outline (primary) or file references (fallback)
      const outline = extractOutline(content)
      if (outline) {
        enriched.documentOutline = outline
      } else {
        const refs = extractFileReferences(content)
        if (refs) {
          enriched.fileReferences = refs
        }
      }

      // Fetch project rules from MemoryManager
      try {
        const memoryManager = getMemoryManager()
        if (memoryManager) {
          const rules = await memoryManager.getMemoryContent(this.projectId)
          if (rules) enriched.projectRules = rules
        }
      } catch (err) {
        logger.warn({ err, projectId: this.projectId }, 'Failed to fetch project rules')
      }

      // Persist snapshot for subsequent requests in this session
      await db.aiSessions.updateOne(
        { _id: new ObjectId(this.sessionId) },
        {
          $set: {
            promptSnapshot: {
              projectName: enriched.projectName || null,
              rootDocPath: enriched.rootDocPath || null,
              documentOutline: enriched.documentOutline || null,
              fileReferences: enriched.fileReferences || null,
              projectRules: enriched.projectRules || null,
            },
          },
        }
      )
    } catch (error) {
      logger.warn(
        { err: error, projectId: this.projectId },
        'Failed to enrich context with outline'
      )
    }

    return enriched
  }

}

export function createAgentLoop(options) {
  return new AgentLoop(options)
}

export default AgentLoop
