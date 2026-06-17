/**
 * Applied Changes Navigation Bar
 * Shows a navigation bar for auto-accepted changes with dismiss controls.
 */

import { memo, useCallback, useContext, useEffect, useRef, useState } from 'react'
import MaterialIcon from '@/shared/components/material-icon'
import OLButton from '@/shared/components/ol/ol-button'
import OLTooltip from '@/shared/components/ol/ol-tooltip'
import { EditorViewContext } from '@/features/ide-react/context/editor-view-context'
import { useEditorManagerContext } from '@/features/ide-react/context/editor-manager-context'
import { useEditorOpenDocContext } from '@/features/ide-react/context/editor-open-doc-context'
import { EditorView } from '@codemirror/view'
import type { PendingChange } from '../types/ai-types'

interface AppliedChangesNavProps {
  changes: PendingChange[]
  onDismiss: (changeId: string) => void
  onDismissAll: () => void
}

function AppliedChangesNav({
  changes,
  onDismiss,
  onDismissAll,
}: AppliedChangesNavProps) {
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

  // Auto-scroll to the first change when nav bar appears
  const hasScrolledRef = useRef(false)
  useEffect(() => {
    if (!hasScrolledRef.current && changes.length > 0) {
      hasScrolledRef.current = true
      scrollToChange(changes[0])
    }
  }, [changes, scrollToChange])

  const handleDismissCurrent = useCallback(() => {
    if (current) {
      onDismiss(current.id)
      // Adjust index if we dismissed the last item
      setCurrentIndex(i => Math.min(i, changes.length - 2))
    }
  }, [current, onDismiss, changes.length])

  if (!current || changes.length === 0) return null

  const fileName = current.path?.split('/').pop() || current.docPath?.split('/').pop() || '\u2014'

  return (
    <div className="ai-changes-nav ai-changes-nav-applied">
      {/* Counter + navigation */}
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

      {/* File name (click to navigate) */}
      <OLTooltip
        id="ai-applied-nav-file"
        description={current.path || current.docPath || 'Unknown file'}
        overlayProps={{ placement: 'bottom' }}
      >
        <span
          className="ai-changes-nav-file"
          onClick={navigateToCurrent}
          role="button"
          tabIndex={0}
          onKeyDown={e => {
            if (e.key === 'Enter') navigateToCurrent()
          }}
        >
          <MaterialIcon type="description" />
          <span className="ai-changes-nav-file-name">{fileName}</span>
        </span>
      </OLTooltip>

      {/* Dismiss actions */}
      <div className="ai-changes-nav-group ai-changes-nav-actions">
        <OLTooltip
          id="ai-applied-dismiss"
          description="Dismiss this change"
          overlayProps={{ placement: 'bottom' }}
        >
          <OLButton
            variant="ghost"
            size="sm"
            className="ai-changes-nav-btn"
            onClick={handleDismissCurrent}
            aria-label="Dismiss change"
          >
            <MaterialIcon type="close" />
          </OLButton>
        </OLTooltip>
        <OLTooltip
          id="ai-applied-dismiss-all"
          description="Dismiss all"
          overlayProps={{ placement: 'bottom' }}
        >
          <OLButton
            variant="ghost"
            size="sm"
            className="ai-changes-nav-btn"
            onClick={onDismissAll}
            aria-label="Dismiss all changes"
          >
            <MaterialIcon type="clear_all" />
          </OLButton>
        </OLTooltip>
      </div>
    </div>
  )
}

export default memo(AppliedChangesNav)
