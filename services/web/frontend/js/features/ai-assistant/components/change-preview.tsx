/**
 * Change Preview Component
 * Shows a single pending change with diff view
 */

import { memo, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import classNames from 'classnames'
import MaterialIcon from '@/shared/components/material-icon'
import OLButton from '@/shared/components/ol/ol-button'
import type { PendingChange } from '../types/ai-types'
import { computeDiffLines } from '../utils/diff-utils'

interface ChangePreviewProps {
  change: PendingChange
  onAccept: (changeId: string) => void
  onReject: (changeId: string) => void
}

function ChangePreview({ change, onAccept, onReject }: ChangePreviewProps) {
  const { t } = useTranslation()

  const changeType = change.type || 'edit'
  const diffLines = useMemo(() => computeDiffLines(change), [change])

  const handleAccept = () => onAccept(change.id)
  const handleReject = () => onReject(change.id)

  const isProcessing = change.status !== 'pending'

  const iconType =
    changeType === 'delete'
      ? 'delete'
      : changeType === 'create'
        ? 'note_add'
        : 'edit_document'

  const displayPath =
    change.path || change.docPath || t('document', 'Document')

  return (
    <div
      className={classNames('ai-change-preview', {
        'ai-change-preview-processing': isProcessing,
      })}
    >
      <div className="ai-change-preview-header">
        <div className="ai-change-preview-info">
          <MaterialIcon type={iconType} />
          <span className="ai-change-preview-path">{displayPath}</span>
        </div>
        <div className="ai-change-preview-actions">
          <OLButton
            variant="secondary"
            size="sm"
            onClick={handleReject}
            disabled={isProcessing}
            aria-label={t('reject_change', 'Reject change')}
          >
            <MaterialIcon type="close" />
          </OLButton>
          <OLButton
            variant="primary"
            size="sm"
            onClick={handleAccept}
            disabled={isProcessing}
            aria-label={t('accept_change', 'Accept change')}
          >
            <MaterialIcon type="check" />
          </OLButton>
        </div>
      </div>
      <div className="ai-change-preview-diff">
        {diffLines.map((line, index) => (
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
      </div>
    </div>
  )
}

export default memo(ChangePreview)
