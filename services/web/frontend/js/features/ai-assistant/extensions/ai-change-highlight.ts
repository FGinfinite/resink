/**
 * AI Change Highlight Extension for CodeMirror 6
 * Provides visual highlighting for pending AI changes in the editor
 */

import { StateEffect, StateField, Range } from '@codemirror/state'
import { Decoration, DecorationSet, EditorView, ViewUpdate, WidgetType } from '@codemirror/view'
import type { PendingChange } from '../types/ai-types'
import { getCachedCharDiff, type CharDiffSegment } from '../utils/diff-utils'

// ============================================================================
// Effects
// ============================================================================

/**
 * Effect to set/update AI changes in the editor
 */
export const setAIChangesEffect = StateEffect.define<PendingChange[]>()

/**
 * Effect to clear all AI changes from the editor
 */
export const clearAIChangesEffect = StateEffect.define<void>()

/**
 * Effect to remove a specific change by ID
 */
export const removeAIChangeEffect = StateEffect.define<string>()

/**
 * Effect to highlight a specific change (on hover)
 */
export const highlightAIChangeEffect = StateEffect.define<string | null>()

// ============================================================================
// State Field
// ============================================================================

interface AIChangesState {
  changes: PendingChange[]
  highlightedChangeId: string | null
}

const initialState: AIChangesState = {
  changes: [],
  highlightedChangeId: null,
}

/**
 * State field to track AI changes
 */
export const aiChangesField = StateField.define<AIChangesState>({
  create() {
    return initialState
  },
  update(state, tr) {
    let newState = state

    for (const effect of tr.effects) {
      if (effect.is(setAIChangesEffect)) {
        newState = {
          ...newState,
          changes: effect.value,
        }
      } else if (effect.is(clearAIChangesEffect)) {
        newState = initialState
      } else if (effect.is(removeAIChangeEffect)) {
        newState = {
          ...newState,
          changes: newState.changes.filter(c => c.id !== effect.value),
        }
      } else if (effect.is(highlightAIChangeEffect)) {
        newState = {
          ...newState,
          highlightedChangeId: effect.value,
        }
      }
    }

    // Map positions through document changes for collaborative editing
    if (tr.docChanged && newState.changes.length > 0) {
      const mappedChanges = newState.changes
        .map(change => {
          if (!change.position) return change
          const newStart = tr.changes.mapPos(change.position.start, 1)
          const newEnd = tr.changes.mapPos(change.position.end, -1)
          // Region was overwritten — mark as invalid
          if (newStart >= newEnd && change.oldText) return null
          // Check if the text at the mapped position still matches oldText
          let stale = change.stale || false
          if (!stale && change.oldText && newStart < newEnd) {
            const currentText = tr.state.doc.sliceString(newStart, newEnd)
            if (currentText !== change.oldText) {
              stale = true
            }
          }
          if (
            newStart === change.position.start &&
            newEnd === change.position.end &&
            stale === (change.stale || false)
          ) {
            return change
          }
          return {
            ...change,
            position: { start: newStart, end: newEnd },
            stale,
          }
        })
        .filter(Boolean) as PendingChange[]

      if (
        mappedChanges.length !== newState.changes.length ||
        mappedChanges.some((c, i) => c !== newState.changes[i])
      ) {
        newState = { ...newState, changes: mappedChanges }
      }
    }

    return newState
  },
})

// ============================================================================
// Decoration Field
// ============================================================================

/**
 * State field that provides decorations for AI changes
 */
export const aiChangesDecorationField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none
  },
  update(decorations, tr) {
    // Map decorations through document changes
    decorations = decorations.map(tr.changes)

    let hasEffectRebuild = false
    for (const effect of tr.effects) {
      if (effect.is(setAIChangesEffect)) {
        decorations = buildDecorations(effect.value, tr.state.doc.length)
        hasEffectRebuild = true
      } else if (effect.is(clearAIChangesEffect)) {
        decorations = Decoration.none
        hasEffectRebuild = true
      } else if (effect.is(removeAIChangeEffect)) {
        const changeId = effect.value
        decorations = removeChangeDecorations(decorations, changeId)
        hasEffectRebuild = true
      }
    }

    // Rebuild decorations when document changes may have caused stale marking
    // (aiChangesField updates stale flags on docChanged, decorations must follow)
    if (tr.docChanged && !hasEffectRebuild) {
      const changesState = tr.state.field(aiChangesField)
      if (changesState.changes.length > 0) {
        decorations = buildDecorations(changesState.changes, tr.state.doc.length)
      }
    }

    return decorations
  },
  provide: field => EditorView.decorations.from(field),
})

