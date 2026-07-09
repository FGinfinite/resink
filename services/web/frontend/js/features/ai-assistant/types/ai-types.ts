/**
 * AI Assistant TypeScript Type Definitions
 * Aligned with backend API from services/ai-writing-agent
 */

// ============================================================================
// Tool Types
// ============================================================================

export interface ToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string // JSON string
  }
}

export interface ToolResult {
  toolCallId: string
  content: string
  isError?: boolean
  data?: Record<string, unknown>
}

// ============================================================================
// Tool Call Display Types
// ============================================================================

export type ToolCallStatus = 'queued' | 'running' | 'completed' | 'error' | 'interrupted'

export interface ToolCallEntry {
  id: string
  tool: string
  arguments: Record<string, unknown>
  status: ToolCallStatus
  result?: {
    output?: string
    data?: Record<string, unknown>
    error?: string
  }
  childSessionId?: string   // delegate_task 关联的子 session
}

// ============================================================================
// Content Block Types (interleaved rendering)
// ============================================================================

export type ContentBlock =
  | { type: 'text'; content: string }
  | { type: 'thinking'; content: string }
  | { type: 'tool_call'; entry: ToolCallEntry }

// ============================================================================
// Model Types
// ============================================================================

export interface ModelSlotInfo {
  slug: string
  label: string
  description?: string
  icon?: string
  supportsImage: boolean
}

export interface ModelInfo {
  slotSlug: string
  slotLabel: string
  modelConfigId: string
  modelName: string
}

// ============================================================================
// Message Types
// ============================================================================

export type MessageRole = 'user' | 'assistant'

export interface AIMessage {
  id: string
  role: MessageRole
  content: string
  timestamp: number
  contentBlocks?: ContentBlock[]
  childSessionParts?: Record<string, ContentBlock[]>  // 子 session 的 content blocks
  pending?: boolean
  isCompaction?: boolean
  interrupted?: boolean
  attachments?: AttachmentInfo[]
  modelInfo?: ModelInfo
}

// ============================================================================
// Pending Change Types
// ============================================================================

export type ChangeStatus = 'pending' | 'awaiting' | 'accepted' | 'rejected' | 'conflict'

export type ChangeType = 'edit' | 'create' | 'delete'

export interface ChangePosition {
  start: number
  end: number
}

export interface PendingChange {
  id: string
  projectId: string
  type?: ChangeType // defaults to 'edit' for backward compatibility

  // edit type fields
  docId?: string
  docPath?: string
  position?: ChangePosition
  oldText?: string
  newText?: string
  replaceAll?: boolean
  newContent?: string
  baseVersion?: number

  // create type fields
  content?: string

  // delete type fields
  deletedContent?: string
  entityType?: 'doc' | 'file'
  entityId?: string
  isBinary?: boolean

  // common
  path?: string
  status: ChangeStatus
  createdAt: number
  sourceToolCallId?: string
  stale?: boolean
  confirmedBy?: 'sse' | 'fallback'
}

// ============================================================================
// Session Types
// ============================================================================

export type SessionStatus = 'idle' | 'pending' | 'streaming' | 'error'

export interface AISession {
  id: string
  projectId: string
  title: string
  messages: AIMessage[]
  changeHistory: PendingChange[]
  activeHandoff?: {
    teamId: string
    taskId?: string
    childSessionId?: string
    capabilityName?: string
    objective?: string
    startedAt?: number | string
  } | null
  error?: Error | null
  hasMore?: boolean
  nextBeforeSeq?: number | null
  createdAt: number
  updatedAt: number
}

export interface AgentTeamTask {
  id: string
  teamId: string
  parentTaskId?: string | null
  childSessionId?: string | null
  agentName: string
  mode?: string
  status: string
  objective: string
  error?: string | null
  findingCount?: number
  artifactCount?: number
  draftChangeCount?: number
  retryable?: boolean
  cancellable?: boolean
}

export interface AgentTeamSummary {
  id: string
  projectId: string
  rootSessionId: string
  rootChangeSetId?: string | null
  workflowType: string
  status: string
  mode?: string
  startedBy?: string
  policySummary?: Record<string, unknown>
  budgetSummary?: Record<string, unknown>
  archiveReason?: string | null
  startedAt?: number | null
  updatedAt?: number | null
  completedAt?: number | null
}

export interface AgentTeamEvent {
  id: string
  teamId: string
  taskId?: string | null
  sessionId?: string | null
  type: string
  payload?: Record<string, unknown>
  createdAt?: number | null
}

export interface AgentTeamRun {
  team: AgentTeamSummary
  tasks: AgentTeamTask[]
  results?: Array<{
    id: string
    taskId: string
    status: string
    summary?: string
    findings?: unknown[]
    artifacts?: unknown[]
  }>
  events?: AgentTeamEvent[]
  diagnostics?: {
    taskCount?: number
    resultCount?: number
    contextPackCount?: number
    eventTypes?: Record<string, number>
  }
}

