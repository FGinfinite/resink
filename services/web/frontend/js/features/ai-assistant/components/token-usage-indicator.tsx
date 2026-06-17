/**
 * Token Usage Indicator Component
 * Displays a progress bar showing context window usage and a manual compaction button
 */

import { memo } from 'react'
import { useTranslation } from 'react-i18next'
import OLTooltip from '@/shared/components/ol/ol-tooltip'
import OLButton from '@/shared/components/ol/ol-button'
import MaterialIcon from '@/shared/components/material-icon'
import LoadingSpinner from '@/shared/components/loading-spinner'

interface TokenUsageIndicatorProps {
  tokenUsage: {
    promptTokens: number
    completionTokens: number
    totalTokens: number
    contextWindow: number
    threshold: number
  } | null
  compactionStatus: 'idle' | 'compacting' | null
  onCompact: () => void
}

function TokenUsageIndicator({
  tokenUsage,
  compactionStatus,
  onCompact,
}: TokenUsageIndicatorProps) {
  const { t } = useTranslation()
  if (!tokenUsage) return null

  const usageRatio = tokenUsage.promptTokens / tokenUsage.contextWindow
  const percentage = Math.min(Math.round(usageRatio * 100), 100)
  const thresholdPercent = Math.round(tokenUsage.threshold * 100)

  const colorClass =
    percentage < 50 ? 'green' : percentage < 80 ? 'yellow' : 'red'
  const isCompacting = compactionStatus === 'compacting'

  const tooltipText = `Tokens: ${tokenUsage.promptTokens.toLocaleString()} / ${tokenUsage.contextWindow.toLocaleString()} (${percentage}%)\n${t('auto_compact_threshold', 'Auto-compact threshold')}: ${thresholdPercent}%`

  return (
    <div className="ai-token-usage">
      <OLTooltip
        id="ai-token-usage-tooltip"
        description={tooltipText}
        overlayProps={{ placement: 'bottom' }}
      >
        <div className="ai-token-usage-inner">
          <div className="ai-token-usage-bar-container">
            <div
              className={`ai-token-usage-bar ai-token-usage-${colorClass}`}
              style={{ width: `${percentage}%` }}
            />
            <div
              className="ai-token-usage-threshold"
              style={{ left: `${thresholdPercent}%` }}
            />
          </div>
          <span className="ai-token-usage-text">{percentage}%</span>
        </div>
      </OLTooltip>
      <OLTooltip
        id="ai-compact-tooltip"
        description={isCompacting ? t('compacting', 'Compacting…') : t('compact_context', 'Compact conversation context')}
        overlayProps={{ placement: 'bottom' }}
      >
        <OLButton
          variant="ghost"
          size="sm"
          onClick={onCompact}
          disabled={isCompacting}
          aria-label={t('compact_context', 'Compact context')}
        >
          {isCompacting ? (
            <LoadingSpinner />
          ) : (
            <MaterialIcon type="compress" />
          )}
        </OLButton>
      </OLTooltip>
    </div>
  )
}

export default memo(TokenUsageIndicator)
