import { describe, it, expect, vi, beforeEach } from 'vitest'

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

// Mock @overleaf/settings
vi.mock('@overleaf/settings', () => ({
  default: {},
}))

// Mock mongodb
const mockFindOne = vi.fn()
const mockUpdateOne = vi.fn()
const mockFind = vi.fn()
const mockInsertOne = vi.fn()
const mockInsertMany = vi.fn()
const mockDeleteMany = vi.fn()
const mockCountDocuments = vi.fn()
const mockUpdateMany = vi.fn()
const mockFindOneAndUpdate = vi.fn()
vi.mock('../../../../app/js/mongodb.js', () => ({
  db: {
    aiSessions: {
      findOne: (...args) => mockFindOne(...args),
      updateOne: (...args) => mockUpdateOne(...args),
      findOneAndUpdate: (...args) => mockFindOneAndUpdate(...args),
    },
    aiMessages: {
      find: (...args) => mockFind(...args),
      insertOne: (...args) => mockInsertOne(...args),
      insertMany: (...args) => mockInsertMany(...args),
      deleteMany: (...args) => mockDeleteMany(...args),
      countDocuments: (...args) => mockCountDocuments(...args),
      updateMany: (...args) => mockUpdateMany(...args),
    },
  },
  ObjectId: class ObjectId {
    constructor(id) { this.id = id || 'test-id' }
    toString() { return this.id }
  },
  allocateSeq: (...args) => mockFindOneAndUpdate(...args),
}))

// Mock prompt/system.js
vi.mock('../../../../app/js/prompt/system.js', () => ({
  buildSystemPrompt: vi.fn().mockResolvedValue('System prompt'),
}))

const { ContextManager } = await import(
  '../../../../app/js/agent/ContextManager.js'
)

