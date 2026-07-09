import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useReducer,
  useMemo,
  useRef,
  FC,
} from 'react'
import { useProjectContext } from '@/shared/context/project-context'
import { useEditorOpenDocContext } from '@/features/ide-react/context/editor-open-doc-context'
import { useFileTreePathContext } from '@/features/file-tree/contexts/file-tree-path'
import getMeta from '@/utils/meta'
import usePersistedState from '@/shared/hooks/use-persisted-state'
import type {
  AIAssistantState,
  AIAssistantAction,
  AIMessage,
  AIEvent,
  ContentBlock,
  ToolCallEntry,
  ToolCallStatus,
  StreamingPhase,
  AttachmentInfo,
  AgentTeamRun,
} from '../types/ai-types'
import * as aiApi from '../api/ai-api'
import type { Reference } from '../components/chat-input/types'
import { useAIStatusUpdater } from './ai-status-context'
import { debugConsole } from '@/utils/debugging'

// ============================================================================
// Initial State
// ============================================================================

const initialState: AIAssistantState = {
  session: null,
  status: 'idle',
  messages: [],
  awaitingConfirmation: [],
  changeHistory: [],
  appliedChanges: [],
  activeBlocks: [],
  childActiveBlocks: {},
  currentMessageId: null,
  error: null,
  streamingError: null,
  initialized: false,
  streamingPhase: null,
  activeToolName: null,
  thinkingTopic: null,
  tokenUsage: null,
  compactionStatus: null,
  selectedModelSlot: null,
  availableModelSlots: [],
  modelSlotsLoaded: false,
  teamRuns: [],
}

// ============================================================================
// Reducer
// ============================================================================

let nextMessageId = 1

function generateMessageId(): string {
  return `ai-msg-${nextMessageId++}`
}

function trimBlocksOnError(blocks: ContentBlock[]): ContentBlock[] {
  return blocks.filter(block => {
    if (block.type === 'thinking') return true
    if (block.type === 'text') return true
    if (block.type === 'tool_call') {
      return block.entry.status !== 'running' && block.entry.status !== 'queued'
    }
    return false
  })
}

/**
 * Append content to the last block of the same type, or push a new block.
 */
function appendOrMergeBlock(
  blocks: ContentBlock[],
  type: 'text' | 'thinking',
  content: string
): ContentBlock[] {
  const updated = [...blocks]
  const lastBlock = updated[updated.length - 1]
  if (lastBlock && lastBlock.type === type) {
    updated[updated.length - 1] = { type, content: lastBlock.content + content }
  } else {
    updated.push({ type, content })
  }
  return updated
}

/**
 * Route a block update to either activeBlocks (main session) or childActiveBlocks[sessionId].
 * Returns a new state with the correct blocks updated.
 */
function routeBlockUpdate(
  state: AIAssistantState,
  sessionId: string | undefined,
  updater: (blocks: ContentBlock[]) => ContentBlock[],
  extraMainState?: Partial<AIAssistantState>
): AIAssistantState {
  const isMainSession = !sessionId || sessionId === state.session?.id
  if (isMainSession) {
    return {
      ...state,
      activeBlocks: updater(state.activeBlocks),
      ...extraMainState,
    }
  }
  return {
    ...state,
    childActiveBlocks: {
      ...state.childActiveBlocks,
      [sessionId!]: updater(state.childActiveBlocks[sessionId!] || []),
    },
  }
}

function compareTeamRuns(a: AgentTeamRun, b: AgentTeamRun): number {
  const aStarted = a.team.startedAt ?? 0
  const bStarted = b.team.startedAt ?? 0
  if (aStarted !== bStarted) {
    return bStarted - aStarted
  }
  return a.team.id.localeCompare(b.team.id)
}

