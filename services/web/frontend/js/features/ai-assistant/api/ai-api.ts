/**
 * AI API Communication Layer
 * Handles all communication with the AI Writing Agent backend service
 */

import {
  postJSON,
  getJSON,
  putJSON,
  deleteJSON,
  FetchError,
} from '@/infrastructure/fetch-json'
import getMeta from '@/utils/meta'
import type {
  AISession,
  AIEvent,
  CreateSessionResponse,
  GetSessionResponse,
  AcceptChangeResponse,
  RejectChangeResponse,
  BulkChangeResponse,
  PendingChange,
  SessionSummary,
  ListSessionsResponse,
  UpdateSessionResponse,
  CompactSessionResponse,
  AttachmentInfo,
  ModelSlotInfo,
  GetTeamRunResponse,
  ListTeamRunsResponse,
  RetryTeamRunTaskResponse,
  AgentTeamRun,
  AgentTeamSummary,
} from '../types/ai-types'

// Base URL for AI API - always use the web proxy path
// The actual AI service URL is configured server-side and proxied through /api/ai
const getAIBaseUrl = (): string => {
  return '/api/ai'
}

const SESSION_PAGE_SIZE = 200

// ============================================================================
// Image Attachment Constants
// ============================================================================

export const ACCEPTED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']
export const ACCEPTED_TEXT_TYPES = ['text/plain', 'text/markdown', 'text/csv', 'application/json']
export const ACCEPTED_ATTACHMENT_TYPES = [...ACCEPTED_IMAGE_TYPES, ...ACCEPTED_TEXT_TYPES]
export const MAX_IMAGE_SIZE = 5 * 1024 * 1024 // 5MB
const UPLOAD_TIMEOUT_MS = 60_000

// ============================================================================
// Model Slots API
// ============================================================================

export async function getModelSlots(): Promise<ModelSlotInfo[]> {
  const baseUrl = getAIBaseUrl()
  const result = await getJSON<{ slots: ModelSlotInfo[] }>(`${baseUrl}/model-slots`)
  return result.slots
}

export async function getDefaultSlot(): Promise<string | null> {
  const baseUrl = getAIBaseUrl()
  const result = await getJSON<{ defaultSlot: string | null }>(`${baseUrl}/model-slots/default`)
  return result.defaultSlot ?? null
}

// ============================================================================
// Attachment Upload
// ============================================================================

/**
 * Upload an image attachment for a session
 */
export async function uploadAttachment(
  sessionId: string,
  file: File
): Promise<AttachmentInfo> {
  const baseUrl = getAIBaseUrl()
  const csrfToken = getMeta('ol-csrfToken')
  const url = `${baseUrl}/sessions/${sessionId}/attachments`

  const formData = new FormData()
  formData.append('file', file)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS)

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'X-Csrf-Token': csrfToken,
      },
      credentials: 'same-origin',
      body: formData,
      signal: controller.signal,
    })

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}))
      throw new FetchError(
        response.statusText || 'Failed to upload attachment',
        url,
        undefined,
        response,
        errorData
      )
    }

    return response.json()
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`Attachment upload timed out after ${UPLOAD_TIMEOUT_MS / 1000}s`)
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Upload a file independently (no session required)
 */
export async function uploadFile(file: File): Promise<AttachmentInfo> {
  const baseUrl = getAIBaseUrl()
  const csrfToken = getMeta('ol-csrfToken')
  const url = `${baseUrl}/files`
  const formData = new FormData()
  formData.append('file', file)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS)

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'X-Csrf-Token': csrfToken },
      credentials: 'same-origin',
      body: formData,
      signal: controller.signal,
    })
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}))
      throw new FetchError(
        response.statusText || 'Upload failed',
        url,
        undefined,
        response,
        errorData
      )
    }
    return response.json()
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`File upload timed out after ${UPLOAD_TIMEOUT_MS / 1000}s`)
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}

// ============================================================================
// Session Management
// ============================================================================

/**
 * Create a new AI session for a project
 */
export async function createSession(
  projectId: string,
  docId?: string
): Promise<AISession> {
  const baseUrl = getAIBaseUrl()
  const response = await postJSON<CreateSessionResponse>(`${baseUrl}/sessions`, {
    body: { projectId, docId },
  })
  return response.session
}

/**
 * Get an existing session by ID
 */
