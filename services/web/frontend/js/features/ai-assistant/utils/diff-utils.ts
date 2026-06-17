/**
 * Shared diff utility functions for AI change preview
 */

import { diffWordsWithSpace } from 'diff'
import type { Change as DiffChange } from 'diff'
import type { PendingChange } from '../types/ai-types'

export interface DiffLine {
  type: 'delete' | 'insert' | 'context'
  content: string
}

export interface CharDiffSegment {
  text: string
  type: 'equal' | 'added' | 'removed'
}

/**
 * Word-level + whitespace-aware diff between two text strings.
 * Uses diffWordsWithSpace which preserves whitespace as independent tokens.
 */
export function computeCharDiff(oldText: string, newText: string): CharDiffSegment[] {
  const changes: DiffChange[] = diffWordsWithSpace(oldText, newText)
  return changes.map(change => ({
    text: change.value,
    type: change.added ? 'added' : change.removed ? 'removed' : 'equal',
  }))
}

// ============================================================================
// Cached char diff — avoids recomputation on every decoration rebuild
// ============================================================================

/** Skip char diff for changes whose combined text exceeds this threshold */
const MAX_CHAR_DIFF_CHARS = 8000

const charDiffCache = new Map<
  string,
  { oldText: string; newText: string; segments: CharDiffSegment[] | null }
>()

/**
 * Cached version of computeCharDiff keyed by change id.
 * Returns null when either text is missing or the combined length exceeds the
 * threshold (to avoid expensive diff on very large changes).
 */
export function getCachedCharDiff(change: {
  id: string
  oldText?: string
  newText?: string
}): CharDiffSegment[] | null {
  if (!change.oldText || !change.newText) return null

  const cached = charDiffCache.get(change.id)
  if (
    cached &&
    cached.oldText === change.oldText &&
    cached.newText === change.newText
  ) {
    return cached.segments
  }

  // Length threshold — skip char diff for very large changes
  if (change.oldText.length + change.newText.length > MAX_CHAR_DIFF_CHARS) {
    charDiffCache.set(change.id, {
      oldText: change.oldText,
      newText: change.newText,
      segments: null,
    })
    return null
  }

  const segments = computeCharDiff(change.oldText, change.newText)
  charDiffCache.set(change.id, {
    oldText: change.oldText,
    newText: change.newText,
    segments,
  })

  // Keep cache bounded
  if (charDiffCache.size > 200) {
    const firstKey = charDiffCache.keys().next().value
    if (firstKey) charDiffCache.delete(firstKey)
  }

  return segments
}

export function computeDiffLines(change: PendingChange): DiffLine[] {
  const changeType = change.type || 'edit'

  if (changeType === 'create') {
    const content = change.content || ''
    return content.split('\n').map(line => ({ type: 'insert', content: line }))
  }

  if (changeType === 'delete') {
    if (change.isBinary) {
      return [
        { type: 'context', content: `[Binary file: ${change.path || 'unknown'}]` },
        {
          type: 'context',
          content:
            'Content cannot be previewed. Deletion can be recovered via version history.',
        },
      ]
    }
    const content = change.deletedContent || ''
    return content.split('\n').map(line => ({ type: 'delete', content: line }))
  }

  // Edit type
  const lines: DiffLine[] = []
  const oldText = change.oldText || ''
  const newText = change.newText || ''
  const oldLines = oldText.split('\n')
  const newLines = newText.split('\n')

  if (oldText === newText) {
    return oldLines.map(content => ({ type: 'context', content }))
  }

  if (oldText) {
    oldLines.forEach(content => {
      lines.push({ type: 'delete', content })
    })
  }

  if (newText) {
    newLines.forEach(content => {
      lines.push({ type: 'insert', content })
    })
  }

  return lines
}
