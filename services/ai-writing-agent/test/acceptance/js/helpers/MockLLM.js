/**
 * MockLLM - Simulates LLM responses for testing
 */
export class MockLLM {
  constructor() {
    this.responses = []
    this.currentIndex = 0
    this.callHistory = []
  }

  /**
   * Add a response to the queue
   * @param {object} response - Response object
   * @param {string} [response.content] - Text content
   * @param {Array} [response.toolCalls] - Tool calls to simulate
   */
  addResponse(response) {
    this.responses.push(response)
    return this
  }

  /**
   * Add a text-only response
   * @param {string} content - Text content
   */
  addTextResponse(content) {
    return this.addResponse({ content, toolCalls: null })
  }

  /**
   * Add a response with tool calls
   * @param {string} content - Text content (can be null)
   * @param {Array} toolCalls - Tool calls
   */
  addToolCallResponse(content, toolCalls) {
    return this.addResponse({ content, toolCalls })
  }

  /**
   * Simulate chat completion
   * @param {object} options - Chat options
   * @returns {Promise|AsyncGenerator}
   */
  async chat(options) {
    const { messages, tools, stream } = options

    // Record the call
    this.callHistory.push({ messages, tools, stream })

    // Get next response
    const response = this.responses[this.currentIndex] || {
      content: 'Mock response',
      toolCalls: null,
    }
    this.currentIndex++

    if (stream) {
      return this._streamResponse(response)
    }

    return {
      content: response.content,
      toolCalls: response.toolCalls,
      finishReason: response.toolCalls ? 'tool_calls' : 'stop',
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    }
  }

  /**
   * Generate streaming response
   */
  async *_streamResponse(response) {
    // Yield text content in chunks
    if (response.content) {
      const words = response.content.split(' ')
      for (const word of words) {
        yield { type: 'text', content: word + ' ' }
        // Simulate delay
        await this._sleep(1)
      }
    }

    // Yield tool calls
    if (response.toolCalls) {
      for (const toolCall of response.toolCalls) {
        yield { type: 'tool_call', toolCall }
      }
    }

    // Yield done event
    yield {
      type: 'done',
      content: response.content,
      toolCalls: response.toolCalls || [],
      finishReason: response.toolCalls ? 'tool_calls' : 'stop',
    }
  }

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
  }

  /**
   * Reset the mock
   */
  reset() {
    this.responses = []
    this.currentIndex = 0
    this.callHistory = []
  }

  /**
   * Get all recorded calls
   */
  getCalls() {
    return this.callHistory
  }

  /**
   * Get the last recorded call
   */
  getLastCall() {
    return this.callHistory[this.callHistory.length - 1]
  }
}

/**
 * Create a mock tool call object
 */
export function createMockToolCall(name, args, id = null) {
  return {
    id: id || `call_${Date.now()}`,
    type: 'function',
    function: {
      name,
      arguments: typeof args === 'string' ? args : JSON.stringify(args),
    },
  }
}

export default MockLLM
