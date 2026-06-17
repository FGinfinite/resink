/**
 * Message Content Component
 * Renders message content with Markdown support via Streamdown
 */

import { memo, Suspense, lazy } from 'react'
import classNames from 'classnames'
import { hardenedRehypePlugins } from '../utils/streamdown-plugins'
import '../../../../stylesheets/ai-tailwind.css'

const StreamdownComponent = lazy(() =>
  import('streamdown').then(mod => ({ default: mod.Streamdown }))
)

interface MessageContentProps {
  content: string
  messageRole: 'user' | 'assistant'
  pending?: boolean
  isStreaming?: boolean
}

function MessageContent({
  content,
  messageRole,
  pending,
  isStreaming = false,
}: MessageContentProps) {
  // User messages: plain text
  if (messageRole === 'user') {
    return (
      <div
        className={classNames('ai-message-content', 'ai-message-user', {
          'ai-message-pending': pending,
        })}
      >
        {content}
      </div>
    )
  }

  // Assistant messages: Streamdown
  return (
    <div className={classNames('ai-message-content', 'ai-message-assistant')}>
      <Suspense fallback={<span>{content}</span>}>
        <StreamdownComponent
          mode={isStreaming ? 'streaming' : 'static'}
          parseIncompleteMarkdown={isStreaming}
          rehypePlugins={hardenedRehypePlugins}
          className="ai-streamdown-root"
          controls={false}
        >
          {content}
        </StreamdownComponent>
      </Suspense>
    </div>
  )
}

export default memo(MessageContent)
