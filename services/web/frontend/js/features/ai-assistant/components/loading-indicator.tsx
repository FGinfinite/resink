/**
 * Loading Indicator Component for AI Assistant
 */

import { memo } from 'react'
import { useTranslation } from 'react-i18next'
import OLSpinner from '@/shared/components/ol/ol-spinner'

interface LoadingIndicatorProps {
  text?: string
}

function LoadingIndicator({ text }: LoadingIndicatorProps) {
  const { t } = useTranslation()

  return (
    <div className="ai-assistant-loading" role="status">
      <OLSpinner size="sm" />
      <span>{text || t('ai_thinking', 'AI is thinking...')}</span>
    </div>
  )
}

export default memo(LoadingIndicator)
