/**
 * AI Change Gutter Extension for CodeMirror 6
 * Shows markers in the gutter for lines with AI changes
 */

import { StateField, RangeSet } from '@codemirror/state'
import { EditorView, GutterMarker, gutter } from '@codemirror/view'
import {
  aiChangesField,
  setAIChangesEffect,
  clearAIChangesEffect,
  removeAIChangeEffect,
} from './ai-change-highlight'
import type { PendingChange } from '../types/ai-types'

// ============================================================================
// Gutter Marker
// ============================================================================

class AIChangeGutterMarker extends GutterMarker {
  constructor(
    public change: PendingChange,
    public hasDelete: boolean,
    public hasInsert: boolean
  ) {
    super()
  }

  toDOM() {
    const marker = document.createElement('div')
    marker.className = 'ol-cm-ai-gutter-marker'

    if (this.hasDelete && this.hasInsert) {
      marker.classList.add('ol-cm-ai-gutter-marker-modify')
      marker.setAttribute('title', 'AI modification')
    } else if (this.hasDelete) {
      marker.classList.add('ol-cm-ai-gutter-marker-delete')
      marker.setAttribute('title', 'AI deletion')
    } else if (this.hasInsert) {
      marker.classList.add('ol-cm-ai-gutter-marker-insert')
      marker.setAttribute('title', 'AI insertion')
    }

    return marker
  }

  eq(other: AIChangeGutterMarker) {
    return (
      this.change.id === other.change.id &&
      this.hasDelete === other.hasDelete &&
      this.hasInsert === other.hasInsert
    )
  }
}

// ============================================================================
// Gutter State
// ============================================================================

/**
 * State field for gutter markers
 */
const aiChangeGutterField = StateField.define<RangeSet<GutterMarker>>({
  create() {
    return RangeSet.empty
  },
  update(markers, tr) {
    // Skip full rebuild if no document change and no AI change effects
    if (
      !tr.docChanged &&
      !tr.effects.some(
        e =>
          e.is(setAIChangesEffect) ||
          e.is(clearAIChangesEffect) ||
          e.is(removeAIChangeEffect)
      )
    ) {
      return markers
    }

    const aiChangesState = tr.state.field(aiChangesField, false)
    if (!aiChangesState) {
      return RangeSet.empty
    }

    const { changes } = aiChangesState
    if (changes.length === 0) {
      return RangeSet.empty
    }

    // Build gutter markers for lines with changes, deduplicating by line
    const doc = tr.state.doc
    const lineMarkers = new Map<
      number,
      { from: number; change: PendingChange; hasDelete: boolean; hasInsert: boolean }
    >()

    for (const change of changes) {
      if (change.status !== 'pending') continue
      if (!change.position) continue

      const { start, end } = change.position

      // Get the line at the start position
      const startLine = doc.lineAt(Math.min(start, doc.length))
      const endLine = doc.lineAt(Math.min(end, doc.length))

      const hasDelete = Boolean(change.oldText)
      const hasInsert = Boolean(change.newText)

      // Add markers for affected lines, merging flags on duplicate lines
      for (let lineNum = startLine.number; lineNum <= endLine.number; lineNum++) {
        const existing = lineMarkers.get(lineNum)
        if (existing) {
          // Merge: if any change on this line has delete/insert, set the flag
          existing.hasDelete = existing.hasDelete || hasDelete
          existing.hasInsert = existing.hasInsert || hasInsert
        } else {
          const line = doc.line(lineNum)
          lineMarkers.set(lineNum, {
            from: line.from,
            change,
            hasDelete,
            hasInsert,
          })
        }
      }
    }

    // Build sorted marker list from deduplicated map
    const markerList = Array.from(lineMarkers.values())
      .sort((a, b) => a.from - b.from)
      .map(({ from, change, hasDelete, hasInsert }) =>
        new AIChangeGutterMarker(change, hasDelete, hasInsert).range(from)
      )

    return RangeSet.of(markerList)
  },
})

// ============================================================================
// Gutter Extension
// ============================================================================

/**
 * Gutter extension for AI changes
 */
const aiChangeGutter = gutter({
  class: 'ol-cm-ai-gutter',
  markers: view => view.state.field(aiChangeGutterField),
  initialSpacer: () => new AIChangeGutterMarker({} as PendingChange, true, true),
})

// ============================================================================
// Theme
// ============================================================================

const aiChangeGutterTheme = EditorView.baseTheme({
  '.ol-cm-ai-gutter': {
    width: '10px',
    background: 'transparent',
  },

  '.ol-cm-ai-gutter-marker': {
    width: '4px',
    height: '100%',
    marginLeft: '3px',
    borderRadius: '2px',
  },

  '.ol-cm-ai-gutter-marker-delete': {
    backgroundColor: 'color-mix(in srgb, var(--ai-error, #f85149) 80%, transparent)',
  },

  '.ol-cm-ai-gutter-marker-insert': {
    backgroundColor: 'color-mix(in srgb, var(--ai-accent, #10b981) 80%, transparent)',
  },

  '.ol-cm-ai-gutter-marker-modify': {
    backgroundColor: 'color-mix(in srgb, var(--ai-change-modify, #ffc107) 80%, transparent)',
  },

  '&dark .ol-cm-ai-gutter-marker-delete': {
    backgroundColor: 'color-mix(in srgb, var(--ai-error, #f85149) 60%, transparent)',
  },

  '&dark .ol-cm-ai-gutter-marker-insert': {
    backgroundColor: 'color-mix(in srgb, var(--ai-accent, #10b981) 60%, transparent)',
  },

  '&dark .ol-cm-ai-gutter-marker-modify': {
    backgroundColor: 'color-mix(in srgb, var(--ai-change-modify, #ffc107) 60%, transparent)',
  },
})

// ============================================================================
// Extension Export
// ============================================================================

/**
 * Extension to add gutter markers for AI changes
 */
export function aiChangeGutterExtension() {
  return [aiChangeGutterField, aiChangeGutter, aiChangeGutterTheme]
}