describe('ContextManager', () => {
  let cm
  let sessionSummaryService
  let memorySuggestionService

  beforeEach(() => {
    sessionSummaryService = {
      createSummary: vi.fn().mockResolvedValue({ _id: 'summary-1' }),
    }
    memorySuggestionService = {
      createSuggestion: vi.fn().mockResolvedValue({ _id: 'suggestion-1' }),
    }
    cm = new ContextManager({
      sessionSummaryService,
      memorySuggestionService,
    })
    mockFindOne.mockReset()
    mockUpdateOne.mockReset()
    mockFind.mockReset()
    mockInsertOne.mockReset()
    mockInsertMany.mockReset()
    mockDeleteMany.mockReset()
    mockCountDocuments.mockReset()
    mockUpdateMany.mockReset()
    mockFindOneAndUpdate.mockReset()

    // Default: allocateSeq returns 1
    mockFindOneAndUpdate.mockResolvedValue(1)
    mockInsertOne.mockResolvedValue({ insertedId: 'test' })
    mockInsertMany.mockResolvedValue({ insertedCount: 1 })
    mockUpdateOne.mockResolvedValue({ modifiedCount: 1 })
    mockDeleteMany.mockResolvedValue({ deletedCount: 0 })
    mockCountDocuments.mockResolvedValue(0)
    mockUpdateMany.mockResolvedValue({ modifiedCount: 0 })
  })

  describe('getConversationHistory - toolContext expansion', () => {
    /** Helper: mock aiMessages.find chain for migrated sessions */
    function mockMigratedSession(sessionFields, messagesDocs) {
      mockFindOne.mockResolvedValue({ _nextSeq: messagesDocs.length + 1, _latestSummarySeq: null, ...sessionFields })
      mockFind.mockReturnValue({
        sort: () => ({
          toArray: () => Promise.resolve(messagesDocs),
        }),
      })
    }

    it('expands toolContext messages before assistant text', async () => {
      const toolContext = [
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'read_document', arguments: '{"path":"main.tex"}' } }],
        },
        {
          role: 'tool',
          tool_call_id: 'tc1',
          content: 'Document content here',
        },
      ]

      mockMigratedSession({}, [
        { seq: 1, role: 'user', content: 'Read my doc' },
        { seq: 2, role: 'assistant', content: 'I read the document.', toolContext },
      ])

      const history = await cm.getConversationHistory('test-session')

      // Should have: user + assistant(tool_calls) + tool(result) + assistant(text) = 4 messages
      expect(history).toHaveLength(4)
      expect(history[0].role).toBe('user')
      expect(history[1].role).toBe('assistant')
      expect(history[1].tool_calls).toBeDefined()
      expect(history[1].tool_calls[0].function.name).toBe('read_document')
      expect(history[2].role).toBe('tool')
      expect(history[2].tool_call_id).toBe('tc1')
      expect(history[3].role).toBe('assistant')
      expect(history[3].content).toBe('I read the document.')
    })

    it('handles messages without toolContext', async () => {
      mockMigratedSession({}, [
        { seq: 1, role: 'user', content: 'Hello' },
        { seq: 2, role: 'assistant', content: 'Hi there!' },
      ])

      const history = await cm.getConversationHistory('test-session')

      expect(history).toHaveLength(2)
      expect(history[0]).toEqual({ role: 'user', content: 'Hello' })
      expect(history[1]).toEqual({ role: 'assistant', content: 'Hi there!' })
    })

    it('preserves long tool results without truncation', async () => {
      const longContent = 'x'.repeat(1000)
      const toolContext = [
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'read_document', arguments: '{}' } }],
        },
        {
          role: 'tool',
          tool_call_id: 'tc1',
          content: longContent,
        },
      ]

      mockMigratedSession({}, [
        { seq: 1, role: 'user', content: 'msg1' },
        { seq: 2, role: 'assistant', content: 'resp1', toolContext },
        { seq: 3, role: 'user', content: 'msg2' },
        { seq: 4, role: 'assistant', content: 'resp2' },
        { seq: 5, role: 'user', content: 'msg3' },
        { seq: 6, role: 'assistant', content: 'resp3' },
      ])

      const history = await cm.getConversationHistory('test-session')

      const toolResult = history.find(m => m.role === 'tool' && m.tool_call_id === 'tc1')
      expect(toolResult).toBeDefined()
      expect(toolResult.content).toBe(longContent)
    })

    it('handles mixed messages with and without toolContext', async () => {
      const toolContext = [
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'list_files', arguments: '{}' } }],
        },
        {
          role: 'tool',
          tool_call_id: 'tc1',
          content: 'file1.tex\nfile2.tex',
        },
      ]

      mockMigratedSession({}, [
        { seq: 1, role: 'user', content: 'first message' },
        { seq: 2, role: 'assistant', content: 'old format response' },
        { seq: 3, role: 'user', content: 'second message' },
        { seq: 4, role: 'assistant', content: 'new format response', toolContext },
      ])

      const history = await cm.getConversationHistory('test-session')

      // user + assistant(old) + user + assistant(tool_calls) + tool + assistant(new) = 6
      expect(history).toHaveLength(6)
      expect(history[0].role).toBe('user')
      expect(history[1].role).toBe('assistant')
      expect(history[1].content).toBe('old format response')
      expect(history[2].role).toBe('user')
      expect(history[3].role).toBe('assistant')
      expect(history[3].tool_calls).toBeDefined()
      expect(history[4].role).toBe('tool')
      expect(history[5].role).toBe('assistant')
      expect(history[5].content).toBe('new format response')
    })

    it('returns empty array when no messages exist', async () => {
      mockMigratedSession({}, [])

      const history = await cm.getConversationHistory('test-session')
      expect(history).toEqual([])
    })

    it('returns empty array when session not found', async () => {
      mockFindOne.mockResolvedValue(null)

      const history = await cm.getConversationHistory('test-session')
      expect(history).toEqual([])
    })

    it('preserves assistant tool_calls field from toolContext', async () => {
      const toolContext = [
        {
          role: 'assistant',
          content: 'thinking...',
          tool_calls: [
            { id: 'tc1', type: 'function', function: { name: 'read_document', arguments: '{"path":"a.tex"}' } },
            { id: 'tc2', type: 'function', function: { name: 'read_document', arguments: '{"path":"b.tex"}' } },
          ],
        },
        { role: 'tool', tool_call_id: 'tc1', content: 'content a' },
        { role: 'tool', tool_call_id: 'tc2', content: 'content b' },
      ]

      mockMigratedSession({}, [
        { seq: 1, role: 'user', content: 'read both' },
        { seq: 2, role: 'assistant', content: 'Done reading both files.', toolContext },
      ])

      const history = await cm.getConversationHistory('test-session')

      // user + assistant(2 tool_calls) + tool + tool + assistant(text) = 5
      expect(history).toHaveLength(5)
      const assistantWithTools = history[1]
      expect(assistantWithTools.tool_calls).toHaveLength(2)
    })

    it('falls back to embedded messages for unmigrated sessions', async () => {
      // Unmigrated session: no _nextSeq, has messages array
      mockFindOne.mockResolvedValue({
        messages: [
          { role: 'user', content: 'Hello' },
          { role: 'assistant', content: 'Hi there!' },
        ],
      })

      const history = await cm.getConversationHistory('test-session')

      expect(history).toHaveLength(2)
      expect(history[0]).toEqual({ role: 'user', content: 'Hello' })
      expect(history[1]).toEqual({ role: 'assistant', content: 'Hi there!' })
    })
  })

  describe('getConversationHistory - summary filtering', () => {
    function mockMigratedWithSummary(sessionFields, messagesDocs) {
      mockFindOne.mockResolvedValue({ _nextSeq: messagesDocs.length + 1, ...sessionFields })
      mockFind.mockReturnValue({
        sort: () => ({
          toArray: () => Promise.resolve(messagesDocs),
        }),
      })
    }

    it('uses _latestSummarySeq to filter messages from aiMessages', async () => {
      // Session has _latestSummarySeq=3, so query starts from seq >= 3
      mockMigratedWithSummary({ _latestSummarySeq: 3 }, [
        { seq: 3, role: 'assistant', content: 'Summary of conversation', isSummary: true },
        { seq: 4, role: 'user', content: 'new message' },
        { seq: 5, role: 'assistant', content: 'new response' },
      ])

      const history = await cm.getConversationHistory('test-session')

      expect(history).toHaveLength(3)
      expect(history[0].content).toBe('Summary of conversation')
      expect(history[1].content).toBe('new message')
      expect(history[2].content).toBe('new response')
    })

    it('returns all messages when no summary exists', async () => {
      mockMigratedWithSummary({ _latestSummarySeq: null }, [
        { seq: 1, role: 'user', content: 'msg1' },
        { seq: 2, role: 'assistant', content: 'resp1' },
        { seq: 3, role: 'user', content: 'msg2' },
        { seq: 4, role: 'assistant', content: 'resp2' },
      ])

      const history = await cm.getConversationHistory('test-session')
      expect(history).toHaveLength(4)
    })

    it('falls back to embedded messages summary filtering for unmigrated sessions', async () => {
      mockFindOne.mockResolvedValue({
        messages: [
          { role: 'user', content: 'very old' },
          { role: 'assistant', content: 'first summary', isSummary: true },
          { role: 'user', content: 'middle' },
          { role: 'assistant', content: 'second summary', isSummary: true },
          { role: 'user', content: 'latest' },
        ],
      })

      const history = await cm.getConversationHistory('test-session')

      expect(history).toHaveLength(2)
      expect(history[0].content).toBe('second summary')
      expect(history[1].content).toBe('latest')
    })

    it('returns all messages when count exceeds maxHistoryMessages (no sliding window)', async () => {
      const messageDocs = []
      for (let i = 0; i < 60; i++) {
        messageDocs.push({ seq: i + 1, role: i % 2 === 0 ? 'user' : 'assistant', content: `msg-${i}` })
      }

      mockMigratedWithSummary({ _latestSummarySeq: null }, messageDocs)

      const history = await cm.getConversationHistory('test-session')

      expect(history).toHaveLength(60)
      expect(history[0].content).toBe('msg-0')
      expect(history[59].content).toBe('msg-59')
    })
  })

  describe('needsCompaction', () => {
    it('returns true when prompt_tokens exceeds threshold', () => {
      const config = { enabled: true, contextWindow: 100000, threshold: 0.7 }
      const usage = { prompt_tokens: 75000 }
      expect(cm.needsCompaction(usage, config)).toBe(true)
    })

    it('returns false when prompt_tokens is below threshold', () => {
      const config = { enabled: true, contextWindow: 100000, threshold: 0.7 }
      const usage = { prompt_tokens: 50000 }
      expect(cm.needsCompaction(usage, config)).toBe(false)
    })

    it('returns false when usage is null and messageCount is 0', () => {
      const config = { enabled: true, contextWindow: 100000, threshold: 0.7 }
      expect(cm.needsCompaction(null, config, 0)).toBe(false)
    })

    it('returns false when compaction is disabled', () => {
      const config = { enabled: false, contextWindow: 100000, threshold: 0.7 }
      const usage = { prompt_tokens: 90000 }
      expect(cm.needsCompaction(usage, config)).toBe(false)
    })

    it('falls back to total_tokens when prompt_tokens is missing', () => {
      const config = { enabled: true, contextWindow: 100000, threshold: 0.7 }
      const usage = { total_tokens: 80000 }
      expect(cm.needsCompaction(usage, config)).toBe(true)
    })

    it('triggers on messageCount when usage is below threshold', () => {
      const config = { enabled: true, contextWindow: 100000, threshold: 0.7, messageThreshold: 20 }
      const usage = { prompt_tokens: 5000 }
      expect(cm.needsCompaction(usage, config, 25)).toBe(true)
    })

    it('does not trigger on messageCount below messageThreshold', () => {
      const config = { enabled: true, contextWindow: 100000, threshold: 0.7, messageThreshold: 30 }
      expect(cm.needsCompaction(null, config, 15)).toBe(false)
    })

    it('uses default messageThreshold of 30 when not configured', () => {
      const config = { enabled: true, contextWindow: 100000, threshold: 0.7 }
      expect(cm.needsCompaction(null, config, 30)).toBe(true)
      expect(cm.needsCompaction(null, config, 29)).toBe(false)
    })
  })

  describe('emergencyTruncate', () => {
    it('preserves system prompt and keeps recent messages', () => {
      const messages = [
        { role: 'system', content: 'System prompt' },
        { role: 'user', content: 'msg1' },
        { role: 'assistant', content: 'resp1' },
        { role: 'user', content: 'msg2' },
        { role: 'assistant', content: 'resp2' },
        { role: 'user', content: 'msg3' },
        { role: 'assistant', content: 'resp3' },
        { role: 'user', content: 'msg4' },
        { role: 'assistant', content: 'resp4' },
      ]

      const result = cm.emergencyTruncate(messages)

      // system + truncation notice (user+assistant) + last 6 messages
      expect(result[0].role).toBe('system')
      expect(result[0].content).toBe('System prompt')
      expect(result[1].role).toBe('user')
      expect(result[1].content).toContain('上下文长度限制')
      expect(result[2].role).toBe('assistant')
      expect(result.length).toBe(9) // 1 system + 2 notice + 6 recent
    })

    it('returns messages unchanged when 2 or fewer', () => {
      const messages = [
        { role: 'system', content: 'System' },
        { role: 'user', content: 'Hi' },
      ]

      const result = cm.emergencyTruncate(messages)
      expect(result).toEqual(messages)
      // Must return a copy, not the same reference (P1 fix)
      expect(result).not.toBe(messages)
    })
  })

  describe('compactHistory', () => {
    function setupCompactMocks(messageCount, historyMessages, sessionFields = {}) {
      mockCountDocuments.mockResolvedValue(messageCount)
      // Mock getConversationHistory path: session with _nextSeq
      mockFindOne.mockResolvedValue({
        _nextSeq: messageCount + 1,
        _latestSummarySeq: null,
        projectId: 'project-1',
        userId: 'user-1',
        ...sessionFields,
      })
      mockFind.mockReturnValue({
        sort: () => ({
          toArray: () => Promise.resolve(historyMessages),
        }),
      })
    }

    it('generates summary, saves to aiMessages, and returns usage', async () => {
      const historyDocs = [
        { seq: 1, role: 'user', content: 'msg1' },
        { seq: 2, role: 'assistant', content: 'resp1' },
        { seq: 3, role: 'user', content: 'msg2' },
        { seq: 4, role: 'assistant', content: 'resp2' },
        { seq: 5, role: 'user', content: 'msg3' },
        { seq: 6, role: 'assistant', content: 'resp3' },
      ]
      setupCompactMocks(6, historyDocs)

      const mockUsage = { prompt_tokens: 500, completion_tokens: 200, total_tokens: 700 }
      const mockLLM = {
        chat: vi.fn().mockResolvedValue({
          content: 'Summary: user worked on main.tex',
          usage: mockUsage,
        }),
      }

      const config = { summaryMaxTokens: 2048 }
      const result = await cm.compactHistory('test-session', mockLLM, config)

      expect(result.success).toBe(true)
      expect(result.summary).toContain('Summary: user worked on main.tex')
      expect(result.summary).toContain('<conversation_summary>')
      expect(result.usage).toEqual(mockUsage)
      expect(mockLLM.chat).toHaveBeenCalledOnce()

      // Verify summary was inserted into aiMessages
      expect(mockInsertOne).toHaveBeenCalledOnce()
      const insertedDoc = mockInsertOne.mock.calls[0][0]
      expect(insertedDoc.isSummary).toBe(true)
      expect(insertedDoc.role).toBe('assistant')

      // Verify _latestSummarySeq was updated
      expect(mockUpdateOne).toHaveBeenCalled()

      // Verify old toolContext was cleaned up
      expect(mockUpdateMany).toHaveBeenCalledOnce()

      expect(sessionSummaryService.createSummary).toHaveBeenCalledWith({
        sessionId: 'test-session',
        projectId: 'project-1',
        userId: 'user-1',
        summary: expect.stringContaining('<conversation_summary>'),
        sourceMessageRange: { fromSeq: 1, toSeq: 6 },
        tokenEstimate: expect.any(Number),
      })
    })

    it('creates pending memory suggestions from compaction without writing memories', async () => {
      setupCompactMocks(4, [
        { seq: 1, role: 'user', content: 'Please remember that I prefer short Chinese progress updates.' },
        { seq: 2, role: 'assistant', content: 'Understood.' },
        { seq: 3, role: 'user', content: 'This is a durable project convention.' },
        { seq: 4, role: 'assistant', content: 'Noted.' },
      ])

      const mockLLM = {
        chat: vi.fn().mockResolvedValue({
          content: 'Summary: user prefers short Chinese progress updates.',
          usage: { completion_tokens: 20 },
        }),
      }

      const result = await cm.compactHistory('test-session', mockLLM, {}, {
        proposeMemorySuggestions: true,
      })

      expect(result.success).toBe(true)
      expect(memorySuggestionService.createSuggestion).toHaveBeenCalledWith({
        userId: 'user-1',
        projectId: 'project-1',
        sessionId: 'test-session',
        messageId: null,
        proposedContent: expect.stringContaining('prefers short Chinese progress updates'),
        scope: 'project',
        reason: 'compaction-summary preference candidate',
      })
    })

    it('does not create memory suggestions unless explicitly enabled', async () => {
      setupCompactMocks(4, [
        { seq: 1, role: 'user', content: 'Remember my preference.' },
        { seq: 2, role: 'assistant', content: 'Ok.' },
        { seq: 3, role: 'user', content: 'Continue.' },
        { seq: 4, role: 'assistant', content: 'Done.' },
      ])
      const mockLLM = {
        chat: vi.fn().mockResolvedValue({
          content: 'Summary: user preference exists.',
          usage: null,
        }),
      }

      await cm.compactHistory('test-session', mockLLM, {})

      expect(memorySuggestionService.createSuggestion).not.toHaveBeenCalled()
    })

    it('returns false when message count is too low', async () => {
      mockCountDocuments.mockResolvedValue(2)

      const mockLLM = { chat: vi.fn() }
      const result = await cm.compactHistory('test-session', mockLLM, {})

      expect(result.success).toBe(false)
      expect(mockLLM.chat).not.toHaveBeenCalled()
    })

    it('returns false when no messages exist', async () => {
      mockCountDocuments.mockResolvedValue(0)

      const mockLLM = { chat: vi.fn() }
      const result = await cm.compactHistory('test-session', mockLLM, {})

      expect(result.success).toBe(false)
    })
  })
})
