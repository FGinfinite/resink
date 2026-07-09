import logger from '@overleaf/logger'
import settings from '@overleaf/settings'
import OError from '@overleaf/o-error'

const DEFAULT_STREAM_LIMITS = {
  maxBufferChars: settings.llmStream?.maxBufferChars || 512 * 1024,
  maxContentChars: settings.llmStream?.maxContentChars || 2 * 1024 * 1024,
  maxToolArgsChars: settings.llmStream?.maxToolArgsChars || 512 * 1024,
}

function parseRetryAfterMs(value) {
  if (!value || typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null

  const seconds = Number(trimmed)
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000
  }

  const dateMs = Date.parse(trimmed)
  if (!Number.isNaN(dateMs)) {
    const delta = dateMs - Date.now()
    return delta > 0 ? delta : 0
  }

  return null
}

export class LLMError extends OError {}
export class LLMTimeoutError extends LLMError {}
export class LLMRateLimitError extends LLMError {}
export class LLMAuthError extends LLMError {}
export class LLMContextOverflowError extends LLMError {}
export class LLMBufferOverflowError extends LLMError {}

export class LLMAdapter {
  constructor(options = {}) {
    // Normalize: strip trailing slash to avoid double-slash URLs
    // (e.g. "https://api.example.com/" + "/chat/completions")
    const apiBase = (options.apiBase || '').replace(/\/+$/, '')
    if (apiBase && !/^https?:\/\/.+/.test(apiBase)) {
      throw new LLMError(
        `Invalid apiBase URL: "${options.apiBase}". Must start with http:// or https://.`
      )
    }
    this.apiBase = apiBase
    this.apiKey = options.apiKey || ''
    this.model = options.model || ''
    this.maxTokens = options.maxTokens || 0          // 0 = don't send max_tokens
    this.temperature = options.temperature ?? null    // null = don't send temperature
    this.timeout = options.timeout || 60000           // network timeout: hardcoded fallback
    this.retryAttempts = options.retryAttempts ?? 3
    this.retryDelay = options.retryDelay || 1000
    this.maxRetryTimeMs = options.maxRetryTimeMs || 120000
    this.proxy = options.proxy || ''
    this._proxyAgentInstance = null
    this._supportsImage = options.supportsImage ?? false
    this.extraBody = options.extraBody || {}
    this.maxCompletionTokens = options.maxCompletionTokens || 0
    this.maxToolCallTemperature = options.maxToolCallTemperature ?? null
  }

  /**
   * Get or create the proxy agent for this instance
   */
  async _getProxyAgent() {
    if (!this.proxy) return null
    if (!this._proxyAgentInstance) {
      const { ProxyAgent } = await import('undici')
      this._proxyAgentInstance = new ProxyAgent(this.proxy)
      logger.info({ proxyEnabled: !!this.proxy }, 'LLM proxy agent initialized')
    }
    return this._proxyAgentInstance
  }

  /**
   * Fetch with optional proxy support (per-instance)
   */
  async _fetchWithProxy(url, options) {
    const agent = await this._getProxyAgent()
    if (agent) {
      const { fetch: proxyFetch } = await import('undici')
      return proxyFetch(url, { ...options, dispatcher: agent })
    }
    return fetch(url, options)
  }

  /**
   * Make a chat completion request to the LLM
   * @param {object} options - Chat options
   * @param {Array} options.messages - Array of message objects
   * @param {Array} [options.tools] - Array of tool definitions (OpenAI function calling format)
   * @param {boolean} [options.stream=false] - Whether to use streaming
   * @returns {AsyncGenerator|Promise} - AsyncGenerator for streaming, Promise for non-streaming
   */
  async chat(options) {
    const {
      messages, tools, stream = false, toolChoice,
      maxTokens, maxCompletionTokens, temperature, signal, extraBody,
    } = options

    const body = {
      model: this.model,
      messages,
      // Pass through any extra provider-specific parameters (e.g. disable_reasoning)
      ...extraBody,
    }

    // Only send temperature when a value is explicitly set
    const effectiveTemp = temperature ?? this.temperature
    if (effectiveTemp !== null && effectiveTemp !== undefined) {
      body.temperature = effectiveTemp
    }

    // For reasoning models, max_tokens includes thinking tokens — use
    // max_completion_tokens to cap only the visible output instead.
    if (maxCompletionTokens) {
      body.max_completion_tokens = maxCompletionTokens
    } else if (this.maxTokens) {
      body.max_tokens = maxTokens || this.maxTokens
    }

    if (tools && tools.length > 0) {
      body.tools = tools
      body.tool_choice = toolChoice || 'auto'
      // Cap temperature when tools are available to balance creativity and reliability
      if (this.maxToolCallTemperature !== null && body.temperature !== undefined) {
        body.temperature = Math.min(body.temperature, this.maxToolCallTemperature)
      }
    }

    if (stream) {
      body.stream = true
      body.stream_options = { include_usage: true }
      return this._streamChat(body, signal)
    }

    return this._nonStreamChat(body, signal)
  }