export async function getSession(sessionId: string): Promise<AISession> {
  const baseUrl = getAIBaseUrl()
  let beforeSeq: number | null = null
  let combinedMessages: AISession['messages'] = []
  let session: AISession | null = null

  while (true) {
    const params = new URLSearchParams({ limit: String(SESSION_PAGE_SIZE) })
    if (beforeSeq) params.set('beforeSeq', String(beforeSeq))

    const response = await getJSON<GetSessionResponse>(
      `${baseUrl}/sessions/${sessionId}?${params.toString()}`
    )

    const page = response.session
    if (!session) {
      session = { ...page, messages: [] }
    }

    if (page.messages?.length) {
      combinedMessages = page.messages.concat(combinedMessages)
    }

    if (!page.hasMore || !page.nextBeforeSeq || page.messages?.length === 0) {
      break
    }

    beforeSeq = page.nextBeforeSeq
  }

  if (!session) {
    throw new Error('Session not found')
  }

  session.messages = combinedMessages
  session.hasMore = false
  session.nextBeforeSeq = null
  return session
}

/**
 * Delete/end an AI session
 */
export async function deleteSession(sessionId: string): Promise<void> {
  const baseUrl = getAIBaseUrl()
  await deleteJSON(`${baseUrl}/sessions/${sessionId}`)
}

/**
 * List sessions for a project
 */
export async function listSessions(
  projectId: string
): Promise<SessionSummary[]> {
  const baseUrl = getAIBaseUrl()
  const response = await getJSON<ListSessionsResponse>(
    `${baseUrl}/sessions?projectId=${encodeURIComponent(projectId)}`
  )
  return response.sessions
}

/**
 * Update session (rename)
 */
export async function updateSession(
  sessionId: string,
  title: string
): Promise<string> {
  const baseUrl = getAIBaseUrl()
  const response = await putJSON<UpdateSessionResponse>(
    `${baseUrl}/sessions/${sessionId}`,
    { body: { title } }
  )
  return response.title
}

// ============================================================================
// Agent Team Runs
// ============================================================================

export async function getTeamRun(
  sessionId: string,
  teamId: string
): Promise<AgentTeamRun> {
  const baseUrl = getAIBaseUrl()
  const response = await getJSON<GetTeamRunResponse>(
    `${baseUrl}/sessions/${sessionId}/team-runs/${teamId}`
  )
  return response.teamRun
}

export async function listTeamRuns(
  sessionId: string
): Promise<AgentTeamSummary[]> {
  const baseUrl = getAIBaseUrl()
  const response = await getJSON<ListTeamRunsResponse>(
    `${baseUrl}/sessions/${sessionId}/team-runs`
  )
  return response.teamRuns
}

export async function cancelTeamRun(
  sessionId: string,
  teamId: string
): Promise<AgentTeamRun> {
  const baseUrl = getAIBaseUrl()
  const response = await postJSON<GetTeamRunResponse>(
    `${baseUrl}/sessions/${sessionId}/team-runs/${teamId}/cancel`,
    { body: { reason: 'user-cancelled' } }
  )
  return response.teamRun
}

export async function retryTeamRunTask(
  sessionId: string,
  teamId: string,
  taskId: string
): Promise<RetryTeamRunTaskResponse> {
  const baseUrl = getAIBaseUrl()
  return postJSON<RetryTeamRunTaskResponse>(
    `${baseUrl}/sessions/${sessionId}/team-runs/${teamId}/tasks/${taskId}/retry`,
    { body: {} }
  )
}

// ============================================================================
// Messaging with SSE Streaming
// ============================================================================

/**
 * Context for current document information
 */
export interface MessageContext {
  currentDocId?: string
  currentDocPath?: string
  rootDocId?: string
  projectName?: string
  references?: Array<{
    type: 'file' | 'selection'
    path: string
    startLine?: number
    endLine?: number
    selectionText?: string
  }>
  skill?: string
  fileIds?: string[]
  attachmentIds?: string[]
}

/**
 * Parse SSE stream from a fetch Response into AIEvent objects
 */
