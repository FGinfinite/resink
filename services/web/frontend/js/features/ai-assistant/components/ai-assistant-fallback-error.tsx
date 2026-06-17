/**
 * AI Assistant Fallback Error Component
 */

import { useTranslation } from 'react-i18next'
import OLNotification from '@/shared/components/ol/ol-notification'
import OLButton from '@/shared/components/ol/ol-button'

interface AIAssistantFallbackErrorProps {
  reconnect?: () => void
}

function AIAssistantFallbackError({
  reconnect,
}: AIAssistantFallbackErrorProps) {
  const { t } = useTranslation()

  return (
    <aside className="ai-assistant">
      <div className="ai-assistant-error">
        <OLNotification
          type="error"
          content={t('ai_assistant_error', 'AI Assistant encountered an error')}
        />
        {reconnect && (
          <p className="text-center">
            <OLButton variant="secondary" onClick={reconnect}>
              {t('try_again', 'Try Again')}
            </OLButton>
          </p>
        )}
      </div>
    </aside>
  )
}

export default AIAssistantFallbackError
