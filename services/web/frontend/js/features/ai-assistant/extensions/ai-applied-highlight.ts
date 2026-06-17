/**
 * AI Applied Changes Highlight Extension for CodeMirror 6
 *
 * Visual pattern mirrors ai-change-highlight.ts but with roles reversed:
 * - Pending mode: old text in-place (red) + new text block widget below (green, accept/reject)
 * - Applied mode: new text in-place (green) + old text block widget above (red, dismiss)
 *
 * Includes gutter markers and line-level background decorations for visual
 * consistency with the pending/manual confirmation mode.
 */

import { StateEffect, StateField, Range, RangeSet } from '@codemirror/state'
import {
  Decoration,
  DecorationSet,
  EditorView,
  GutterMarker,
  WidgetType,
  gutter,
} from '@codemirror/view'
import type { PendingChange } from '../types/ai-types'
import { getCachedCharDiff } from '../utils/diff-utils'

// ============================================================================
// Effects
// ============================================================================

export const setAIAppliedEffect = StateEffect.define<PendingChange[]>()
export const clearAIAppliedEffect = StateEffect.define<void>()
export const dismissAIAppliedEffect = StateEffect.define<string>()

// ============================================================================
// State Field
// ============================================================================

const aiAppliedField = StateField.define<PendingChange[]>({
  create() {
    return []
  },
  update(state, tr) {
    let newState = state

    for (const effect of tr.effects) {
      if (effect.is(setAIAppliedEffect)) {
        newState = effect.value
      } else if (effect.is(clearAIAppliedEffect)) {
        newState = []
      } else if (effect.is(dismissAIAppliedEffect)) {
        newState = newState.filter(c => c.id !== effect.value)
      }
    }

    // Map positions through document changes for collaborative editing
    if (tr.docChanged && newState.length > 0) {
      newState = newState
        .map(change => {
          if (!change.position) return change
          const newStart = tr.changes.mapPos(change.position.start, 1)
          const newEnd = tr.changes.mapPos(change.position.end, -1)
          if (newStart >= newEnd) return null
          return { ...change, position: { start: newStart, end: newEnd } }
        })
        .filter(Boolean) as PendingChange[]
    }

    return newState
  },
})

// ============================================================================
// Old Text Block Widget (mirrors AIInsertWidget from ai-change-highlight.ts)
// ============================================================================

class AIAppliedOldTextWidget extends WidgetType {
  changeId: string

  constructor(public change: PendingChange) {
    super()
    this.changeId = change.id
  }

  toDOM() {
    const wrapper = document.createElement('div')
    wrapper.className = 'ol-cm-ai-applied-old-widget'
    wrapper.setAttribute('data-change-id', this.change.id)

    const text = document.createElement('span')
    text.className = 'ol-cm-ai-applied-old-text'

    // Char-level diff: show old text perspective
    if (this.change.oldText && this.change.newText) {
      const segments = getCachedCharDiff(this.change)
      if (segments) {
        for (const seg of segments) {
          if (seg.type === 'added') continue // Only show old-text perspective
          const span = document.createElement('span')
          span.textContent = seg.text
          if (seg.type === 'removed') {
            span.className = 'ol-cm-ai-applied-char-removed'
          }
          text.appendChild(span)
        }
      } else {
        // Segments unavailable (threshold exceeded) — show plain old text
        text.textContent = this.change.oldText || ''
      }
    } else {
      text.textContent = this.change.oldText || ''
    }

    wrapper.appendChild(text)

    // Dismiss button
    const actions = document.createElement('span')
    actions.className = 'ol-cm-ai-change-actions'

    const dismissBtn = document.createElement('button')
    dismissBtn.className = 'ol-cm-ai-change-btn ol-cm-ai-applied-btn-dismiss'
    dismissBtn.textContent = '\u00d7'
    dismissBtn.title = 'Dismiss'
    dismissBtn.addEventListener('click', e => {
      e.preventDefault()
      e.stopPropagation()
      window.dispatchEvent(
        new CustomEvent('ai:dismiss-applied', {
          detail: { changeId: this.change.id },
        })
      )
    })

    actions.appendChild(dismissBtn)
    wrapper.appendChild(actions)

    return wrapper
  }

  eq(other: AIAppliedOldTextWidget) {
    return this.change.id === other.change.id
  }

  ignoreEvent(event: Event) {
    const target = event.target as HTMLElement | null
    if (target?.closest('.ol-cm-ai-applied-btn-dismiss')) return true
    return false
  }
}