function aiAssistantReducer(
  state: AIAssistantState,
  action: AIAssistantAction
): AIAssistantState {
  switch (action.type) {
    case 'INIT_START':
      return {
        ...state,
        status: 'pending',
      }

    case 'INIT_SUCCESS':
      return {
        ...initialState,
        status: 'idle',
        session: action.session,
        messages: action.session.messages || [],
        changeHistory: action.session.changeHistory || [],
        initialized: true,
        // Preserve model slot state across session switches
        selectedModelSlot: state.selectedModelSlot,
        availableModelSlots: state.availableModelSlots,
        modelSlotsLoaded: state.modelSlotsLoaded,
        teamRuns: [],
      }

    case 'INIT_FAILURE':
      return {
        ...state,
        status: 'error',
        error: action.error,
        initialized: true,
      }

    case 'CREATE_SESSION_START':
      return {
        ...state,
        status: 'pending',
      }

    case 'CREATE_SESSION_SUCCESS':
      return {
        ...state,
        status: 'idle',
        session: action.session,
        messages: [],
        awaitingConfirmation: [],
        changeHistory: [],
        appliedChanges: [],
        activeBlocks: [],
        childActiveBlocks: {},
        currentMessageId: null,
        error: null,
        initialized: true,
        tokenUsage: null,
        compactionStatus: null,
        teamRuns: [],
      }

    case 'CREATE_SESSION_FAILURE':
      return {
        ...state,
        status: 'error',
        error: action.error,
      }

    case 'DELETE_SESSION':
      return {
        ...initialState,
        initialized: true,
        // Preserve model slot state across session deletion
        selectedModelSlot: state.selectedModelSlot,
        availableModelSlots: state.availableModelSlots,
        modelSlotsLoaded: state.modelSlotsLoaded,
        teamRuns: [],
      }

    case 'RENAME_SESSION':
      return {
        ...state,
        session: state.session
          ? { ...state.session, title: action.title }
          : null,
      }

    case 'SEND_MESSAGE_START': {
      const userMessage: AIMessage = {
        id: action.messageId,
        role: 'user',
        content: action.content,
        timestamp: Date.now(),
        pending: true,
        attachments: action.attachments,
      }
      // When a skill is pre-activated, inject a synthetic completed activate_skill
      // tool_call block so the user immediately sees visual feedback.
      const initialBlocks: ContentBlock[] = []
      if (action.skill) {
        initialBlocks.push({
          type: 'tool_call',
          entry: {
            id: `synthetic-skill-${action.skill}`,
            tool: 'activate_skill',
            arguments: { name: action.skill },
            status: 'completed' as ToolCallStatus,
            result: { output: `技能「${action.skill}」已加载` },
          },
        })
      }
      return {
        ...state,
        status: 'streaming',
        messages: [...state.messages, userMessage],
        activeBlocks: initialBlocks,
        childActiveBlocks: {},
        currentMessageId: null,
        error: null,
        streamingError: null,
        streamingPhase: null,
        activeToolName: null,
        thinkingTopic: null,
        appliedChanges: [],
      }
    }

    case 'RECEIVE_THINKING_CHUNK': {
      if (!action.content) return state

      const blocks = appendOrMergeBlock(
        state.activeBlocks,
        'thinking',
        action.content
      )
      // Extract topic from beginning of reasoning text: **Topic**
      const accumulated = blocks.filter(b => b.type === 'thinking').pop()?.content || ''
      const topicMatch = accumulated.trimStart().match(/^\*\*(.+?)\*\*/)
      const topic = topicMatch ? topicMatch[1].trim() : null

      return routeBlockUpdate(
        state,
        action.sessionId,
        childBlocks => appendOrMergeBlock(childBlocks, 'thinking', action.content),
        {
          activeBlocks: blocks,
          currentMessageId: action.messageId,
          streamingPhase: 'thinking',
          thinkingTopic: topic,
        }
      )
    }

    case 'RECEIVE_TEXT_CHUNK': {
      if (!action.content) return state

      return routeBlockUpdate(
        state,
        action.sessionId,
        blocks => appendOrMergeBlock(blocks, 'text', action.content),
        {
          currentMessageId: action.messageId,
          streamingPhase: 'replying' as StreamingPhase,
        }
      )
    }

    case 'CHILD_SESSION_INIT': {
      // Associate childSessionId with the last running delegate_task entry
      const updatedBlocks = state.activeBlocks.map(block => {
        if (
          block.type === 'tool_call' &&
          block.entry.tool === 'delegate_task' &&
          block.entry.status === 'running' &&
          !block.entry.childSessionId
        ) {
          return {
            ...block,
            entry: { ...block.entry, childSessionId: action.childSessionId },
          }
        }
        return block
      })
      return { ...state, activeBlocks: updatedBlocks }
    }

    case 'RECEIVE_TOOL_CALL': {
      let args: Record<string, unknown> = {}
      try {
        const rawArgs = action.toolCall.function?.arguments || (action.toolCall as any).arguments || '{}'
        args = typeof rawArgs === 'string' ? JSON.parse(rawArgs) : rawArgs
      } catch {
        // If arguments parsing fails, use empty object
      }
      const entry: ToolCallEntry = {
        id: action.toolCall.id,
        tool: action.toolCall.function?.name || (action.toolCall as any).name || 'unknown',
        arguments: args,
        status: action.queued ? 'queued' as const : 'running' as const,
      }

      return routeBlockUpdate(
        state,
        action.sessionId,
        blocks => [...blocks, { type: 'tool_call' as const, entry }],
        action.queued ? {} : {
          streamingPhase: 'tool_running' as StreamingPhase,
          activeToolName: entry.tool,
        }
      )
    }

    case 'TOOL_CALL_START': {
      const updateStatus = (blocks: ContentBlock[]): ContentBlock[] =>
        blocks.map(block => {
          if (block.type === 'tool_call' && block.entry.id === action.toolCallId && block.entry.status === 'queued') {
            return { ...block, entry: { ...block.entry, status: 'running' as ToolCallStatus } }
          }
          return block
        })
      const startingTool = state.activeBlocks.find(
        (b): b is ContentBlock & { type: 'tool_call' } =>
          b.type === 'tool_call' && b.entry.id === action.toolCallId
      )
      return routeBlockUpdate(state, action.sessionId, updateStatus, {
        streamingPhase: 'tool_running' as StreamingPhase,
        activeToolName: startingTool?.entry?.tool || null,
      })
    }

    case 'RECEIVE_TOOL_RESULT': {
      const updateToolResultBlock = (blocks: ContentBlock[]): ContentBlock[] =>
        blocks.map(block => {
          if (block.type === 'tool_call' && block.entry.id === action.toolResult.toolCallId) {
            const updatedEntry = {
              ...block.entry,
              status: (action.toolResult.isError ? 'error' : 'completed') as ToolCallStatus,
              result: {
                output: action.toolResult.content,
                data: action.toolResult.data,
                error: action.toolResult.isError ? action.toolResult.content : undefined,
              },
            }
            // If this is a delegate_task result with childSessionId, attach it
            if (updatedEntry.tool === 'delegate_task' && action.toolResult.data?.childSessionId) {
              updatedEntry.childSessionId = action.toolResult.data.childSessionId as string
            }
            return { ...block, entry: updatedEntry }
          }
          return block
        })

      return routeBlockUpdate(
        state,
        action.sessionId,
        updateToolResultBlock,
        {
          streamingPhase: 'replying' as StreamingPhase,
          activeToolName: null,
        }
      )
    }

    case 'AWAITING_CONFIRMATION':
      return {
        ...state,
        awaitingConfirmation: [...state.awaitingConfirmation, action.change],
      }

    case 'CHANGE_CONFIRMED': {
      const confirmedChange = state.awaitingConfirmation.find(c => c.id === action.changeId)
      const isAccepted = action.action === 'accept'
      const confirmedBy = action.source ?? 'sse'
      return {
        ...state,
        awaitingConfirmation: state.awaitingConfirmation.filter(c => c.id !== action.changeId),
        changeHistory: confirmedChange
          ? [...state.changeHistory, {
              ...confirmedChange,
              status: isAccepted ? 'accepted' as const : 'rejected' as const,
              confirmedBy,
            }]
          : state.changeHistory,
        appliedChanges: confirmedChange && isAccepted
          ? [...state.appliedChanges, {
              ...confirmedChange,
              status: 'accepted' as const,
              confirmedBy,
              // Remap position.end to reflect the NEW text range in the document.
              // The original position covers the old text [start, start+oldText.length),
              // but after the edit is applied the document contains the new text at
              // [start, start+newText.length).
              ...(confirmedChange.position && confirmedChange.newText != null
                ? { position: { start: confirmedChange.position.start, end: confirmedChange.position.start + confirmedChange.newText.length } }
                : {}),
            }]
          : state.appliedChanges,
      }
    }

    case 'CHANGE_CONFLICT': {
      const conflictedChange = state.awaitingConfirmation.find(c => c.id === action.changeId)
      return {
        ...state,
        awaitingConfirmation: state.awaitingConfirmation.filter(c => c.id !== action.changeId),
        changeHistory: conflictedChange
          ? [...state.changeHistory, {
              ...conflictedChange,
              status: 'conflict' as const,
            }]
          : state.changeHistory,
      }
    }

    case 'MARK_CHANGES_STALE': {
      const staleSet = new Set(action.staleIds)
      const updated = state.awaitingConfirmation.map(c =>
        staleSet.has(c.id) && !c.stale ? { ...c, stale: true } : c
      )
      // Only update if something actually changed
      if (updated.every((c, i) => c === state.awaitingConfirmation[i])) {
        return state
      }
      return { ...state, awaitingConfirmation: updated }
    }

    case 'DISMISS_APPLIED_CHANGE':
      return {
        ...state,
        appliedChanges: state.appliedChanges.filter(c => c.id !== action.changeId),
      }

    case 'DISMISS_ALL_APPLIED_CHANGES':
      return {
        ...state,
        appliedChanges: [],
      }

    case 'MESSAGE_COMPLETE': {
      // Confirm user message (remove pending flag) and add assistant message
      const confirmedMessages = state.messages.map(msg =>
        msg.pending ? { ...msg, pending: false } : msg
      )
      const fullContent = state.activeBlocks
        .filter(b => b.type === 'text')
        .map(b => b.content)
        .join('')
      const hasChildParts = Object.keys(state.childActiveBlocks).length > 0
      const messageWithBlocks: AIMessage = {
        ...action.message,
        content: fullContent || action.message.content,
        contentBlocks: state.activeBlocks.length > 0 ? [...state.activeBlocks] : undefined,
        childSessionParts: hasChildParts ? { ...state.childActiveBlocks } : undefined,
      }
      return {
        ...state,
        status: 'idle',
        messages: [...confirmedMessages, messageWithBlocks],
        activeBlocks: [],
        childActiveBlocks: {},
        currentMessageId: null,
        streamingError: null,
        streamingPhase: null,
        activeToolName: null,
        thinkingTopic: null,
      }
    }

    case 'SET_ERROR':
      return {
        ...state,
        status: 'error',
        error: action.error,
      }

    case 'CLEAR_ERROR':
      return {
        ...state,
        status: state.session ? 'idle' : 'idle',
        error: null,
        streamingError: null,
      }

    case 'STREAMING_ERROR': {
      return {
        ...state,
        status: 'idle',
        activeBlocks: trimBlocksOnError(state.activeBlocks),
        childActiveBlocks: {},
        streamingError: action.error,
        streamingPhase: null,
        activeToolName: null,
        thinkingTopic: null,
      }
    }

    case 'RETRY_START': {
      return {
        ...state,
        status: 'streaming',
        streamingError: null,
        childActiveBlocks: {},
      }
    }

    case 'UPDATE_TOKEN_USAGE':
      return {
        ...state,
        tokenUsage: {
          promptTokens: action.usage.prompt_tokens,
          completionTokens: action.usage.completion_tokens,
          totalTokens: action.usage.total_tokens,
          contextWindow: action.compaction.contextWindow,
          threshold: action.compaction.threshold,
        },
      }

    case 'COMPACTION_START':
      return { ...state, compactionStatus: 'compacting' as const }

    case 'COMPACTION_DONE':
      return {
        ...state,
        compactionStatus: 'idle' as const,
        ...(action.success && { tokenUsage: null }),
      }

    case 'RESET':
      return {
        ...initialState,
        // Preserve model slot state across conversation reset
        selectedModelSlot: state.selectedModelSlot,
        availableModelSlots: state.availableModelSlots,
        modelSlotsLoaded: state.modelSlotsLoaded,
      }

    case 'STOP_CONVERSATION': {
      // Build interrupted message from activeBlocks content accumulated so far
      const confirmedMsgs = state.messages.map(msg =>
        msg.pending ? { ...msg, pending: false } : msg
      )
      const textContent = state.activeBlocks
        .filter(b => b.type === 'text')
        .map(b => b.content)
        .join('')

      // Mark all running/queued tool_call entries as interrupted
      const interruptBlocks = (blocks: ContentBlock[]): ContentBlock[] =>
        blocks.map(block => {
          if (block.type === 'tool_call' && (block.entry.status === 'running' || block.entry.status === 'queued')) {
            return { ...block, entry: { ...block.entry, status: 'interrupted' as ToolCallStatus } }
          }
          return block
        })

      const finalBlocks = interruptBlocks(state.activeBlocks)
      const finalChildBlocks: Record<string, ContentBlock[]> = {}
      for (const [sid, blocks] of Object.entries(state.childActiveBlocks)) {
        finalChildBlocks[sid] = interruptBlocks(blocks)
      }
      const hasChildContent = Object.keys(finalChildBlocks).length > 0

      if (finalBlocks.length > 0) {
        const interruptedMessage: AIMessage = {
          id: state.currentMessageId || `interrupted-${Date.now()}`,
          role: 'assistant',
          content: textContent,
          timestamp: Date.now(),
          contentBlocks: finalBlocks,
          childSessionParts: hasChildContent ? finalChildBlocks : undefined,
          interrupted: true,
        }
        return {
          ...state,
          status: 'idle',
          messages: [...confirmedMsgs, interruptedMessage],
          activeBlocks: [],
          childActiveBlocks: {},
          currentMessageId: null,
          streamingPhase: null,
          activeToolName: null,
          thinkingTopic: null,
        }
      }
      // No active content yet — just reset streaming state
      return {
        ...state,
        status: 'idle',
        messages: confirmedMsgs,
        activeBlocks: [],
        childActiveBlocks: {},
        currentMessageId: null,
        streamingPhase: null,
        activeToolName: null,
        thinkingTopic: null,
      }
    }

    case 'SET_MODEL_SLOT':
      return { ...state, selectedModelSlot: action.slug }

    case 'SET_AVAILABLE_MODEL_SLOTS':
      return { ...state, availableModelSlots: action.slots, modelSlotsLoaded: true }

    case 'SET_TEAM_RUNS':
      return { ...state, teamRuns: action.teamRuns }

    case 'UPSERT_TEAM_RUN': {
      const nextTeamRuns = state.teamRuns.filter(
        item => item.team.id !== action.teamRun.team.id
      )
      nextTeamRuns.push(action.teamRun)
      return {
        ...state,
        teamRuns: nextTeamRuns.sort(compareTeamRuns),
      }
    }

    default:
      throw new Error(`Unknown action type`)
  }
}