export interface SessionSummary {
  id: string
  projectId: string
  title: string
  createdAt: number
  updatedAt: number
}

// ============================================================================
// API Event Types (SSE)
// ============================================================================

export type AIEventType =
  | 'session_created'
  | 'thinking_chunk'
  | 'text_chunk'
  | 'tool_call'
  | 'tool_call_start'
  | 'tool_result'
  | 'child_session_init'
  | 'pending_change'
  | 'awaiting_confirmation'
  | 'change_confirmed'
  | 'change_conflict'
  | 'message_complete'
  | 'conversation_stopped'
  | 'compaction_start'
  | 'compaction_done'
  | 'error'
  | 'done'

export interface AIEventBase {
  type: AIEventType
  timestamp: number
  sessionId?: string  // 事件来源 session（主 session 或子 session）
}

export interface SessionCreatedEvent extends AIEventBase {
  type: 'session_created'
  sessionId: string
}

export interface ThinkingChunkEvent extends AIEventBase {
  type: 'thinking_chunk'
  content: string
  messageId: string
}

export interface TextChunkEvent extends AIEventBase {
  type: 'text_chunk'
  content: string
  messageId: string
}

export interface ToolCallEvent extends AIEventBase {
  type: 'tool_call'
  toolCall: ToolCall
  messageId: string
  queued?: boolean
}

export interface ToolCallStartEvent extends AIEventBase {
  type: 'tool_call_start'
  toolCallId: string
  messageId: string
}

export interface ToolResultEvent extends AIEventBase {
  type: 'tool_result'
  toolResult: ToolResult
  messageId: string
}

export interface ChildSessionInitEvent extends AIEventBase {
  type: 'child_session_init'
  childSessionId: string
  agentName: string
  messageId: string
}

export interface PendingChangeEvent extends AIEventBase {
  type: 'pending_change'
  change: PendingChange
}

export interface AwaitingConfirmationEvent extends AIEventBase {
  type: 'awaiting_confirmation'
  change: PendingChange
  messageId: string
}

export interface ChangeConfirmedEvent extends AIEventBase {
  type: 'change_confirmed'
  changeId: string
  action: 'accept' | 'reject'
  messageId: string
}

export interface ChangeConflictEvent extends AIEventBase {
  type: 'change_conflict'
  changeId: string
  conflictType: string
  message: string
}

export interface MessageCompleteEvent extends AIEventBase {
  type: 'message_complete'
  message: AIMessage
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
  } | null
  compaction?: {
    contextWindow: number
    threshold: number
  } | null
}

export interface CompactionStartEvent extends AIEventBase {
  type: 'compaction_start'
  messageId: string
}

export interface CompactionDoneEvent extends AIEventBase {
  type: 'compaction_done'
  success: boolean
  messageId: string
}

export interface ErrorEvent extends AIEventBase {
  type: 'error'
  error: {
    code: string
    message: string
  }
}

export interface DoneEvent extends AIEventBase {
  type: 'done'
}

export interface ConversationStoppedEvent extends AIEventBase {
  type: 'conversation_stopped'
  message: AIMessage
}

export type AIEvent =
  | SessionCreatedEvent
  | ThinkingChunkEvent
  | TextChunkEvent
  | ToolCallEvent
  | ToolCallStartEvent
  | ToolResultEvent
  | ChildSessionInitEvent
  | PendingChangeEvent
  | AwaitingConfirmationEvent
  | ChangeConfirmedEvent
  | ChangeConflictEvent
  | MessageCompleteEvent
  | ConversationStoppedEvent
  | CompactionStartEvent
  | CompactionDoneEvent
  | ErrorEvent
  | DoneEvent

// ============================================================================
// API Request/Response Types
// ============================================================================

export interface CreateSessionRequest {
  projectId: string
  docId?: string
}

export interface CreateSessionResponse {
  session: AISession
}

export interface GetSessionResponse {
  session: AISession
}

export interface SendMessageRequest {
  content: string
  docId?: string
}

export interface AcceptChangeResponse {
  success: boolean
  change: PendingChange
}

export interface RejectChangeResponse {
  success: boolean
  change: PendingChange
}

export interface BulkChangeResponse {
  success: boolean
  changes: PendingChange[]
}

export interface ListSessionsResponse {
  sessions: SessionSummary[]
}

export interface UpdateSessionResponse {
  success: boolean
  title: string
}

export interface CompactSessionResponse {
  success: boolean
  summary?: string
  message?: string
}

export interface GetTeamRunResponse {
  teamRun: AgentTeamRun
}

export interface ListTeamRunsResponse {
  teamRuns: AgentTeamSummary[]
}

export interface RetryTeamRunTaskResponse {
  teamRun: AgentTeamRun
  task?: AgentTeamTask
}

// ============================================================================
// Streaming Phase
// ============================================================================

export type StreamingPhase = 'thinking' | 'replying' | 'tool_running' | null

