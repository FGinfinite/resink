import { renderHook, act } from '@testing-library/react'
import { expect } from 'chai'
import fetchMock from 'fetch-mock'
import { useAIAssistantContext } from '@/features/ai-assistant/context/ai-assistant-context'
import { resetAIApiMocks, mockSSEResponse } from '../helpers/ai-api-mock'
import {
  createMockSession,
  createMockAssistantMessage,
  createTextChunkEvent,
  createMessageCompleteEvent,
  createErrorEvent,
  createDoneEvent,
  resetMockCounters,
} from '../helpers/ai-mock-data'
import {
  createAIProviderWrapper,
  setupAIMetaAttributes,
  clearAIMetaAttributes,
} from '../helpers/ai-test-providers'

describe('AIAssistantContext', function () {
  beforeEach(function () {
    resetAIApiMocks()
    resetMockCounters()
    setupAIMetaAttributes()
  })

  afterEach(function () {
    resetAIApiMocks()
    clearAIMetaAttributes()
  })

  describe('initial state', function () {
    it('starts with correct default values', function () {
      const { result } = renderHook(() => useAIAssistantContext(), {
        wrapper: createAIProviderWrapper(),
      })

      expect(result.current.state.session).to.be.null
      expect(result.current.state.status).to.equal('idle')
      expect(result.current.state.messages).to.have.length(0)
      expect(result.current.state.awaitingConfirmation).to.have.length(0)
      expect(result.current.state.changeHistory).to.have.length(0)
      expect(result.current.state.activeBlocks).to.have.length(0)
      expect(result.current.state.error).to.be.null
      expect(result.current.state.initialized).to.be.false
    })
  })

  describe('createSession', function () {
    it('creates session and sets initialized', async function () {
      const mockSession = createMockSession({ id: 'new-session' })
      fetchMock.post('/api/ai/sessions', {
        status: 200,
        body: { session: mockSession },
      })

      const { result } = renderHook(() => useAIAssistantContext(), {
        wrapper: createAIProviderWrapper(),
      })

      await act(async () => {
        await result.current.createSession()
      })

      expect(result.current.state.session?.id).to.equal('new-session')
      expect(result.current.state.status).to.equal('idle')
      expect(result.current.state.initialized).to.be.true
    })

    it('handles creation error', async function () {
      fetchMock.post('/api/ai/sessions', {
        status: 500,
        body: { message: 'Server error' },
      })

      const { result } = renderHook(() => useAIAssistantContext(), {
        wrapper: createAIProviderWrapper(),
      })

      await act(async () => {
        await result.current.createSession()
      })

      expect(result.current.state.status).to.equal('error')
      expect(result.current.state.error).to.not.be.null
    })
  })

  describe('sendMessage', function () {
    beforeEach(async function () {
      const mockSession = createMockSession({ id: 'chat-session' })
      fetchMock.post('/api/ai/sessions', {
        status: 200,
        body: { session: mockSession },
      })
    })

    it('adds user message and assistant response', async function () {
      const assistantMessage = createMockAssistantMessage('AI response', {
        id: 'assistant-1',
      })
      const events = [
        createTextChunkEvent('AI response', 'assistant-1'),
        createMessageCompleteEvent(assistantMessage),
        createDoneEvent(),
      ]
      fetchMock.post('/api/ai/sessions/chat-session/messages', () =>
        mockSSEResponse(events)
      )

      const { result } = renderHook(() => useAIAssistantContext(), {
        wrapper: createAIProviderWrapper(),
      })

      await act(async () => {
        await result.current.createSession()
      })

      await act(async () => {
        await result.current.sendMessage('Test')
      })

      expect(result.current.state.messages).to.have.length(2)
      expect(result.current.state.messages[0].role).to.equal('user')
      expect(result.current.state.messages[1].role).to.equal('assistant')
    })

    it('handles stream with no changes gracefully', async function () {
      const events = [
        createDoneEvent(),
      ]
      fetchMock.post('/api/ai/sessions/chat-session/messages', () =>
        mockSSEResponse(events)
      )

      const { result } = renderHook(() => useAIAssistantContext(), {
        wrapper: createAIProviderWrapper(),
      })

      await act(async () => {
        await result.current.createSession()
      })

      await act(async () => {
        await result.current.sendMessage('Edit something')
      })

      expect(result.current.state.awaitingConfirmation).to.have.length(0)
      expect(result.current.state.changeHistory).to.have.length(0)
    })

    it('handles stream errors', async function () {
      const events = [
        createErrorEvent('AI_ERROR', 'Something went wrong'),
        createDoneEvent(),
      ]
      fetchMock.post('/api/ai/sessions/chat-session/messages', () =>
        mockSSEResponse(events)
      )

      const { result } = renderHook(() => useAIAssistantContext(), {
        wrapper: createAIProviderWrapper(),
      })

      await act(async () => {
        await result.current.createSession()
      })

      await act(async () => {
        await result.current.sendMessage('Test')
      })

      expect(result.current.state.streamingError).to.not.be.null
      expect(result.current.state.streamingError?.message).to.include(
        'Something went wrong'
      )
    })

    it('ignores empty messages', async function () {
      const { result } = renderHook(() => useAIAssistantContext(), {
        wrapper: createAIProviderWrapper(),
      })

      await act(async () => {
        await result.current.createSession()
      })

      await act(async () => {
        await result.current.sendMessage('')
        await result.current.sendMessage('   ')
      })

      expect(result.current.state.messages).to.have.length(0)
    })
  })

  describe('confirmChange', function () {
    beforeEach(async function () {
      const mockSession = createMockSession({ id: 'change-session' })
      fetchMock.post('/api/ai/sessions', {
        status: 200,
        body: { session: mockSession },
      })
    })

    it('calls confirm-change API with accept action', async function () {
      fetchMock.post(
        '/api/ai/sessions/change-session/confirm-change/change-1',
        {
          status: 200,
          body: { success: true },
        }
      )

      const { result } = renderHook(() => useAIAssistantContext(), {
        wrapper: createAIProviderWrapper(),
      })

      await act(async () => {
        await result.current.createSession()
      })

      await act(async () => {
        await result.current.confirmChange('change-1', 'accept')
      })

      expect(
        fetchMock.callHistory.called(
          '/api/ai/sessions/change-session/confirm-change/change-1'
        )
      ).to.be.true
    })

    it('calls confirm-change API with reject action', async function () {
      fetchMock.post(
        '/api/ai/sessions/change-session/confirm-change/change-2',
        {
          status: 200,
          body: { success: true },
        }
      )

      const { result } = renderHook(() => useAIAssistantContext(), {
        wrapper: createAIProviderWrapper(),
      })

      await act(async () => {
        await result.current.createSession()
      })

      await act(async () => {
        await result.current.confirmChange('change-2', 'reject', 'Not needed')
      })

      expect(
        fetchMock.callHistory.called(
          '/api/ai/sessions/change-session/confirm-change/change-2'
        )
      ).to.be.true
    })
  })

  describe('reset', function () {
    it('clears all state to initial', async function () {
      const mockSession = createMockSession({ id: 'reset-session' })
      fetchMock.post('/api/ai/sessions', {
        status: 200,
        body: { session: mockSession },
      })

      const events = [
        createMessageCompleteEvent(createMockAssistantMessage('Hello')),
        createDoneEvent(),
      ]
      fetchMock.post('/api/ai/sessions/reset-session/messages', () =>
        mockSSEResponse(events)
      )

      const { result } = renderHook(() => useAIAssistantContext(), {
        wrapper: createAIProviderWrapper(),
      })

      await act(async () => {
        await result.current.createSession()
      })

      await act(async () => {
        await result.current.sendMessage('Test')
      })

      expect(result.current.hasSession).to.be.true

      act(() => {
        result.current.reset()
      })

      expect(result.current.hasSession).to.be.false
      expect(result.current.state.session).to.be.null
      expect(result.current.state.messages).to.have.length(0)
      expect(result.current.state.initialized).to.be.false
    })
  })

  describe('clearError', function () {
    it('clears error and sets status to idle', async function () {
      fetchMock.post('/api/ai/sessions', {
        status: 500,
        body: { message: 'Error' },
      })

      const { result } = renderHook(() => useAIAssistantContext(), {
        wrapper: createAIProviderWrapper(),
      })

      await act(async () => {
        await result.current.createSession()
      })

      expect(result.current.state.error).to.not.be.null

      act(() => {
        result.current.clearError()
      })

      expect(result.current.state.error).to.be.null
      expect(result.current.state.status).to.equal('idle')
    })
  })

  describe('AIAssistantProvider', function () {
    it('throws when used outside provider', function () {
      expect(() => {
        renderHook(() => useAIAssistantContext())
      }).to.throw('useAIAssistantContext is only available inside AIAssistantProvider')
    })
  })
})