// ============================================================================
// Context Type
// ============================================================================

interface AIAssistantContextValue {
  state: AIAssistantState
  // Session actions
  createSession: () => Promise<void>
  deleteSession: () => Promise<void>
  switchSession: (sessionId: string) => Promise<void>
  renameSession: (title: string) => Promise<void>
  // Message actions
  sendMessage: (content: string, references?: Reference[], skill?: string, pendingAttachments?: AttachmentInfo[]) => Promise<void>
  retryFromError: () => Promise<void>
  stopConversation: () => Promise<void>
  // Change confirmation (synchronous edit flow)
  confirmChange: (changeId: string, action: 'accept' | 'reject', reason?: string) => Promise<void>
  confirmAllChanges: (action: 'accept' | 'reject') => Promise<void>
  // Applied changes (auto-accept mode)
  dismissAppliedChange: (changeId: string) => void
  dismissAllAppliedChanges: () => void
  // Stale detection (from CodeMirror)
  markChangesStale: (staleIds: string[]) => void
  // UI helpers
  reset: () => void
  clearError: () => void
  // Auto-accept mode
  autoAccept: boolean
  setAutoAccept: (value: boolean) => void
  // Context compaction
  compactSession: () => Promise<void>
  refreshTeamRun: () => Promise<void>
  cancelTeamRun: (teamId: string) => Promise<void>
  retryTeamRunTask: (teamId: string, taskId: string) => Promise<void>
  // Model selection
  setModelSlot: (slug: string) => void
  currentModelSupportsImage: boolean
  // Derived state
  isStreaming: boolean
  hasSession: boolean
  hasAwaitingConfirmation: boolean
  hasAppliedChanges: boolean
}

