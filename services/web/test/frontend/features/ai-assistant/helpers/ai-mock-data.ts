import type {
  AISession,
  AIMessage,
  PendingChange,
  TextChunkEvent,
  ToolCallEvent,
  ToolResultEvent,
  PendingChangeEvent,
  MessageCompleteEvent,
  ErrorEvent,
  DoneEvent,
  ToolCall,
  ToolResult,
  ChangeStatus,
} from '@/features/ai-assistant/types/ai-types'

let sessionCounter = 0
let messageCounter = 0
let changeCounter = 0
let toolCallCounter = 0

export function createMockSession(
  overrides: Partial<AISession> = {}
): AISession {
  const id = overrides.id ?? `session-${++sessionCounter}`
  return {
    id,
    projectId: 'project123',
    title: 'Test session',
    messages: [],
    changeHistory: [],
    error: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  }
}

export function createMockMessage(
  overrides: Partial<AIMessage> = {}
): AIMessage {
  const id = overrides.id ?? `msg-${++messageCounter}`
  return {
    id,
    role: 'user',
    content: 'Test message',
    timestamp: Date.now(),
    ...overrides,
  }
}

export function createMockAssistantMessage(
  content: string,
  overrides: Partial<AIMessage> = {}
): AIMessage {
  return createMockMessage({
    role: 'assistant',
    content,
    ...overrides,
  })
}

export function createMockPendingChange(
  overrides: Partial<PendingChange> = {}
): PendingChange {
  const id = overrides.id ?? `change-${++changeCounter}`
  return {
    id,
    projectId: 'project123',
    docId: 'doc123',
    docPath: 'main.tex',
    position: { start: 0, end: 10 },
    oldText: 'old text',
    newText: 'new text',
    status: 'pending' as ChangeStatus,
    createdAt: Date.now(),
    ...overrides,
  }
}

export function createMockAcceptedChange(
  overrides: Partial<PendingChange> = {}
): PendingChange {
  return createMockPendingChange({ status: 'accepted', ...overrides })
}

export function createMockRejectedChange(
  overrides: Partial<PendingChange> = {}
): PendingChange {
  return createMockPendingChange({ status: 'rejected', ...overrides })
}

export function createMockToolCall(
  overrides: Partial<ToolCall> = {}
): ToolCall {
  return {
    id: `tool-${++toolCallCounter}`,
    type: 'function',
    function: {
      name: 'read_document',
      arguments: '{}',
    },
    ...overrides,
  }
}

export function createMockToolResult(
  overrides: Partial<ToolResult> = {}
): ToolResult {
  return {
    toolCallId: 'tool-1',
    content: 'Tool result content',
    isError: false,
    ...overrides,
  }
}

// SSE event factories

export function createTextChunkEvent(
  content: string,
  messageId: string = 'msg-1'
): TextChunkEvent {
  return { type: 'text_chunk', content, messageId, timestamp: Date.now() }
}

export function createToolCallEvent(
  toolCall: ToolCall,
  messageId: string = 'msg-1'
): ToolCallEvent {
  return { type: 'tool_call', toolCall, messageId, timestamp: Date.now() }
}

export function createToolResultEvent(
  toolResult: ToolResult,
  messageId: string = 'msg-1'
): ToolResultEvent {
  return { type: 'tool_result', toolResult, messageId, timestamp: Date.now() }
}

export function createPendingChangeEvent(
  change: PendingChange
): PendingChangeEvent {
  return { type: 'pending_change', change, timestamp: Date.now() }
}

export function createMessageCompleteEvent(
  message: AIMessage
): MessageCompleteEvent {
  return { type: 'message_complete', message, timestamp: Date.now() }
}

export function createErrorEvent(code: string, message: string): ErrorEvent {
  return { type: 'error', error: { code, message }, timestamp: Date.now() }
}

export function createDoneEvent(): DoneEvent {
  return { type: 'done', timestamp: Date.now() }
}

export function resetMockCounters() {
  sessionCounter = 0
  messageCounter = 0
  changeCounter = 0
  toolCallCounter = 0
}
