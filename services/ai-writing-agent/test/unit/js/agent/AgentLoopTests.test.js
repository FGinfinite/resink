import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock @overleaf/settings
vi.mock('@overleaf/settings', () => ({
  default: {
    agent: {
      maxTurns: 10,
      maxToolCalls: 20,
    },
    compaction: {
      enabled: true,
      contextWindow: 100000,
      threshold: 0.7,
      summaryMaxTokens: 2048,
    },
  },
}))

// Mock @overleaf/logger
vi.mock('@overleaf/logger', () => ({
  default: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    log: vi.fn(),
  },
}))

// Mock @overleaf/o-error
vi.mock('@overleaf/o-error', () => {
  class OError extends Error {
    constructor(message, info) {
      super(message)
      this.name = this.constructor.name
      this.info = info
    }
  }
  return { default: OError }
})

// Mock mongodb
const mockAgentFindOne = vi.fn()
const mockAgentUpdateOne = vi.fn()
const mockAiMessagesCountDocuments = vi.fn()
vi.mock('../../../../app/js/mongodb.js', () => ({
  db: {
    aiSessions: {
      findOne: (...args) => mockAgentFindOne(...args),
      updateOne: (...args) => mockAgentUpdateOne(...args),
    },
    aiMessages: {
      countDocuments: (...args) => mockAiMessagesCountDocuments(...args),
    },
  },
  ObjectId: class ObjectId {
    constructor(id) { this.id = id || 'test-id' }
    toString() { return this.id }
  },
}))

// Mock prompt/system.js
const mockBuildSystemPrompt = vi.fn().mockResolvedValue('System prompt')
vi.mock('../../../../app/js/prompt/system.js', () => ({
  buildSystemPrompt: (...args) => mockBuildSystemPrompt(...args),
}))

// Mock util/outline.js
const mockExtractOutline = vi.fn()
const mockExtractFileReferences = vi.fn()
vi.mock('../../../../app/js/util/outline.js', () => ({
  extractOutline: (...args) => mockExtractOutline(...args),
  extractFileReferences: (...args) => mockExtractFileReferences(...args),
}))

const { AgentLoop } = await import(
  '../../../../app/js/agent/AgentLoop.js'
)

/**
 * MockLLM - inline mock for vitest
 */
class MockLLM {
  constructor() {
    this.responses = []
    this.currentIndex = 0
    this.chatCalls = []
  }

  addResponse(response) {
    this.responses.push(response)
    return this
  }

  addTextResponse(content, finishReason = 'stop', usage = null) {
    return this.addResponse({ content, toolCalls: null, finishReason, usage })
  }

  addToolCallResponse(content, toolCalls, finishReason = 'tool_calls', usage = null) {
    return this.addResponse({ content, toolCalls, finishReason, usage })
  }

  async chat(options) {
    this.chatCalls.push(options)
    const response = this.responses[this.currentIndex] || {
      content: 'Default mock response',
      toolCalls: null,
      finishReason: 'stop',
    }
    this.currentIndex++

    if (options.stream) {
      return this._streamResponse(response)
    }

    return {
      content: response.content,
      toolCalls: response.toolCalls,
      finishReason: response.toolCalls ? 'tool_calls' : 'stop',
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }
  }

  async *_streamResponse(response) {
    if (response.content) {
      yield { type: 'text', content: response.content }
    }

    if (response.toolCalls) {
      for (const toolCall of response.toolCalls) {
        yield { type: 'tool_call', toolCall }
      }
    }

    yield {
      type: 'done',
      content: response.content,
      toolCalls: response.toolCalls || [],
      finishReason: response.finishReason || (response.toolCalls ? 'tool_calls' : 'stop'),
      usage: response.usage || null,
    }
  }
}