// ============================================================================
// Decoration Builders
// ============================================================================

/**
 * Build decorations for all pending changes.
 * For edit changes with both old and new text, uses char-level diff highlighting.
 */
function buildDecorations(changes: PendingChange[], docLength: number): DecorationSet {
  const decorations: Range<Decoration>[] = []

  for (const change of changes) {
    if (change.status !== 'pending') continue
    if (!change.position) continue

    const { start, end } = change.position

    // Validate positions
    if (start < 0 || end > docLength || start > end) {
      continue
    }

    // Stale changes: grey background + strikethrough, skip normal diff decorations
    if (change.stale) {
      decorations.push(
        Decoration.mark({
          class: 'ol-cm-ai-change-stale',
          attributes: { 'data-change-id': change.id },
        }).range(start, end)
      )
      continue
    }

    // Char-level diff: use cached computation to avoid redundant work on rebuilds
    const segments = getCachedCharDiff(change)
    const hasCharDiff = segments !== null

    if (hasCharDiff) {
      let pos = start
      for (const seg of segments) {
        if (seg.type === 'added') continue // Added text doesn't exist in document
        const segEnd = Math.min(pos + seg.text.length, end)
        if (seg.type === 'removed' && pos < segEnd) {
          decorations.push(
            Decoration.mark({
              class: 'ol-cm-ai-change-char-removed',
              attributes: { 'data-change-id': change.id },
            }).range(pos, segEnd)
          )
        } else if (seg.type === 'equal' && pos < segEnd) {
          // Equal segments within the old range get a subtle base mark
          decorations.push(
            Decoration.mark({
              class: 'ol-cm-ai-change-delete',
              attributes: { 'data-change-id': change.id },
            }).range(pos, segEnd)
          )
        }
        pos = segEnd
      }

      // Pass pre-computed segments to the insert widget to avoid recomputation
      if (change.newText) {
        const insertWidget = Decoration.widget({
          widget: new AIInsertWidget(change, segments),
          side: 1,
          block: true,
        })
        decorations.push(insertWidget.range(end))
      }
    } else if (change.oldText && start !== end) {
      // No char diff available: mark entire old region
      decorations.push(
        Decoration.mark({
          class: 'ol-cm-ai-change-delete',
          attributes: {
            'data-change-id': change.id,
            'data-change-type': 'delete',
          },
        }).range(start, end)
      )
    }

    // Inserted text without char diff: block widget on a new line after the old text
    if (change.newText && !hasCharDiff) {
      const insertWidget = Decoration.widget({
        widget: new AIInsertWidget(change, null),
        side: 1,
        block: true,
      })
      decorations.push(insertWidget.range(end))
    }
  }

  return Decoration.set(decorations, true)
}

/**
 * Remove decorations for a specific change
 */
function removeChangeDecorations(
  decorations: DecorationSet,
  changeId: string
): DecorationSet {
  const newDecorations: Range<Decoration>[] = []
  const cursor = decorations.iter()

  while (cursor.value) {
    const spec = cursor.value.spec
    if (spec.attributes?.['data-change-id'] !== changeId &&
        spec.widget?.changeId !== changeId) {
      // Keep this decoration
      if (cursor.value.spec.widget) {
        newDecorations.push(
          Decoration.widget({ widget: cursor.value.spec.widget, side: 1 }).range(cursor.from)
        )
      } else {
        newDecorations.push(
          Decoration.mark(spec).range(cursor.from, cursor.to)
        )
      }
    }
    cursor.next()
  }

  return Decoration.set(newDecorations, true)
}

// ============================================================================
// Widgets
// ============================================================================

/**
 * Widget to show inserted text preview with accept/reject buttons.
 * Renders as a block element below the old text, with char-level diff highlighting.
 * No truncation — all content is shown.
 */
class AIInsertWidget extends WidgetType {
  changeId: string
  private cachedSegments: CharDiffSegment[] | null

  constructor(public change: PendingChange, segments: CharDiffSegment[] | null) {
    super()
    this.changeId = change.id
    this.cachedSegments = segments
  }