// ============================================================================
// Decoration Builder
// ============================================================================

function buildAppliedDecorations(
  changes: PendingChange[],
  doc: { length: number; lineAt(pos: number): { from: number; number: number }; line(n: number): { from: number } }
): DecorationSet {
  const decorations: Range<Decoration>[] = []
  const docLength = doc.length

  for (const change of changes) {
    if (!change.position) continue
    const { start, end } = change.position
    if (start < 0 || end > docLength || start > end) continue

    // 1. Old text block widget above — mirrors the insert widget pattern
    if (change.oldText) {
      decorations.push(
        Decoration.widget({
          widget: new AIAppliedOldTextWidget(change),
          side: -1,
          block: true,
        }).range(start)
      )
    }

    // 2. Line-level background for all affected lines
    if (start < end) {
      const startLine = doc.lineAt(Math.min(start, docLength))
      const endLine = doc.lineAt(Math.min(Math.max(end - 1, start), docLength))
      for (let lineNum = startLine.number; lineNum <= endLine.number; lineNum++) {
        const line = doc.line(lineNum)
        decorations.push(
          Decoration.line({
            class: 'ol-cm-ai-applied-line',
          }).range(line.from)
        )
      }
    }

    // 3. New text in-place: char-level diff marks (mirrors pending mode's old text marks)
    if (change.newText && change.oldText && start < end) {
      const segments = getCachedCharDiff(change)
      if (segments) {
        let pos = start
        for (const seg of segments) {
          if (seg.type === 'removed') continue // Removed text doesn't exist in document
          const segEnd = Math.min(pos + seg.text.length, end)
          if (seg.type === 'added' && pos < segEnd) {
            decorations.push(
              Decoration.mark({
                class: 'ol-cm-ai-applied-char-added',
                attributes: { 'data-change-id': change.id },
              }).range(pos, segEnd)
            )
          } else if (seg.type === 'equal' && pos < segEnd) {
            decorations.push(
              Decoration.mark({
                class: 'ol-cm-ai-applied-new',
                attributes: { 'data-change-id': change.id },
              }).range(pos, segEnd)
            )
          }
          pos = segEnd
        }
      } else {
        // Segments unavailable (threshold exceeded) — mark entire new region
        decorations.push(
          Decoration.mark({
            class: 'ol-cm-ai-applied-new',
            attributes: { 'data-change-id': change.id },
          }).range(start, end)
        )
      }
    } else if (change.newText && start < end) {
      // No char diff: mark entire new region
      decorations.push(
        Decoration.mark({
          class: 'ol-cm-ai-applied-new',
          attributes: { 'data-change-id': change.id },
        }).range(start, end)
      )
    }
  }

  return Decoration.set(decorations.sort((a, b) => a.from - b.from), true)
}

// ============================================================================
// Decoration Field
// ============================================================================

const aiAppliedDecorationField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none
  },
  update(decorations, tr) {
    decorations = decorations.map(tr.changes)

    for (const effect of tr.effects) {
      if (effect.is(setAIAppliedEffect)) {
        decorations = buildAppliedDecorations(
          effect.value,
          tr.state.doc
        )
      } else if (effect.is(clearAIAppliedEffect)) {
        decorations = Decoration.none
      } else if (effect.is(dismissAIAppliedEffect)) {
        const remaining = tr.state
          .field(aiAppliedField)
          .filter(c => c.id !== effect.value)
        decorations = buildAppliedDecorations(remaining, tr.state.doc)
      }
    }

    return decorations
  },
  provide: field => EditorView.decorations.from(field),
})

// ============================================================================
// Gutter Marker
// ============================================================================

class AIAppliedGutterMarker extends GutterMarker {
  constructor(
    public hasOld: boolean,
    public hasNew: boolean
  ) {
    super()
  }

  toDOM() {
    const marker = document.createElement('div')
    marker.className = 'ol-cm-ai-applied-gutter-marker'

    if (this.hasOld && this.hasNew) {
      marker.classList.add('ol-cm-ai-applied-gutter-marker-modify')
      marker.setAttribute('title', 'AI modification (applied)')
    } else if (this.hasOld) {
      marker.classList.add('ol-cm-ai-applied-gutter-marker-delete')
      marker.setAttribute('title', 'AI deletion (applied)')
    } else if (this.hasNew) {
      marker.classList.add('ol-cm-ai-applied-gutter-marker-insert')
      marker.setAttribute('title', 'AI insertion (applied)')
    }

    return marker
  }