function createMockToolCall(name, args, id) {
  return {
    id: id || `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    type: 'function',
    function: {
      name,
      arguments: typeof args === 'string' ? args : JSON.stringify(args),
    },
  }
}

/**
 * Simple mock tool for testing
 */
function createMockTool(name, executeFn) {
  return {
    name,
    validateArgs: args => args,
    execute: executeFn || (async () => ({ success: true, output: `${name} executed` })),
  }
}

describe('AgentLoop', () => {
  let mockLLM
  let mockToolRegistry
  let mockContextManager
  let mockAdapters

  beforeEach(() => {
    mockLLM = new MockLLM()

    mockAgentFindOne.mockReset()
    mockAgentUpdateOne.mockReset()
    mockAiMessagesCountDocuments.mockReset()
    mockBuildSystemPrompt.mockReset().mockResolvedValue('System prompt')
    mockExtractOutline.mockReset()
    mockExtractFileReferences.mockReset()
    // Default: no promptSnapshot
    mockAgentFindOne.mockResolvedValue(null)
    mockAgentUpdateOne.mockResolvedValue({ modifiedCount: 1 })
    mockAiMessagesCountDocuments.mockResolvedValue(0)

    mockToolRegistry = {
      get: vi.fn(),
      getTools: vi.fn().mockReturnValue([]),
      getNames: vi.fn().mockReturnValue(['read_document', 'edit_document', 'list_files']),
    }

    mockContextManager = {
      buildMessages: vi.fn().mockResolvedValue([
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'Hello' },
      ]),
      needsCompaction: vi.fn().mockReturnValue(false),
      compactHistory: vi.fn().mockResolvedValue({ success: false }),
      getConversationHistory: vi.fn().mockResolvedValue([]),
      emergencyTruncate: vi.fn(messages => messages),
    }

    mockAdapters = {
      document: {},
    }
  })

  function createAgentLoop(overrides = {}) {
    return new AgentLoop({
      sessionId: 'session-1',
      projectId: 'proj-1',
      llmAdapter: mockLLM,
      toolRegistry: mockToolRegistry,
      contextManager: mockContextManager,
      adapters: mockAdapters,
      ...overrides,
    })
  }

  async function collectEvents(generator) {
    const events = []
    for await (const event of generator) {
      events.push(event)
    }
    return events
  }

  describe('finish_reason=stop pure text termination', () => {
    it('ends loop with done when model returns text with finish_reason=stop', async () => {
      mockLLM.addTextResponse('Hello! How can I help you today?', 'stop')

      const loop = createAgentLoop()
      const events = await collectEvents(loop.run('Hi'))

      const textEvents = events.filter(e => e.type === 'text')
      expect(textEvents).toHaveLength(1)
      expect(textEvents[0].content).toBe('Hello! How can I help you today?')

      const doneEvents = events.filter(e => e.type === 'done')
      expect(doneEvents).toHaveLength(1)
      expect(doneEvents[0].content).toBe('Hello! How can I help you today?')
    })

    it('ends loop with done when finish_reason=length', async () => {
      mockLLM.addTextResponse('A very long response...', 'length')

      const loop = createAgentLoop()
      const events = await collectEvents(loop.run('Tell me a story'))

      const doneEvents = events.filter(e => e.type === 'done')
      expect(doneEvents).toHaveLength(1)
      expect(doneEvents[0].content).toBe('A very long response...')
    })

    it('handles empty content with finish_reason=stop', async () => {
      mockLLM.addTextResponse('', 'stop')

      const loop = createAgentLoop()
      const events = await collectEvents(loop.run('Hi'))

      const doneEvents = events.filter(e => e.type === 'done')
      expect(doneEvents).toHaveLength(1)
      expect(doneEvents[0].content).toBe('')
    })
  })

  describe('finish_reason=tool_calls continues loop', () => {
    it('continues loop when tool calls are present then ends with text', async () => {
      const toolCall = createMockToolCall('read_document', { path: 'main.tex' })

      mockLLM
        .addToolCallResponse('Let me read that.', [toolCall], 'tool_calls')
        .addTextResponse('Done reading. Here is a summary.', 'stop')

      const readTool = createMockTool('read_document')
      mockToolRegistry.get.mockImplementation(name => {
        if (name === 'read_document') return readTool
        return undefined
      })

      const loop = createAgentLoop()
      const events = await collectEvents(loop.run('Read my doc'))

      const toolResults = events.filter(e => e.type === 'tool_result')
      expect(toolResults).toHaveLength(1)
      expect(toolResults[0].toolName).toBe('read_document')

      const doneEvents = events.filter(e => e.type === 'done')
      expect(doneEvents).toHaveLength(1)
      expect(doneEvents[0].content).toBe('Done reading. Here is a summary.')
    })

    it('handles anomaly: no tool calls with unexpected finish_reason', async () => {
      // finish_reason=tool_calls but no actual tools returned
      mockLLM.addTextResponse('Confused response', 'tool_calls')

      const loop = createAgentLoop()
      const events = await collectEvents(loop.run('Hi'))

      const doneEvents = events.filter(e => e.type === 'done')
      expect(doneEvents).toHaveLength(1)
      expect(doneEvents[0].content).toBe('Confused response')
    })

    it('handles anomaly: no tool calls with null finish_reason', async () => {
      mockLLM.addResponse({ content: 'Something', toolCalls: null, finishReason: null })

      const loop = createAgentLoop()
      const events = await collectEvents(loop.run('Hi'))

      const doneEvents = events.filter(e => e.type === 'done')
      expect(doneEvents).toHaveLength(1)
      expect(doneEvents[0].content).toBe('Something')
    })
  })

  describe('streaming text is yielded directly', () => {
    it('yields LLM text content in real-time during tool call turns', async () => {
      const toolCall = createMockToolCall('read_document', { path: 'main.tex' })

      mockLLM
        .addToolCallResponse('Let me read the document first.', [toolCall], 'tool_calls')
        .addTextResponse('Summary of the document.', 'stop')

      const readTool = createMockTool('read_document')
      mockToolRegistry.get.mockImplementation(name => {
        if (name === 'read_document') return readTool
        return undefined
      })

      const loop = createAgentLoop()
      const events = await collectEvents(loop.run('Read my doc'))

      const textEvents = events.filter(e => e.type === 'text')
      expect(textEvents.length).toBeGreaterThanOrEqual(2)
      expect(textEvents[0].content).toBe('Let me read the document first.')
    })

    it('streams text in multi-turn conversations', async () => {
      const listToolCall = createMockToolCall('list_files', { pattern: '*' })
      const readToolCall = createMockToolCall('read_document', { path: 'a.tex' })

      mockLLM
        .addToolCallResponse('Let me list files.', [listToolCall])
        .addToolCallResponse('Now reading.', [readToolCall])
        .addTextResponse('All done.', 'stop')

      mockToolRegistry.get.mockImplementation(name => {
        return createMockTool(name)
      })

      const loop = createAgentLoop()
      const events = await collectEvents(loop.run('Edit my doc'))

      const textEvents = events.filter(e => e.type === 'text')
      // 'Let me list files.' + 'Now reading.' + 'All done.'
      expect(textEvents.length).toBe(3)
      expect(textEvents[0].content).toBe('Let me list files.')
      expect(textEvents[1].content).toBe('Now reading.')
      expect(textEvents[2].content).toBe('All done.')
    })
  })

  describe('toolChoice parameter', () => {
    it('always uses toolChoice=auto', async () => {
      mockLLM.addTextResponse('Hello!', 'stop')

      const loop = createAgentLoop()
      await collectEvents(loop.run('Hi'))

      for (const call of mockLLM.chatCalls) {
        expect(call.toolChoice).toBe('auto')
      }
    })
  })

  describe('doom loop detection', () => {
    it('detects 3 consecutive identical tool call turns and breaks', async () => {
      // Same tool call 3 times, then a 4th that should not be reached
      for (let i = 0; i < 4; i++) {
        mockLLM.addToolCallResponse(null, [
          createMockToolCall('read_document', { path: 'main.tex' }, `call_read_${i}`),
        ])
      }

      const readTool = createMockTool('read_document')
      mockToolRegistry.get.mockImplementation(name => {
        if (name === 'read_document') return readTool
        return createMockTool(name)
      })

      const loop = createAgentLoop()
      const events = await collectEvents(loop.run('Read'))

      const textEvents = events.filter(e => e.type === 'text')
      expect(textEvents.some(e => e.content.includes('检测到重复操作'))).toBe(true)

      const doneEvents = events.filter(e => e.type === 'done')
      expect(doneEvents).toHaveLength(1)

      // Should have executed only 3 turns of tool calls (doom detected before 4th LLM call)
      const toolResults = events.filter(e => e.type === 'tool_result')
      expect(toolResults).toHaveLength(3)
    })

    it('does not trigger doom loop when tool calls differ', async () => {
      mockLLM
        .addToolCallResponse(null, [
          createMockToolCall('read_document', { path: 'a.tex' }, 'call_1'),
        ])
        .addToolCallResponse(null, [
          createMockToolCall('read_document', { path: 'b.tex' }, 'call_2'),
        ])
        .addToolCallResponse(null, [
          createMockToolCall('read_document', { path: 'c.tex' }, 'call_3'),
        ])
        .addTextResponse('All files read.', 'stop')

      const readTool = createMockTool('read_document')
      mockToolRegistry.get.mockImplementation(name => {
        if (name === 'read_document') return readTool
        return createMockTool(name)
      })

      const loop = createAgentLoop()
      const events = await collectEvents(loop.run('Read files'))

      // No doom loop text
      const textEvents = events.filter(e => e.type === 'text')
      expect(textEvents.every(e => !e.content.includes('检测到重复操作'))).toBe(true)

      // Should complete normally via text response
      const doneEvents = events.filter(e => e.type === 'done')
      expect(doneEvents).toHaveLength(1)
    })
  })

  describe('maxTurns graceful degradation', () => {
    it('sends final summary request without tools when maxTurns exceeded', async () => {
      // Turn 1: tool call (fills the 1 allowed turn)
      mockLLM.addToolCallResponse(null, [
        createMockToolCall('read_document', { path: 'main.tex' }),
      ])
      // Turn 2 (maxTurns exceeded): text-only final response
      mockLLM.addTextResponse('Here is my summary of the work.', 'stop')

      const readTool = createMockTool('read_document')
      mockToolRegistry.get.mockImplementation(name => {
        if (name === 'read_document') return readTool
        return createMockTool(name)
      })

      const loop = createAgentLoop({ maxTurns: 1 })
      const events = await collectEvents(loop.run('Do stuff'))

      // Should NOT throw — graceful degradation instead
      const doneEvents = events.filter(e => e.type === 'done')
      expect(doneEvents).toHaveLength(1)
      expect(doneEvents[0].content).toBe('Here is my summary of the work.')

      // The final LLM call should have empty tools array
      const lastCall = mockLLM.chatCalls[mockLLM.chatCalls.length - 1]
      expect(lastCall.tools).toEqual([])
    })
  })

  describe('max tool calls limit', () => {
    it('gracefully degrades when maxToolCalls exceeded', async () => {
      const toolCalls = Array.from({ length: 3 }, (_, i) =>
        createMockToolCall('read_document', { projectId: 'p1', docId: `d${i}` }, `call_${i}`)
      )

      mockLLM.addToolCallResponse(null, toolCalls)
      // Summary response after graceful degradation
      mockLLM.addTextResponse('Here is a summary of what was done.', 'stop')

      mockToolRegistry.get.mockImplementation(name => createMockTool(name))

      const loop = createAgentLoop({ maxToolCalls: 2 })

      const events = await collectEvents(loop.run('Do stuff'))

      // Should NOT throw — graceful degradation instead
      const doneEvents = events.filter(e => e.type === 'done')
      expect(doneEvents).toHaveLength(1)
      expect(doneEvents[0].content).toBe('Here is a summary of what was done.')

      // The final LLM call should have empty tools array (summary mode)
      const lastCall = mockLLM.chatCalls[mockLLM.chatCalls.length - 1]
      expect(lastCall.tools).toEqual([])
    })
  })

  describe('error handling', () => {
    it('handles tool execution errors gracefully', async () => {
      const toolCall = createMockToolCall('failing_tool', { input: 'test' })

      mockLLM
        .addToolCallResponse(null, [toolCall])
        .addTextResponse('Sorry, the tool failed.', 'stop')

      const failingTool = createMockTool('failing_tool', async () => {
        throw new Error('Tool crashed!')
      })

      mockToolRegistry.get.mockImplementation(name => {
        if (name === 'failing_tool') return failingTool
        return undefined
      })

      const loop = createAgentLoop()
      const events = await collectEvents(loop.run('Call failing tool'))

      const toolResults = events.filter(e => e.type === 'tool_result')
      expect(toolResults[0].result.success).toBe(false)
      expect(toolResults[0].result.output).toContain('Tool execution failed')
    })

    it('returns available tools list for unknown tool name', async () => {
      const toolCall = createMockToolCall('nonexistent_tool', { foo: 'bar' })

      mockLLM
        .addToolCallResponse(null, [toolCall])
        .addTextResponse('Sorry, that tool does not exist.', 'stop')

      mockToolRegistry.get.mockImplementation(() => undefined)

      const loop = createAgentLoop()
      const events = await collectEvents(loop.run('Call unknown tool'))

      const toolResults = events.filter(e => e.type === 'tool_result')
      expect(toolResults[0].result.success).toBe(false)
      expect(toolResults[0].result.output).toContain('Unknown tool "nonexistent_tool"')
      expect(toolResults[0].result.output).toContain('Available tools:')
      expect(toolResults[0].result.output).toContain('read_document')
      expect(toolResults[0].result.output).toContain('Please use one of these')
    })

    it('returns guidance message for invalid JSON arguments', async () => {
      const toolCall = {
        id: 'call_bad_json',
        type: 'function',
        function: {
          name: 'read_document',
          arguments: '{invalid json!!!',
        },
      }

      mockLLM
        .addToolCallResponse(null, [toolCall])
        .addTextResponse('Let me try again with valid JSON.', 'stop')

      mockToolRegistry.get.mockImplementation(name => {
        if (name === 'read_document') return createMockTool(name)
        return undefined
      })

      const loop = createAgentLoop()
      const events = await collectEvents(loop.run('Call with bad args'))

      const toolResults = events.filter(e => e.type === 'tool_result')
      expect(toolResults[0].result.success).toBe(false)
      expect(toolResults[0].result.output).toContain('Invalid JSON in arguments for "read_document"')
      expect(toolResults[0].result.output).toContain('Please rewrite with valid JSON')
    })

    it('returns guidance message for validation errors', async () => {
      const toolCall = createMockToolCall('strict_tool', { wrong: 'args' })

      mockLLM
        .addToolCallResponse(null, [toolCall])
        .addTextResponse('Let me fix the arguments.', 'stop')

      const strictTool = {
        name: 'strict_tool',
        validateArgs: () => {
          const err = new Error('Validation failed')
          err.info = {
            errors: [
              { path: ['field1'], message: 'Required' },
              { path: ['field2'], message: 'Must be a number' },
            ],
          }
          throw err
        },
        execute: async () => ({ success: true, output: 'ok' }),
      }

      mockToolRegistry.get.mockImplementation(name => {
        if (name === 'strict_tool') return strictTool
        return undefined
      })

      const loop = createAgentLoop()
      const events = await collectEvents(loop.run('Call strict tool'))

      const toolResults = events.filter(e => e.type === 'tool_result')
      expect(toolResults[0].result.success).toBe(false)
      expect(toolResults[0].result.error).toBe('VALIDATION_ERROR')
      expect(toolResults[0].result.output).toContain('Tool "strict_tool" arguments invalid')
      expect(toolResults[0].result.output).toContain('field1: Required')
      expect(toolResults[0].result.output).toContain('field2: Must be a number')
    })
  })

  describe('tool execution', () => {
    it('executes tool calls and yields tool_result events', async () => {
      const toolCall = createMockToolCall('read_document', {
        projectId: 'proj-1',
        docId: 'doc-1',
      })

      mockLLM
        .addToolCallResponse(null, [toolCall])
        .addTextResponse('Here is the result.', 'stop')

      const readTool = createMockTool('read_document', async () => ({
        success: true,
        output: 'Document content here',
      }))

      mockToolRegistry.get.mockImplementation(name => {
        if (name === 'read_document') return readTool
        return undefined
      })

      const loop = createAgentLoop()
      const events = await collectEvents(loop.run('Read my doc'))

      const toolResults = events.filter(e => e.type === 'tool_result')
      expect(toolResults).toHaveLength(1)
      expect(toolResults[0].toolName).toBe('read_document')
      expect(toolResults[0].result.success).toBe(true)
      expect(toolResults[0].result.output).toBe('Document content here')
    })

    it('continues loop through multiple tool call turns', async () => {
      const toolCall1 = createMockToolCall('read_document', {
        projectId: 'p1',
        docId: 'd1',
      })
      const toolCall2 = createMockToolCall('edit_document', {
        projectId: 'p1',
        docId: 'd1',
        oldText: 'a',
        newText: 'b',
      })

      mockLLM
        .addToolCallResponse('Reading...', [toolCall1])
        .addToolCallResponse('Editing...', [toolCall2])
        .addTextResponse('Done editing.', 'stop')

      mockToolRegistry.get.mockImplementation(name => {
        return createMockTool(name)
      })

      const loop = createAgentLoop()
      const events = await collectEvents(loop.run('Do stuff'))

      const toolResults = events.filter(e => e.type === 'tool_result')
      expect(toolResults).toHaveLength(2) // read + edit

      const doneEvents = events.filter(e => e.type === 'done')
      expect(doneEvents).toHaveLength(1)
    })
  })

  describe('done event', () => {
    it('yields done event with content from pure text response', async () => {
      mockLLM.addTextResponse('Just a greeting!', 'stop')

      const loop = createAgentLoop()
      const events = await collectEvents(loop.run('Hello'))

      const doneEvents = events.filter(e => e.type === 'done')
      expect(doneEvents).toHaveLength(1)
      expect(doneEvents[0].content).toBe('Just a greeting!')
      expect(doneEvents[0].changeHistory).toEqual([])
    })

    it('yields done event after tool calls followed by text', async () => {
      const toolCall = createMockToolCall('read_document', { path: 'main.tex' })

      mockLLM
        .addToolCallResponse(null, [toolCall])
        .addTextResponse('All done!', 'stop')

      const readTool = createMockTool('read_document')
      mockToolRegistry.get.mockImplementation(name => {
        if (name === 'read_document') return readTool
        return undefined
      })

      const loop = createAgentLoop()
      const events = await collectEvents(loop.run('Hi'))

      const doneEvents = events.filter(e => e.type === 'done')
      expect(doneEvents).toHaveLength(1)
      expect(doneEvents[0].changeHistory).toEqual([])
    })

    it('done event includes readDocuments Map', async () => {
      mockLLM.addTextResponse('Hello!', 'stop')

      const loop = createAgentLoop()
      const events = await collectEvents(loop.run('Hi'))

      const doneEvents = events.filter(e => e.type === 'done')
      expect(doneEvents).toHaveLength(1)
      expect(doneEvents[0].readDocuments).toBeInstanceOf(Map)
    })

    it('done event readDocuments accumulates after tool calls', async () => {
      const toolCall = createMockToolCall('read_document', { path: 'main.tex' })

      mockLLM
        .addToolCallResponse(null, [toolCall])
        .addTextResponse('Done.', 'stop')

      const readTool = createMockTool('read_document', async (args, ctx) => {
        // Simulate what read_document tool does: add to readDocuments
        ctx.sessionState.readDocuments.set('/main.tex', { version: 1 })
        return { success: true, output: 'Content of main.tex' }
      })
      mockToolRegistry.get.mockImplementation(name => {
        if (name === 'read_document') return readTool
        return undefined
      })

      const loop = createAgentLoop()
      const events = await collectEvents(loop.run('Read my doc'))

      const doneEvents = events.filter(e => e.type === 'done')
      expect(doneEvents).toHaveLength(1)
      expect(doneEvents[0].readDocuments).toBeInstanceOf(Map)
      expect(doneEvents[0].readDocuments.get('/main.tex')).toEqual({ version: 1 })
    })
  })

  describe('readDocuments initialization', () => {
    it('run() uses _initialReadDocuments from context when provided', async () => {
      const toolCall = createMockToolCall('edit_document', { path: 'main.tex', oldText: 'a', newText: 'b' })

      mockLLM
        .addToolCallResponse(null, [toolCall])
        .addTextResponse('Edited.', 'stop')

      let capturedSessionState = null
      const editTool = createMockTool('edit_document', async (args, ctx) => {
        capturedSessionState = ctx.sessionState
        return { success: true, output: 'Edit applied' }
      })
      mockToolRegistry.get.mockImplementation(name => {
        if (name === 'edit_document') return editTool
        return undefined
      })

      const initialMap = new Map([['/main.tex', { version: 5 }]])
      const loop = createAgentLoop()
      await collectEvents(loop.run('Edit', { _initialReadDocuments: initialMap }))

      expect(capturedSessionState).not.toBeNull()
      expect(capturedSessionState.readDocuments.get('/main.tex')).toEqual({ version: 5 })
    })

    it('run() creates empty Map when no _initialReadDocuments provided', async () => {
      mockLLM.addTextResponse('Hi', 'stop')

      const loop = createAgentLoop()
      const events = await collectEvents(loop.run('Hello'))

      const doneEvents = events.filter(e => e.type === 'done')
      expect(doneEvents[0].readDocuments).toBeInstanceOf(Map)
      expect(doneEvents[0].readDocuments.size).toBe(0)
    })
  })

  describe('context compaction', () => {
    it('triggers compaction when usage exceeds threshold', async () => {
      const toolCall = createMockToolCall('read_document', { path: 'main.tex' })
      const highUsage = { prompt_tokens: 80000, completion_tokens: 500, total_tokens: 80500 }

      mockLLM
        .addToolCallResponse(null, [toolCall], 'tool_calls', highUsage)
        .addTextResponse('Done.', 'stop')

      const readTool = createMockTool('read_document')
      mockToolRegistry.get.mockImplementation(name => {
        if (name === 'read_document') return readTool
        return undefined
      })

      mockContextManager.needsCompaction.mockReturnValue(true)
      mockContextManager.compactHistory.mockResolvedValue({ success: true, summary: 'Summary' })
      mockContextManager.getConversationHistory.mockResolvedValue([
        { role: 'assistant', content: 'Summary' },
      ])

      const loop = createAgentLoop()
      const events = await collectEvents(loop.run('Read'))

      const compactionStart = events.filter(e => e.type === 'compaction_start')
      expect(compactionStart).toHaveLength(1)

      const compactionDone = events.filter(e => e.type === 'compaction_done')
      expect(compactionDone).toHaveLength(1)
      expect(compactionDone[0].success).toBe(true)
    })

    it('does not trigger compaction when usage is below threshold', async () => {
      const toolCall = createMockToolCall('read_document', { path: 'main.tex' })
      const lowUsage = { prompt_tokens: 5000, completion_tokens: 100, total_tokens: 5100 }

      mockLLM
        .addToolCallResponse(null, [toolCall], 'tool_calls', lowUsage)
        .addTextResponse('Done.', 'stop')

      const readTool = createMockTool('read_document')
      mockToolRegistry.get.mockImplementation(name => {
        if (name === 'read_document') return readTool
        return undefined
      })

      mockContextManager.needsCompaction.mockReturnValue(false)

      const loop = createAgentLoop()
      const events = await collectEvents(loop.run('Read'))

      const compactionEvents = events.filter(e => e.type === 'compaction_start')
      expect(compactionEvents).toHaveLength(0)
    })

    it('continues loop when compaction fails', async () => {
      const toolCall = createMockToolCall('read_document', { path: 'main.tex' })
      const highUsage = { prompt_tokens: 80000 }

      mockLLM
        .addToolCallResponse(null, [toolCall], 'tool_calls', highUsage)
        .addTextResponse('Done.', 'stop')

      const readTool = createMockTool('read_document')
      mockToolRegistry.get.mockImplementation(name => {
        if (name === 'read_document') return readTool
        return undefined
      })

      mockContextManager.needsCompaction.mockReturnValue(true)
      mockContextManager.compactHistory.mockRejectedValue(new Error('LLM failed'))

      const loop = createAgentLoop()
      const events = await collectEvents(loop.run('Read'))

      const compactionDone = events.filter(e => e.type === 'compaction_done')
      expect(compactionDone).toHaveLength(1)
      expect(compactionDone[0].success).toBe(false)

      // Loop should still complete normally
      const doneEvents = events.filter(e => e.type === 'done')
      expect(doneEvents).toHaveLength(1)
    })
  })

  describe('context overflow emergency truncation', () => {
    it('truncates and retries on LLMContextOverflowError', async () => {
      // Create an error with the right constructor name
      class LLMContextOverflowError extends Error {
        constructor(message, info) {
          super(message)
          this.name = 'LLMContextOverflowError'
          this.info = info
        }
      }

      let callCount = 0
      const overflowLLM = {
        async chat(options) {
          callCount++
          if (callCount === 1) {
            throw new LLMContextOverflowError('maximum context length exceeded', { status: 400 })
          }
          if (options.stream) {
            return (async function* () {
              yield { type: 'text', content: 'Recovered.' }
              yield { type: 'done', content: 'Recovered.', toolCalls: [], finishReason: 'stop', usage: null }
            })()
          }
          return { content: 'Recovered.', toolCalls: null, finishReason: 'stop', usage: null }
        },
      }

      mockContextManager.emergencyTruncate.mockImplementation(msgs => {
        return [msgs[0], { role: 'user', content: 'truncated' }]
      })

      const loop = createAgentLoop({ llmAdapter: overflowLLM })
      const events = await collectEvents(loop.run('Hi'))

      const truncatedEvents = events.filter(e => e.type === 'context_truncated')
      expect(truncatedEvents).toHaveLength(1)

      const doneEvents = events.filter(e => e.type === 'done')
      expect(doneEvents).toHaveLength(1)
      expect(doneEvents[0].content).toBe('Recovered.')
    })
  })

  describe('selection reference pre-execution (_executeSelectionReads)', () => {
    /** Helper: set up read_document mock that registers readDocuments */
    function setupReadMock(executeFn) {
      const readTool = {
        name: 'read_document',
        validateArgs: args => args,
        execute: executeFn,
      }
      mockToolRegistry.get.mockImplementation(name => {
        if (name === 'read_document') return readTool
        return undefined
      })
      return executeFn
    }

    /** Helper: capture context passed to buildMessages */
    function captureBuildMessages() {
      let capturedContext = null
      mockContextManager.buildMessages.mockImplementation(async (_sid, _msg, ctx) => {
        capturedContext = ctx
        return [
          { role: 'system', content: 'System.' },
          { role: 'user', content: 'Hello' },
        ]
      })
      return () => capturedContext
    }

    it('populates sessionState.readDocuments and builds focused selection output', async () => {
      mockLLM.addTextResponse('I will edit the file.', 'stop')

      const executeFn = setupReadMock(vi.fn(async (args, ctx) => {
        ctx.sessionState.readDocuments.set(`${ctx.projectId}:doc-abc`, {
          version: 7,
          readAt: Date.now(),
        })
        return { success: true, output: 'Document: /main.tex (version 7):\n\n01| Hello world' }
      }))
      const getCtx = captureBuildMessages()

      const loop = createAgentLoop()
      const context = {
        references: [
          { type: 'selection', path: 'main.tex', startLine: 99, endLine: 101, selectionText: 'line A\nline B\nline C' },
        ],
      }
      const events = await collectEvents(loop.run('Edit this', context))

      // readTool should have been called once (full read to register version)
      expect(executeFn).toHaveBeenCalledTimes(1)
      expect(executeFn).toHaveBeenCalledWith(
        { path: 'main.tex' },
        expect.objectContaining({
          sessionId: 'session-1',
          projectId: 'proj-1',
          sessionState: expect.objectContaining({
            readDocuments: expect.any(Map),
          }),
        })
      )

      // _syntheticReadMessages: 1 assistant + 1 tool result = 2
      const msgs = getCtx()._syntheticReadMessages
      expect(msgs).toHaveLength(2)
      expect(msgs[0].role).toBe('assistant')
      expect(msgs[0].tool_calls[0].function.name).toBe('read_document')
      expect(msgs[1].role).toBe('tool')

      // Tool result should contain the focused selection text with line numbers
      expect(msgs[1].content).toContain('lines 99-101')
      expect(msgs[1].content).toContain('99| line A')
      expect(msgs[1].content).toContain('100| line B')
      expect(msgs[1].content).toContain('101| line C')

      // Loop completes normally
      expect(events.filter(e => e.type === 'done')).toHaveLength(1)
    })

    it('deduplicates reads for the same file path', async () => {
      mockLLM.addTextResponse('Done.', 'stop')

      const executeFn = setupReadMock(vi.fn(async (args, ctx) => {
        ctx.sessionState.readDocuments.set(`${ctx.projectId}:doc-1`, {
          version: 3,
          readAt: Date.now(),
        })
        return { success: true, output: `Document: /${args.path} (version 3)` }
      }))
      const getCtx = captureBuildMessages()

      const loop = createAgentLoop()
      const context = {
        references: [
          { type: 'selection', path: 'main.tex', startLine: 10, endLine: 20, selectionText: 'section A' },
          { type: 'selection', path: 'main.tex', startLine: 50, endLine: 55, selectionText: 'section B' },
        ],
      }
      await collectEvents(loop.run('Edit both sections', context))

      // Only ONE read_document call despite two references to the same file
      expect(executeFn).toHaveBeenCalledTimes(1)

      // But TWO tool results — one per selection reference
      const msgs = getCtx()._syntheticReadMessages
      expect(msgs).toHaveLength(3) // 1 assistant (2 tool_calls) + 2 tool results
      expect(msgs[0].tool_calls).toHaveLength(2)
      expect(msgs[1].content).toContain('lines 10-20')
      expect(msgs[1].content).toContain('section A')
      expect(msgs[2].content).toContain('lines 50-55')
      expect(msgs[2].content).toContain('section B')
    })

    it('handles multiple different files with independent tool results', async () => {
      mockLLM.addTextResponse('Done.', 'stop')

      let callCount = 0
      const executeFn = setupReadMock(vi.fn(async (args, ctx) => {
        callCount++
        ctx.sessionState.readDocuments.set(`${ctx.projectId}:doc-${callCount}`, {
          version: callCount,
          readAt: Date.now(),
        })
        return { success: true, output: `Document: /${args.path} (version ${callCount})` }
      }))
      const getCtx = captureBuildMessages()

      const loop = createAgentLoop()
      const context = {
        references: [
          { type: 'selection', path: 'intro.tex', startLine: 1, endLine: 10, selectionText: 'intro text' },
          { type: 'selection', path: 'methods.tex', startLine: 20, endLine: 30, selectionText: 'method text' },
        ],
      }
      await collectEvents(loop.run('Edit both files', context))

      expect(executeFn).toHaveBeenCalledTimes(2)
      const msgs = getCtx()._syntheticReadMessages
      // 1 assistant message with 2 tool_calls + 2 tool result messages = 3 total
      expect(msgs).toHaveLength(3)
      expect(msgs[0].tool_calls).toHaveLength(2)
      expect(msgs[1].tool_call_id).toBe('ref-sel-0')
      expect(msgs[2].tool_call_id).toBe('ref-sel-1')
    })

    it('falls back to full read output when selectionText is absent', async () => {
      mockLLM.addTextResponse('Done.', 'stop')

      setupReadMock(vi.fn(async (args, ctx) => {
        ctx.sessionState.readDocuments.set(`${ctx.projectId}:doc-1`, {
          version: 1,
          readAt: Date.now(),
        })
        return { success: true, output: 'Document: /main.tex (version 1):\n\n01| Full content' }
      }))
      const getCtx = captureBuildMessages()

      const loop = createAgentLoop()
      const context = {
        references: [
          { type: 'selection', path: 'main.tex', startLine: 1, endLine: 5 },
        ],
      }
      await collectEvents(loop.run('Edit this', context))

      const msgs = getCtx()._syntheticReadMessages
      // Without selectionText, should use the full read output
      expect(msgs[1].content).toContain('Full content')
      expect(msgs[1].content).not.toContain('user-selected content')
    })

    it('returns empty array when read_document tool is not in registry', async () => {
      mockLLM.addTextResponse('Hi.', 'stop')

      mockToolRegistry.get.mockImplementation(() => undefined)
      const getCtx = captureBuildMessages()

      const loop = createAgentLoop()
      const context = {
        references: [
          { type: 'selection', path: 'main.tex', startLine: 1, endLine: 5 },
        ],
      }
      await collectEvents(loop.run('Edit this', context))

      expect(getCtx()._syntheticReadMessages).toEqual([])
    })

    it('skips failing references and continues processing others', async () => {
      mockLLM.addTextResponse('Done.', 'stop')

      setupReadMock(vi.fn(async (args, ctx) => {
        if (args.path === 'missing.tex') {
          throw new Error('File not found')
        }
        ctx.sessionState.readDocuments.set(`${ctx.projectId}:doc-ok`, {
          version: 1,
          readAt: Date.now(),
        })
        return { success: true, output: `Document: /${args.path}` }
      }))
      const getCtx = captureBuildMessages()

      const loop = createAgentLoop()
      const context = {
        references: [
          { type: 'selection', path: 'missing.tex', startLine: 1, endLine: 5, selectionText: 'gone' },
          { type: 'selection', path: 'exists.tex', startLine: 10, endLine: 20, selectionText: 'here' },
        ],
      }
      await collectEvents(loop.run('Edit files', context))

      // Only the successful reference should appear
      const msgs = getCtx()._syntheticReadMessages
      expect(msgs).toHaveLength(2) // 1 assistant + 1 tool result
      expect(msgs[0].tool_calls).toHaveLength(1)
      expect(msgs[0].tool_calls[0].id).toBe('ref-sel-1')
      expect(msgs[1].tool_call_id).toBe('ref-sel-1')
    })

    it('does not inject messages when context has only file-type references', async () => {
      mockLLM.addTextResponse('Hi.', 'stop')
      const getCtx = captureBuildMessages()

      const loop = createAgentLoop()
      const context = {
        references: [
          { type: 'file', path: 'main.tex' },
        ],
      }
      await collectEvents(loop.run('Hello', context))

      expect(getCtx()._syntheticReadMessages).toEqual([])
    })

    it('does not inject messages when context has no references at all', async () => {
      mockLLM.addTextResponse('Hi.', 'stop')
      const getCtx = captureBuildMessages()

      const loop = createAgentLoop()
      await collectEvents(loop.run('Hello', {}))

      expect(getCtx()._syntheticReadMessages).toEqual([])
    })
  })

  describe('promptSnapshot mechanism (_enrichContext)', () => {
    function createAdapters(overrides = {}) {
      return {
        document: {
          getDocumentContent: overrides.getDocumentContent || vi.fn().mockResolvedValue({ content: '\\section{Intro}' }),
        },
        project: {
          resolveDocIdToPath: overrides.resolveDocIdToPath || vi.fn().mockResolvedValue('/main.tex'),
        },
      }
    }

    it('uses promptSnapshot when available instead of live parsing', async () => {
      mockLLM.addTextResponse('Hello!', 'stop')

      const adapters = createAdapters()

      // Session has an existing snapshot
      mockAgentFindOne.mockResolvedValue({
        promptSnapshot: {
          projectName: 'My Paper',
          rootDocPath: '/paper.tex',
          documentOutline: '# Intro\n# Methods',
          fileReferences: null,
        },
      })

      const loop = createAgentLoop({
        adapters,
      })
      const context = { rootDocId: 'root-doc-123', projectName: 'Original Name' }
      await collectEvents(loop.run('Hi', context))

      // Adapters should NOT be called — snapshot was used
      expect(adapters.project.resolveDocIdToPath).not.toHaveBeenCalled()
      expect(adapters.document.getDocumentContent).not.toHaveBeenCalled()

      // buildMessages should have been called with snapshot-enriched context
      const buildCall = mockContextManager.buildMessages.mock.calls[0]
      const enrichedCtx = buildCall[2]
      expect(enrichedCtx.projectName).toBe('My Paper')
      expect(enrichedCtx.rootDocPath).toBe('/paper.tex')
      expect(enrichedCtx.documentOutline).toBe('# Intro\n# Methods')
    })

    it('creates and persists promptSnapshot when none exists', async () => {
      mockLLM.addTextResponse('Hello!', 'stop')

      const adapters = createAdapters({
        resolveDocIdToPath: vi.fn().mockResolvedValue('/main.tex'),
        getDocumentContent: vi.fn().mockResolvedValue({ content: '\\section{Intro}\n\\section{Methods}' }),
      })
      mockExtractOutline.mockReturnValue('# Intro\n# Methods')

      // No snapshot in session
      mockAgentFindOne.mockResolvedValue(null)

      const loop = createAgentLoop({
        adapters,
      })
      const context = { rootDocId: 'root-doc-123', projectName: 'My Paper' }
      await collectEvents(loop.run('Hi', context))

      // Adapters SHOULD be called — no snapshot available
      expect(adapters.project.resolveDocIdToPath).toHaveBeenCalledWith('proj-1', 'root-doc-123')
      expect(adapters.document.getDocumentContent).toHaveBeenCalledWith('proj-1', 'root-doc-123')

      // Snapshot should have been persisted
      expect(mockAgentUpdateOne).toHaveBeenCalledWith(
        expect.objectContaining({}),
        expect.objectContaining({
          $set: {
            promptSnapshot: {
              projectName: 'My Paper',
              rootDocPath: '/main.tex',
              documentOutline: '# Intro\n# Methods',
              fileReferences: null,
              projectRules: null,
            },
          },
        })
      )
    })

    it('clears and refreshes promptSnapshot after compaction', async () => {
      const toolCall = createMockToolCall('read_document', { path: 'main.tex' })
      const highUsage = { prompt_tokens: 80000, completion_tokens: 500, total_tokens: 80500 }

      mockLLM
        .addToolCallResponse(null, [toolCall], 'tool_calls', highUsage)
        .addTextResponse('Done.', 'stop')

      const readTool = createMockTool('read_document')
      mockToolRegistry.get.mockImplementation(name => {
        if (name === 'read_document') return readTool
        return undefined
      })

      mockContextManager.needsCompaction.mockReturnValue(true)
      mockContextManager.compactHistory.mockResolvedValue({ success: true, summary: 'Summary' })
      mockContextManager.getConversationHistory.mockResolvedValue([
        { role: 'assistant', content: 'Summary' },
      ])

      const adapters = createAdapters()
      mockExtractOutline.mockReturnValue('# Updated Outline')

      // First call: no snapshot (initial enrich)
      // Second call (after $unset): no snapshot (re-enrich)
      mockAgentFindOne.mockResolvedValue(null)

      mockBuildSystemPrompt.mockResolvedValue('Refreshed system prompt')

      const loop = createAgentLoop({ adapters })
      const context = { rootDocId: 'root-doc-123', projectName: 'Paper' }
      const events = await collectEvents(loop.run('Read', context))

      // Compaction should have occurred
      const compactionDone = events.filter(e => e.type === 'compaction_done')
      expect(compactionDone).toHaveLength(1)
      expect(compactionDone[0].success).toBe(true)

      // Verify snapshot was cleared ($unset)
      const unsetCalls = mockAgentUpdateOne.mock.calls.filter(
        call => call[1]?.$unset?.promptSnapshot !== undefined
      )
      expect(unsetCalls.length).toBeGreaterThanOrEqual(1)

      // Verify buildSystemPrompt was called for the refresh
      expect(mockBuildSystemPrompt).toHaveBeenCalled()
    })
  })
})