  toDOM() {
    const wrapper = document.createElement('div')
    wrapper.className = 'ol-cm-ai-change-insert-widget'
    wrapper.setAttribute('data-change-id', this.change.id)

    const text = document.createElement('span')
    text.className = 'ol-cm-ai-change-insert-text'

    // Use char-level diff if both old and new text are available
    if (this.change.oldText && this.change.newText) {
      // Use pre-computed segments if available, otherwise use cached diff
      const segments =
        this.cachedSegments ??
        getCachedCharDiff(this.change)
      if (segments) {
        for (const seg of segments) {
          if (seg.type === 'removed') continue // Only show new-text perspective
          const span = document.createElement('span')
          span.textContent = seg.text
          if (seg.type === 'added') {
            span.className = 'ol-cm-ai-change-char-added'
          }
          text.appendChild(span)
        }
      } else {
        // Segments unavailable (threshold exceeded) — show plain new text
        text.textContent = this.change.newText || ''
      }
    } else {
      text.textContent = this.change.newText || ''
    }

    wrapper.appendChild(text)

    // Accept / Reject buttons
    const actions = document.createElement('span')
    actions.className = 'ol-cm-ai-change-actions'

    const acceptBtn = document.createElement('button')
    acceptBtn.className = 'ol-cm-ai-change-btn ol-cm-ai-change-btn-accept'
    acceptBtn.textContent = '\u2713'
    acceptBtn.title = 'Accept change'
    acceptBtn.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      window.dispatchEvent(
        new CustomEvent('ai:accept-change', { detail: { changeId: this.change.id } })
      )
    })

    const rejectBtn = document.createElement('button')
    rejectBtn.className = 'ol-cm-ai-change-btn ol-cm-ai-change-btn-reject'
    rejectBtn.textContent = '\u2717'
    rejectBtn.title = 'Reject change'
    rejectBtn.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      window.dispatchEvent(
        new CustomEvent('ai:reject-change', { detail: { changeId: this.change.id } })
      )
    })

    actions.appendChild(acceptBtn)
    actions.appendChild(rejectBtn)
    wrapper.appendChild(actions)

    return wrapper
  }

  eq(other: AIInsertWidget) {
    return (
      this.change.id === other.change.id &&
      this.change.newText === other.change.newText
    )
  }

  ignoreEvent(event: Event) {
    // Allow button clicks to propagate to our handlers
    const target = event.target as HTMLElement | null
    if (target?.closest('.ol-cm-ai-change-btn')) return true
    return false
  }
}

// ============================================================================
// Theme
// ============================================================================

/**
 * Base theme for AI change highlighting
 */