  eq(other: AIAppliedGutterMarker) {
    return this.hasOld === other.hasOld && this.hasNew === other.hasNew
  }
}

// ============================================================================
// Gutter State
// ============================================================================

const aiAppliedGutterField = StateField.define<RangeSet<GutterMarker>>({
  create() {
    return RangeSet.empty
  },
  update(markers, tr) {
    if (
      !tr.docChanged &&
      !tr.effects.some(
        e =>
          e.is(setAIAppliedEffect) ||
          e.is(clearAIAppliedEffect) ||
          e.is(dismissAIAppliedEffect)
      )
    ) {
      return markers
    }

    const changes = tr.state.field(aiAppliedField, false)
    if (!changes || changes.length === 0) {
      return RangeSet.empty
    }

    const doc = tr.state.doc
    const lineMarkers = new Map<
      number,
      { from: number; hasOld: boolean; hasNew: boolean }
    >()

    for (const change of changes) {
      if (!change.position) continue
      const { start, end } = change.position
      if (start < 0 || end > doc.length || start > end) continue

      const hasOld = Boolean(change.oldText)
      const hasNew = Boolean(change.newText)

      const clampedEnd = Math.min(Math.max(end - 1, start), doc.length)
      const startLine = doc.lineAt(Math.min(start, doc.length))
      const endLine = doc.lineAt(clampedEnd)

      for (let lineNum = startLine.number; lineNum <= endLine.number; lineNum++) {
        const existing = lineMarkers.get(lineNum)
        if (existing) {
          existing.hasOld = existing.hasOld || hasOld
          existing.hasNew = existing.hasNew || hasNew
        } else {
          const line = doc.line(lineNum)
          lineMarkers.set(lineNum, { from: line.from, hasOld, hasNew })
        }
      }
    }

    const markerList = Array.from(lineMarkers.values())
      .sort((a, b) => a.from - b.from)
      .map(({ from, hasOld, hasNew }) =>
        new AIAppliedGutterMarker(hasOld, hasNew).range(from)
      )

    return RangeSet.of(markerList)
  },
})

// ============================================================================
// Gutter Extension
// ============================================================================

const aiAppliedGutter = gutter({
  class: 'ol-cm-ai-applied-gutter',
  markers: view => view.state.field(aiAppliedGutterField),
  initialSpacer: () => new AIAppliedGutterMarker(true, true),
})

// ============================================================================
// Theme — mirrors ai-change-highlight.ts with roles reversed
// ============================================================================

