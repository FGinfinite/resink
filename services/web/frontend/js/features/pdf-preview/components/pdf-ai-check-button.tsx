import { memo, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useDetachCompileContext as useCompileContext } from '../../../shared/context/detach-compile-context'
import { useOptionalRailContext } from '@/features/ide-react/context/rail-context'
import getMeta from '@/utils/meta'
import OLTooltip from '@/shared/components/ol/ol-tooltip'
import OLIconButton from '@/shared/components/ol/ol-icon-button'
import {
  enqueueCompileErrors,
  selectTopEntries,
} from '@/features/ai-assistant/utils/compile-error-bridge'
import { useOptionalAIStatus } from '@/features/ai-assistant/context/ai-status-context'

function PdfAICheckButton() {
  const { logEntries, error, rawLog } = useCompileContext()
  const railContext = useOptionalRailContext()
  const { t } = useTranslation()
  const aiStatus = useOptionalAIStatus()
  const isAIStreaming = aiStatus?.status === 'streaming'

  const aiEnabled =
    getMeta('ol-capabilities')?.includes('ai-assistant') ?? false

  const handleClick = useCallback(() => {
    if (!railContext) return

    if (logEntries && (logEntries.errors.length > 0 || logEntries.warnings.length > 0 || logEntries.typesetting.length > 0)) {
      const entries = selectTopEntries(logEntries, 10)
      enqueueCompileErrors({ mode: 'batch', entries })
    } else if (rawLog) {
      const rawLogExcerpt = rawLog.slice(0, 2000)
      enqueueCompileErrors({ mode: 'batch', entries: [], rawLogExcerpt })
    } else {
      enqueueCompileErrors({ mode: 'batch', entries: [] })
    }

    railContext.openTab('ai-assistant')
  }, [logEntries, rawLog, railContext])

  // Hide when AI is not enabled or when in detached mode (no railContext)
  if (!aiEnabled || !railContext) {
    return null
  }

  const hasEntries =
    (logEntries?.errors?.length ?? 0) > 0 ||
    (logEntries?.warnings?.length ?? 0) > 0 ||
    (logEntries?.typesetting?.length ?? 0) > 0
  const disabled = isAIStreaming || (!hasEntries && !error && !rawLog)

  return (
    <OLTooltip
      id="pdf-ai-check-button-tooltip"
      description={t('ask_ai_to_check', 'Ask AI to check')}
      overlayProps={{ placement: 'bottom' }}
    >
      <OLIconButton
        variant="ghost"
        size="sm"
        icon="auto_fix_high"
        accessibilityLabel={t('ask_ai_to_check', 'Ask AI to check')}
        className="pdf-toolbar-btn toolbar-item"
        onClick={handleClick}
        disabled={disabled}
      />
    </OLTooltip>
  )
}

export default memo(PdfAICheckButton)
