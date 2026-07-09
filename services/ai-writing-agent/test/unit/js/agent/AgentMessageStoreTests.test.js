import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockToolCalls = new Map()
const mockMessages = []
const mockSessionUpdates = []
const mockAllocateSeq = vi.fn()

const db = {
  aiAgentToolCalls: {
    updateOne: vi.fn(async (filter, update, options = {}) => {
      const key = `${filter.sessionId}:${filter.toolCallId}`
      const existing = mockToolCalls.get(key)
      if (!existing && options.upsert) {
        mockToolCalls.set(key, {
          ...update.$setOnInsert,
          ...update.$set,
        })
        return { upsertedCount: 1, matchedCount: 0 }
      }
      if (existing) {
        mockToolCalls.set(key, {
          ...existing,
          ...update.$set,
        })
        return { matchedCount: 1, modifiedCount: 1 }
      }
      return { matchedCount: 0, modifiedCount: 0 }
    }),
    findOne: vi.fn(async filter =>
      mockToolCalls.get(`${filter.sessionId}:${filter.toolCallId}`) || null
    ),
    find: vi.fn(filter => ({
      sort: () => ({
        toArray: async () =>
          [...mockToolCalls.values()].filter(
            toolCall => toolCall.sessionId === filter.sessionId
          ),
      }),
    })),
  },
  aiMessages: {
    insertOne: vi.fn(async doc => {
      mockMessages.push(doc)
      return { insertedId: 'message-id' }
    }),
    insertMany: vi.fn(async docs => {
      mockMessages.push(...docs)
      return { insertedCount: docs.length }
    }),
  },
  aiSessions: {
    updateOne: vi.fn(async (...args) => {
      mockSessionUpdates.push(args)
      return { modifiedCount: 1 }
    }),
  },
}

const { AgentMessageStore } = await import(
  '../../../../app/js/agent/AgentMessageStore.js'
)

describe('AgentMessageStore', () => {
  let store

  beforeEach(() => {
    mockToolCalls.clear()
    mockMessages.length = 0
    mockSessionUpdates.length = 0
    mockAllocateSeq.mockReset().mockResolvedValue(10)
    for (const collection of Object.values(db)) {
      for (const method of Object.values(collection)) {
        if (method?.mockClear) method.mockClear()
      }
    }
    store = new AgentMessageStore({ db, allocateSeq: mockAllocateSeq })
  })

  it('persists tool calls with parsed arguments and completion metadata', async () => {
    await store.startToolCall({
      sessionId: 'session-1',
      messageId: 'message-1',
      toolCall: {
        id: 'tc-1',
        function: {
          name: 'edit_document',
          arguments: '{"path":"main.tex","changeId":"chg-1"}',
        },
      },
    })

    await store.finishToolCall({
      sessionId: 'session-1',
      toolCallId: 'tc-1',
      toolName: 'edit_document',
      result: {
        success: true,
        output: 'edited main.tex',
        data: { changeId: 'chg-1', artifactId: 'art-1' },
      },
    })

    const [doc] = await store.listToolCalls('session-1')
    expect(doc).toMatchObject({
      sessionId: 'session-1',
      messageId: 'message-1',
      toolCallId: 'tc-1',
      name: 'edit_document',
      arguments: { path: 'main.tex', changeId: 'chg-1' },
      status: 'completed',
      resultSummary: 'edited main.tex',
      relatedChangeIds: ['chg-1'],
      relatedArtifactIds: ['art-1'],
    })
    expect(doc.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('records failed turns without exposing stack traces', async () => {
    const error = new Error('provider failed')
    error.code = 'MODEL_ERROR'
    error.status = 502

    await store.markTurnFailed({ sessionId: 'session-1', error })

    expect(mockMessages).toHaveLength(1)
    expect(mockMessages[0]).toMatchObject({
      sessionId: 'session-1',
      seq: 10,
      role: 'assistant',
      content: '',
      status: 'error',
      error: {
        message: 'provider failed',
        code: 'MODEL_ERROR',
        status: 502,
      },
    })
    expect(mockMessages[0].error.stack).toBeUndefined()
    expect(mockSessionUpdates).toHaveLength(1)
  })

  it('persists a simple user and assistant turn with inspectable blocks', async () => {
    await store.saveSimpleTurn({
      sessionId: 'child-session-1',
      userContent: 'Audit references',
      assistantContent: 'Found two issues.',
      contentBlocks: [{ type: 'text', content: 'Found two issues.' }],
      toolContext: [{ role: 'tool', tool_call_id: 'tc-1', content: 'ok' }],
    })

    expect(mockAllocateSeq).toHaveBeenCalledWith('child-session-1', 2)
    expect(mockMessages).toHaveLength(2)
    expect(mockMessages[0]).toMatchObject({
      sessionId: 'child-session-1',
      seq: 10,
      role: 'user',
      content: 'Audit references',
    })
    expect(mockMessages[1]).toMatchObject({
      sessionId: 'child-session-1',
      seq: 11,
      role: 'assistant',
      content: 'Found two issues.',
      contentBlocks: [{ type: 'text', content: 'Found two issues.' }],
      toolContext: [{ role: 'tool', tool_call_id: 'tc-1', content: 'ok' }],
    })
    expect(mockSessionUpdates).toHaveLength(1)
  })
})