const aiAppliedTheme = EditorView.baseTheme({
  // Old text block widget — mirrors .ol-cm-ai-change-insert-widget but red
  '.ol-cm-ai-applied-old-widget': {
    display: 'flex',
    alignItems: 'flex-start',
    gap: '4px',
    padding: '2px 4px',
    borderLeft: '3px solid color-mix(in srgb, var(--ai-error, #f44336) 50%, transparent)',
    backgroundColor: 'color-mix(in srgb, var(--ai-error, #f44336) 6%, transparent)',
    margin: '2px 0',
  },

  '.ol-cm-ai-applied-old-text': {
    flex: '1 1 auto',
    minWidth: '0',
    backgroundColor: 'color-mix(in srgb, var(--ai-error, #f44336) 12%, transparent)',
    borderRadius: '2px',
    padding: '1px 4px',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  },

  // Char-level removed highlight within old text widget
  '.ol-cm-ai-applied-char-removed': {
    backgroundColor: 'color-mix(in srgb, var(--ai-error, #f44336) 35%, transparent)',
    textDecoration: 'line-through',
    textDecorationColor: 'color-mix(in srgb, var(--ai-error, #f44336) 80%, transparent)',
    borderRadius: '1px',
  },

  // Dismiss button — mirrors accept/reject button sizing
  '.ol-cm-ai-applied-btn-dismiss': {
    backgroundColor: 'color-mix(in srgb, var(--ai-error, #f44336) 85%, transparent)',
    '&:hover': {
      backgroundColor: 'var(--ai-error, #f44336)',
    },
  },

  // Line-level background for applied change lines
  '.ol-cm-ai-applied-line': {
    backgroundColor: 'color-mix(in srgb, var(--ai-accent, #4caf50) 8%, transparent)',
  },

  // New text in-place: subtle green — mirrors .ol-cm-ai-change-delete
  '.ol-cm-ai-applied-new': {
    backgroundColor: 'color-mix(in srgb, var(--ai-accent, #4caf50) 10%, transparent)',
    padding: 'var(--half-leading, 0) 0',
  },

  // Char-level added highlight in-place — mirrors .ol-cm-ai-change-char-removed
  '.ol-cm-ai-applied-char-added': {
    backgroundColor: 'color-mix(in srgb, var(--ai-change-modify, #ffc107) 35%, transparent)',
    borderRadius: '1px',
    padding: 'var(--half-leading, 0) 0',
  },

  // Gutter
  '.ol-cm-ai-applied-gutter': {
    width: '10px',
    background: 'transparent',
  },

  '.ol-cm-ai-applied-gutter-marker': {
    width: '4px',
    height: '100%',
    marginLeft: '3px',
    borderRadius: '2px',
  },

  '.ol-cm-ai-applied-gutter-marker-delete': {
    backgroundColor: 'color-mix(in srgb, var(--ai-error, #f44336) 80%, transparent)',
  },

  '.ol-cm-ai-applied-gutter-marker-insert': {
    backgroundColor: 'color-mix(in srgb, var(--ai-accent, #4caf50) 80%, transparent)',
  },

  '.ol-cm-ai-applied-gutter-marker-modify': {
    backgroundColor: 'color-mix(in srgb, var(--ai-change-modify, #ffc107) 80%, transparent)',
  },

  // Dark theme
  '&dark .ol-cm-ai-applied-old-widget': {
    borderLeftColor: 'color-mix(in srgb, var(--ai-error, #f85149) 40%, transparent)',
    backgroundColor: 'color-mix(in srgb, var(--ai-error, #f85149) 4%, transparent)',
  },

  '&dark .ol-cm-ai-applied-old-text': {
    backgroundColor: 'color-mix(in srgb, var(--ai-error, #f85149) 10%, transparent)',
  },

  '&dark .ol-cm-ai-applied-char-removed': {
    backgroundColor: 'color-mix(in srgb, var(--ai-error, #f85149) 20%, transparent)',
    textDecorationColor: 'color-mix(in srgb, var(--ai-error, #f85149) 60%, transparent)',
  },

  '&dark .ol-cm-ai-applied-btn-dismiss': {
    backgroundColor: 'color-mix(in srgb, var(--ai-error, #f85149) 70%, transparent)',
    '&:hover': {
      backgroundColor: 'color-mix(in srgb, var(--ai-error, #f85149) 90%, transparent)',
    },
  },

  '&dark .ol-cm-ai-applied-line': {
    backgroundColor: 'color-mix(in srgb, var(--ai-accent, #10b981) 5%, transparent)',
  },

  '&dark .ol-cm-ai-applied-new': {
    backgroundColor: 'color-mix(in srgb, var(--ai-accent, #10b981) 5%, transparent)',
  },

  '&dark .ol-cm-ai-applied-char-added': {
    backgroundColor: 'color-mix(in srgb, var(--ai-change-modify, #ffc107) 20%, transparent)',
  },

  '&dark .ol-cm-ai-applied-gutter-marker-delete': {
    backgroundColor: 'color-mix(in srgb, var(--ai-error, #f85149) 60%, transparent)',
  },

  '&dark .ol-cm-ai-applied-gutter-marker-insert': {
    backgroundColor: 'color-mix(in srgb, var(--ai-accent, #10b981) 60%, transparent)',
  },

  '&dark .ol-cm-ai-applied-gutter-marker-modify': {
    backgroundColor: 'color-mix(in srgb, var(--ai-change-modify, #ffc107) 60%, transparent)',
  },
})

// ============================================================================
// Helper Functions
// ============================================================================

export function setAIAppliedChanges(
  view: EditorView,
  changes: PendingChange[]
) {
  view.dispatch({ effects: setAIAppliedEffect.of(changes) })
}

export function clearAIAppliedChanges(view: EditorView) {
  view.dispatch({ effects: clearAIAppliedEffect.of(undefined) })
}

// ============================================================================
// Extension Export
// ============================================================================

export function aiAppliedHighlight() {
  return [
    aiAppliedField,
    aiAppliedDecorationField,
    aiAppliedGutterField,
    aiAppliedGutter,
    aiAppliedTheme,
  ]
}