  /**
   * Non-streaming chat completion
   */
  async _nonStreamChat(body, externalSignal) {
    const deadline = Date.now() + this.maxRetryTimeMs
    const response = await this._makeRequest(body, 1, externalSignal, deadline)
    const data = await response.json()

    if (!data.choices || data.choices.length === 0) {
      throw new LLMError('No choices returned from LLM')
    }

    const choice = data.choices[0]
    const message = choice.message

    return {
      content: message.content,
      toolCalls: message.tool_calls || null,
      finishReason: choice.finish_reason,
      usage: data.usage,
    }
  }

  /**
   * Streaming chat completion - returns an AsyncGenerator
   */
  async *_streamChat(body, externalSignal) {
    const deadline = Date.now() + this.maxRetryTimeMs
    const response = await this._makeRequest(body, 1, externalSignal, deadline)

    if (!response.body) {
      throw new LLMError('No response body for streaming')
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()

    // Re-wire external signal for stream reading phase
    // (_makeRequest removes its listener in finally, so we need our own)
    let onExternalAbort
    if (externalSignal) {
      onExternalAbort = () => reader.cancel()
      externalSignal.addEventListener('abort', onExternalAbort)
    }

    let buffer = ''
    let currentContent = ''
    let contentTruncated = false
    const currentToolCalls = []
    let finishReason = null
    let lastUsage = null

    // Per-chunk stall timeout: abort if no data arrives within timeout period
    const stallTimeoutMs = this.timeout

    try {
      while (true) {
        let stallTimer
        const { done, value } = await Promise.race([
          reader.read(),
          new Promise((_resolve, reject) => {
            stallTimer = setTimeout(
              () => reject(new LLMTimeoutError('Stream stalled — no data received', { timeout: stallTimeoutMs })),
              stallTimeoutMs
            )
          }),
        ]).finally(() => clearTimeout(stallTimer))

        if (done) break

        buffer += decoder.decode(value, { stream: true })

        // Guard: abort if unparsed buffer grows beyond safe limit
        if (buffer.length > DEFAULT_STREAM_LIMITS.maxBufferChars) {
          throw new LLMBufferOverflowError(
            `SSE buffer exceeded ${DEFAULT_STREAM_LIMITS.maxBufferChars} chars`,
            { bufferLength: buffer.length }
          )
        }

        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          const trimmed = line.trim()

          if (!trimmed || trimmed === 'data: [DONE]') {
            continue
          }

          if (!trimmed.startsWith('data: ')) {
            continue
          }

          const jsonStr = trimmed.slice(6)

          try {
            const chunk = JSON.parse(jsonStr)

            // Capture usage data (sent in the final chunk with stream_options)
            if (chunk.usage) {
              lastUsage = chunk.usage
            }

            const delta = chunk.choices?.[0]?.delta

            if (!delta) continue

            // Handle thinking/reasoning content (OpenAI-compatible reasoning models)
            // Some providers use `reasoning_content`, others use `reasoning`
            const reasoningText = delta.reasoning_content || delta.reasoning
            if (reasoningText) {
              yield {
                type: 'thinking',
                content: reasoningText,
              }
            }

            // Handle text content
            if (delta.content) {
              currentContent += delta.content

              // Guard: truncate accumulated content if it exceeds the safe limit
              if (currentContent.length > DEFAULT_STREAM_LIMITS.maxContentChars) {
                const excess = currentContent.length - DEFAULT_STREAM_LIMITS.maxContentChars
                currentContent = currentContent.slice(excess)
                contentTruncated = true
                logger.warn(
                  { excessChars: excess, maxContentChars: DEFAULT_STREAM_LIMITS.maxContentChars },
                  'SSE content exceeded limit, truncated to retain tail'
                )
              }

              yield {
                type: 'text',
                content: delta.content,
              }
            }

            // Handle tool calls
            if (delta.tool_calls) {
              for (const toolCall of delta.tool_calls) {
                const index = toolCall.index

                if (!currentToolCalls[index]) {
                  currentToolCalls[index] = {
                    id: toolCall.id || '',
                    type: 'function',
                    function: {
                      name: toolCall.function?.name || '',
                      arguments: '',
                    },
                  }
                }

                if (toolCall.function?.name) {
                  currentToolCalls[index].function.name = toolCall.function.name
                }

                if (toolCall.function?.arguments) {
                  const cur = currentToolCalls[index].function.arguments
                  if (cur.length + toolCall.function.arguments.length > DEFAULT_STREAM_LIMITS.maxToolArgsChars) {
                    throw new LLMBufferOverflowError(
                      `Tool call arguments exceeded ${DEFAULT_STREAM_LIMITS.maxToolArgsChars} chars`,
                      { index, argsLength: cur.length + toolCall.function.arguments.length }
                    )
                  }
                  currentToolCalls[index].function.arguments +=
                    toolCall.function.arguments
                }

                if (toolCall.id) {
                  currentToolCalls[index].id = toolCall.id
                }
              }
            }

            // Track finish reason
            if (chunk.choices?.[0]?.finish_reason) {
              finishReason = chunk.choices[0].finish_reason
            }
          } catch (parseError) {
            logger.warn(
              { err: parseError, jsonStrLength: jsonStr?.length },
              'Failed to parse SSE JSON chunk'
            )
          }
        }
      }
    } finally {
      try {
        reader.cancel()
      } catch {
        // ignore cancel errors
      }
      reader.releaseLock()
      if (externalSignal && onExternalAbort) {
        externalSignal.removeEventListener('abort', onExternalAbort)
      }
    }

    // Yield completed tool calls at the end
    if (currentToolCalls.length > 0) {
      for (const toolCall of currentToolCalls) {
        if (toolCall && toolCall.function.name) {
          yield {
            type: 'tool_call',
            toolCall,
          }
        }
      }
    }

    // Yield final summary
    yield {
      type: 'done',
      content: currentContent,
      toolCalls: currentToolCalls.filter(Boolean),
      finishReason,
      usage: lastUsage || null,
      ...(contentTruncated && { truncated: true }),
    }
  }