export const AIAssistantContext = createContext<
  AIAssistantContextValue | undefined
>(undefined)

// ============================================================================
// Provider Component
// ============================================================================

export const AIAssistantProvider: FC<React.PropsWithChildren> = ({
  children,
}) => {
  const aiEnabled =
    getMeta('ol-capabilities')?.includes('ai-assistant') ?? false
  const { projectId, project } = useProjectContext()

  // Get current document context for tool execution
  const { currentDocumentId } = useEditorOpenDocContext()
  const { pathInFolder } = useFileTreePathContext()

  // Compute current document path from ID
  const currentDocPath = useMemo(() => {
    if (!currentDocumentId) return null
    return pathInFolder(currentDocumentId)
  }, [currentDocumentId, pathInFolder])

  const [state, dispatch] = useReducer(aiAssistantReducer, initialState)
  const abortControllerRef = useRef<AbortController | null>(null)

  // Fallback timers for confirmChange: if SSE event is not received within
  // 15 seconds after a successful HTTP confirmation, dispatch locally to
  // prevent the UI from being stuck in awaitingConfirmation indefinitely.
  const confirmFallbackTimers = useRef<Map<string, { timer: ReturnType<typeof setTimeout>; action: 'accept' | 'reject' }>>(new Map())

  // Track the active session ID via ref so async stream loops can detect
  // stale events after the user switches sessions.
  const activeSessionIdRef = useRef<string | null>(null)
  useEffect(() => {
    activeSessionIdRef.current = state.session?.id ?? null
  }, [state.session?.id])

  const hydratedUrlSessionRef = useRef<string | null>(null)

  // Auto-accept: persisted user preference
  const [autoAccept, setAutoAccept] = usePersistedState<boolean>(
    'ai-auto-accept',
    false
  )
  // Ref bridge: let async closures (sendMessage/retryFromError) read latest value
  const autoAcceptRef = useRef(autoAccept)
  useEffect(() => {
    autoAcceptRef.current = autoAccept
  }, [autoAccept])

  // Model slot: persisted user preference
  const [persistedModelSlot, setPersistedModelSlot] = usePersistedState<string | null>(
    'ai-selected-model-slot',
    null
  )
  const selectedModelSlotRef = useRef(state.selectedModelSlot)
  useEffect(() => {
    selectedModelSlotRef.current = state.selectedModelSlot
  }, [state.selectedModelSlot])

  // Load model slots on mount
  useEffect(() => {
    if (!aiEnabled) return
    let cancelled = false
    Promise.all([aiApi.getModelSlots(), aiApi.getDefaultSlot()])
      .then(([slots, defaultSlot]) => {
        if (cancelled) return
        dispatch({ type: 'SET_AVAILABLE_MODEL_SLOTS', slots })
        const valid = slots.some(s => s.slug === persistedModelSlot)
        const effectiveSlot = valid ? persistedModelSlot : (defaultSlot ?? slots[0]?.slug ?? null)
        dispatch({ type: 'SET_MODEL_SLOT', slug: effectiveSlot })
        if (!valid) setPersistedModelSlot(effectiveSlot)
      })
      .catch(err => debugConsole.warn('Failed to load model slots', err))
    return () => { cancelled = true }
  }, [aiEnabled]) // eslint-disable-line react-hooks/exhaustive-deps

  // Cleanup on unmount
  useEffect(() => {
    const fallbackTimers = confirmFallbackTimers.current
    return () => {
      abortControllerRef.current?.abort()
      // Clear all pending fallback timers
      for (const { timer } of fallbackTimers.values()) {
        clearTimeout(timer)
      }
      fallbackTimers.clear()
    }
  }, [])

  // Sync AI status to the lightweight AIStatusContext (always mounted, survives panel unmount)
  const { setStatus: setAIStatus } = useAIStatusUpdater()
  useEffect(() => {
    setAIStatus({ status: state.status, streamingPhase: state.streamingPhase })
  }, [state.status, state.streamingPhase, setAIStatus])

  // Create session
  const createSession = useCallback(async () => {
    if (!aiEnabled) return

    dispatch({ type: 'CREATE_SESSION_START' })
    try {
      const session = await aiApi.createSession(projectId)
      dispatch({ type: 'CREATE_SESSION_SUCCESS', session })
    } catch (error) {
      dispatch({
        type: 'CREATE_SESSION_FAILURE',
        error: error instanceof Error ? error : new Error(String(error)),
      })
    }
  }, [projectId, aiEnabled])

  // Delete session
  const deleteSession = useCallback(async () => {
    const sessionId = state.session?.id
    if (!sessionId) return

    // Abort any ongoing streaming
    abortControllerRef.current?.abort()

    try {
      await aiApi.deleteSession(sessionId)
    } catch {
      // Ignore errors when deleting
    }
    dispatch({ type: 'DELETE_SESSION' })
  }, [state.session?.id])

  // Send message with streaming
  const sendMessage = useCallback(
    async (content: string, references?: Reference[], skill?: string, pendingAttachments?: AttachmentInfo[]) => {
      if (!aiEnabled) return
      if (!content.trim() && !skill && !pendingAttachments?.length) return

      // Reject new messages while streaming to prevent aborting the active stream
      if (state.status === 'streaming') {
        return
      }

      let sessionId = state.session?.id

      // Lazy session creation: create session if none exists
      if (!sessionId) {
        dispatch({ type: 'CREATE_SESSION_START' })
        try {
          const session = await aiApi.createSession(projectId)
          dispatch({ type: 'CREATE_SESSION_SUCCESS', session })
          sessionId = session.id
          // Synchronously update the ref so the SSE loop below sees the
          // correct session ID immediately — useEffect would only run after
          // the next render which may be too late.
          activeSessionIdRef.current = sessionId
        } catch (error) {
          dispatch({
            type: 'CREATE_SESSION_FAILURE',
            error: error instanceof Error ? error : new Error(String(error)),
          })
          return
        }
      }

      // Abort previous stream if still running
      abortControllerRef.current?.abort()
      const abortController = new AbortController()
      abortControllerRef.current = abortController

      // When skill is active with no user text, the LLM still receives the
      // full skill body via ContextManager's synthetic activation messages.
      // We use displayContent for both display AND API so the persisted
      // message matches what the user sees (avoids stale trigger text on
      // session reload).
      const displayContent = skill
        ? `/${skill}${content.trim() ? ' ' + content.trim() : ''}`
        : content

      // Attachments are already uploaded in chat-input — just extract IDs
      const fileIds = pendingAttachments
        ?.filter(a => a.uploadStatus === 'uploaded' || !a.uploadStatus)
        .map(a => a.id)
      // Strip localPreviewUrl (blob URLs) from attachments stored in message state.
      // Message-list will use the server URL /api/ai/files/${att.id} instead,
      // which avoids broken images when blob URLs are revoked on chat-input unmount.
      // Only include successfully uploaded attachments to avoid broken IDs in messages.
      const displayAttachments = pendingAttachments
        ?.filter(a => a.uploadStatus === 'uploaded' || !a.uploadStatus)
        .map(attachment => {
          const { localPreviewUrl: _localPreviewUrl, ...rest } = attachment
          return rest
        })

      const messageId = generateMessageId()
      dispatch({ type: 'SEND_MESSAGE_START', content: displayContent, messageId, skill, attachments: displayAttachments })

      try {
        const context: aiApi.MessageContext = {}
        if (currentDocumentId) {
          context.currentDocId = currentDocumentId
        }
        if (currentDocPath) {
          context.currentDocPath = currentDocPath
        }
        if (project?.rootDocId) {
          context.rootDocId = project.rootDocId
        }
        if (project?.name) {
          context.projectName = project.name
        }
        if (references?.length) {
          context.references = references
        }
        if (skill) {
          context.skill = skill
        }
        if (fileIds?.length) {
          context.fileIds = fileIds
        }

        const stream = aiApi.sendMessage(
          sessionId,
          displayContent,
          context,
          abortController.signal,
          selectedModelSlotRef.current || undefined
        )

        let streamTerminated = false
        for await (const event of stream) {
          if (abortController.signal.aborted) break
          // Ignore events from a stale session after the user switched away
          if (activeSessionIdRef.current !== sessionId) break
          handleStreamEvent(event, dispatch)
          // Clear fallback timer when SSE confirmation/conflict event arrives
          if (event.type === 'change_confirmed' || event.type === 'change_conflict') {
            const evtChangeId = (event as any).changeId as string
            const pending = confirmFallbackTimers.current.get(evtChangeId)
            if (pending) {
              clearTimeout(pending.timer)
              confirmFallbackTimers.current.delete(evtChangeId)
            }
          }
          if (event.type === 'message_complete' || event.type === 'conversation_stopped' || event.type === 'error') {
            streamTerminated = true
          }
          // Auto-accept: immediately confirm awaiting_confirmation events
          if (event.type === 'awaiting_confirmation' && autoAcceptRef.current) {
            const changeId = (event as any).change.id
            aiApi.confirmChange(sessionId!, changeId, 'accept')
              .catch(() => {
                // Best effort — if it fails, user can manually confirm
              })
          }
        }

        // Fallback: if stream ended without a terminal event (e.g. network
        // interruption where the connection closes cleanly), reset UI state
        // so it does not stay stuck in "streaming".
        if (!streamTerminated && !abortController.signal.aborted) {
          dispatch({ type: 'STOP_CONVERSATION' })
        }
      } catch (error) {
        if (abortController.signal.aborted) return
        dispatch({
          type: 'STREAMING_ERROR',
          error: error instanceof Error ? error : new Error(String(error)),
        })
      }
    },
    [state.session?.id, state.status, projectId, aiEnabled, currentDocumentId, currentDocPath, project]
  )

  // Retry from streaming error
  const retryFromError = useCallback(async () => {
    const sessionId = state.session?.id
    if (!sessionId) return

    abortControllerRef.current?.abort()
    const abortController = new AbortController()
    abortControllerRef.current = abortController

    dispatch({ type: 'RETRY_START' })

    try {
      const context: aiApi.MessageContext = {}
      if (currentDocumentId) context.currentDocId = currentDocumentId
      if (currentDocPath) context.currentDocPath = currentDocPath
      if (project?.rootDocId) context.rootDocId = project.rootDocId
      if (project?.name) context.projectName = project.name

      const stream = aiApi.resumeMessage(
        sessionId,
        context,
        abortController.signal,
        selectedModelSlotRef.current || undefined
      )

      let streamTerminated = false
      for await (const event of stream) {
        if (abortController.signal.aborted) break
        // Ignore events from a stale session after the user switched away
        if (activeSessionIdRef.current !== sessionId) break
        handleStreamEvent(event, dispatch)
        // Clear fallback timer when SSE confirmation/conflict event arrives
        if (event.type === 'change_confirmed' || event.type === 'change_conflict') {
          const evtChangeId = (event as any).changeId as string
          const pending = confirmFallbackTimers.current.get(evtChangeId)
          if (pending) {
            clearTimeout(pending.timer)
            confirmFallbackTimers.current.delete(evtChangeId)
          }
        }
        if (event.type === 'message_complete' || event.type === 'conversation_stopped' || event.type === 'error') {
          streamTerminated = true
        }
        // Auto-accept: immediately confirm awaiting_confirmation events
        if (event.type === 'awaiting_confirmation' && autoAcceptRef.current) {
          const changeId = (event as any).change.id
          aiApi.confirmChange(sessionId!, changeId, 'accept')
            .catch(() => {
              // Best effort
            })
        }
      }

      // Fallback: if stream ended without a terminal event, reset UI state
      if (!streamTerminated && !abortController.signal.aborted) {
        dispatch({ type: 'STOP_CONVERSATION' })
      }
    } catch (error) {
      if (abortController.signal.aborted) return
      dispatch({
        type: 'STREAMING_ERROR',
        error: error instanceof Error ? error : new Error(String(error)),
      })
    }
  }, [state.session?.id, currentDocumentId, currentDocPath, project])

  // Confirm or reject a change (synchronous edit flow)
  const confirmChange = useCallback(
    async (changeId: string, action: 'accept' | 'reject', reason?: string) => {
      const sessionId = state.session?.id
      if (!sessionId) return

      try {
        await aiApi.confirmChange(sessionId, changeId, action, reason)
        // Do NOT dispatch CHANGE_CONFIRMED here — let the SSE
        // change_confirmed or change_conflict event drive state updates.
        // Dispatching eagerly would remove the change from awaitingConfirmation
        // before a potential change_conflict event arrives, losing the conflict.

        // Fallback: if SSE confirmation is not received within 15 seconds
        // (e.g. SSE disconnected or event lost), dispatch locally so the UI
        // does not stay stuck in awaitingConfirmation indefinitely.
        const fallbackTimer = setTimeout(() => {
          confirmFallbackTimers.current.delete(changeId)
          dispatch({ type: 'CHANGE_CONFIRMED', changeId, action, source: 'fallback' })
        }, 15_000)
        confirmFallbackTimers.current.set(changeId, { timer: fallbackTimer, action })
      } catch (error) {
        dispatch({
          type: 'SET_ERROR',
          error: error instanceof Error ? error : new Error(String(error)),
        })
      }
    },
    [state.session?.id]
  )

  // Confirm or reject all awaiting changes at once
  const confirmAllChanges = useCallback(
    async (action: 'accept' | 'reject') => {
      const sessionId = state.session?.id
      if (!sessionId) return

      // When accepting, skip stale changes (they can't be applied safely)
      const eligible = action === 'accept'
        ? state.awaitingConfirmation.filter(c => !c.stale)
        : state.awaitingConfirmation
      const changeIds = eligible.map(c => c.id)
      await Promise.all(
        changeIds.map(id =>
          aiApi.confirmChange(sessionId, id, action)
            .catch(() => {
              // Best effort per change
            })
        )
      )
    },
    [state.session?.id, state.awaitingConfirmation]
  )

  // Dismiss applied changes (auto-accept mode)
  const dismissAppliedChange = useCallback(
    (changeId: string) => dispatch({ type: 'DISMISS_APPLIED_CHANGE', changeId }),
    []
  )

  const dismissAllAppliedChanges = useCallback(
    () => dispatch({ type: 'DISMISS_ALL_APPLIED_CHANGES' }),
    []
  )

  // Mark changes as stale (from CodeMirror stale detection)
  const markChangesStale = useCallback(
    (staleIds: string[]) => dispatch({ type: 'MARK_CHANGES_STALE', staleIds }),
    []
  )

  // Reset
  const reset = useCallback(async () => {
    abortControllerRef.current?.abort()
    dispatch({ type: 'RESET' })
  }, [])

  // Switch session
  const switchSession = useCallback(
    async (sessionId: string) => {
      // Abort in-progress stream
      abortControllerRef.current?.abort()

      // Load target session
      dispatch({ type: 'INIT_START' })
      try {
        const session = await aiApi.getSession(sessionId)
        dispatch({ type: 'INIT_SUCCESS', session })
      } catch (error) {
        dispatch({
          type: 'INIT_FAILURE',
          error: error instanceof Error ? error : new Error(String(error)),
        })
      }
    },
    []
  )

  useEffect(() => {
    if (!aiEnabled || typeof window === 'undefined') return

    const sessionId = new URLSearchParams(window.location.search).get('aiSession')
    if (!sessionId || hydratedUrlSessionRef.current === sessionId) return
    if (state.session?.id === sessionId) return

    hydratedUrlSessionRef.current = sessionId
    switchSession(sessionId)
  }, [aiEnabled, state.session?.id, switchSession])

  const refreshTeamRun = useCallback(async () => {
    const sessionId = state.session?.id
    if (!sessionId) {
      dispatch({ type: 'SET_TEAM_RUNS', teamRuns: [] })
      return
    }

    try {
      const summaries = await aiApi.listTeamRuns(sessionId)
      const teamRuns = await Promise.all(
        summaries.map(summary => aiApi.getTeamRun(sessionId, summary.id))
      )
      dispatch({ type: 'SET_TEAM_RUNS', teamRuns: teamRuns.sort(compareTeamRuns) })
    } catch {
      dispatch({ type: 'SET_TEAM_RUNS', teamRuns: [] })
    }
  }, [state.session?.id])

  useEffect(() => {
    if (!aiEnabled) return
    refreshTeamRun()
  }, [aiEnabled, state.session?.id, state.session?.activeHandoff?.teamId, refreshTeamRun])

  const cancelTeamRun = useCallback(async (teamId: string) => {
    const session = state.session
    if (!session?.id || !teamId) return

    const teamRun = await aiApi.cancelTeamRun(session.id, teamId)
    dispatch({ type: 'UPSERT_TEAM_RUN', teamRun })
  }, [state.session])

  const retryTeamRunTask = useCallback(async (teamId: string, taskId: string) => {
    const sessionId = state.session?.id
    if (!sessionId) return

    const response = await aiApi.retryTeamRunTask(sessionId, teamId, taskId)
    dispatch({ type: 'UPSERT_TEAM_RUN', teamRun: response.teamRun })
  }, [state.session?.id])

  // Rename session
  const renameSession = useCallback(
    async (title: string) => {
      const sessionId = state.session?.id
      if (!sessionId || !title.trim()) return

      try {
        const newTitle = await aiApi.updateSession(sessionId, title.trim())
        dispatch({ type: 'RENAME_SESSION', title: newTitle })
      } catch (error) {
        dispatch({
          type: 'SET_ERROR',
          error: error instanceof Error ? error : new Error(String(error)),
        })
      }
    },
    [state.session?.id]
  )

  // Manual context compaction
  const compactSession = useCallback(async () => {
    const sessionId = state.session?.id
    if (!sessionId) return

    dispatch({ type: 'COMPACTION_START' })
    try {
      const result = await aiApi.compactSession(sessionId)
      dispatch({ type: 'COMPACTION_DONE', success: result.success })
      if (result.success && result.summary) {
        dispatch({
          type: 'MESSAGE_COMPLETE',
          message: {
            id: `compaction-${Date.now()}`,
            role: 'assistant',
            content: result.summary,
            isCompaction: true,
            timestamp: Date.now(),
          },
        })
      }
    } catch {
      dispatch({ type: 'COMPACTION_DONE', success: false })
    }
  }, [state.session?.id])

  // Stop conversation
  const stopConversation = useCallback(async () => {
    const sessionId = state.session?.id
    if (!sessionId || state.status !== 'streaming') return

    // Snapshot and temporarily disable auto-accept to prevent
    // any in-flight confirmations from being auto-accepted after stop.
    // Restore the original value after the stop sequence completes.
    const savedAutoAccept = autoAcceptRef.current
    autoAcceptRef.current = false

    // Dispatch first to update UI synchronously
    dispatch({ type: 'STOP_CONVERSATION' })

    // Abort the SSE fetch
    abortControllerRef.current?.abort()

    // Notify backend (best-effort)
    try {
      await aiApi.stopSession(sessionId)
    } catch {
      // Ignore — loop may have already ended
    }

    // Restore auto-accept preference
    autoAcceptRef.current = savedAutoAccept
  }, [state.session?.id, state.status])

  // Clear error
  const clearError = useCallback(() => {
    dispatch({ type: 'CLEAR_ERROR' })
  }, [])

  // Model slot management
  const setModelSlot = useCallback((slug: string) => {
    dispatch({ type: 'SET_MODEL_SLOT', slug })
    setPersistedModelSlot(slug)
  }, [setPersistedModelSlot])

  const currentModelSupportsImage = useMemo(() => {
    const slot = state.availableModelSlots.find(s => s.slug === state.selectedModelSlot)
    return slot?.supportsImage ?? true // default to supporting images if not loaded
  }, [state.availableModelSlots, state.selectedModelSlot])

  const value = useMemo(
    () => ({
      state,
      createSession,
      deleteSession,
      switchSession,
      renameSession,
      sendMessage,
      retryFromError,
      stopConversation,
      confirmChange,
      confirmAllChanges,
      dismissAppliedChange,
      dismissAllAppliedChanges,
      markChangesStale,
      reset,
      clearError,
      autoAccept,
      setAutoAccept,
      compactSession,
      refreshTeamRun,
      cancelTeamRun,
      retryTeamRunTask,
      setModelSlot,
      currentModelSupportsImage,
      isStreaming: state.status === 'streaming',
      hasSession: state.session !== null,
      hasAwaitingConfirmation: state.awaitingConfirmation.length > 0,
      hasAppliedChanges: state.appliedChanges.length > 0,
    }),
    [
      state,
      createSession,
      deleteSession,
      switchSession,
      renameSession,
      sendMessage,
      retryFromError,
      stopConversation,
      confirmChange,
      confirmAllChanges,
      dismissAppliedChange,
      dismissAllAppliedChanges,
      markChangesStale,
      reset,
      clearError,
      autoAccept,
      setAutoAccept,
      compactSession,
      refreshTeamRun,
      cancelTeamRun,
      retryTeamRunTask,
      setModelSlot,
      currentModelSupportsImage,
    ]
  )

  if (!aiEnabled) {
    return <>{children}</>
  }

  return (
    <AIAssistantContext.Provider value={value}>
      {children}
    </AIAssistantContext.Provider>
  )
}

