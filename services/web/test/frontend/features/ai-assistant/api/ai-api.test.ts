import { expect } from 'chai'
import fetchMock from 'fetch-mock'
import * as aiApi from '@/features/ai-assistant/api/ai-api'
import type { AIEvent } from '@/features/ai-assistant/types/ai-types'
import { mockSSEResponse, resetAIApiMocks } from '../helpers/ai-api-mock'
import {
  createMockSession,
  createMockPendingChange,
  createMockAssistantMessage,
  createTextChunkEvent,
  createPendingChangeEvent,
  createMessageCompleteEvent,
  createErrorEvent,
  createDoneEvent,
  resetMockCounters,
} from '../helpers/ai-mock-data'
import {
  setupAIMetaAttributes,
  clearAIMetaAttributes,
} from '../helpers/ai-test-providers'

describe('AI API', function () {
  beforeEach(function () {
    resetAIApiMocks()
    resetMockCounters()
    setupAIMetaAttributes()
  })

  afterEach(function () {
    resetAIApiMocks()
    clearAIMetaAttributes()
  })

  describe('Session CRUD', function () {
    it('creates a session successfully', async function () {
      const mockSession = createMockSession({ id: 'new-session-123' })
      fetchMock.post('/api/ai/sessions', {
        status: 200,
        body: { session: mockSession },
      })

      const session = await aiApi.createSession('project123')

      expect(session.id).to.equal('new-session-123')
      expect(session.projectId).to.equal('project123')
    })

    it('retrieves a session', async function () {
      const mockSession = createMockSession({ id: 'existing-session' })
      fetchMock.get('/api/ai/sessions/existing-session?limit=200', {
        status: 200,
        body: { session: mockSession },
      })

      const session = await aiApi.getSession('existing-session')

      expect(session.id).to.equal('existing-session')
    })

    it('deletes a session', async function () {
      fetchMock.delete('/api/ai/sessions/session-to-delete', 204)

      await aiApi.deleteSession('session-to-delete')

      expect(
        fetchMock.callHistory.called('/api/ai/sessions/session-to-delete', {
          method: 'delete',
        })
      ).to.be.true
    })

    it('throws on server error', async function () {
      fetchMock.post('/api/ai/sessions', {
        status: 500,
        body: { message: 'Internal server error' },
      })

      try {
        await aiApi.createSession('project123')
        expect.fail('Should have thrown')
      } catch (error) {
        expect(aiApi.isAIApiError(error)).to.be.true
      }
    })
  })

  describe('SSE parsing', function () {
    it('parses text_chunk events', async function () {
      const events = [
        createTextChunkEvent('Hello ', 'msg-1'),
        createTextChunkEvent('world!', 'msg-1'),
        createDoneEvent(),
      ]

      fetchMock.post('/api/ai/sessions/s1/messages', () =>
        mockSSEResponse(events)
      )

      const received: AIEvent[] = []
      const stream = aiApi.sendMessage('s1', 'Hi')
      for await (const event of stream) {
        received.push(event)
      }

      expect(received).to.have.length(3)
      expect(received[0].type).to.equal('text_chunk')
      expect((received[0] as any).content).to.equal('Hello ')
    })

    it('parses pending_change events', async function () {
      const change = createMockPendingChange({
        id: 'change-1',
        oldText: 'old',
        newText: 'new',
      })
      const events = [createPendingChangeEvent(change), createDoneEvent()]

      fetchMock.post('/api/ai/sessions/s1/messages', () =>
        mockSSEResponse(events)
      )

      const received: AIEvent[] = []
      const stream = aiApi.sendMessage('s1', 'Test')
      for await (const event of stream) {
        received.push(event)
      }

      expect(received).to.have.length(2)
      expect(received[0].type).to.equal('pending_change')
      expect((received[0] as any).change.id).to.equal('change-1')
    })

    it('parses message_complete events', async function () {
      const message = createMockAssistantMessage('Full response', {
        id: 'msg-complete',
      })
      const events = [createMessageCompleteEvent(message), createDoneEvent()]

      fetchMock.post('/api/ai/sessions/s1/messages', () =>
        mockSSEResponse(events)
      )

      const received: AIEvent[] = []
      const stream = aiApi.sendMessage('s1', 'Test')
      for await (const event of stream) {
        received.push(event)
      }

      expect(received).to.have.length(2)
      expect(received[0].type).to.equal('message_complete')
      expect((received[0] as any).message.content).to.equal('Full response')
    })

    it('parses error events', async function () {
      const events = [
        createErrorEvent('RATE_LIMIT', 'Too many requests'),
        createDoneEvent(),
      ]

      fetchMock.post('/api/ai/sessions/s1/messages', () =>
        mockSSEResponse(events)
      )

      const received: AIEvent[] = []
      const stream = aiApi.sendMessage('s1', 'Test')
      for await (const event of stream) {
        received.push(event)
      }

      expect(received).to.have.length(2)
      expect(received[0].type).to.equal('error')
      expect((received[0] as any).error.code).to.equal('RATE_LIMIT')
    })

    it('stops on [DONE] marker', async function () {
      const events = [createTextChunkEvent('Hello', 'msg-1'), createDoneEvent()]

      fetchMock.post('/api/ai/sessions/s1/messages', () =>
        mockSSEResponse(events)
      )

      const received: AIEvent[] = []
      const stream = aiApi.sendMessage('s1', 'Test')
      for await (const event of stream) {
        received.push(event)
      }

      expect(received).to.have.length(2)
    })
  })

  describe('SSE edge cases', function () {
    it('handles partial lines in buffer', async function () {
      const encoder = new TextEncoder()
      let sentPart1 = false

      const stream = new ReadableStream({
        pull(controller) {
          if (!sentPart1) {
            controller.enqueue(
              encoder.encode('data: {"type":"text_chunk","content":"He')
            )
            sentPart1 = true
          } else {
            controller.enqueue(
              encoder.encode(
                'llo","messageId":"m1","timestamp":123}\n\ndata: [DONE]\n\n'
              )
            )
            controller.close()
          }
        },
      })

      fetchMock.post(
        '/api/ai/sessions/s1/messages',
        new Response(stream, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        })
      )

      const received: AIEvent[] = []
      const gen = aiApi.sendMessage('s1', 'Test')
      for await (const event of gen) {
        received.push(event)
      }

      expect(received).to.have.length(1)
      expect((received[0] as any).content).to.equal('Hello')
    })

    it('ignores malformed JSON lines', async function () {
      const encoder = new TextEncoder()
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              'data: {"type":"text_chunk","content":"A","messageId":"m1","timestamp":1}\n\n'
            )
          )
          controller.enqueue(encoder.encode('data: {invalid json}\n\n'))
          controller.enqueue(
            encoder.encode(
              'data: {"type":"text_chunk","content":"B","messageId":"m1","timestamp":2}\n\n'
            )
          )
          controller.enqueue(encoder.encode('data: [DONE]\n\n'))
          controller.close()
        },
      })

      fetchMock.post(
        '/api/ai/sessions/s1/messages',
        new Response(stream, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        })
      )

      const received: AIEvent[] = []
      const gen = aiApi.sendMessage('s1', 'Test')
      for await (const event of gen) {
        received.push(event)
      }

      expect(received).to.have.length(2)
      expect((received[0] as any).content).to.equal('A')
      expect((received[1] as any).content).to.equal('B')
    })
  })

  describe('error handling', function () {
    it('throws on HTTP 500', async function () {
      fetchMock.post('/api/ai/sessions/s1/messages', {
        status: 500,
        body: { message: 'Server error' },
      })

      try {
        const stream = aiApi.sendMessage('s1', 'Test')
        for await (const _event of stream) {
          // no-op
        }
        expect.fail('Should have thrown')
      } catch (error) {
        expect(aiApi.isAIApiError(error)).to.be.true
      }
    })

    it('throws on HTTP 401', async function () {
      fetchMock.post('/api/ai/sessions/s1/messages', {
        status: 401,
        body: { message: 'Unauthorized' },
      })

      try {
        const stream = aiApi.sendMessage('s1', 'Test')
        for await (const _event of stream) {
          // no-op
        }
        expect.fail('Should have thrown')
      } catch (error) {
        expect(aiApi.isAIApiError(error)).to.be.true
      }
    })

    it('throws on HTTP 429', async function () {
      fetchMock.post('/api/ai/sessions/s1/messages', {
        status: 429,
        body: { message: 'Rate limited' },
      })

      try {
        const stream = aiApi.sendMessage('s1', 'Test')
        for await (const _event of stream) {
          // no-op
        }
        expect.fail('Should have thrown')
      } catch (error) {
        expect(aiApi.isAIApiError(error)).to.be.true
      }
    })
  })

  describe('change management', function () {
    it('accepts a change', async function () {
      const acceptedChange = createMockPendingChange({
        id: 'change-1',
        status: 'accepted',
      })

      fetchMock.post('/api/ai/sessions/s1/changes/change-1/accept', {
        status: 200,
        body: { success: true, change: acceptedChange },
      })

      const result = await aiApi.acceptChange('s1', 'change-1')

      expect(result.id).to.equal('change-1')
      expect(result.status).to.equal('accepted')
    })

    it('rejects a change', async function () {
      const rejectedChange = createMockPendingChange({
        id: 'change-2',
        status: 'rejected',
      })

      fetchMock.post('/api/ai/sessions/s1/changes/change-2/reject', {
        status: 200,
        body: { success: true, change: rejectedChange },
      })

      const result = await aiApi.rejectChange('s1', 'change-2')

      expect(result.id).to.equal('change-2')
      expect(result.status).to.equal('rejected')
    })
  })

  describe('health check', function () {
    it('returns true when healthy', async function () {
      fetchMock.get('/api/ai/health', 200)

      const isHealthy = await aiApi.checkAIServiceHealth()

      expect(isHealthy).to.be.true
    })

    it('returns false when unhealthy', async function () {
      fetchMock.get('/api/ai/health', 503)

      const isHealthy = await aiApi.checkAIServiceHealth()

      expect(isHealthy).to.be.false
    })
  })
})