async function* parseSSEStream(response: Response): AsyncGenerator<AIEvent, void, unknown> {
  const reader = response.body?.getReader()
  if (!reader) {
    throw new Error('Response body is not readable')
  }

  const IDLE_TIMEOUT_MS = 60_000
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      let idleTimer: ReturnType<typeof setTimeout> | undefined
      const readWithTimeout = (): Promise<ReadableStreamReadResult<Uint8Array>> => {
        return new Promise((resolve, reject) => {
          idleTimer = setTimeout(() => {
            reject(new Error('SSE idle timeout'))
          }, IDLE_TIMEOUT_MS)
          reader.read().then(resolve, reject)
        })
      }

      let done: boolean
      let value: Uint8Array | undefined
      try {
        ({ done, value } = await readWithTimeout())
      } finally {
        clearTimeout(idleTimer)
      }

      if (done) {
        break
      }

      buffer += decoder.decode(value, { stream: true })

      // Guard against unbounded buffer growth from malformed SSE streams
      const MAX_SSE_BUFFER_CHARS = 1024 * 1024 // 1MB
      if (buffer.length > MAX_SSE_BUFFER_CHARS) {
        reader.cancel()
        throw new Error('SSE buffer exceeded maximum size')
      }

      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6).trim()

          if (data === '[DONE]') {
            return
          }

          try {
            const event = JSON.parse(data) as AIEvent
            yield event
          } catch {
            // Ignore parse errors for malformed SSE events
          }
        }
      }
    }
  } finally {
    try { await reader.cancel() } catch {}
    reader.releaseLock()
  }
}

/**
 * Send a message to the AI and receive streaming responses
 * Uses Server-Sent Events (SSE) for real-time streaming
 */
export async function* sendMessage(
  sessionId: string,
  content: string,
  context?: MessageContext,
  signal?: AbortSignal,
  modelSlot?: string
): AsyncGenerator<AIEvent, void, unknown> {
  const baseUrl = getAIBaseUrl()
  const csrfToken = getMeta('ol-csrfToken')

  const response = await fetch(`${baseUrl}/sessions/${sessionId}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Csrf-Token': csrfToken,
      Accept: 'text/event-stream',
    },
    credentials: 'same-origin',
    body: JSON.stringify({
      content,
      context: context || {},
      stream: true,
      fileIds: context?.fileIds,
      modelSlot,
    }),
    signal,
  })

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}))
    throw new FetchError(
      response.statusText || 'Failed to send message',
      `${baseUrl}/sessions/${sessionId}/messages`,
      undefined,
      response,
      errorData
    )
  }

  yield* parseSSEStream(response)
}

/**
 * Resume a message stream from an error breakpoint
 */
export async function* resumeMessage(
  sessionId: string,
  context?: MessageContext,
  signal?: AbortSignal,
  modelSlot?: string
): AsyncGenerator<AIEvent, void, unknown> {
  const baseUrl = getAIBaseUrl()
  const csrfToken = getMeta('ol-csrfToken')

  const response = await fetch(`${baseUrl}/sessions/${sessionId}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Csrf-Token': csrfToken,
      Accept: 'text/event-stream',
    },
    credentials: 'same-origin',
    body: JSON.stringify({ resume: true, context: context || {}, stream: true, modelSlot }),
    signal,
  })

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}))
    throw new FetchError(
      response.statusText || 'Failed to resume message',
      `${baseUrl}/sessions/${sessionId}/messages`,
      undefined,
      response,
      errorData
    )
  }

  yield* parseSSEStream(response)
}

// ============================================================================
// Change Confirmation (Synchronous Edit Flow)
// ============================================================================

/**
 * Confirm or reject a change during synchronous edit flow.
 * Called while the SSE stream is open and the AgentLoop is waiting for user input.
 */
export async function confirmChange(
  sessionId: string,
  changeId: string,
  action: 'accept' | 'reject',
  reason?: string
): Promise<void> {
  const baseUrl = getAIBaseUrl()
  await postJSON(`${baseUrl}/sessions/${sessionId}/confirm-change/${changeId}`, {
    body: { action, reason },
  })
}

// ============================================================================
// Stop Session
// ============================================================================

/**
 * Stop an in-progress AI conversation
 */
export async function stopSession(sessionId: string): Promise<void> {
  const baseUrl = getAIBaseUrl()
  await postJSON(`${baseUrl}/sessions/${sessionId}/stop`)
}

// ============================================================================
// Context Compaction
// ============================================================================

/**
 * Manually trigger context compaction for a session
 */
export async function compactSession(
  sessionId: string
): Promise<CompactSessionResponse> {
  const baseUrl = getAIBaseUrl()
  const response = await postJSON<CompactSessionResponse>(
    `${baseUrl}/sessions/${sessionId}/compact`
  )
  return response
}

