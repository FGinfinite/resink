/**
 * AI Change Extensions - Main Export
 * Combines highlight, gutter, and applied-change extensions
 */

import { Extension } from '@codemirror/state'
import { aiChangeHighlight } from './ai-change-highlight'
import { aiChangeGutterExtension } from './ai-change-gutter'
import { aiAppliedHighlight } from './ai-applied-highlight'

export {
  // Highlight extension
  aiChangeHighlight,
  aiChangesField,
  aiChangesDecorationField,
  aiChangesTheme,
  // Effects
  setAIChangesEffect,
  clearAIChangesEffect,
  removeAIChangeEffect,
  highlightAIChangeEffect,
  // Helper functions
  setAIChanges,
  clearAIChanges,
  removeAIChange,
  highlightAIChange,
} from './ai-change-highlight'

export { aiChangeGutterExtension } from './ai-change-gutter'

export {
  setAIAppliedChanges,
  clearAIAppliedChanges,
} from './ai-applied-highlight'

export { aiAutocomplete, setAIAutocomplete } from './ai-autocomplete'

/**
 * Complete AI change extension with highlight, gutter, and applied-change ghost text
 */
export function aiChangeExtension(): Extension {
  return [aiChangeHighlight(), aiChangeGutterExtension(), aiAppliedHighlight()]
}
