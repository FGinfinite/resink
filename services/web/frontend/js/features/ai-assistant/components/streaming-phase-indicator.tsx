import { memo, useState, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import OLSpinner from '@/shared/components/ol/ol-spinner'

const DEBOUNCE_MS = 2500

interface StreamingPhaseIndicatorProps {
  phase: 'thinking' | 'replying' | 'tool_running' | null
  toolName?: string | null
  thinkingTopic?: string | null
}

function StreamingPhaseIndicator({ phase, toolName, thinkingTopic }: StreamingPhaseIndicatorProps) {
  const { t } = useTranslation()

  // Debounce the displayed label so it doesn't flicker on rapid phase transitions.
  // The raw label is computed from props every render, but only applied to
  // displayedLabel when at least DEBOUNCE_MS has elapsed since the last change.
  const computeLabel = (): string | null => {
    if (!phase) return null
    switch (phase) {
      case 'thinking':
        return thinkingTopic
          ? t('ai_phase_thinking_topic', 'Thinking — __topic__...', { topic: thinkingTopic })
          : t('ai_phase_thinking', 'Thinking...')
      case 'replying':
        return t('ai_phase_replying', 'Replying...')
      case 'tool_running':
        return toolName
          ? t('ai_phase_tool_running', 'Running __toolName__...', { toolName })
          : t('ai_phase_tool_running_generic', 'Running tool...')
      default:
        return null
    }
  }

  const rawLabel = computeLabel()
  const [displayedLabel, setDisplayedLabel] = useState(rawLabel)
  const lastChange = useRef(Date.now())
  const timer = useRef<ReturnType<typeof setTimeout>>()

  useEffect(() => {
    // Always show immediately on first render or when going to null (phase ended)
    if (!rawLabel) {
      if (timer.current) {
        clearTimeout(timer.current)
        timer.current = undefined
      }
      setDisplayedLabel(null)
      lastChange.current = Date.now()
      return
    }

    if (rawLabel === displayedLabel) return

    const elapsed = Date.now() - lastChange.current
    if (elapsed >= DEBOUNCE_MS) {
      // Enough time has passed — update immediately
      if (timer.current) {
        clearTimeout(timer.current)
        timer.current = undefined
      }
      setDisplayedLabel(rawLabel)
      lastChange.current = Date.now()
    } else if (!timer.current) {
      // Schedule a deferred update
      timer.current = setTimeout(() => {
        setDisplayedLabel(rawLabel)
        lastChange.current = Date.now()
        timer.current = undefined
      }, DEBOUNCE_MS - elapsed)
    }
  }, [rawLabel, displayedLabel])

  // Cleanup
  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [])

  if (!displayedLabel) return null

  return (
    <div className="ai-streaming-phase">
      <OLSpinner size="sm" />
      <span className="ai-streaming-phase-label">{displayedLabel}</span>
    </div>
  )
}

export default memo(StreamingPhaseIndicator)
