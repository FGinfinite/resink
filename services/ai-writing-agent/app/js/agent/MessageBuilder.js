/**
 * Helper class for building messages in OpenAI chat format
 */
export class MessageBuilder {
  constructor() {
    this.messages = []
  }

  /**
   * Add a system message
   * @param {string} content - Message content
   * @returns {MessageBuilder}
   */
  system(content) {
    this.messages.push({
      role: 'system',
      content,
    })
    return this
  }

  /**
   * Add a user message
   * @param {string} content - Message content
   * @returns {MessageBuilder}
   */
  user(content) {
    this.messages.push({
      role: 'user',
      content,
    })
    return this
  }

  /**
   * Add an assistant message
   * @param {string} content - Message content
   * @param {Array} toolCalls - Optional tool calls
   * @returns {MessageBuilder}
   */
  assistant(content, toolCalls = null) {
    const message = {
      role: 'assistant',
      content,
    }
    if (toolCalls) {
      message.tool_calls = toolCalls
    }
    this.messages.push(message)
    return this
  }

  /**
   * Add a tool result message
   * @param {string} toolCallId - Tool call ID
   * @param {string} content - Tool result content
   * @returns {MessageBuilder}
   */
  tool(toolCallId, content) {
    this.messages.push({
      role: 'tool',
      tool_call_id: toolCallId,
      content,
    })
    return this
  }

  /**
   * Add multiple messages
   * @param {Array} messages - Messages to add
   * @returns {MessageBuilder}
   */
  addAll(messages) {
    this.messages.push(...messages)
    return this
  }

  /**
   * Get the built messages array
   * @returns {Array}
   */
  build() {
    return [...this.messages]
  }

  /**
   * Clear all messages
   * @returns {MessageBuilder}
   */
  clear() {
    this.messages = []
    return this
  }

  /**
   * Get the number of messages
   * @returns {number}
   */
  get length() {
    return this.messages.length
  }
}

/**
 * Create a tool call object in OpenAI format
 * @param {string} id - Tool call ID
 * @param {string} name - Function name
 * @param {object} args - Function arguments
 * @returns {object}
 */
export function createToolCall(id, name, args) {
  return {
    id,
    type: 'function',
    function: {
      name,
      arguments: typeof args === 'string' ? args : JSON.stringify(args),
    },
  }
}

/**
 * Create a new MessageBuilder instance
 * @returns {MessageBuilder}
 */
export function createMessageBuilder() {
  return new MessageBuilder()
}

export default MessageBuilder
