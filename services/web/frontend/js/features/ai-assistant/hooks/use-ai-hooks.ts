/**
 * Custom hooks for AI Assistant session management
 */

import { useCallback, useEffect, useState } from 'react'
import { useAIAssistantContext } from '../context/ai-assistant-context'

/**
 * Hook for managing AI session lifecycle
 * Automatically creates session when panel opens and cleans up on close
 */
export function useAISession(isOpen: boolean) {
  const {
    state,
    createSession,
    deleteSession,
    switchSession,
    renameSession,
    hasSession,
  } = useAIAssistantContext()

  const [autoCreateAttempted, setAutoCreateAttempted] = useState(false)

  // Auto-create session when panel opens for the first time
  useEffect(() => {
    if (isOpen && !hasSession && !autoCreateAttempted) {
      setAutoCreateAttempted(true)
      createSession()
    }
  }, [isOpen, hasSession, autoCreateAttempted, createSession])

  // Reset auto-create flag when session is deleted
  useEffect(() => {
    if (!hasSession) {
      setAutoCreateAttempted(false)
    }
  }, [hasSession])

  return {
    session: state.session,
    isLoading: state.status === 'pending' && !hasSession,
    error: state.error,
    createSession,
    deleteSession,
    switchSession,
    renameSession,
    hasSession,
  }
}

/**
 * Hook for AI chat functionality
 */
export function useAIChat() {
  const { state, sendMessage, isStreaming, clearError } =
    useAIAssistantContext()

  const send = useCallback(
    async (content: string) => {
      if (!content.trim() || isStreaming) return
      await sendMessage(content)
    },
    [sendMessage, isStreaming]
  )

  return {
    messages: state.messages,
    activeBlocks: state.activeBlocks,
    isStreaming,
    error: state.error,
    sendMessage: send,
    clearError,
  }
}

/**
 * Hook for managing the current awaiting confirmation change
 */
export function useAwaitingConfirmation() {
  const {
    state,
    confirmChange,
    hasAwaitingConfirmation,
  } = useAIAssistantContext()

  return {
    awaitingConfirmation: state.awaitingConfirmation,
    changeHistory: state.changeHistory,
    hasAwaitingConfirmation,
    confirmChange,
  }
}