// ============================================================================
// Context State Types
// ============================================================================

export interface AIAssistantState {
  session: AISession | null
  status: SessionStatus
  messages: AIMessage[]
  awaitingConfirmation: PendingChange[]
  changeHistory: PendingChange[]
  appliedChanges: PendingChange[]
  activeBlocks: ContentBlock[]
  childActiveBlocks: Record<string, ContentBlock[]>  // 子 session → ContentBlocks
  currentMessageId: string | null
  error: Error | null
  streamingError: Error | null
  initialized: boolean
  streamingPhase: StreamingPhase
  activeToolName: string | null
  thinkingTopic: string | null
  tokenUsage: {
    promptTokens: number
    completionTokens: number
    totalTokens: number
    contextWindow: number
    threshold: number
  } | null
  compactionStatus: 'idle' | 'compacting' | null
  selectedModelSlot: string | null
  availableModelSlots: ModelSlotInfo[]
  modelSlotsLoaded: boolean
  teamRuns: AgentTeamRun[]
}

// ============================================================================
// Context Action Types
// ============================================================================

export type AIAssistantAction =
  | { type: 'INIT_START' }
  | { type: 'INIT_SUCCESS'; session: AISession }
  | { type: 'INIT_FAILURE'; error: Error }
  | { type: 'CREATE_SESSION_START' }
  | { type: 'CREATE_SESSION_SUCCESS'; session: AISession }
  | { type: 'CREATE_SESSION_FAILURE'; error: Error }
  | { type: 'DELETE_SESSION' }
  | { type: 'SEND_MESSAGE_START'; content: string; messageId: string; skill?: string; attachments?: AttachmentInfo[] }
  | { type: 'RECEIVE_TEXT_CHUNK'; content: string; messageId: string; sessionId?: string }
  | { type: 'RECEIVE_TOOL_CALL'; toolCall: ToolCall; messageId: string; sessionId?: string; queued?: boolean }
  | { type: 'RECEIVE_TOOL_RESULT'; toolResult: ToolResult; messageId: string; sessionId?: string }
  | { type: 'RECEIVE_THINKING_CHUNK'; content: string; messageId: string; sessionId?: string }
  | { type: 'TOOL_CALL_START'; toolCallId: string; sessionId?: string }
  | { type: 'CHILD_SESSION_INIT'; childSessionId: string; agentName: string }
  | { type: 'AWAITING_CONFIRMATION'; change: PendingChange }
  | { type: 'CHANGE_CONFIRMED'; changeId: string; action: 'accept' | 'reject'; source?: 'sse' | 'fallback' }
  | { type: 'CHANGE_CONFLICT'; changeId: string; conflictType: string; message: string }
  | { type: 'MARK_CHANGES_STALE'; staleIds: string[] }
  | { type: 'DISMISS_APPLIED_CHANGE'; changeId: string }
  | { type: 'DISMISS_ALL_APPLIED_CHANGES' }
  | { type: 'MESSAGE_COMPLETE'; message: AIMessage }
  | { type: 'SET_ERROR'; error: Error }
  | { type: 'CLEAR_ERROR' }
  | { type: 'RESET' }
  | { type: 'RENAME_SESSION'; title: string }
  | { type: 'STREAMING_ERROR'; error: Error }
  | { type: 'RETRY_START' }
  | { type: 'UPDATE_TOKEN_USAGE'; usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number }; compaction: { contextWindow: number; threshold: number } }
  | { type: 'COMPACTION_START' }
  | { type: 'COMPACTION_DONE'; success: boolean }
  | { type: 'STOP_CONVERSATION' }
  | { type: 'SET_MODEL_SLOT'; slug: string | null }
  | { type: 'SET_AVAILABLE_MODEL_SLOTS'; slots: ModelSlotInfo[] }
  | { type: 'SET_TEAM_RUNS'; teamRuns: AgentTeamRun[] }
  | { type: 'UPSERT_TEAM_RUN'; teamRun: AgentTeamRun }

// ============================================================================
// Attachment Types
// ============================================================================

export type FileUploadStatus = 'uploading' | 'uploaded' | 'error'

export interface AttachmentInfo {
  id: string
  filename: string
  mimeType: string
  size: number
  localPreviewUrl?: string
  uploadStatus?: FileUploadStatus
  uploadError?: string
}

// ============================================================================
// Quick Edit Types
// ============================================================================

export type QuickEditAction = 'rewrite' | 'translate' | 'paraphrase' | 'deai'

export type RewriteStyle = 'scientific' | 'concise' | 'punchy' | 'split' | 'join'

export interface QuickEditRequest {
  projectId: string
  docId: string
  selectedText: string
  action: QuickEditAction
  style?: RewriteStyle
  targetLanguage?: string
  surroundingContext?: string
  customInstruction?: string
}

export interface QuickEditResponse {
  success: boolean
  editedText: string
  action: QuickEditAction
  style?: RewriteStyle
  targetLanguage?: string
}
