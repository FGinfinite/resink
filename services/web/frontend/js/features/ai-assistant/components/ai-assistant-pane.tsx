/**
 * AI Assistant Pane - Main container component
 */

import React, { memo, useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAIAssistantContext } from '../context/ai-assistant-context'
import { useOptionalAIRailContext } from '../context/ai-rail-context'
import MessageList from './message-list'
import ChatInput from './chat-input'
import PendingChangesList from './pending-changes-list'
import AppliedChangesNav from './applied-changes-nav'
import SessionList from './session-list'
import ProjectRulesEditor from './project-rules-editor'
import TokenUsageIndicator from './token-usage-indicator'
import AIAssistantFallbackError from './ai-assistant-fallback-error'
import { FullSizeLoadingSpinner } from '@/shared/components/loading-spinner'
import withErrorBoundary from '@/infrastructure/error-boundary'
import { useProjectContext } from '@/shared/context/project-context'
import { useAIEditorSync } from '../hooks/use-ai-editor-sync'
import { FetchError } from '@/infrastructure/fetch-json'
import MaterialIcon from '@/shared/components/material-icon'
import OLButton from '@/shared/components/ol/ol-button'
import OLTooltip from '@/shared/components/ol/ol-tooltip'
import {
  registerCompileErrorHandler,
  unregisterCompileErrorHandler,
  formatCompileErrorsForAI,
  formatSingleEntryForAI,
} from '../utils/compile-error-bridge'
import type { CompileErrorPayload } from '../utils/compile-error-bridge'
import type { Reference } from '../components/chat-input/types'

