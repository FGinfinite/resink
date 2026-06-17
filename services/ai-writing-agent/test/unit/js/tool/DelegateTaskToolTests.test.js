import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock @overleaf/settings (must include mongo for AgentController import chain)
vi.mock('@overleaf/settings', () => ({
  default: {
    mongo: { url: 'mongodb://localhost/test', options: {} },
    internal: { aiWritingAgent: { port: 3060, host: '127.0.0.1' } },
    review: {
      subAgentTemperature: 0.3,
      subAgentMaxTokens: 8192,
    },
    agent: {},
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

// Mock @overleaf/metrics
vi.mock('@overleaf/metrics', () => ({
  default: {
    mongodb: { monitor: vi.fn() },
  },
}))

// Mock @overleaf/mongo-utils
vi.mock('@overleaf/mongo-utils', () => ({
  default: {
    cleanupTestDatabase: vi.fn(),
  },
}))

// Mock @overleaf/promise-utils
vi.mock('@overleaf/promise-utils', () => ({
  expressify: fn => fn,
}))

// Mock mongodb
vi.mock('mongodb', () => {
  class ObjectId {
    constructor(id) { this._id = id || Math.random().toString(36).slice(2) }
    toString() { return this._id }
  }
  const mockCollection = {
    findOne: vi.fn(),
    insertOne: vi.fn(),
    updateOne: vi.fn(),
    find: vi.fn(() => ({
      sort: vi.fn(() => ({
        limit: vi.fn(() => ({
          toArray: vi.fn(async () => []),
        })),
      })),
    })),
    createIndex: vi.fn(),
  }
  return {
    ObjectId,
    MongoClient: vi.fn().mockImplementation(() => ({
      connect: vi.fn(),
      db: () => ({
        collection: () => mockCollection,
      }),
    })),
  }
})

// Mock AgentController for child session management
const mockCreateChildSession = vi.fn()
const mockUpdateSessionStatus = vi.fn()
vi.mock('../../../../app/js/AgentController.js', () => ({
  default: {
    createChildSession: mockCreateChildSession,
    updateSessionStatus: mockUpdateSessionStatus,
  },
}))

// Mock ToolPool to avoid importing real tool implementations
const mockBuildToolRegistry = vi.fn()
vi.mock('../../../../app/js/tool/ToolPool.js', () => ({
  buildToolRegistry: mockBuildToolRegistry,
}))

// Mock AgentLoop to control child loop behavior
const mockAgentLoopInstance = { _agentLoop: vi.fn() }
vi.mock('../../../../app/js/agent/AgentLoop.js', () => ({
  AgentLoop: vi.fn(() => mockAgentLoopInstance),
}))

// Mock ContextManager
vi.mock('../../../../app/js/agent/ContextManager.js', () => ({
  ContextManager: vi.fn(),
}))

const { DelegateTaskTool } = await import(
  '../../../../app/js/tool/delegate_task.js'
)
const { AgentLoop: MockAgentLoop } = await import(
  '../../../../app/js/agent/AgentLoop.js'
)

function createMockAgentTypeRegistry(agents = {}) {
  const map = new Map(Object.entries(agents))
  return {
    get: name => map.get(name),
    getAll: () =>
      Array.from(map.values()).map(a => ({
        name: a.name,
        description: a.description,
        tools: a.tools,
        maxTurns: a.maxTurns,
      })),
  }
}

/**
 * Helper to collect all yields from an AsyncGenerator and return the final ToolResult.
 */
async function collectGeneratorResult(gen) {
  const events = []
  let toolResult = null
  for await (const item of gen) {
    if (item && item._isToolResult) {
      toolResult = item
    } else {
      events.push(item)
    }
  }
  return { events, toolResult }
}

describe('DelegateTaskTool', () => {
  let mockRegistry

  const defaultContext = {
    sessionId: 'parent-sess-1',
    projectId: 'proj-1',
    userId: 'user-1',
    adapters: { llm: {}, document: {}, project: {} },
    confirmationChannel: null,
    rootSessionId: 'root-sess-1',
  }

  beforeEach(() => {
    vi.clearAllMocks()

    mockRegistry = createMockAgentTypeRegistry({
      'test-agent': {
        name: 'test-agent',
        description: 'A test agent',
        tools: ['read_document', 'list_files'],
        maxTurns: 3,
        body: 'You are a test agent.',
      },
    })

    // Default mock implementations
    mockCreateChildSession.mockResolvedValue({
      _id: { toString: () => 'child-sess-1' },
      projectId: 'proj-1',
    })
    mockUpdateSessionStatus.mockResolvedValue()
    mockBuildToolRegistry.mockReturnValue({
      getTools: () => [],
      get: () => null,
      getNames: () => [],
    })
  })

  it('returns error for unknown agent type', async () => {
    const tool = new DelegateTaskTool(mockRegistry)

    const gen = tool.execute(
      { task: 'Do something', agent: 'nonexistent' },
      defaultContext
    )

    const { toolResult } = await collectGeneratorResult(gen)

    expect(toolResult.success).toBe(false)
    expect(toolResult.output).toContain('Unknown agent type "nonexistent"')
    expect(toolResult.output).toContain('test-agent')
  })

  it('returns error when registry is empty', async () => {
    const emptyRegistry = createMockAgentTypeRegistry({})
    const tool = new DelegateTaskTool(emptyRegistry)

    const gen = tool.execute(
      { task: 'Do something', agent: 'any' },
      defaultContext
    )

    const { toolResult } = await collectGeneratorResult(gen)

    expect(toolResult.success).toBe(false)
    expect(toolResult.output).toContain('Unknown agent type')
  })

  it('has correct tool name and description', () => {
    const tool = new DelegateTaskTool(mockRegistry)

    expect(tool.name).toBe('delegate_task')
    expect(tool.description).toContain('sub-task')
  })

  describe('streaming execution', () => {
    it('yields child_session_init and streams child events with sessionId', async () => {
      const tool = new DelegateTaskTool(mockRegistry)

      // Mock child AgentLoop._agentLoop to yield some events
      mockAgentLoopInstance._agentLoop = async function* () {
        yield { type: 'text', content: 'Hello from child' }
        yield { type: 'tool_call', toolCall: { id: 'tc-1', function: { name: 'read_document', arguments: '{}' } } }
        yield { type: 'tool_result', toolCallId: 'tc-1', toolName: 'read_document', result: { success: true, output: 'doc content' } }
        yield { type: 'done', content: 'Hello from child', changeHistory: [], readDocuments: new Map() }
      }

      const gen = tool.execute(
        { task: 'Read the main document', agent: 'test-agent' },
        defaultContext
      )

      const { events, toolResult } = await collectGeneratorResult(gen)

      // First event should be child_session_init
      expect(events[0]).toEqual({
        type: 'child_session_init',
        childSessionId: 'child-sess-1',
        agentName: 'test-agent',
      })

      // All subsequent events should have sessionId = childSessionId
      const taggedEvents = events.slice(1)
      for (const event of taggedEvents) {
        expect(event.sessionId).toBe('child-sess-1')
      }

      // Verify event types in order
      expect(taggedEvents.map(e => e.type)).toEqual([
        'text', 'tool_call', 'tool_result', 'done',
      ])

      // Final ToolResult should be successful
      expect(toolResult.success).toBe(true)
      expect(toolResult.output).toContain('Hello from child')
      expect(toolResult.data.childSessionId).toBe('child-sess-1')
      expect(toolResult.data.agent).toBe('test-agent')

      // Session status should be updated to completed
      expect(mockUpdateSessionStatus).toHaveBeenCalledWith('child-sess-1', 'completed')
    })

    it('preserves existing sessionId on nested events (grandchild)', async () => {
      const tool = new DelegateTaskTool(mockRegistry)

      // Simulate events from a grandchild session that already have sessionId
      mockAgentLoopInstance._agentLoop = async function* () {
        yield { type: 'text', content: 'from child' }
        // This event already has a sessionId from a nested delegate_task
        yield { type: 'text', content: 'from grandchild', sessionId: 'grandchild-sess-1' }
        yield { type: 'done', content: 'from child', changeHistory: [], readDocuments: new Map() }
      }

      const gen = tool.execute(
        { task: 'Nested task', agent: 'test-agent' },
        defaultContext
      )

      const { events } = await collectGeneratorResult(gen)

      // Skip child_session_init
      const taggedEvents = events.slice(1)

      // First text event: no original sessionId → tagged with child session
      expect(taggedEvents[0].sessionId).toBe('child-sess-1')

      // Second text event: has grandchild sessionId → preserved
      expect(taggedEvents[1].sessionId).toBe('grandchild-sess-1')
    })

    it('marks child session as error on failure', async () => {
      const tool = new DelegateTaskTool(mockRegistry)

      mockAgentLoopInstance._agentLoop = async function* () {
        yield { type: 'text', content: 'starting...' }
        throw new Error('LLM connection failed')
      }

      const gen = tool.execute(
        { task: 'Failing task', agent: 'test-agent' },
        defaultContext
      )

      const { events, toolResult } = await collectGeneratorResult(gen)

      // Should still have child_session_init and the text event
      expect(events[0].type).toBe('child_session_init')
      expect(events[1].type).toBe('text')

      // ToolResult should be an error
      expect(toolResult.success).toBe(false)
      expect(toolResult.output).toContain('execution failed')
      expect(toolResult.output).toContain('LLM connection failed')

      // Session should be marked as error
      expect(mockUpdateSessionStatus).toHaveBeenCalledWith('child-sess-1', 'error')
    })

    it('returns error when createChildSession fails', async () => {
      const tool = new DelegateTaskTool(mockRegistry)

      mockCreateChildSession.mockRejectedValue(new Error('DB connection lost'))

      const gen = tool.execute(
        { task: 'Some task', agent: 'test-agent' },
        defaultContext
      )

      const { events, toolResult } = await collectGeneratorResult(gen)

      // No child_session_init since session creation failed
      expect(events).toHaveLength(0)

      expect(toolResult.success).toBe(false)
      expect(toolResult.output).toContain('Failed to create child session')
    })

    it('calls createChildSession with correct parameters', async () => {
      const tool = new DelegateTaskTool(mockRegistry)

      mockAgentLoopInstance._agentLoop = async function* () {
        yield { type: 'done', content: '', changeHistory: [], readDocuments: new Map() }
      }

      const gen = tool.execute(
        { task: 'Test task', agent: 'test-agent' },
        defaultContext
      )

      await collectGeneratorResult(gen)

      expect(mockCreateChildSession).toHaveBeenCalledWith({
        parentId: 'parent-sess-1',
        projectId: 'proj-1',
        userId: 'user-1',
        agentName: 'test-agent',
      })
    })

    it('builds tool registry with agent type tools', async () => {
      const tool = new DelegateTaskTool(mockRegistry)

      mockAgentLoopInstance._agentLoop = async function* () {
        yield { type: 'done', content: '', changeHistory: [], readDocuments: new Map() }
      }

      const gen = tool.execute(
        { task: 'Test task', agent: 'test-agent' },
        defaultContext
      )

      await collectGeneratorResult(gen)

      expect(mockBuildToolRegistry).toHaveBeenCalledWith(['read_document', 'list_files'])
    })

    it('passes temperature and maxTokens from settings to child AgentLoop', async () => {
      const tool = new DelegateTaskTool(mockRegistry)

      mockAgentLoopInstance._agentLoop = async function* () {
        yield { type: 'done', content: '', changeHistory: [], readDocuments: new Map() }
      }

      const gen = tool.execute(
        { task: 'Review task', agent: 'test-agent' },
        defaultContext
      )

      await collectGeneratorResult(gen)

      // AgentLoop constructor should have been called with temperature and maxTokens
      // from settings.review.subAgentTemperature (0.3) and settings.review.subAgentMaxTokens (8192)
      expect(MockAgentLoop).toHaveBeenCalledWith(
        expect.objectContaining({
          temperature: 0.3,
          maxTokens: 8192,
        })
      )
    })
  })
})