export const aiChangesTheme = EditorView.baseTheme({
  // Delete highlighting - subtle background for equal segments within old text
  '.ol-cm-ai-change-delete': {
    backgroundColor: 'color-mix(in srgb, var(--ai-error, #f85149) 10%, transparent)',
    padding: 'var(--half-leading, 0) 0',
  },

  // Char-level removed highlight - strong red + strikethrough
  '.ol-cm-ai-change-char-removed': {
    backgroundColor: 'color-mix(in srgb, var(--ai-error, #f85149) 30%, transparent)',
    textDecoration: 'line-through',
    textDecorationColor: 'color-mix(in srgb, var(--ai-error, #f85149) 80%, transparent)',
    padding: 'var(--half-leading, 0) 0',
  },

  // Insert widget styling - block layout, on its own line
  '.ol-cm-ai-change-insert-widget': {
    display: 'flex',
    alignItems: 'flex-start',
    gap: '4px',
    padding: '2px 4px',
    borderLeft: '3px solid color-mix(in srgb, var(--ai-accent, #10b981) 50%, transparent)',
    backgroundColor: 'color-mix(in srgb, var(--ai-accent, #10b981) 6%, transparent)',
    margin: '2px 0',
  },

  '.ol-cm-ai-change-insert-text': {
    flex: '1 1 auto',
    minWidth: '0',
    backgroundColor: 'color-mix(in srgb, var(--ai-accent, #10b981) 12%, transparent)',
    color: 'var(--ai-change-insert-text, #34d399)',
    borderRadius: '2px',
    padding: '1px 4px',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  },

  // Char-level added highlight within insert text
  '.ol-cm-ai-change-char-added': {
    backgroundColor: 'rgba(255, 193, 7, 0.35)',
    borderRadius: '1px',
  },

  // Action buttons container
  '.ol-cm-ai-change-actions': {
    display: 'inline-flex',
    gap: '2px',
    flexShrink: '0',
    alignSelf: 'flex-start',
    marginTop: '1px',
  },

  // Action button base
  '.ol-cm-ai-change-btn': {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '18px',
    height: '18px',
    borderRadius: '3px',
    border: 'none',
    cursor: 'pointer',
    fontSize: '12px',
    lineHeight: '1',
    fontWeight: 'bold',
    color: '#fff',
    padding: '0',
  },

  '.ol-cm-ai-change-btn-accept': {
    backgroundColor: 'color-mix(in srgb, var(--ai-accent, #10b981) 85%, transparent)',
    '&:hover': {
      backgroundColor: 'var(--ai-accent, #10b981)',
    },
  },

  '.ol-cm-ai-change-btn-reject': {
    backgroundColor: 'color-mix(in srgb, var(--ai-error, #f85149) 85%, transparent)',
    '&:hover': {
      backgroundColor: 'var(--ai-error, #f85149)',
    },
  },

  // Dark theme adjustments
  '&dark .ol-cm-ai-change-delete': {
    backgroundColor: 'color-mix(in srgb, var(--ai-error, #f85149) 8%, transparent)',
  },

  '&dark .ol-cm-ai-change-char-removed': {
    backgroundColor: 'color-mix(in srgb, var(--ai-error, #f85149) 20%, transparent)',
    textDecorationColor: 'color-mix(in srgb, var(--ai-error, #f85149) 60%, transparent)',
  },

  '&dark .ol-cm-ai-change-insert-widget': {
    borderLeftColor: 'color-mix(in srgb, var(--ai-accent, #10b981) 40%, transparent)',
    backgroundColor: 'color-mix(in srgb, var(--ai-accent, #10b981) 4%, transparent)',
  },

  '&dark .ol-cm-ai-change-insert-text': {
    backgroundColor: 'color-mix(in srgb, var(--ai-accent, #10b981) 10%, transparent)',
    color: 'var(--ai-change-insert-text, #34d399)',
  },

  '&dark .ol-cm-ai-change-char-added': {
    backgroundColor: 'rgba(255, 193, 7, 0.2)',
  },

  '&dark .ol-cm-ai-change-btn-accept': {
    backgroundColor: 'color-mix(in srgb, var(--ai-accent, #10b981) 70%, transparent)',
    '&:hover': {
      backgroundColor: 'color-mix(in srgb, var(--ai-accent, #10b981) 90%, transparent)',
    },
  },

  '&dark .ol-cm-ai-change-btn-reject': {
    backgroundColor: 'color-mix(in srgb, var(--ai-error, #f85149) 70%, transparent)',
    '&:hover': {
      backgroundColor: 'color-mix(in srgb, var(--ai-error, #f85149) 90%, transparent)',
    },
  },

  // Stale change: grey + strikethrough (document was modified externally)
  '.ol-cm-ai-change-stale': {
    backgroundColor: 'color-mix(in srgb, var(--content-secondary-dark, #8b949e) 15%, transparent)',
    textDecoration: 'line-through',
    textDecorationColor: 'color-mix(in srgb, var(--content-secondary-dark, #8b949e) 50%, transparent)',
    opacity: '0.6',
  },

  '&dark .ol-cm-ai-change-stale': {
    backgroundColor: 'color-mix(in srgb, var(--content-secondary-dark, #8b949e) 12%, transparent)',
    textDecorationColor: 'color-mix(in srgb, var(--content-secondary-dark, #8b949e) 40%, transparent)',
  },

  // Highlighted state (on hover in panel)
  '.ol-cm-ai-change-highlighted': {
    outline: '2px solid var(--ai-blue, #388bfd)',
    outlineOffset: '1px',
  },
})

// ============================================================================
// Extension Export
// ============================================================================

/**
 * Main extension to enable AI change highlighting
 */
export function aiChangeHighlight() {
  // Listener that detects newly stale changes and notifies React via CustomEvent
  const staleNotifier = EditorView.updateListener.of((update: ViewUpdate) => {
    if (!update.docChanged) return
    const changes = update.state.field(aiChangesField).changes
    const staleIds = changes.filter(c => c.stale).map(c => c.id)
    if (staleIds.length > 0) {
      window.dispatchEvent(
        new CustomEvent('ai:changes-stale', { detail: { staleIds } })
      )
    }
  })

  return [aiChangesField, aiChangesDecorationField, aiChangesTheme, staleNotifier]
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Dispatch effect to set AI changes in an editor view
 */
export function setAIChanges(view: EditorView, changes: PendingChange[]) {
  view.dispatch({
    effects: setAIChangesEffect.of(changes),
  })
}

/**
 * Dispatch effect to clear AI changes from an editor view
 */
export function clearAIChanges(view: EditorView) {
  view.dispatch({
    effects: clearAIChangesEffect.of(undefined),
  })
}

/**
 * Dispatch effect to remove a specific change from an editor view
 */
export function removeAIChange(view: EditorView, changeId: string) {
  view.dispatch({
    effects: removeAIChangeEffect.of(changeId),
  })
}

/**
 * Dispatch effect to highlight a specific change
 */
export function highlightAIChange(view: EditorView, changeId: string | null) {
  view.dispatch({
    effects: highlightAIChangeEffect.of(changeId),
  })
}
