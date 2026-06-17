/**
 * Hook to sync AI changes from React state to CodeMirror editor.
 * Handles both manual confirmation mode and auto-accept applied changes.
 */

import { useEffect, useRef } from 'react'
import { useEditorViewContext } from '@/features/ide-react/context/editor-view-context'
import { useEditorOpenDocContext } from '@/features/ide-react/context/editor-open-doc-context'
import { useAIAssistantContext } from '../context/ai-assistant-context'
import { setAIChanges, clearAIChanges } from '../extensions/ai-change-highlight'
import {
  setAIAppliedChanges,
  clearAIAppliedChanges,
} from '../extensions/ai-applied-highlight'

export function useAIEditorSync() {
  const { view } = useEditorViewContext()
  const { currentDocumentId } = useEditorOpenDocContext()
  const { state, confirmChange, autoAccept, dismissAppliedChange, markChangesStale } =
    useAIAssistantContext()
  const prevKeyRef = useRef<string>('')

  // Sync changes to CodeMirror
  useEffect(() => {
    if (!view) return

    if (autoAccept) {
      // Auto-accept mode: show applied changes ghost text
      const docChanges = state.appliedChanges.filter(
        c =>
          c.docId === currentDocumentId &&
          c.type !== 'create' &&
          c.type !== 'delete'
      )
      if (docChanges.length > 0) {
        setAIAppliedChanges(view, docChanges)
      } else {
        clearAIAppliedChanges(view)
      }
      // Clear pending change decorations in auto-accept mode
      clearAIChanges(view)
      prevKeyRef.current = ''
      return
    }

    // Manual confirmation mode: show all awaiting confirmation decorations
    const pendingChanges = state.awaitingConfirmation.filter(
      c => c.docId === currentDocumentId
    )
    const key = pendingChanges.map(c => c.id).join(',')
    if (key === prevKeyRef.current) return
    prevKeyRef.current = key

    if (pendingChanges.length > 0) {
      setAIChanges(view, pendingChanges)
    } else {
      clearAIChanges(view)
    }
    // Clear applied ghosts when not in auto-accept
    clearAIAppliedChanges(view)
  }, [
    view,
    state.awaitingConfirmation,
    state.appliedChanges,
    currentDocumentId,
    autoAccept,
  ])

  // Clear decorations on document switch or unmount
  useEffect(() => {
    return () => {
      if (view) {
        try {
          clearAIChanges(view)
          clearAIAppliedChanges(view)
        } catch {
          // View may be destroyed
        }
      }
      prevKeyRef.current = ''
    }
  }, [view, currentDocumentId])

  // Listen for accept/reject CustomEvents from CodeMirror widgets
  useEffect(() => {
    const handleAccept = (e: Event) => {
      const changeId = (e as CustomEvent).detail?.changeId
      if (changeId) confirmChange(changeId, 'accept')
    }
    const handleReject = (e: Event) => {
      const changeId = (e as CustomEvent).detail?.changeId
      if (changeId) confirmChange(changeId, 'reject')
    }

    window.addEventListener('ai:accept-change', handleAccept)
    window.addEventListener('ai:reject-change', handleReject)
    return () => {
      window.removeEventListener('ai:accept-change', handleAccept)
      window.removeEventListener('ai:reject-change', handleReject)
    }
  }, [confirmChange])

  // Listen for dismiss CustomEvents from applied change ghost widgets
  useEffect(() => {
    const handleDismiss = (e: Event) => {
      const changeId = (e as CustomEvent).detail?.changeId
      if (changeId) dismissAppliedChange(changeId)
    }
    window.addEventListener('ai:dismiss-applied', handleDismiss)
    return () =>
      window.removeEventListener('ai:dismiss-applied', handleDismiss)
  }, [dismissAppliedChange])

  // Sync stale detection from CodeMirror back to React state
  useEffect(() => {
    const handleStale = (e: Event) => {
      const staleIds = (e as CustomEvent).detail?.staleIds as string[] | undefined
      if (staleIds && staleIds.length > 0) {
        markChangesStale(staleIds)
      }
    }
    window.addEventListener('ai:changes-stale', handleStale)
    return () => window.removeEventListener('ai:changes-stale', handleStale)
  }, [markChangesStale])
}
