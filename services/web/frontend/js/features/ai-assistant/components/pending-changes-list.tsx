/**
 * Change Confirmation Bar
 * Shows accept/reject controls for awaiting changes
 * in the synchronous edit confirmation flow.
 * Supports multiple parallel changes with navigation.
 */

import { memo, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import MaterialIcon from '@/shared/components/material-icon'
import OLButton from '@/shared/components/ol/ol-button'
import OLTooltip from '@/shared/components/ol/ol-tooltip'
import { EditorViewContext } from '@/features/ide-react/context/editor-view-context'
import { useEditorManagerContext } from '@/features/ide-react/context/editor-manager-context'
import { useEditorOpenDocContext } from '@/features/ide-react/context/editor-open-doc-context'
import { EditorView } from '@codemirror/view'
import type { PendingChange } from '../types/ai-types'

interface PendingChangesListProps {
  changes: PendingChange[]
  onAccept: (changeId: string) => void
  onReject: (changeId: string) => void
  onAcceptAll: () => void
  onRejectAll: () => void
}

function PendingChangesList({
  changes,
  onAccept,
  onReject,
  onAcceptAll,
  onRejectAll,
}: PendingChangesListProps) {
  const editorViewCtx = useContext(EditorViewContext)
  const { openDocWithId } = useEditorManagerContext()
  const { currentDocumentId } = useEditorOpenDocContext()

  const [currentIndex, setCurrentIndex] = useState(0)
  const safeIndex = Math.min(currentIndex, changes.length - 1)
  const current = changes[safeIndex]

  const scrollToChange = useCallback(
    (change: PendingChange) => {
      if (!change?.position) return
      const view = editorViewCtx?.view
      if (!view) return

      const scrollTo = (v: EditorView, pos: number) => {
        v.dispatch({
          selection: { anchor: pos },
          effects: EditorView.scrollIntoView(pos, { y: 'center' }),
        })
        v.focus()
      }

      if (change.docId && change.docId !== currentDocumentId) {
        openDocWithId(change.docId)
        setTimeout(() => {
          const v = editorViewCtx?.view
          if (v && change.position) {
            scrollTo(v, change.position.start)
          }
        }, 300)
      } else {
        scrollTo(view, change.position.start)
      }
    },
    [editorViewCtx?.view, currentDocumentId, openDocWithId]
  )

  const navigateToCurrent = useCallback(() => {
    if (current) scrollToChange(current)
  }, [current, scrollToChange])

  const handleAccept = useCallback(() => {
    if (current) onAccept(current.id)
  }, [current, onAccept])

  const handleReject = useCallback(() => {
    if (current) onReject(current.id)
  }, [current, onReject])

  const handlePrev = useCallback(() => {
    const newIndex = Math.max(0, safeIndex - 1)
    setCurrentIndex(newIndex)
    const target = changes[newIndex]
    if (target) scrollToChange(target)
  }, [safeIndex, changes, scrollToChange])

  const handleNext = useCallback(() => {
    const newIndex = Math.min(changes.length - 1, safeIndex + 1)
    setCurrentIndex(newIndex)
    const target = changes[newIndex]
    if (target) scrollToChange(target)
  }, [safeIndex, changes, scrollToChange])

  // Auto-scroll to the first change when nav bar first appears
  const hasScrolledRef = useRef(false)
  useEffect(() => {
    if (!hasScrolledRef.current && changes.length > 0) {
      hasScrolledRef.current = true
      scrollToChange(changes[0])
    }
  }, [changes, scrollToChange])

  const changeTypeLabel = useMemo(() => {
    switch (current?.type) {
      case 'create': return 'Create'
      case 'delete': return 'Delete'
      default: return 'Edit'
    }
  }, [current?.type])

  if (!current || changes.length === 0) return null

  const currentLabel = current.path || current.docPath || ''
  const hasMultiple = changes.length > 1
  const allStale = changes.every(c => !!c.stale)

  return (
    <div className="ai-changes-nav">
      {/* Counter + navigation (only when multiple) */}
      {hasMultiple && (
        <>
          <span className="ai-changes-nav-counter">
            {safeIndex + 1}/{changes.length}
          </span>
          <div className="ai-changes-nav-group">
            <OLButton
              variant="ghost"
              size="sm"
              className="ai-changes-nav-btn"
              onClick={handlePrev}
              disabled={safeIndex === 0}
              aria-label="Previous change"
            >
              <MaterialIcon type="keyboard_arrow_up" />
            </OLButton>
            <OLButton
              variant="ghost"
              size="sm"
              className="ai-changes-nav-btn"
              onClick={handleNext}
              disabled={safeIndex >= changes.length - 1}
              aria-label="Next change"
            >
              <MaterialIcon type="keyboard_arrow_down" />
            </OLButton>
          </div>
          <div className="ai-changes-nav-separator" />
        </>
      )}

      {/* Change type indicator */}
      <span className="ai-changes-nav-counter">
        {changeTypeLabel}
      </span>

      {/* File indicator */}
      <OLTooltip
        id="ai-nav-file"
        description={currentLabel || 'Unknown file'}
        overlayProps={{ placement: 'bottom' }}
      >
        <span
          className="ai-changes-nav-file"
          onClick={navigateToCurrent}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => { if (e.key === 'Enter') navigateToCurrent() }}
        >
          <MaterialIcon type="description" />
          <span className="ai-changes-nav-file-name">
            {currentLabel ? currentLabel.split('/').pop() : '\u2014'}
          </span>
        </span>
      </OLTooltip>

      {/* Accept / Reject current */}
      <div className="ai-changes-nav-group ai-changes-nav-actions">
        <OLTooltip
          id="ai-nav-reject"
          description="Reject change"
          overlayProps={{ placement: 'bottom' }}
        >
          <OLButton
            variant="ghost"
            size="sm"
            className="ai-changes-nav-btn ai-changes-nav-btn-reject"
            onClick={handleReject}
            aria-label="Reject change"
          >
            <MaterialIcon type="close" />
          </OLButton>
        </OLTooltip>

        <OLTooltip
          id="ai-nav-accept"
          description={current.stale ? 'Document changed — accept disabled' : 'Accept change'}
          overlayProps={{ placement: 'bottom' }}
        >
          <OLButton
            variant="ghost"
            size="sm"
            className="ai-changes-nav-btn ai-changes-nav-btn-accept"
            onClick={handleAccept}
            disabled={!!current.stale}
            aria-label="Accept change"
          >
            <MaterialIcon type="check" />
          </OLButton>
        </OLTooltip>

        {/* Accept All / Reject All (only when multiple) */}
        {hasMultiple && (
          <>
            <div className="ai-changes-nav-separator" />
            <OLTooltip
              id="ai-nav-reject-all"
              description="Reject all"
              overlayProps={{ placement: 'bottom' }}
            >
              <OLButton
                variant="ghost"
                size="sm"
                className="ai-changes-nav-btn ai-changes-nav-btn-reject"
                onClick={onRejectAll}
                aria-label="Reject all changes"
              >
                <MaterialIcon type="delete_sweep" />
              </OLButton>
            </OLTooltip>
            <OLTooltip
              id="ai-nav-accept-all"
              description={allStale ? 'All changes are stale' : 'Accept all'}
              overlayProps={{ placement: 'bottom' }}
            >
              <OLButton
                variant="ghost"
                size="sm"
                className="ai-changes-nav-btn ai-changes-nav-btn-accept"
                onClick={onAcceptAll}
                disabled={allStale}
                aria-label="Accept all changes"
              >
                <MaterialIcon type="done_all" />
              </OLButton>
            </OLTooltip>
          </>
        )}
      </div>
    </div>
  )
}

export default memo(PendingChangesList)
