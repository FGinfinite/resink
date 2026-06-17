/**
 * Message List Component for AI Assistant
 */

import { memo, useRef, useEffect, useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import classNames from 'classnames'
import MessageContent from './message-content'
import ThinkingBlock from './thinking-block'
import StreamingPhaseIndicator from './streaming-phase-indicator'
import { ToolCallItem } from './tool-call-list'
import SkillToolbar from './skill-toolbar'
import MaterialIcon from '@/shared/components/material-icon'
import type { AIMessage, ContentBlock, StreamingPhase } from '../types/ai-types'

interface MessageListProps {
  messages: AIMessage[]
  activeBlocks: ContentBlock[]
  childActiveBlocks?: Record<string, ContentBlock[]>
  isStreaming: boolean
  streamingPhase?: StreamingPhase
  activeToolName?: string | null
  thinkingTopic?: string | null
  streamingError?: Error | null
  onRetry?: () => void
  onSkillSelect?: (skillName: string) => void
  sessionId?: string | null
}

function ContentBlockRenderer({
  blocks,
  isStreaming,
  childParts,
}: {
  blocks: ContentBlock[]
  isStreaming: boolean
  childParts?: Record<string, ContentBlock[]>
}) {
  return (
    <>
      {blocks.map((block, index) => {
        if (block.type === 'thinking') {
          return (
            <ThinkingBlock
              key={`thinking-${index}`}
              content={block.content}
              isStreaming={isStreaming && index === blocks.length - 1}
            />
          )
        }
        if (block.type === 'text') {
          return (
            <MessageContent
              key={`text-${index}`}
              content={block.content}
              messageRole="assistant"
              isStreaming={isStreaming && index === blocks.length - 1}
            />
          )
        }
        if (block.type === 'tool_call') {
          const childSessionId = block.entry.childSessionId
          return (
            <ToolCallItem
              key={block.entry.id}
              entry={block.entry}
              childParts={childSessionId ? childParts?.[childSessionId] : undefined}
            />
          )
        }
        return null
      })}
    </>
  )
}

function MessageList({
  messages,
  activeBlocks,
  childActiveBlocks,
  isStreaming,
  streamingPhase,
  activeToolName,
  thinkingTopic,
  streamingError,
  onRetry,
  onSkillSelect,
  sessionId,
}: MessageListProps) {
  const { t } = useTranslation()
  const containerRef = useRef<HTMLDivElement>(null)
  const isNearBottomRef = useRef(true)
  const prevMessageCountRef = useRef(messages.length)
  const [showScrollToBottom, setShowScrollToBottom] = useState(false)

  const NEAR_BOTTOM_RATIO = 0.1

  const checkIsNearBottom = useCallback((el: HTMLElement): boolean => {
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    return distanceFromBottom <= el.clientHeight * NEAR_BOTTOM_RATIO
  }, [])

  const scrollToBottom = useCallback(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight
      isNearBottomRef.current = true
      setShowScrollToBottom(false)
    }
  }, [])

  const handleScroll = useCallback(() => {
    if (containerRef.current) {
      const nearBottom = checkIsNearBottom(containerRef.current)
      isNearBottomRef.current = nearBottom
      setShowScrollToBottom(!nearBottom)
    }
  }, [checkIsNearBottom])

  // When user sends a new message, unconditionally scroll to bottom.
  // Only trigger for user messages, not for AI responses being finalized.
  useEffect(() => {
    if (messages.length > prevMessageCountRef.current) {
      const lastMessage = messages[messages.length - 1]
      if (lastMessage?.role === 'user') {
        scrollToBottom()
      }
    }
    prevMessageCountRef.current = messages.length
  }, [messages.length, messages, scrollToBottom])

  // Auto-scroll during streaming only when user is near bottom
  useEffect(() => {
    if (isNearBottomRef.current && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight
    }
  }, [activeBlocks, childActiveBlocks, streamingError])

  const isEmpty = messages.length === 0 && !isStreaming && !streamingError

  if (isEmpty) {
    return <EmptyState onSkillSelect={onSkillSelect} />
  }

  return (
    <div className="ai-message-list" ref={containerRef} onScroll={handleScroll}>
      <ul className="ai-message-list-items">
        {messages.map(message =>
          message.isCompaction ? (
            <CompactionDivider
              key={message.id}
              summary={message.content}
            />
          ) : (
          <li
            key={message.id}
            className={classNames('ai-message-item', {
              'ai-message-item-user': message.role === 'user',
              'ai-message-item-assistant': message.role === 'assistant',
            })}
          >
            <div className="ai-message-avatar">
              {message.role === 'user' ? (
                <MaterialIcon type="person" />
              ) : (
                <MaterialIcon type="smart_toy" />
              )}
            </div>
            <div className="ai-message-body">
              <div className="ai-message-header">
                <span className="ai-message-role">
                  {message.role === 'user'
                    ? t('you', 'You')
                    : t('ai_assistant', 'AI Assistant')}
                </span>
                {message.role === 'assistant' && message.modelInfo && (
                  <span className="ai-message-model-badge">{message.modelInfo.slotLabel}</span>
                )}
              </div>
              {message.role === 'assistant' && message.contentBlocks ? (
                <ContentBlockRenderer
                  blocks={message.contentBlocks}
                  isStreaming={false}
                  childParts={message.childSessionParts}
                />
              ) : (
                <>
                  <MessageContent
                    content={message.content}
                    messageRole="user"
                    pending={message.pending}
                  />
                  {message.attachments && message.attachments.length > 0 && (
                    <div className="ai-message-attachments">
                      {message.attachments.map(att => {
                        const isImage = att.mimeType?.startsWith('image/')
                        if (isImage) {
                          return (
                            <img
                              key={att.id}
                              src={att.localPreviewUrl || `/api/ai/files/${att.id}`}
                              alt={att.filename}
                              className="ai-message-attachment-img"
                              loading="lazy"
                              onError={e => {
                                // If blob URL was revoked or image failed to load,
                                // fall back to server URL exactly once to avoid
                                // infinite retry loops.
                                const target = e.currentTarget
                                if (!target.dataset.fallback && att.localPreviewUrl) {
                                  target.dataset.fallback = '1'
                                  target.src = `/api/ai/files/${att.id}`
                                }
                              }}
                            />
                          )
                        }
                        return (
                          <div key={att.id} className="ai-message-attachment-file">
                            <span className="ai-message-attachment-file-name">{att.filename}</span>
                            <span className="ai-message-attachment-file-size">
                              {att.size ? `${(att.size / 1024).toFixed(1)}KB` : ''}
                            </span>
                          </div>
                        )
                      })}
                    </div>
                  )}
                </>
              )}
              {message.interrupted && (
                <div className="ai-message-interrupted-badge">
                  <MaterialIcon type="stop_circle" />
                  <span>{t('conversation_stopped', 'Conversation stopped')}</span>
                </div>
              )}
            </div>
          </li>
          )
        )}
        {/* Streaming content */}
        {isStreaming && (
          <li className="ai-message-item ai-message-item-assistant ai-message-streaming">
            <div className="ai-message-avatar">
              <MaterialIcon type="smart_toy" />
            </div>
            <div className="ai-message-body">
              <div className="ai-message-header">
                <span className="ai-message-role">
                  {t('ai_assistant', 'AI Assistant')}
                </span>
              </div>
              {activeBlocks.length > 0 ? (
                <>
                  <ContentBlockRenderer blocks={activeBlocks} isStreaming childParts={childActiveBlocks} />
                  <StreamingPhaseIndicator
                    phase={streamingPhase || null}
                    toolName={activeToolName}
                    thinkingTopic={thinkingTopic}
                  />
                </>
              ) : (
                <StreamingPhaseIndicator
                  phase={streamingPhase || 'thinking'}
                  toolName={activeToolName}
                  thinkingTopic={thinkingTopic}
                />
              )}
            </div>
          </li>
        )}
        {/* Error breakpoint - show retained activeBlocks content */}
        {streamingError && activeBlocks.length > 0 && (
          <li className="ai-message-item ai-message-item-assistant">
            <div className="ai-message-avatar">
              <MaterialIcon type="smart_toy" />
            </div>
            <div className="ai-message-body">
              <ContentBlockRenderer blocks={activeBlocks} isStreaming={false} childParts={childActiveBlocks} />
            </div>
          </li>
        )}

        {/* Inline error + retry button */}
        {streamingError && (
          <li className="ai-message-error-inline">
            <div className="ai-message-error-content">
              <MaterialIcon type="error_outline" className="ai-error-icon" />
              <span>{t('ai_streaming_error', 'Response was interrupted')}</span>
            </div>
            {onRetry && (
              <button className="ai-retry-button" onClick={onRetry}>
                <MaterialIcon type="refresh" />
                {t('retry', 'Retry')}
              </button>
            )}
          </li>
        )}
      </ul>
      <button
        className={classNames('ai-scroll-to-bottom-btn', {
          'ai-scroll-to-bottom-btn-visible': showScrollToBottom,
        })}
        onClick={scrollToBottom}
        aria-label={t('scroll_to_bottom', 'Scroll to bottom')}
      >
        <MaterialIcon type="keyboard_arrow_down" />
      </button>
    </div>
  )
}

