import React, {
  FC,
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'
import ReactDOM from 'react-dom'
import {
  useCodeMirrorStateContext,
  useCodeMirrorViewContext,
} from '@/features/source-editor/components/codemirror-context'
import {
  quickEditTooltipField,
  setQuickEditModeEffect,
  hideQuickEditTooltipEffect,
} from '@/features/source-editor/extensions/ai-quick-edit-tooltip'
import { getTooltip } from '@codemirror/view'
import getMeta from '@/utils/meta'
import { quickEdit } from '../api/quick-edit-api'
import { quoteToAIBridge } from '../context/quote-to-ai-bridge'
import { useOptionalAIRailContext } from '../context/ai-rail-context'
import { useProjectContext } from '@/shared/context/project-context'
import { useEditorOpenDocContext } from '@/features/ide-react/context/editor-open-doc-context'
import { useFileTreePathContext } from '@/features/file-tree/contexts/file-tree-path'
import type { QuickEditAction, RewriteStyle } from '../types/ai-types'
import AIQuickEditDiffPanel from './ai-quick-edit-diff-panel'

const REWRITE_OPTIONS: Array<{ label: string; value: RewriteStyle; stageLabel: string }> = [
  { label: '学术化', value: 'scientific', stageLabel: '学术化改写' },
  { label: '精简', value: 'concise', stageLabel: '精简改写' },
  { label: '有力', value: 'punchy', stageLabel: '有力改写' },
  { label: '拆分长句', value: 'split', stageLabel: '拆分长句' },
  { label: '合并短句', value: 'join', stageLabel: '合并短句' },
]

const TRANSLATE_OPTIONS: Array<{ label: string; value: string; stageLabel: string }> = [
  { label: '中文', value: 'zh-CN', stageLabel: '翻译为中文' },
  { label: 'English', value: 'en', stageLabel: '翻译为English' },
  { label: '日本語', value: 'ja', stageLabel: '翻译为日本語' },
  { label: '한국어', value: 'ko', stageLabel: '翻译为한국어' },
  { label: 'Deutsch', value: 'de', stageLabel: '翻译为Deutsch' },
  { label: 'Français', value: 'fr', stageLabel: '翻译为Français' },
]

interface ActivePreset {
  action: QuickEditAction
  style?: RewriteStyle
  targetLanguage?: string
  label: string
}

const AIQuickEditToolbar: FC = () => {
  const state = useCodeMirrorStateContext()
  const view = useCodeMirrorViewContext()
  const aiEnabled =
    getMeta('ol-capabilities')?.includes('ai-assistant') ?? false
  const tooltipState = state.field(quickEditTooltipField, false)

  if (!aiEnabled || !tooltipState?.tooltip) {
    return null
  }

  const tooltipView = getTooltip(view, tooltipState.tooltip)

  if (!tooltipView) {
    return null
  }

  return ReactDOM.createPortal(
    <AIQuickEditToolbarContent mode={tooltipState.mode} />,
    tooltipView.dom
  )
}

interface ToolbarContentProps {
  mode: 'idle' | 'editing' | 'loading' | 'diff'
}

const AIQuickEditToolbarContent = memo<ToolbarContentProps>(
  function AIQuickEditToolbarContent({ mode }) {
    const view = useCodeMirrorViewContext()
    const { projectId } = useProjectContext()
    const { currentDocumentId } = useEditorOpenDocContext()
    const { pathInFolder } = useFileTreePathContext()
    const aiRailCtx = useOptionalAIRailContext()

    const [loading, setLoading] = useState(false)
    const [loadingAction, setLoadingAction] = useState<string | null>(null)
    const [diffData, setDiffData] = useState<{
      oldText: string
      newText: string
    } | null>(null)
    const [selectionRange, setSelectionRange] = useState<{
      from: number
      to: number
    } | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [openDropdown, setOpenDropdown] = useState<string | null>(null)
    const [activePreset, setActivePreset] = useState<ActivePreset | null>(null)
    const [customInstruction, setCustomInstruction] = useState('')
    const toolbarRef = useRef<HTMLDivElement>(null)
    const inputRef = useRef<HTMLInputElement>(null)

    // Close dropdown when clicking outside
    useEffect(() => {
      if (!openDropdown) return
      const handleClickOutside = (e: MouseEvent) => {
        if (
          toolbarRef.current &&
          !toolbarRef.current.contains(e.target as Node)
        ) {
          setOpenDropdown(null)
        }
      }
      document.addEventListener('mousedown', handleClickOutside)
      return () => document.removeEventListener('mousedown', handleClickOutside)
    }, [openDropdown])

    // Auto-focus input when entering stage 2
    useEffect(() => {
      if (activePreset && inputRef.current) {
        inputRef.current.focus()
      }
    }, [activePreset])

    const handleQuoteToAI = useCallback(() => {
      if (!currentDocumentId) return
      const { from, to } = view.state.selection.main
      if (from === to) return

      const selectedText = view.state.sliceDoc(from, to)
      const startLine = view.state.doc.lineAt(from).number
      const endLine = view.state.doc.lineAt(to).number
      const filePath = pathInFolder(currentDocumentId)
      if (!filePath) return

      quoteToAIBridge.emit({
        selectedText,
        filePath,
        startLine,
        endLine,
        docId: currentDocumentId,
      })

      // Hide tooltip after quoting
      view.dispatch({ effects: hideQuickEditTooltipEffect.of(null) })

      // Open AI panel
      aiRailCtx?.openAIPanel()
    }, [view, currentDocumentId, pathInFolder, aiRailCtx])

    const handleQuickEdit = useCallback(
      async (
        action: QuickEditAction,
        style?: RewriteStyle,
        targetLanguage?: string,
        customInstr?: string
      ) => {
        if (!currentDocumentId) return
        const { from, to } = view.state.selection.main
        if (from === to) return

        const selectedText = view.state.sliceDoc(from, to)

        // Get surrounding context (~500 chars before and after)
        const contextStart = Math.max(0, from - 500)
        const contextEnd = Math.min(view.state.doc.length, to + 500)
        const surroundingContext =
          view.state.sliceDoc(contextStart, from) +
          '[SELECTED]' +
          view.state.sliceDoc(to, contextEnd)

        setLoading(true)
        setLoadingAction(
          `${action}${style ? `-${style}` : ''}${targetLanguage ? `-${targetLanguage}` : ''}`
        )
        setError(null)
        setOpenDropdown(null)
        setSelectionRange({ from, to })

        // Lock tooltip
        view.dispatch({ effects: setQuickEditModeEffect.of('loading') })

        try {
          const result = await quickEdit({
            projectId,
            docId: currentDocumentId,
            selectedText,
            action,
            style,
            targetLanguage,
            surroundingContext,
            customInstruction: customInstr,
          })

          if (result.success && result.editedText) {
            setDiffData({ oldText: selectedText, newText: result.editedText })
            view.dispatch({ effects: setQuickEditModeEffect.of('diff') })
          } else {
            throw new Error('No edited text returned')
          }
        } catch (err: unknown) {
          const message =
            err instanceof Error ? err.message : 'Quick edit failed'
          setError(message)
          setActivePreset(null)
          setCustomInstruction('')
          view.dispatch({ effects: setQuickEditModeEffect.of('idle') })
        } finally {
          setLoading(false)
          setLoadingAction(null)
        }
      },
      [view, projectId, currentDocumentId]
    )

    const handleStage2Send = useCallback(() => {
      if (!activePreset) return
      const instruction = customInstruction.trim() || undefined
      handleQuickEdit(
        activePreset.action,
        activePreset.style,
        activePreset.targetLanguage,
        instruction
      )
      setActivePreset(null)
      setCustomInstruction('')
    }, [activePreset, customInstruction, handleQuickEdit])

    const handleStage2Cancel = useCallback(() => {
      setActivePreset(null)
      setCustomInstruction('')
      view.dispatch({ effects: setQuickEditModeEffect.of('idle') })
    }, [view])

    const handleApplyDiff = useCallback(
      (finalText: string) => {
        if (!selectionRange || !diffData) return
        // Validate that the original text still matches (guard against concurrent edits)
        const currentText = view.state.sliceDoc(
          selectionRange.from,
          selectionRange.to
        )
        if (currentText !== diffData.oldText) {
          setError('文档已被修改，无法应用变更。请重新选择文本后重试。')
          setDiffData(null)
          setSelectionRange(null)
          view.dispatch({ effects: setQuickEditModeEffect.of('idle') })
          return
        }
        view.dispatch({
          changes: {
            from: selectionRange.from,
            to: selectionRange.to,
            insert: finalText,
          },
        })
        setDiffData(null)
        setSelectionRange(null)
        view.dispatch({ effects: hideQuickEditTooltipEffect.of(null) })
      },
      [view, selectionRange, diffData]
    )

    const handleDiscardDiff = useCallback(() => {
      setDiffData(null)
      setSelectionRange(null)
      setError(null)
      setActivePreset(null)
      setCustomInstruction('')
      view.dispatch({ effects: setQuickEditModeEffect.of('idle') })
    }, [view])

    if (mode === 'diff' && diffData) {
      return (
        <AIQuickEditDiffPanel
          oldText={diffData.oldText}
          newText={diffData.newText}
          onApply={handleApplyDiff}
          onDiscard={handleDiscardDiff}
        />
      )
    }

    return (
      <div className="ai-quick-edit-toolbar" ref={toolbarRef}>
        {error && (
          <div className="ai-quick-edit-error">
            {error}
            <button
              className="ai-quick-edit-error-dismiss"
              onClick={() => setError(null)}
            >
              ×
            </button>
          </div>
        )}
        <div className="ai-quick-edit-row">
          <button
            className="ai-quick-edit-btn ai-quick-edit-btn-quote"
            onClick={handleQuoteToAI}
            disabled={loading}
            data-tooltip="让ResInk进行更有挑战性的解释、审阅、复杂编辑任务"
          >
            发送给ResInk并引用
          </button>
        </div>
        <div className="ai-quick-edit-row">
          {/* Rewrite dropdown */}
          <div className="ai-quick-edit-dropdown-wrapper">
            <button
              className="ai-quick-edit-btn"
              onClick={() =>
                setOpenDropdown(
                  openDropdown === 'rewrite' ? null : 'rewrite'
                )
              }
              disabled={loading}
            >
              {loadingAction?.startsWith('rewrite') ? '...' : '改写'}
              <span className="ai-quick-edit-caret">▾</span>
            </button>
            {openDropdown === 'rewrite' && (
              <div className="ai-quick-edit-dropdown">
                {REWRITE_OPTIONS.map(opt => (
                  <button
                    key={opt.value}
                    className="ai-quick-edit-dropdown-item"
                    onClick={() => {
                      setActivePreset({
                        action: 'rewrite',
                        style: opt.value,
                        label: opt.stageLabel,
                      })
                      setOpenDropdown(null)
                      view.dispatch({ effects: setQuickEditModeEffect.of('editing') })
                    }}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Translate dropdown */}
          <div className="ai-quick-edit-dropdown-wrapper">
            <button
              className="ai-quick-edit-btn"
              onClick={() =>
                setOpenDropdown(
                  openDropdown === 'translate' ? null : 'translate'
                )
              }
              disabled={loading}
            >
              {loadingAction?.startsWith('translate') ? '...' : '翻译'}
              <span className="ai-quick-edit-caret">▾</span>
            </button>
            {openDropdown === 'translate' && (
              <div className="ai-quick-edit-dropdown">
                {TRANSLATE_OPTIONS.map(opt => (
                  <button
                    key={opt.value}
                    className="ai-quick-edit-dropdown-item"
                    onClick={() => {
                      setActivePreset({
                        action: 'translate',
                        targetLanguage: opt.value,
                        label: opt.stageLabel,
                      })
                      setOpenDropdown(null)
                      view.dispatch({ effects: setQuickEditModeEffect.of('editing') })
                    }}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Paraphrase button */}
          <button
            className="ai-quick-edit-btn"
            onClick={() => {
              setActivePreset({ action: 'paraphrase', label: '改述' })
              view.dispatch({ effects: setQuickEditModeEffect.of('editing') })
            }}
            disabled={loading}
          >
            {loadingAction === 'paraphrase' ? '...' : '改述'}
          </button>

          {/* De-AI button */}
          <button
            className="ai-quick-edit-btn"
            onClick={() => {
              setActivePreset({ action: 'deai', label: '去AI味' })
              view.dispatch({ effects: setQuickEditModeEffect.of('editing') })
            }}
            disabled={loading}
          >
            {loadingAction === 'deai' ? '...' : '去AI味'}
          </button>
        </div>

        {/* Stage 2: expandable custom instruction area */}
        <div className={`ai-quick-edit-stage2 ${activePreset ? 'ai-quick-edit-stage2--open' : ''}`}>
          {activePreset && (
            <>
              <div className="ai-quick-edit-preset-tag">
                {activePreset.label}
              </div>
              <div className="ai-quick-edit-stage2-input-row">
                <input
                  ref={inputRef}
                  className="ai-quick-edit-input"
                  type="text"
                  placeholder="额外指令（可选）..."
                  value={customInstruction}
                  onChange={e => setCustomInstruction(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      handleStage2Send()
                    }
                    if (e.key === 'Escape') {
                      e.preventDefault()
                      handleStage2Cancel()
                    }
                  }}
                  disabled={loading}
                  autoFocus
                />
              </div>
              <div className="ai-quick-edit-stage2-actions">
                <button
                  className="ai-quick-edit-btn ai-quick-edit-btn-stage2-cancel"
                  onClick={handleStage2Cancel}
                  disabled={loading}
                >
                  ✕
                </button>
                <button
                  className="ai-quick-edit-btn ai-quick-edit-btn-stage2-send"
                  onClick={handleStage2Send}
                  disabled={loading}
                >
                  {loading ? '...' : '发送'}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    )
  }
)

export default AIQuickEditToolbar
