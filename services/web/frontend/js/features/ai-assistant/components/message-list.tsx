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
import { useAIAssistantContext } from '../context/ai-assistant-context'
import type {
  AgentTeamEvent,
  AgentTeamRun,
  AgentTeamTask,
  AIMessage,
  ContentBlock,
  StreamingPhase,
} from '../types/ai-types'

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
}: MessageListProps) {
  const { t } = useTranslation()
  const { state, cancelTeamRun, retryTeamRunTask } = useAIAssistantContext()
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

  const hasTeamRuns = state.teamRuns.length > 0
  const isEmpty = messages.length === 0 && !isStreaming && !streamingError && !hasTeamRuns

  if (isEmpty) {
    return <EmptyState onSkillSelect={onSkillSelect} />
  }

  return (
    <div className="ai-message-list" ref={containerRef} onScroll={handleScroll}>
      {state.session?.activeHandoff && (
        <div className="ai-active-handoff-banner">
          <MaterialIcon type="published_with_changes" />
          <span>
            Active handoff · {state.session.activeHandoff.capabilityName || 'specialist agent'}
          </span>
        </div>
      )}
      <ul className="ai-message-list-items">
        {state.teamRuns.map(teamRun => (
          <li
            key={teamRun.team.id}
            className="ai-message-item ai-message-item-assistant"
          >
            <div className="ai-message-avatar">
              <MaterialIcon type="group_work" />
            </div>
            <div className="ai-message-body">
              <TeamTraceBlock
                teamRun={teamRun}
                onCancel={cancelTeamRun}
                onRetryTask={retryTeamRunTask}
              />
            </div>
          </li>
        ))}
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

function TeamTraceBlock({
  teamRun,
  onCancel,
  onRetryTask,
}: {
  teamRun: AgentTeamRun
  onCancel: (teamId: string) => Promise<void>
  onRetryTask: (teamId: string, taskId: string) => Promise<void>
}) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const team = teamRun.team
  const running = team.status === 'queued' || team.status === 'running'
  const tasks = teamRun.tasks || []
  const events = teamRun.events || []
  const results = teamRun.results || []
  const completed = tasks.filter(task => task.status === 'completed').length
  const failed = tasks.filter(task => ['failed', 'timeout', 'cancelled'].includes(task.status)).length
  const findingCount = tasks.reduce((sum, task) => sum + (task.findingCount || 0), 0)
  const artifactCount = tasks.reduce((sum, task) => sum + (task.artifactCount || 0), 0)
  const draftCount = tasks.reduce((sum, task) => sum + (task.draftChangeCount || 0), 0)
  const teamLabel = team.workflowType || team.mode || team.id

  const runAction = async (key: string, action: () => Promise<void>) => {
    setBusy(key)
    try {
      await action()
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className={`ai-team-trace-block ai-team-trace-${team.status}`}>
      <button
        type="button"
        className="ai-tool-call-header ai-tool-call-header-clickable"
        onClick={() => setExpanded(value => !value)}
      >
        <span className="ai-tool-call-icon">
          <MaterialIcon type={running ? 'groups' : team.status === 'cancelled' ? 'stop_circle' : 'task_alt'} />
        </span>
        <span className="ai-tool-call-text">
          Team {teamLabel} · {team.status}
        </span>
        <span className="ai-team-trace-metrics">
          {completed}/{tasks.length} {t('completed', 'completed')}
          {failed ? ` · ${failed} ${t('failed', 'failed')}` : ''}
          {findingCount ? ` · ${findingCount} findings` : ''}
          {artifactCount ? ` · ${artifactCount} artifacts` : ''}
          {draftCount ? ` · ${draftCount} drafts` : ''}
        </span>
        <span className="ai-tool-call-expand-icon">
          <MaterialIcon type={expanded ? 'expand_less' : 'expand_more'} />
        </span>
      </button>
      {expanded && (
        <div className="ai-team-trace-detail">
          <div className="ai-team-trace-meta">
            <span>{t('status', 'Status')}: {team.status}</span>
            <span>{t('mode', 'Mode')}: {team.mode || 'default'}</span>
            {results.length > 0 && (
              <span>
                {t('results', 'Results')}: {results.length}
              </span>
            )}
            {teamRun.diagnostics?.eventTypes && (
              <span>
                {t('events', 'Events')}: {Object.values(teamRun.diagnostics.eventTypes).reduce((sum, count) => sum + count, 0)}
              </span>
            )}
            {running && (
              <button
                type="button"
                className="ai-retry-button"
                disabled={busy === 'cancel'}
                onClick={() => runAction('cancel', () => onCancel(team.id))}
              >
                <MaterialIcon type="stop_circle" />
                {t('cancel_team', 'Cancel team')}
              </button>
            )}
          </div>
          <div className="ai-team-task-list">
            {tasks.map(task => (
              <TeamTaskRow
                key={task.id}
                task={task}
                busy={busy === task.id}
                onRetry={() => runAction(task.id, () => onRetryTask(team.id, task.id))}
              />
            ))}
          </div>
          {events.length > 0 && (
            <div className="ai-team-event-list">
              {events.map(event => (
                <TeamEventRow event={event} key={event.id} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function TeamEventRow({ event }: { event: AgentTeamEvent }) {
  const details = [
    event.payload?.capabilityName,
    event.payload?.tool,
    event.payload?.reason,
    event.payload?.conflictType,
  ]
    .filter(value => value !== undefined && value !== null && value !== '')
    .map(value => String(value))

  return (
    <div className="ai-team-event-row">
      <MaterialIcon type="radio_button_checked" />
      <span>{event.type}</span>
      {details.map(detail => (
        <span key={detail}>{detail}</span>
      ))}
    </div>
  )
}

function TeamTaskRow({
  task,
  busy,
  onRetry,
}: {
  task: AgentTeamTask
  busy: boolean
  onRetry: () => Promise<void>
}) {
  const { t } = useTranslation()
  const icon =
    task.status === 'completed'
      ? 'task_alt'
      : task.status === 'running'
        ? 'autorenew'
        : ['failed', 'timeout'].includes(task.status)
          ? 'error_outline'
          : task.status === 'cancelled'
            ? 'stop_circle'
            : 'schedule'

  return (
    <div className={`ai-team-task-row ai-team-task-${task.status}`}>
      <MaterialIcon type={icon} />
      <div className="ai-team-task-main">
        <div className="ai-team-task-title">
          {task.agentName}: {task.objective}
        </div>
        <div className="ai-team-task-meta">
          {task.status}
          {task.findingCount ? ` · ${task.findingCount} findings` : ''}
          {task.draftChangeCount ? ` · ${task.draftChangeCount} drafts` : ''}
          {task.error ? ` · ${task.error}` : ''}
        </div>
      </div>
      {task.retryable && (
        <button
          type="button"
          className="ai-retry-button ai-team-task-retry"
          disabled={busy}
          onClick={onRetry}
        >
          <MaterialIcon type="refresh" />
          {t('queue_retry', 'Queue retry')}
        </button>
      )}
    </div>
  )
}