  /**
   * Make HTTP request with retry logic
   * @param {object} body - Request body
   * @param {number} attempt - Current attempt number
   * @param {AbortSignal} [externalSignal] - External abort signal
   * @param {number} [deadline] - Absolute timestamp (ms) after which retries are forbidden
   */
  async _makeRequest(body, attempt = 1, externalSignal, deadline) {
    // If external signal is already aborted, bail out immediately
    if (externalSignal?.aborted) {
      const err = new Error('Aborted')
      err.name = 'AbortError'
      throw err
    }

    // Check global retry deadline before each attempt
    if (deadline && Date.now() >= deadline) {
      throw new LLMTimeoutError('LLM retry deadline exceeded', {
        maxRetryTimeMs: this.maxRetryTimeMs,
        attempt,
      })
    }

    const url = `${this.apiBase}/chat/completions`

    // Clamp per-request timeout to remaining time before deadline
    const remaining = deadline ? deadline - Date.now() : Infinity
    const effectiveTimeout = Math.min(this.timeout, remaining)
    if (effectiveTimeout <= 0) {
      throw new LLMTimeoutError('LLM retry deadline exceeded', {
        maxRetryTimeMs: this.maxRetryTimeMs,
        attempt,
      })
    }

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), effectiveTimeout)

    // Wire external signal to internal controller
    let onExternalAbort
    if (externalSignal) {
      onExternalAbort = () => controller.abort()
      externalSignal.addEventListener('abort', onExternalAbort)
    }

    try {
      const response = await this._fetchWithProxy(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })

      clearTimeout(timeoutId)

      if (!response.ok) {
        // _handleErrorResponse either throws (non-retryable) or returns a new
        // response from a successful retry.  We must use that returned response
        // because the original response's body has already been consumed by
        // response.text() inside _handleErrorResponse, which locks the
        // ReadableStream and makes it unusable for streaming.
        return await this._handleErrorResponse(response, body, attempt, externalSignal, deadline)
      }

      return response
    } catch (error) {
      clearTimeout(timeoutId)

      if (error.name === 'AbortError') {
        // Distinguish external abort from internal timeout
        if (externalSignal?.aborted) {
          const abortErr = new Error('Aborted')
          abortErr.name = 'AbortError'
          throw abortErr
        }
        throw new LLMTimeoutError('LLM request timed out', { timeout: this.timeout })
      }

      // Don't retry or wrap already-classified errors.
      if (
        error instanceof LLMContextOverflowError ||
        error instanceof LLMAuthError ||
        error instanceof LLMRateLimitError ||
        error instanceof LLMTimeoutError ||
        error instanceof LLMBufferOverflowError
      ) {
        throw error
      }

      // Classify network-level errors that will never succeed on retry
      const nonRetryable = [
        'ENOTFOUND',
        'ECONNREFUSED',
        'ECONNRESET',
        'ERR_TLS_CERT_ALTNAME_INVALID',
      ]
      const syscallCode = error.cause?.code || error.code
      if (nonRetryable.includes(syscallCode)) {
        throw new LLMError(
          `Cannot reach LLM API at ${this.apiBase}: ${syscallCode}. ` +
            'Check your OPENAI_API_BASE setting and network connectivity.',
          { cause: error, code: syscallCode }
        )
      }

      if (attempt < this.retryAttempts) {
        const delay = this.retryDelay * Math.pow(2, attempt - 1)
        // Check if the delay would exceed the global deadline
        if (deadline && Date.now() + delay >= deadline) {
          throw new LLMTimeoutError('LLM retry deadline exceeded', {
            maxRetryTimeMs: this.maxRetryTimeMs,
            attempt,
          })
        }
        logger.warn(
          { err: error, attempt, delay },
          'LLM request failed, retrying'
        )
        await this._sleep(delay)
        return this._makeRequest(body, attempt + 1, externalSignal, deadline)
      }

      throw new LLMError('LLM request failed', { cause: error })
    } finally {
      if (externalSignal && onExternalAbort) {
        externalSignal.removeEventListener('abort', onExternalAbort)
      }
    }
  }

  async _handleErrorResponse(response, body, attempt, externalSignal, deadline) {
    const errorBody = await response.text()
    let errorData
    try {
      errorData = JSON.parse(errorBody)
    } catch {
      errorData = { error: { message: errorBody } }
    }

    const errorMessage = errorData.error?.message || 'Unknown error'

    // Detect context overflow errors (covers major providers)
    const OVERFLOW_PATTERNS = [
      /prompt is too long/i,
      /exceeds the context window/i,
      /maximum context length/i,
      /input is too long/i,
      /reduce the length of the messages/i,
      /token count.*exceeds/i,
      /context.?length.?exceeded/i,
    ]
    if (response.status === 400 && OVERFLOW_PATTERNS.some(p => p.test(errorMessage))) {
      throw new LLMContextOverflowError(this._sanitizeProviderError(errorMessage), { status: 400 })
    }

    // Handle specific error codes
    if (response.status === 401) {
      throw new LLMAuthError('Authentication failed', { status: 401 })
    }

    if (response.status === 429) {
      if (attempt < this.retryAttempts) {
        const retryAfterHeader = response.headers.get('retry-after')
        const retryAfter = parseRetryAfterMs(retryAfterHeader) ??
          this.retryDelay * Math.pow(2, attempt)
        // Check if the delay would exceed the global deadline
        if (deadline && Date.now() + retryAfter >= deadline) {
          throw new LLMTimeoutError('LLM retry deadline exceeded during rate limit backoff', {
            maxRetryTimeMs: this.maxRetryTimeMs,
            attempt,
          })
        }
        logger.warn({ attempt, retryAfter }, 'Rate limited, retrying')
        await this._sleep(retryAfter)
        return this._makeRequest(body, attempt + 1, externalSignal, deadline)
      }
      throw new LLMRateLimitError('Rate limit exceeded', { status: 429 })
    }

    if (response.status >= 500 && attempt < this.retryAttempts) {
      const delay = this.retryDelay * Math.pow(2, attempt - 1)
      // Check if the delay would exceed the global deadline
      if (deadline && Date.now() + delay >= deadline) {
        throw new LLMTimeoutError('LLM retry deadline exceeded during server error backoff', {
          maxRetryTimeMs: this.maxRetryTimeMs,
          attempt,
        })
      }
      logger.warn({ status: response.status, attempt, delay }, 'Server error, retrying')
      await this._sleep(delay)
      return this._makeRequest(body, attempt + 1, externalSignal, deadline)
    }

    throw new LLMError(this._sanitizeProviderError(errorMessage), {
      status: response.status,
    })
  }

  /**
   * Check if the configured LLM supports image inputs
   * @returns {boolean}
   */
  supportsImage() {
    return this._supportsImage
  }

  /**
   * Sanitize provider error messages to prevent information leakage.
   * Removes internal paths, URLs, and limits message length.
   */
  _sanitizeProviderError(message) {
    if (!message || typeof message !== 'string') return 'LLM request failed'
    return message
      .replace(/https?:\/\/[^\s"')]+/g, '[url]')
      .replace(/\/[\w\-/.]+/g, '[path]')
      .replace(/sk-[a-zA-Z0-9]+/g, '[key]')
      .trim()
      .slice(0, 200)
  }

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
  }
}

export default LLMAdapter