const AIAssistantPaneContent = memo(function AIAssistantPaneContent() {
  const { t } = useTranslation()
  const { projectId } = useProjectContext()

  const {
    state,
    createSession,
    sendMessage,
    retryFromError,
    stopConversation,
    confirmChange,
    confirmAllChanges,
    dismissAppliedChange,
    dismissAllAppliedChanges,
    reset,
    clearError,
    autoAccept,
    setAutoAccept,
    compactSession,
    setModelSlot,
    currentModelSupportsImage,
    isStreaming,
    hasSession,
    hasAwaitingConfirmation,
    hasAppliedChanges,
  } = useAIAssistantContext()

  // Get AI Rail context for Move button (optional — absent when AI is disabled)
  const aiRailCtx = useOptionalAIRailContext()

  // Sync pending changes to CodeMirror editor decorations
  useAIEditorSync()

  // Consume compile errors from "Fix with AI" button via callback registration
  useEffect(() => {
    const handler = (payload: CompileErrorPayload) => {
      let prompt: string
      let files: string[] = []

      if (payload.mode === 'single') {
        const formatted = formatSingleEntryForAI(payload.entry)
        prompt = `以下 LaTeX 编译日志条目需要修复：\n\n${formatted}`
        if (payload.entry.file) files = [payload.entry.file]
      } else {
        // batch mode
        if (payload.entries.length > 0) {
          const formatted = formatCompileErrorsForAI(payload.entries)
          prompt = `以下是 LaTeX 编译产生的问题（共 ${payload.entries.length} 条），请帮我分析并修复：\n\n${formatted}`
          files = [
            ...new Set(
              payload.entries.map(e => e.file).filter((f): f is string => !!f)
            ),
          ]
        } else if (payload.rawLogExcerpt) {
          prompt = `以下是 LaTeX 编译的原始日志摘录，请帮我分析并修复其中的问题：\n\n${payload.rawLogExcerpt}`
        } else {
          prompt = '编译出现了问题，请帮我检查项目中可能存在的 LaTeX 错误。'
        }
      }

      const references: Reference[] = files.map(f => ({
        type: 'file' as const,
        path: f,
      }))

      sendMessage(prompt, references)
    }

    registerCompileErrorHandler(handler)
    return () => unregisterCompileErrorHandler()
  }, [sendMessage])

  const [showSessionList, setShowSessionList] = useState(false)
  const [showProjectRules, setShowProjectRules] = useState(false)
  const toggleSessionList = useCallback(
    () => setShowSessionList(prev => !prev),
    []
  )
  const closeSessionList = useCallback(() => setShowSessionList(false), [])

  const handleSkillSelect = useCallback(
    (skillName: string) => {
      // Insert /skillName into the editor instead of immediately sending.
      // The SkillInsertPlugin inside ChatInput handles the insertion.
      document.dispatchEvent(
        new CustomEvent('ai-skill-insert', {
          detail: { skillName },
        })
      )
    },
    []
  )

  // Handle error state
  if (state.error) {
    if (state.error instanceof FetchError) {
      return (
        <AIAssistantFallbackError
          reconnect={() => {
            clearError()
            createSession()
          }}
        />
      )
    }
    throw state.error
  }

  // Loading state
  if (state.status === 'pending' && !hasSession) {
    return (
      <aside className="ai-assistant" aria-label={t('ai_assistant', 'AI Assistant')}>
        <FullSizeLoadingSpinner delay={500} />
      </aside>
    )
  }

  return (
    <aside className="ai-assistant" aria-label={t('ai_assistant', 'AI Assistant')}>
      <div className="ai-assistant-panel">
        {/* Header with session controls */}
        <div className="ai-assistant-header">
          <div className="ai-assistant-header-left">
            <h2 className="ai-assistant-title">
              <MaterialIcon type="smart_toy" />
              <span className="ai-assistant-session-title">
                {state.session?.title || t('ai_assistant', 'AI Assistant')}
              </span>
            </h2>
          </div>
          <TokenUsageIndicator
            tokenUsage={state.tokenUsage}
            compactionStatus={state.compactionStatus}
            onCompact={compactSession}
          />
          <div className="ai-assistant-header-actions">
            {aiRailCtx && (
              <OLTooltip
                id="ai-move-panel"
                description={aiRailCtx.side === 'left' ? t('move_to_right', '移至右侧') : t('move_to_left', '移至左侧')}
                overlayProps={{ placement: 'bottom' }}
              >
                <OLButton
                  variant="ghost"
                  size="sm"
                  onClick={aiRailCtx.toggleSide}
                  aria-label={aiRailCtx.side === 'left' ? t('move_to_right', '移至右侧') : t('move_to_left', '移至左侧')}
                >
                  <MaterialIcon type={aiRailCtx.side === 'left' ? 'dock_to_right' : 'dock_to_left'} />
                </OLButton>
              </OLTooltip>
            )}
            <OLTooltip
              id="ai-auto-accept-toggle"
              description={autoAccept ? '自动接受: 开' : '自动接受: 关'}
              overlayProps={{ placement: 'bottom' }}
            >
              <OLButton
                variant="ghost"
                size="sm"
                onClick={() => setAutoAccept(!autoAccept)}
                className={autoAccept ? 'ai-auto-accept-active' : ''}
                aria-label="Toggle auto-accept"
              >
                <MaterialIcon type={autoAccept ? 'flash_on' : 'flash_off'} />
              </OLButton>
            </OLTooltip>
            <div className="ai-project-rules-container">
              <OLTooltip
                id="ai-project-rules"
                description="项目规则"
                overlayProps={{ placement: 'bottom' }}
              >
                <OLButton
                  variant="ghost"
                  size="sm"
                  onClick={() => setShowProjectRules(prev => !prev)}
                  aria-label="Project Rules"
                >
                  <MaterialIcon type="description" />
                </OLButton>
              </OLTooltip>
              <ProjectRulesEditor
                isOpen={showProjectRules}
                onClose={() => setShowProjectRules(false)}
              />
            </div>
            <div className="ai-session-list-container">
              <OLButton
                variant="ghost"
                size="sm"
                onClick={toggleSessionList}
                disabled={isStreaming}
                aria-label={t('session_history', 'Session History')}
              >
                <MaterialIcon type="history" />
              </OLButton>
              <SessionList
                isOpen={showSessionList}
                onClose={closeSessionList}
                currentSessionId={state.session?.id}
                isStreaming={isStreaming}
              />
            </div>
            {hasSession && (
              <OLButton
                variant="ghost"
                size="sm"
                onClick={reset}
                disabled={isStreaming}
                aria-label={t('new_conversation', 'New conversation')}
              >
                <MaterialIcon type="add" />
              </OLButton>
            )}
          </div>
        </div>

        {/* Awaiting confirmation changes (manual mode) */}
        {!autoAccept && hasAwaitingConfirmation && (
          <PendingChangesList
            changes={state.awaitingConfirmation}
            onAccept={(changeId) => confirmChange(changeId, 'accept')}
            onReject={(changeId) => confirmChange(changeId, 'reject')}
            onAcceptAll={() => confirmAllChanges('accept')}
            onRejectAll={() => confirmAllChanges('reject')}
          />
        )}

        {/* Applied changes notification (auto-accept mode) */}
        {autoAccept && hasAppliedChanges && (
          <AppliedChangesNav
            changes={state.appliedChanges}
            onDismiss={dismissAppliedChange}
            onDismissAll={dismissAllAppliedChanges}
          />
        )}

        {/* Chat messages */}
        <div className="ai-assistant-chat">
          <MessageList
            messages={state.messages}
            activeBlocks={state.activeBlocks}
            childActiveBlocks={state.childActiveBlocks}
            isStreaming={isStreaming}
            streamingPhase={state.streamingPhase}
            activeToolName={state.activeToolName}
            thinkingTopic={state.thinkingTopic}
            streamingError={state.streamingError}
            onRetry={retryFromError}
            onSkillSelect={handleSkillSelect}
            sessionId={state.session?.id}
          />
        </div>

        {/* Input */}
        <ChatInput
          onSendMessage={sendMessage}
          onStopConversation={stopConversation}
          isStreaming={isStreaming || state.status === 'pending'}
          projectId={projectId}
          selectedModelSlot={state.selectedModelSlot}
          onModelSlotChange={setModelSlot}
          availableModelSlots={state.availableModelSlots}
          currentModelSupportsImage={currentModelSupportsImage}
        />
      </div>
    </aside>
  )
})

/**
 * AI Assistant Pane — Provider is now in react-context-root, so this is just the content.
 */
function AIAssistantPane() {
  return <AIAssistantPaneContent />
}

export default withErrorBoundary(AIAssistantPane, () => (
  <AIAssistantFallbackError />
))

/**
 * Indicator component for rail tab
 * Shows badge when there are pending changes
 */
export const AIAssistantIndicator = memo(function AIAssistantIndicator() {
  return null // Indicator logic can be added later if needed
})
