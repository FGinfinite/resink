import { memo, useState, useRef, useEffect, Suspense, lazy } from 'react'
import { useTranslation } from 'react-i18next'
import MaterialIcon from '@/shared/components/material-icon'
import { hardenedRehypePlugins } from '../utils/streamdown-plugins'
import '../../../../stylesheets/ai-tailwind.css'

const StreamdownComponent = lazy(() =>
  import('streamdown').then(mod => ({ default: mod.Streamdown }))
)

const THROTTLE_MS = 100

interface ThinkingBlockProps {
  content: string
  isStreaming?: boolean
}

/**
 * Returns a throttled version of a rapidly-changing string value.
 * During streaming, updates are batched to at most one render per THROTTLE_MS.
 * When streaming stops, the final value is flushed immediately.
 */
function useThrottledText(raw: string, active: boolean): string {
  const [display, setDisplay] = useState(raw)
  const lastFlush = useRef(Date.now())
  const timer = useRef<ReturnType<typeof setTimeout>>()

  useEffect(() => {
    if (!active) {
      // Not streaming — show final value immediately
      if (timer.current) {
        clearTimeout(timer.current)
        timer.current = undefined
      }
      setDisplay(raw)
      return
    }

    const now = Date.now()
    const elapsed = now - lastFlush.current

    if (elapsed >= THROTTLE_MS) {
      if (timer.current) {
        clearTimeout(timer.current)
        timer.current = undefined
      }
      lastFlush.current = now
      setDisplay(raw)
    } else if (!timer.current) {
      timer.current = setTimeout(() => {
        lastFlush.current = Date.now()
        setDisplay(raw)
        timer.current = undefined
      }, THROTTLE_MS - elapsed)
    }
  }, [raw, active])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [])

  return display
}

/**
 * Extract a topic from the beginning of reasoning text.
 * Models sometimes start reasoning with **Topic** or **topic name**.
 */
function extractTopic(text: string): string | null {
  const match = text.trimStart().match(/^\*\*(.+?)\*\*/)
  return match ? match[1].trim() : null
}

function ThinkingBlock({ content, isStreaming = false }: ThinkingBlockProps) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const throttled = useThrottledText(content, isStreaming)
  const topic = extractTopic(throttled)

  let label: string
  if (isStreaming) {
    label = topic
      ? t('ai_thinking_topic', 'Thinking — __topic__', { topic })
      : t('ai_thinking_in_progress', 'Thinking...')
  } else {
    label = topic
      ? t('ai_thought_topic', 'Thought — __topic__', { topic })
      : t('ai_thinking_process', 'Thinking')
  }

  return (
    <div className="ai-thinking-block">
      <button
        className="ai-thinking-header"
        onClick={() => setExpanded(!expanded)}
      >
        <MaterialIcon type="psychology" className="ai-thinking-icon" />
        <span className="ai-thinking-label">{label}</span>
        <MaterialIcon
          type={expanded ? 'expand_less' : 'expand_more'}
          className="ai-thinking-expand-icon"
        />
      </button>
      {expanded && (
        <div className="ai-thinking-content">
          <Suspense fallback={<span>{throttled}</span>}>
            <StreamdownComponent
              mode={isStreaming ? 'streaming' : 'static'}
              parseIncompleteMarkdown={isStreaming}
              rehypePlugins={hardenedRehypePlugins}
              className="ai-streamdown-root"
              controls={false}
            >
              {throttled}
            </StreamdownComponent>
          </Suspense>
        </div>
      )}
    </div>
  )
}

export default memo(ThinkingBlock)
