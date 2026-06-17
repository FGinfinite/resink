import {
  EditorView,
  showTooltip,
  Tooltip,
  TooltipView,
  ViewPlugin,
} from '@codemirror/view'
import {
  Extension,
  StateField,
  StateEffect,
  EditorState,
  Transaction,
} from '@codemirror/state'

export type QuickEditMode = 'idle' | 'editing' | 'loading' | 'diff'

export const hideQuickEditTooltipEffect = StateEffect.define<null>()
export const setQuickEditModeEffect = StateEffect.define<QuickEditMode>()

const qeMouseDownEffect = StateEffect.define()
const qeMouseUpEffect = StateEffect.define()

const qeMouseDownStateField = StateField.define<boolean>({
  create() {
    return false
  },
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(qeMouseDownEffect)) {
        return true
      } else if (effect.is(qeMouseUpEffect)) {
        return false
      }
    }
    return value
  },
})

export const quickEditTooltipField = StateField.define<{
  tooltip: Tooltip | null
  mode: QuickEditMode
}>({
  create() {
    return { tooltip: null, mode: 'idle' as QuickEditMode }
  },
  update(field, tr) {
    let { tooltip, mode } = field

    for (const effect of tr.effects) {
      if (effect.is(hideQuickEditTooltipEffect)) {
        return { tooltip: null, mode: 'idle' as QuickEditMode }
      }
      if (effect.is(setQuickEditModeEffect)) {
        mode = effect.value
        // If going back to idle with no selection, hide tooltip
        if (mode === 'idle' && tr.state.selection.main.empty) {
          return { tooltip: null, mode }
        }
        return { tooltip, mode }
      }
    }

    // In editing, loading or diff mode, keep tooltip locked
    if (mode === 'editing' || mode === 'loading' || mode === 'diff') {
      return { tooltip, mode }
    }

    // idle mode: follow selection changes like review-tooltip
    if (tr.state.selection.main.empty) {
      return { tooltip: null, mode }
    }

    if (
      !tr.effects.some(effect => effect.is(qeMouseUpEffect)) &&
      tr.annotation(Transaction.userEvent) !== 'select' &&
      tr.annotation(Transaction.userEvent) !== 'select.pointer'
    ) {
      if (tr.selection) {
        return { tooltip: null, mode }
      }
      return { tooltip, mode }
    }

    const isMouseDown = tr.state.field(qeMouseDownStateField)
    return { tooltip: buildQuickEditTooltip(tr.state, isMouseDown), mode }
  },

  provide: field => [
    showTooltip.compute([field], state => state.field(field).tooltip),
  ],
})

function buildQuickEditTooltip(
  state: EditorState,
  hidden: boolean
): Tooltip | null {
  const { main } = state.selection
  if (main.empty) return null

  // Position at the start of selection (above)
  const pos = main.from

  return {
    pos,
    above: true,
    create: hidden ? createHiddenTooltipView : createVisibleTooltipView,
  }
}

const createTooltipView = (hidden: boolean): TooltipView => {
  const dom = document.createElement('div')
  dom.className = 'ai-quick-edit-tooltip-container'
  dom.style.display = hidden ? 'none' : 'block'
  return {
    dom,
    overlap: true,
    offset: { x: 0, y: 8 },
  }
}

const createHiddenTooltipView = () => createTooltipView(true)
const createVisibleTooltipView = () => createTooltipView(false)

const quickEditTooltipTheme = EditorView.baseTheme({
  '.ai-quick-edit-tooltip-container.cm-tooltip': {
    backgroundColor: 'transparent',
    border: 'none',
    zIndex: 0,
  },
  '&dark .ai-quick-edit-tooltip-container .ai-quick-edit-toolbar, &dark .ai-quick-edit-tooltip-container .ai-quick-edit-diff-panel, &dark .ai-quick-edit-tooltip-container .ai-quick-edit-dropdown':
    {
      backgroundColor: '#161b22',
      color: '#e8eaed',
      borderColor: 'rgba(139, 148, 158, 0.25)',
    },
  '&light .ai-quick-edit-tooltip-container .ai-quick-edit-toolbar, &light .ai-quick-edit-tooltip-container .ai-quick-edit-diff-panel, &light .ai-quick-edit-tooltip-container .ai-quick-edit-dropdown':
    {
      backgroundColor: '#fafbfc',
      color: '#1a1a2e',
      borderColor: 'rgba(107, 114, 128, 0.2)',
    },
})

export const aiQuickEditTooltip = (): Extension => {
  const mousePlugin = ViewPlugin.fromClass(
    class {
      private mouseUpHandler: ((e: Event) => void) | null = null
      private view: EditorView

      constructor(view: EditorView) {
        this.view = view
      }

      private removeMouseUpHandler() {
        if (this.mouseUpHandler) {
          document.removeEventListener('mouseup', this.mouseUpHandler)
          this.mouseUpHandler = null
        }
      }

      handleMouseDown(_event: MouseEvent) {
        const currentMode = this.view.state.field(quickEditTooltipField).mode
        if (currentMode === 'editing' || currentMode === 'loading' || currentMode === 'diff') {
          return
        }

        this.removeMouseUpHandler()
        this.mouseUpHandler = () => {
          this.removeMouseUpHandler()
          this.view.dispatch({ effects: qeMouseUpEffect.of(null) })
        }

        this.view.dispatch({
          effects: qeMouseDownEffect.of(null),
        })
        document.addEventListener('mouseup', this.mouseUpHandler)
      }

      destroy() {
        this.removeMouseUpHandler()
      }
    },
    {
      eventHandlers: {
        mousedown(event: MouseEvent) {
          this.handleMouseDown(event)
        },
      },
    }
  )

  return [
    quickEditTooltipTheme,
    quickEditTooltipField,
    qeMouseDownStateField,
    mousePlugin,
  ]
}