// ============================================================================
// Hook
// ============================================================================

export function useAIAssistantContext(): AIAssistantContextValue {
  const context = useContext(AIAssistantContext)
  if (!context) {
    throw new Error(
      'useAIAssistantContext is only available inside AIAssistantProvider'
    )
  }
  return context
}

// ============================================================================
// Stream Event Handler
// ============================================================================

function handleStreamEvent(
  event: AIEvent,
  dispatch: React.Dispatch<AIAssistantAction>
) {
  const sessionId = (event as any).sessionId as string | undefined

  switch (event.type) {
    case 'thinking_chunk':
      dispatch({
        type: 'RECEIVE_THINKING_CHUNK',
        content: (event as any).content,
        messageId: (event as any).messageId,
        sessionId,
      })
      break

    case 'text_chunk':
      dispatch({
        type: 'RECEIVE_TEXT_CHUNK',
        content: event.content,
        messageId: event.messageId,
        sessionId,
      })
      break

    case 'tool_call':
      dispatch({
        type: 'RECEIVE_TOOL_CALL',
        toolCall: event.toolCall,
        messageId: event.messageId,
        sessionId,
        queued: (event as any).queued || false,
      })
      break

    case 'tool_call_start':
      dispatch({
        type: 'TOOL_CALL_START',
        toolCallId: (event as any).toolCallId,
        sessionId,
      })
      break

    case 'tool_result':
      dispatch({
        type: 'RECEIVE_TOOL_RESULT',
        toolResult: {
          toolCallId: (event as any).toolResult?.toolCallId || '',
          content: (event as any).toolResult?.output || (event as any).toolResult?.content || '',
          isError: !(event as any).toolResult?.success,
          data: (event as any).toolResult?.data,
        },
        messageId: event.messageId,
        sessionId,
      })
      break

    case 'child_session_init':
      dispatch({
        type: 'CHILD_SESSION_INIT',
        childSessionId: (event as any).childSessionId,
        agentName: (event as any).agentName,
      })
      break

    case 'pending_change':
      // Legacy event — ignored in synchronous edit flow
      break

    case 'awaiting_confirmation':
      dispatch({
        type: 'AWAITING_CONFIRMATION',
        change: (event as any).change,
      })
      break

    case 'change_confirmed':
      dispatch({
        type: 'CHANGE_CONFIRMED',
        changeId: (event as any).changeId,
        action: (event as any).action,
        source: 'sse',
      })
      break

    case 'change_conflict':
      dispatch({
        type: 'CHANGE_CONFLICT',
        changeId: (event as any).changeId,
        conflictType: (event as any).conflictType,
        message: (event as any).message,
      })
      break

    case 'message_complete':
      dispatch({
        type: 'MESSAGE_COMPLETE',
        message: event.message,
      })
      // Update token usage if available
      if ((event as any).usage) {
        dispatch({
          type: 'UPDATE_TOKEN_USAGE',
          usage: (event as any).usage,
          compaction: (event as any).compaction || { contextWindow: 131072, threshold: 0.7 },
        })
      }
      break

    case 'conversation_stopped':
      dispatch({
        type: 'MESSAGE_COMPLETE',
        message: { ...(event as any).message, interrupted: true },
      })
      // Update token usage if available
      if ((event as any).usage) {
        dispatch({
          type: 'UPDATE_TOKEN_USAGE',
          usage: (event as any).usage,
          compaction: (event as any).compaction || { contextWindow: 131072, threshold: 0.7 },
        })
      }
      break

    case 'compaction_start':
      dispatch({ type: 'COMPACTION_START' })
      break

    case 'compaction_done':
      dispatch({ type: 'COMPACTION_DONE', success: (event as any).success })
      break

    case 'error':
      dispatch({
        type: 'STREAMING_ERROR',
        error: new Error(event.error.message),
      })
      break

    case 'done':
      // Stream complete, no action needed
      break
  }
}