function CompactionDivider({ summary }: { summary: string }) {
  const [expanded, setExpanded] = useState(false)
  const { t } = useTranslation()

  return (
    <li className="ai-compaction-divider">
      <div className="ai-compaction-divider-row">
        <div className="ai-compaction-divider-line" />
        <button
          className="ai-compaction-divider-label"
          onClick={() => setExpanded(prev => !prev)}
        >
          <MaterialIcon type="compress" />
          {t('context_compacted', 'Context compacted')}
          <MaterialIcon type={expanded ? 'expand_less' : 'expand_more'} />
        </button>
        <div className="ai-compaction-divider-line" />
      </div>
      {expanded && (
        <div className="ai-compaction-summary">
          <MessageContent content={summary} messageRole="assistant" />
        </div>
      )}
    </li>
  )
}

function EmptyState({ onSkillSelect }: { onSkillSelect?: (skillName: string) => void }) {
  const { t } = useTranslation()

  return (
    <div className="ai-assistant-empty-state">
      <div className="ai-assistant-empty-state-greeting">
        <div className="ai-assistant-empty-state-icon">
          <MaterialIcon type="smart_toy" />
        </div>
        <div className="ai-assistant-empty-state-intro">
          <h3 className="ai-assistant-empty-state-title">
            {t('ai_assistant', 'AI Assistant')}
          </h3>
          <p className="ai-assistant-empty-state-body">
            {t(
              'ai_assistant_intro',
              'Ask me to help you write, edit, or improve your LaTeX document.'
            )}
          </p>
        </div>
      </div>
      {onSkillSelect && (
        <SkillToolbar onSkillSelect={onSkillSelect} disabled={false} />
      )}
    </div>
  )
}

export default memo(MessageList)
