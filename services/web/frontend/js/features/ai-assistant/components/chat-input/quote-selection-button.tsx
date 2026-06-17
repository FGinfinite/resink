import React, { useCallback, useEffect, useMemo } from 'react'
import {
  $getRoot,
  $getSelection,
  $isRangeSelection,
  $createTextNode,
  $isParagraphNode,
} from 'lexical'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { useEditorViewContext } from '@/features/ide-react/context/editor-view-context'
import { useEditorSelectionContext } from '@/shared/context/editor-selection-context'
import { useEditorOpenDocContext } from '@/features/ide-react/context/editor-open-doc-context'
import { useFileTreePathContext } from '@/features/file-tree/contexts/file-tree-path'
import MaterialIcon from '@/shared/components/material-icon'
import { $createMentionNode } from './mention-node'
import { quoteToAIBridge } from '../../context/quote-to-ai-bridge'
import type { QuoteToAIPayload } from '../../context/quote-to-ai-bridge'

export default function QuoteSelectionButton(): React.ReactElement {
  const [editor] = useLexicalComposerContext()
  const { view } = useEditorViewContext()
  const { editorSelection } = useEditorSelectionContext()
  const { currentDocumentId } = useEditorOpenDocContext()
  const { pathInFolder } = useFileTreePathContext()

  const hasSelection = useMemo(() => {
    if (!editorSelection?.main) return false
    return editorSelection.main.from !== editorSelection.main.to
  }, [editorSelection])

  // Listen for external quote requests (from Quick Edit toolbar)
  useEffect(() => {
    const unsubscribe = quoteToAIBridge.subscribe((payload: QuoteToAIPayload) => {
      const displayText = `@${payload.filePath}:${payload.startLine}-${payload.endLine}`

      editor.update(() => {
        const mentionNode = $createMentionNode(displayText, 'selection', payload.filePath, {
          startLine: payload.startLine,
          endLine: payload.endLine,
          selectionText: payload.selectedText,
        })
        const spaceNode = $createTextNode(' ')
        const selection = $getSelection()

        if ($isRangeSelection(selection)) {
          selection.insertNodes([mentionNode, spaceNode])
        } else {
          const root = $getRoot()
          const lastChild = root.getLastChild()
          if (lastChild && $isParagraphNode(lastChild)) {
            lastChild.append(mentionNode, spaceNode)
          }
        }
      })
    })

    return unsubscribe
  }, [editor])

  const handleClick = useCallback(() => {
    if (!view || !editorSelection?.main || !currentDocumentId) return

    const { from, to } = editorSelection.main
    if (from === to) return

    const selectedText = view.state.sliceDoc(from, to)
    const startLine = view.state.doc.lineAt(from).number
    const endLine = view.state.doc.lineAt(to).number
    const filePath = pathInFolder(currentDocumentId)

    if (!filePath) return

    const displayText = `@${filePath}:${startLine}-${endLine}`

    editor.update(() => {
      const mentionNode = $createMentionNode(displayText, 'selection', filePath, {
        startLine,
        endLine,
        selectionText: selectedText,
      })
      const spaceNode = $createTextNode(' ')
      const selection = $getSelection()

      if ($isRangeSelection(selection)) {
        selection.insertNodes([mentionNode, spaceNode])
      } else {
        const root = $getRoot()
        const lastChild = root.getLastChild()
        if (lastChild && $isParagraphNode(lastChild)) {
          lastChild.append(mentionNode, spaceNode)
        }
      }
    })
  }, [view, editorSelection, currentDocumentId, pathInFolder, editor])

  return (
    <button
      type="button"
      className="ai-quote-selection-button"
      disabled={!hasSelection}
      onClick={handleClick}
      aria-label="Quote editor selection"
    >
      <MaterialIcon type="format_quote" />
    </button>
  )
}