// ============================================================================
// Change Management (Deprecated — kept for backward compatibility)
// ============================================================================

/**
 * Accept a single pending change
 */
export async function acceptChange(
  sessionId: string,
  changeId: string
): Promise<PendingChange> {
  const baseUrl = getAIBaseUrl()
  const response = await postJSON<AcceptChangeResponse>(
    `${baseUrl}/sessions/${sessionId}/changes/${changeId}/accept`
  )
  return response.change
}

/**
 * Reject a single pending change
 */
export async function rejectChange(
  sessionId: string,
  changeId: string
): Promise<PendingChange> {
  const baseUrl = getAIBaseUrl()
  const response = await postJSON<RejectChangeResponse>(
    `${baseUrl}/sessions/${sessionId}/changes/${changeId}/reject`
  )
  return response.change
}

/**
 * Accept all pending changes in a session
 */
export async function acceptAllChanges(
  sessionId: string
): Promise<PendingChange[]> {
  const baseUrl = getAIBaseUrl()
  const response = await postJSON<BulkChangeResponse>(
    `${baseUrl}/sessions/${sessionId}/changes/accept-all`
  )
  return response.changes
}

/**
 * Reject all pending changes in a session
 */
export async function rejectAllChanges(
  sessionId: string
): Promise<PendingChange[]> {
  const baseUrl = getAIBaseUrl()
  const response = await postJSON<BulkChangeResponse>(
    `${baseUrl}/sessions/${sessionId}/changes/reject-all`
  )
  return response.changes
}

// ============================================================================
// File Search (for @ mention autocomplete)
// ============================================================================

/**
 * Search project files for @ mention autocomplete
 */
export async function searchFiles(
  projectId: string,
  query: string
): Promise<Array<{ path: string; type: 'doc' | 'file' }>> {
  const baseUrl = getAIBaseUrl()
  const result = await getJSON<{ files: Array<{ path: string; type: 'doc' | 'file' }> }>(
    `${baseUrl}/projects/${projectId}/files?query=${encodeURIComponent(query)}`
  )
  return result.files
}

// ============================================================================
// Error Handling Utilities
// ============================================================================

/**
 * Check if an error is an AI API error
 */
export function isAIApiError(error: unknown): error is FetchError {
  return error instanceof FetchError
}

/**
 * Get user-friendly error message from AI API error
 */
export function getAIErrorMessage(error: unknown): string {
  if (error instanceof FetchError) {
    const data = error.data as { message?: string; error?: string } | undefined
    return data?.message || data?.error || error.getUserFacingMessage()
  }
  if (error instanceof Error) {
    return error.message
  }
  return 'An unexpected error occurred'
}

// ============================================================================
// Project Rules
// ============================================================================

/**
 * Get project rules content
 */
export async function getProjectRules(
  projectId: string
): Promise<{ content: string; updatedAt: string | null; maxLength?: number }> {
  const baseUrl = getAIBaseUrl()
  return getJSON(`${baseUrl}/projects/${projectId}/rules`)
}

/**
 * Update project rules content
 */
export async function updateProjectRules(
  projectId: string,
  content: string
): Promise<void> {
  const baseUrl = getAIBaseUrl()
  await putJSON(`${baseUrl}/projects/${projectId}/rules`, { body: { content } })
}

// ============================================================================
// Completion Rules
// ============================================================================

/**
 * Get completion rules content
 */
export async function getCompletionRules(
  projectId: string
): Promise<{ content: string; updatedAt: string | null; maxLength?: number }> {
  const baseUrl = getAIBaseUrl()
  return getJSON(`${baseUrl}/projects/${projectId}/completion-rules`)
}

/**
 * Update completion rules content
 */
export async function updateCompletionRules(
  projectId: string,
  content: string
): Promise<void> {
  const baseUrl = getAIBaseUrl()
  await putJSON(`${baseUrl}/projects/${projectId}/completion-rules`, { body: { content } })
}

// ============================================================================
// Connection Health Check
// ============================================================================

/**
 * Check if the AI service is available
 */
export async function checkAIServiceHealth(): Promise<boolean> {
  try {
    const baseUrl = getAIBaseUrl()
    const response = await fetch(`${baseUrl}/health`, {
      method: 'GET',
      credentials: 'same-origin',
    })
    return response.ok
  } catch {
    return false
  }
}
