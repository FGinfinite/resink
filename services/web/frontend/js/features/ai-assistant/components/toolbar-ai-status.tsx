import { useTranslation } from 'react-i18next'
import { useAIStatus } from '../context/ai-status-context'
import { useOptionalAIRailContext } from '../context/ai-rail-context'
import OLTooltip from '@/shared/components/ol/ol-tooltip'
import MaterialIcon from '@/shared/components/material-icon'
import classNames from 'classnames'
import getMeta from '@/utils/meta'

export function ToolbarAIStatus() {
  const aiEnabled =
    getMeta('ol-capabilities')?.includes('ai-assistant') ?? false
  const aiRailCtx = useOptionalAIRailContext()

  if (!aiEnabled || !aiRailCtx) return null

  return <ToolbarAIStatusInner />
}

function ToolbarAIStatusInner() {
  const { t } = useTranslation()
  const { status } = useAIStatus()
  const aiRailCtx = useOptionalAIRailContext()

  const isAgentWorking = status === 'streaming' || status === 'pending'

  const tooltipText = isAgentWorking
    ? t('ai_working', 'AI 工作中...')
    : t('ai_assistant', 'AI Assistant')

  return (
    <OLTooltip
      id="toolbar-ai-status"
      description={tooltipText}
      overlayProps={{ placement: 'bottom' }}
    >
      <button
        className={classNames('toolbar-ai-status', {
          'toolbar-ai-status-working': isAgentWorking,
        })}
        onClick={aiRailCtx?.openAIPanel}
        aria-label={t('ai_assistant', 'AI Assistant')}
      >
        <MaterialIcon type="smart_toy" className="toolbar-ai-status-icon" />
      </button>
    </OLTooltip>
  )
}
