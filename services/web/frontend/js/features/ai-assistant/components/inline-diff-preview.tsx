/**
 * Inline Diff Preview Component
 * Compact diff view for tool call expansion in the message flow.
 * Uses character-level diff for edit-type changes and line-level for create/delete.
 */

import classNames from 'classnames'
import type { PendingChange } from '../types/ai-types'
import { computeDiffLines, computeCharDiff } from '../utils/diff-utils'
import type { CharDiffSegment } from '../utils/diff-utils'

const MAX_PREVIEW_LINES = 20

interface InlineDiffPreviewProps {
  change: PendingChange
}

function CharDiffView({ oldText, newText }: { oldText: string; newText: string }) {
  const segments: CharDiffSegment[] = computeCharDiff(oldText, newText)

  return (
    <div className="ai-char-diff">
      {/* Old text block */}
      <div className="ai-char-diff-block ai-char-diff-old">
        <span className="ai-diff-line-marker">-</span>
        <span className="ai-char-diff-content">
          {segments
            .filter(s => s.type !== 'added')
            .map((seg, i) => (
              <span
                key={i}
                className={seg.type === 'removed' ? 'ai-char-diff-removed' : ''}
              >
                {seg.text}
              </span>
            ))}
        </span>
      </div>
      {/* New text block */}
      <div className="ai-char-diff-block ai-char-diff-new">
        <span className="ai-diff-line-marker">+</span>
        <span className="ai-char-diff-content">
          {segments
            .filter(s => s.type !== 'removed')
            .map((seg, i) => (
              <span
                key={i}
                className={seg.type === 'added' ? 'ai-char-diff-added' : ''}
              >
                {seg.text}
              </span>
            ))}
        </span>
      </div>
    </div>
  )
}

export default function InlineDiffPreview({ change }: InlineDiffPreviewProps) {
  const changeType = change.type || 'edit'

  // Edit type with both old and new text: use character-level diff
  if (changeType === 'edit' && change.oldText && change.newText) {
    return (
      <div className="ai-inline-diff-preview">
        <CharDiffView oldText={change.oldText} newText={change.newText} />
      </div>
    )
  }

  // Create/Delete type or missing text: use line-level diff
  const allLines = computeDiffLines(change)
  const truncated = allLines.length > MAX_PREVIEW_LINES
  const lines = truncated ? allLines.slice(0, MAX_PREVIEW_LINES) : allLines

  return (
    <div className="ai-inline-diff-preview">
      {lines.map((line, index) => (
        <div
          key={index}
          className={classNames('ai-diff-line', {
            'ai-diff-line-delete': line.type === 'delete',
            'ai-diff-line-insert': line.type === 'insert',
            'ai-diff-line-context': line.type === 'context',
          })}
        >
          <span className="ai-diff-line-marker">
            {line.type === 'delete' ? '-' : line.type === 'insert' ? '+' : ' '}
          </span>
          <span className="ai-diff-line-content">{line.content}</span>
        </div>
      ))}
      {truncated && (
        <div className="ai-inline-diff-truncated">
          ... {allLines.length - MAX_PREVIEW_LINES} more lines
        </div>
      )}
    </div>
  )
}
